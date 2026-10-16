import {
  corsHeaders,
  getWnbfSecret,
  json,
  mazatlanIso,
  modalityKey,
  parseRegistration,
  requireUser,
  WNBF_COMPETITION_ID,
  WNBF_WEBHOOK_URL,
} from "../_shared/wnbf.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type OutboxRow = { id: string; payload: Record<string, unknown>; attempts: number; updated_at: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const authenticated = await requireUser(req);
  if ("error" in authenticated) return authenticated.error;
  const { user, profile, service } = authenticated;

  let input: {
    action?: "papeleta_enviada" | "resultado_confirmado" | "medidas_registradas";
    ballot_id?: string;
    category_id?: string;
    athlete_id?: string;
    peso_kg?: number | null;
    estatura_cm?: number | null;
  } = {};
  try { input = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  let queuedIds: string[] = [];
  if (input.action === "papeleta_enviada" && input.ballot_id) {
    const built = await queueBallot(service, input.ballot_id, user.id, profile.role);
    if (built.error) return json({ error: built.error }, built.status ?? 400);
    queuedIds = built.ids;
  } else if (input.action === "resultado_confirmado" && input.category_id) {
    if (!["admin", "head_judge"].includes(profile.role)) return json({ error: "Solo el juez principal puede confirmar resultados" }, 403);
    const built = await queueResult(service, input.category_id);
    if (built.error) return json({ error: built.error }, built.status ?? 400);
    queuedIds = built.ids;
  } else if (input.action === "medidas_registradas" && input.athlete_id) {
    const built = await queueMeasurements(service, input, profile);
    if (built.error) return json({ error: built.error }, built.status ?? 400);
    queuedIds = built.ids;
    await processOutbox(service, queuedIds, true);
    const delivery = queuedIds[0]
      ? await service.from("wnbf_webhook_outbox").select("status,last_error,response_status").eq("id", queuedIds[0]).maybeSingle()
      : { data: null };
    return json({
      ok: delivery.data?.status !== "failed",
      queued: queuedIds.length,
      delivery_status: delivery.data?.status ?? "pending",
      response_status: delivery.data?.response_status ?? null,
      error: delivery.data?.last_error ?? null,
      athlete: built.athlete,
    });
  } else {
    return json({ error: "Acción o identificador inválido" }, 400);
  }

  const due = await service.from("wnbf_webhook_outbox").select("id").eq("status", "pending").lte("next_attempt_at", new Date().toISOString()).limit(100);
  const ids = [...new Set([...queuedIds, ...(due.data ?? []).map((row) => row.id)])];
  const processing = processOutbox(service, ids);
  const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime) edgeRuntime.waitUntil(processing);
  else await processing;
  return json({ ok: true, queued: queuedIds.length });
});

async function queueMeasurements(
  service: SupabaseClient,
  input: { athlete_id?: string; peso_kg?: number | null; estatura_cm?: number | null },
  profile: { id: string; full_name: string | null; email: string; role: string },
) {
  const hasWeight = Object.prototype.hasOwnProperty.call(input, "peso_kg");
  const hasHeight = Object.prototype.hasOwnProperty.call(input, "estatura_cm");
  if (!hasWeight && !hasHeight) return { error: "Debes enviar peso_kg y/o estatura_cm", status: 400, ids: [] as string[], athlete: null };
  const weight = input.peso_kg === null ? null : Number(input.peso_kg);
  const height = input.estatura_cm === null ? null : Number(input.estatura_cm);
  if (hasWeight && weight !== null && (!Number.isFinite(weight) || weight < 30 || weight > 200)) {
    return { error: "peso_kg debe estar entre 30 y 200", status: 400, ids: [] as string[], athlete: null };
  }
  if (hasHeight && height !== null && (!Number.isInteger(height) || height < 120 || height > 230)) {
    return { error: "estatura_cm debe ser un entero entre 120 y 230", status: 400, ids: [] as string[], athlete: null };
  }

  const athleteResult = await service.from("athletes")
    .select("id,competition_id,wnbf_athlete_id,weight_kg,height_cm,active,registration_status")
    .eq("id", input.athlete_id)
    .maybeSingle();
  const athlete = athleteResult.data;
  if (athleteResult.error || !athlete) return { error: "Atleta no encontrado", status: 404, ids: [] as string[], athlete: null };
  if (!athlete.active || athlete.registration_status === "withdrawn") return { error: "El atleta ya no compite", status: 404, ids: [] as string[], athlete: null };
  if (!athlete.wnbf_athlete_id) return { error: "El atleta no está vinculado con WNBF México", status: 400, ids: [] as string[], athlete: null };
  if (profile.role === "judge") {
    const assignment = await service.from("judge_assignments").select("id").eq("competition_id", athlete.competition_id).eq("judge_id", profile.id).eq("active", true).maybeSingle();
    if (assignment.error || !assignment.data) return { error: "No estás asignado a este evento", status: 403, ids: [] as string[], athlete: null };
  }
  if (profile.role === "pending") return { error: "Tu cuenta todavía no tiene acceso al evento", status: 403, ids: [] as string[], athlete: null };

  const nextWeight = hasWeight ? weight : numberOrNull(athlete.weight_kg);
  const nextHeight = hasHeight ? height : numberOrNull(athlete.height_cm);
  const measuredBy = profile.full_name || profile.email;
  const update: Record<string, unknown> = {
    measured_by: measuredBy,
    measures_complete: nextWeight !== null && nextHeight !== null,
    updated_at: new Date().toISOString(),
  };
  if (hasWeight) update.weight_kg = weight;
  if (hasHeight) update.height_cm = height;
  const saved = await service.from("athletes").update(update).eq("id", athlete.id)
    .select("id,competition_id,category_id,bib,name,active,registered_division,height_cm,weight_kg,registration_status,wnbf_athlete_id,measured_by,measures_complete,external_updated_at")
    .single();
  if (saved.error) return { error: saved.error.message, status: 500, ids: [] as string[], athlete: null };

  const payload: Record<string, unknown> = {
    tipo_evento: "medidas_registradas",
    competencia_id: WNBF_COMPETITION_ID,
    atleta_id_wnbf: athlete.wnbf_athlete_id,
    medido_por: measuredBy,
  };
  if (hasWeight) payload.peso_kg = weight;
  if (hasHeight) payload.estatura_cm = height;
  const now = new Date().toISOString();
  const queued = await service.from("wnbf_webhook_outbox").upsert({
    competition_id: athlete.competition_id,
    event_type: "medidas_registradas",
    idempotency_key: `medidas:${athlete.competition_id}:${athlete.wnbf_athlete_id}`,
    payload,
    status: "pending",
    attempts: 0,
    next_attempt_at: now,
    response_status: null,
    last_error: null,
    sent_at: null,
    updated_at: now,
  }, { onConflict: "idempotency_key" }).select("id").single();
  if (queued.error) return { error: queued.error.message, status: 500, ids: [] as string[], athlete: saved.data };
  return { error: undefined, status: 200, ids: [queued.data.id as string], athlete: saved.data };
}

async function queueBallot(service: SupabaseClient, ballotId: string, userId: string, role: string) {
  const ballotResult = await service.from("ballots").select("id,category_id,judge_id,status,submitted_at,included_in_results").eq("id", ballotId).maybeSingle();
  const ballot = ballotResult.data;
  if (ballotResult.error || !ballot) return { error: "Papeleta no encontrada", status: 404, ids: [] as string[] };
  if (ballot.judge_id !== userId && !["admin", "head_judge"].includes(role)) return { error: "No puedes enviar la papeleta de otro juez", status: 403, ids: [] as string[] };
  if (ballot.status !== "submitted" || !ballot.submitted_at) return { error: "La papeleta todavía no está enviada", status: 400, ids: [] as string[] };

  const [categoryResult, judgeResult, placementResult, feedbackResult] = await Promise.all([
    service.from("categories").select("id,competition_id,name,division,rounds,tie_break_round,is_test").eq("id", ballot.category_id).maybeSingle(),
    service.from("profiles").select("full_name,email").eq("id", ballot.judge_id).maybeSingle(),
    service.from("placements").select("athlete_id,round_key,place").eq("ballot_id", ballot.id),
    service.from("athlete_feedback").select("athlete_id,strengths,improvements,notes").eq("category_id", ballot.category_id).eq("judge_id", ballot.judge_id),
  ]);
  const category = categoryResult.data;
  if (!category || categoryResult.error) return { error: "Categoría no encontrada", status: 404, ids: [] as string[] };
  if (category.is_test) return { error: "Las simulaciones no se envían a WNBF", status: 400, ids: [] as string[] };
  const athletesResult = await service.from("athletes").select("id,name,bib,registered_division,active,registration_status").eq("competition_id", category.competition_id);
  if (athletesResult.error || placementResult.error || feedbackResult.error) return { error: athletesResult.error?.message || placementResult.error?.message || feedbackResult.error?.message, status: 500, ids: [] as string[] };

  const athletes = (athletesResult.data ?? []).filter((athlete) => athlete.active && athlete.registration_status !== "withdrawn" && parseRegistration(athlete.registered_division).categoryIds.includes(category.id));
  const placements = placementResult.data ?? [];
  const feedback = new Map((feedbackResult.data ?? []).map((row) => [row.athlete_id, row]));
  const rounds = scoringRounds(category.rounds);
  const ranked = athletes.map((athlete) => {
    const roundPlaces = rounds.map((round) => placements.find((row) => row.athlete_id === athlete.id && row.round_key === round.key)?.place ?? 0);
    const total = roundPlaces.reduce((sum, place, index) => sum + place * rounds[index].weight, 0);
    const tieIndex = rounds.findIndex((round) => round.key === category.tie_break_round);
    return { athlete, roundPlaces, total, tie: tieIndex >= 0 ? roundPlaces[tieIndex] : total };
  }).sort((a, b) => a.total - b.total || a.tie - b.tie || (a.athlete.bib ?? 9999) - (b.athlete.bib ?? 9999) || a.athlete.name.localeCompare(b.athlete.name));
  const judgeName = judgeResult.data?.full_name || judgeResult.data?.email || "Juez WNBF";
  const rows = ranked.flatMap((rankedAthlete, index) => {
    const registration = parseRegistration(rankedAthlete.athlete.registered_division);
    if (!registration.external) return [];
    const athleteFeedback = feedback.get(rankedAthlete.athlete.id);
    const criteria = Object.fromEntries(rounds.map((round, roundIndex) => [criterionName(round.key, category.division), rankedAthlete.roundPlaces[roundIndex]]));
    const payload = {
      tipo_evento: "papeleta_enviada",
      competencia_id: WNBF_COMPETITION_ID,
      atleta_id_wnbf: registration.external.athleteId,
      dorsal: rankedAthlete.athlete.bib ?? null,
      categoria_final: registration.external.finalCategory || category.division,
      juez: judgeName,
      criterios: criteria,
      lugar_calculado_juez: index + 1,
      feedback: {
        fortalezas: athleteFeedback?.strengths ?? "",
        aspectos_a_mejorar: athleteFeedback?.improvements ?? "",
        observaciones: athleteFeedback?.notes ?? "",
      },
      enviado_at: mazatlanIso(ballot.submitted_at),
    };
    return [{
      competition_id: category.competition_id,
      event_type: "papeleta_enviada",
      idempotency_key: `papeleta:${ballot.id}:${ballot.submitted_at}:${registration.external.athleteId}`,
      payload,
    }];
  });
  return insertOutbox(service, rows);
}

async function queueResult(service: SupabaseClient, categoryId: string) {
  const categoryResult = await service.from("categories").select("id,competition_id,name,division,status,rounds,tie_break_round,is_test").eq("id", categoryId).maybeSingle();
  const category = categoryResult.data;
  if (!category || categoryResult.error) return { error: "Categoría no encontrada", status: 404, ids: [] as string[] };
  if (category.status !== "complete") return { error: "La categoría aún no está cerrada", status: 400, ids: [] as string[] };
  if (category.is_test) return { error: "Las simulaciones no se envían a WNBF", status: 400, ids: [] as string[] };

  const [athletesResult, ballotsResult, abstentionsResult, auditResult] = await Promise.all([
    service.from("athletes").select("id,name,bib,registered_division,active,registration_status").eq("competition_id", category.competition_id),
    service.from("ballots").select("id,judge_id,status,included_in_results").eq("category_id", category.id).eq("status", "submitted").eq("included_in_results", true),
    service.from("judge_abstentions").select("judge_id").eq("category_id", category.id),
    service.from("ballot_audit_log").select("created_at").eq("category_id", category.id).eq("action", "category_closed").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (athletesResult.error || ballotsResult.error || abstentionsResult.error) return { error: athletesResult.error?.message || ballotsResult.error?.message || abstentionsResult.error?.message, status: 500, ids: [] as string[] };
  const abstained = new Set((abstentionsResult.data ?? []).map((row) => row.judge_id));
  const ballots = (ballotsResult.data ?? []).filter((ballot) => !abstained.has(ballot.judge_id));
  const ballotIds = ballots.map((ballot) => ballot.id);
  const placementsResult = ballotIds.length
    ? await service.from("placements").select("ballot_id,athlete_id,round_key,place").in("ballot_id", ballotIds)
    : { data: [], error: null };
  if (placementsResult.error) return { error: placementsResult.error.message, status: 500, ids: [] as string[] };

  const athletes = (athletesResult.data ?? []).filter((athlete) => athlete.active && athlete.registration_status !== "withdrawn" && parseRegistration(athlete.registered_division).categoryIds.includes(category.id));
  const rounds = scoringRounds(category.rounds);
  const placements = placementsResult.data ?? [];
  const ranked = athletes.map((athlete) => {
    const roundTotals = rounds.map((round) => placements.filter((row) => row.athlete_id === athlete.id && row.round_key === round.key).reduce((sum, row) => sum + row.place * round.weight, 0));
    const total = roundTotals.reduce((sum, value) => sum + value, 0);
    const tieIndex = rounds.findIndex((round) => round.key === category.tie_break_round);
    return { athlete, total, tie: tieIndex >= 0 ? roundTotals[tieIndex] : total };
  }).sort((a, b) => a.total - b.total || a.tie - b.tie || (a.athlete.bib ?? 9999) - (b.athlete.bib ?? 9999) || a.athlete.name.localeCompare(b.athlete.name));
  const confirmedAt = auditResult.data?.created_at ?? new Date().toISOString();
  const rows = ranked.flatMap((rankedAthlete, index) => {
    const registration = parseRegistration(rankedAthlete.athlete.registered_division);
    if (!registration.external) return [];
    return [{
      competition_id: category.competition_id,
      event_type: "resultado_confirmado",
      idempotency_key: `resultado:${category.id}:${confirmedAt}:${registration.external.athleteId}`,
      payload: {
        tipo_evento: "resultado_confirmado",
        competencia_id: WNBF_COMPETITION_ID,
        atleta_id_wnbf: registration.external.athleteId,
        dorsal: rankedAthlete.athlete.bib ?? null,
        categoria_final: registration.external.finalCategory || category.division,
        lugar_final: index + 1,
        confirmado_at: mazatlanIso(confirmedAt),
      },
    }];
  });
  return insertOutbox(service, rows);
}

async function insertOutbox(service: SupabaseClient, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return { error: undefined, status: 200, ids: [] as string[] };
  const inserted = await service.from("wnbf_webhook_outbox").upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true }).select("id");
  if (inserted.error) return { error: inserted.error.message, status: 500, ids: [] as string[] };
  return { error: undefined, status: 200, ids: (inserted.data ?? []).map((row) => row.id as string) };
}

async function processOutbox(service: SupabaseClient, ids: string[], singleAttempt = false) {
  if (!ids.length) return;
  let webhookKey: string;
  try {
    webhookKey = await getWnbfSecret(service, "WNBF_API_KEY_WEBHOOK");
  } catch (error) {
    await service.from("wnbf_webhook_outbox").update({ last_error: error instanceof Error ? error.message : "No se pudo leer la llave de WNBF", updated_at: new Date().toISOString() }).in("id", ids);
    return;
  }
  const rows = await service.from("wnbf_webhook_outbox").select("id,payload,attempts,updated_at").in("id", ids).eq("status", "pending");
  await Promise.all((rows.data ?? []).map((row) => deliverRow(service, row as OutboxRow, webhookKey, singleAttempt)));
}

async function deliverRow(service: SupabaseClient, row: OutboxRow, webhookKey: string, singleAttempt = false) {
  const delays = [5000, 15000, 60000];
  let attempts = row.attempts ?? 0;
  const finalStep = singleAttempt ? 0 : delays.length;
  for (let step = 0; step <= finalStep; step += 1) {
    attempts += 1;
    let status = 0;
    let errorMessage = "";
    try {
      const response = await fetch(WNBF_WEBHOOK_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${webhookKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(15000),
      });
      status = response.status;
      if (response.status === 200) {
        await service.from("wnbf_webhook_outbox").update({ status: "sent", attempts, response_status: 200, last_error: null, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", row.id).eq("updated_at", row.updated_at);
        return;
      }
      errorMessage = `WNBF respondió HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500) {
        await service.from("wnbf_webhook_outbox").update({ status: "failed", attempts, response_status: response.status, last_error: errorMessage, updated_at: new Date().toISOString() }).eq("id", row.id).eq("updated_at", row.updated_at);
        return;
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Sin respuesta de WNBF";
    }
    const delay = delays[step];
    const nextAttemptAt = new Date(Date.now() + (delay ?? 60000)).toISOString();
    const retryUpdatedAt = new Date().toISOString();
    await service.from("wnbf_webhook_outbox").update({ attempts, response_status: status || null, last_error: errorMessage, next_attempt_at: nextAttemptAt, updated_at: retryUpdatedAt }).eq("id", row.id).eq("updated_at", row.updated_at);
    row.updated_at = retryUpdatedAt;
    if (singleAttempt) return;
    if (delay === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scoringRounds(value: unknown): Array<{ key: string; weight: number }> {
  if (!Array.isArray(value)) return [{ key: "overall", weight: 1 }];
  const rounds = value.flatMap((item) => item && typeof item === "object" && typeof item.key === "string" ? [{ key: item.key, weight: Number(item.weight) || 0 }] : []);
  return rounds.length ? rounds : [{ key: "overall", weight: 1 }];
}

function criterionName(roundKey: string, division: string) {
  if (roundKey === "symmetry") return modalityKey(division) === "mens_physique" ? "simetria_tono" : "simetria";
  if (roundKey === "muscle_tone") return "tono_muscular";
  if (roundKey === "condition_muscularity") return "condicion_muscularidad";
  if (roundKey === "muscularity") return "muscularidad";
  if (roundKey === "presentation") return "presentacion";
  return roundKey === "overall" ? "evaluacion_general" : roundKey;
}

