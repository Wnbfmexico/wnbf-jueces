import {
  corsHeaders,
  encodeRegistration,
  getWnbfSecret,
  json,
  matchImportedCategories,
  normalize,
  parseRegistration,
  requireUser,
  WNBF_ATHLETES_URL,
  WNBF_COMPETITION_ID,
} from "../_shared/wnbf.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const authenticated = await requireUser(req);
  if ("error" in authenticated) return authenticated.error;
  const { profile, service, user } = authenticated;

  let input: { competition_id?: string; full?: boolean } = {};
  try { input = await req.json(); } catch { /* cuerpo vacío */ }
  if (!input.competition_id) return json({ error: "competition_id es obligatorio" }, 400);

  const competition = await service.from("competitions").select("id,name").eq("id", input.competition_id).maybeSingle();
  if (competition.error || !competition.data) return json({ error: "Evento no encontrado" }, 404);
  if (!normalize(competition.data.name).includes("theforge")) return json({ error: "Este evento no está conectado con WNBF México" }, 400);
  if (profile.role === "pending") return json({ error: "Tu cuenta todavía no tiene acceso al evento" }, 403);
  if (profile.role === "judge") {
    const assignment = await service.from("judge_assignments").select("id").eq("competition_id", input.competition_id).eq("judge_id", user.id).eq("active", true).maybeSingle();
    if (assignment.error || !assignment.data) return json({ error: "No estás asignado a este evento" }, 403);
  }

  const existingState = await service.from("wnbf_sync_state").select("last_generated_at").eq("competition_id", input.competition_id).maybeSingle();
  const incrementalSince = input.full === true ? null : existingState.data?.last_generated_at ?? null;
  const url = new URL(WNBF_ATHLETES_URL);
  url.searchParams.set("competenciaId", WNBF_COMPETITION_ID);
  if (incrementalSince) url.searchParams.set("actualizados_desde", incrementalSince);

  let readKey: string;
  try {
    readKey = await getWnbfSecret(service, "WNBF_API_KEY_LECTURA");
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "No se pudo leer la llave de WNBF" }, 500);
  }

  let externalResponse: Response;
  try {
    externalResponse = await fetch(url, {
      headers: { Authorization: `Bearer ${readKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    await saveSyncError(service, input.competition_id, error instanceof Error ? error.message : "Sin respuesta de WNBF");
    return json({ error: "WNBF México no respondió a tiempo" }, 502);
  }
  if (!externalResponse.ok) {
    const message = `WNBF respondió HTTP ${externalResponse.status}`;
    await saveSyncError(service, input.competition_id, message);
    return json({ error: message }, 502);
  }

  const payload = await externalResponse.json();
  const incoming = Array.isArray(payload) ? payload : Array.isArray(payload?.atletas) ? payload.atletas : Array.isArray(payload?.data) ? payload.data : [];
  const retiredPayload = Array.isArray(payload?.retirados) ? payload.retirados : [];
  const generatedAt = String(payload?.generado_at ?? new Date().toISOString());
  const retiredExternalIds = new Set<string>();
  retiredPayload.forEach((item: unknown) => {
    const id = typeof item === "string" ? item : item && typeof item === "object" ? String((item as Record<string, unknown>).atleta_id_wnbf ?? "") : "";
    if (id) retiredExternalIds.add(id);
  });
  const activeIncoming = incoming.filter((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const athlete = item as Record<string, unknown>;
    if (athlete.compite !== false) return true;
    const id = String(athlete.atleta_id_wnbf ?? "");
    if (id) retiredExternalIds.add(id);
    return false;
  });

  const [categoryResult, athleteResult] = await Promise.all([
    service.from("categories").select("id,name,division,is_test").eq("competition_id", input.competition_id),
    service.from("athletes").select("id,name,bib,category_id,registered_division,wnbf_athlete_id,active,registration_status,height_cm,weight_kg,measured_by,measures_complete,external_updated_at").eq("competition_id", input.competition_id),
  ]);
  if (categoryResult.error || athleteResult.error) {
    return json({ error: categoryResult.error?.message || athleteResult.error?.message }, 500);
  }

  const categories = categoryResult.data ?? [];
  const localAthletes = athleteResult.data ?? [];
  const byExternalId = new Map<string, typeof localAthletes[number]>();
  const byName = new Map<string, Array<typeof localAthletes[number]>>();
  for (const athlete of localAthletes) {
    const registration = parseRegistration(athlete.registered_division);
    const externalId = athlete.wnbf_athlete_id || registration.external?.athleteId;
    if (externalId) byExternalId.set(externalId, athlete);
    const nameKey = normalize(athlete.name);
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), athlete]);
  }

  let created = 0;
  let updated = 0;
  const changedIds = new Set<string>();
  const seenLocalIds = new Set<string>();
  const errors: string[] = [];
  for (const raw of activeIncoming) {
    if (!raw || typeof raw !== "object") continue;
    const external = raw as Record<string, unknown>;
    const externalId = String(external.atleta_id_wnbf ?? "");
    const name = String(external.nombre ?? external.nombre_completo ?? "").trim();
    if (!externalId || !name) {
      errors.push(`Registro incompleto: ${name || "sin nombre"}`);
      continue;
    }

    const nameMatches = byName.get(normalize(name)) ?? [];
    const unlinkedNameMatches = nameMatches.filter((item) => !parseRegistration(item.registered_division).external?.athleteId);
    const local = byExternalId.get(externalId) ?? (unlinkedNameMatches.length === 1 ? unlinkedNameMatches[0] : undefined);
    const previous = local ? parseRegistration(local.registered_division) : parseRegistration("");
    const matched = matchImportedCategories(external, categories);
    const oldImportedIds = new Set(previous.external?.importedCategoryIds ?? []);
    const oldImportedModalities = new Set(previous.external?.importedModalityKeys ?? []);
    const categoryIds = [
      ...previous.categoryIds.filter((id) => !oldImportedIds.has(id)),
      ...matched.categoryIds,
    ];
    const modalityKeys = [
      ...previous.modalityKeys.filter((key) => !oldImportedModalities.has(key)),
      ...matched.modalityKeys,
    ];
    const subcategories = Object.fromEntries(Object.entries(previous.subcategories).filter(([id]) => !oldImportedIds.has(id)));
    Object.assign(subcategories, matched.subcategories);
    const dorsal = integerOrNull(external.dorsal);
    const directHeight = numberOrNull(external.estatura_cm);
    const heightMetres = numberOrNull(external.estatura_m);
    const heightCm = directHeight ?? (heightMetres === null ? null : Math.round(heightMetres * 100));
    const externalUpdatedAt = validIso(external.actualizado_at) ?? generatedAt;
    const meta = {
      ...previous,
      categoryIds: [...new Set(categoryIds)],
      modalityKeys: [...new Set(modalityKeys)],
      subcategories,
      gender: external.genero === "F" ? "women" as const : external.genero === "M" ? "men" as const : previous.gender,
      external: {
        source: "wnbf_mexico" as const,
        athleteId: externalId,
        dorsalStatus: external.dorsal_estado === "asignado" && dorsal !== null ? "asignado" as const : "pendiente" as const,
        finalCategory: String(external.categoria_final ?? ""),
        registeredCategories: stringArray(external.categorias_inscritas),
        cutDivision: String(external.division_corte ?? ""),
        heightClass: String(external.talla ?? ""),
        heightClassStatus: external.talla_estado === "definida" ? "definida" as const : "pendiente" as const,
        affiliationYear: String(external.anio_afiliacion ?? ""),
        registrationComplete: external.inscripcion_completa === true,
        polygraphApproved: external.poligrafo_aprobado === true,
        importedCategoryIds: matched.categoryIds,
        importedModalityKeys: matched.modalityKeys,
        updatedAt: String(external.actualizado_at ?? generatedAt),
      },
    };
    const row = {
      competition_id: input.competition_id,
      category_id: meta.categoryIds[0] ?? null,
      wnbf_athlete_id: externalId,
      name,
      bib: dorsal,
      height_cm: heightCm,
      weight_kg: numberOrNull(external.peso_kg),
      measured_by: typeof external.medido_por === "string" && external.medido_por.trim() ? external.medido_por.trim() : null,
      measures_complete: external.medidas_completas === true,
      external_updated_at: externalUpdatedAt,
      registered_division: encodeRegistration(meta),
      active: true,
      registration_status: "confirmed",
      updated_at: new Date().toISOString(),
    };
    const saved = local
      ? await service.from("athletes").update(row).eq("id", local.id).select("id").single()
      : await service.from("athletes").insert(row).select("id").single();
    if (saved.error) {
      errors.push(`${name}: ${saved.error.message}`);
      continue;
    }
    const savedAthlete = { ...local, ...row, id: saved.data.id } as typeof localAthletes[number];
    seenLocalIds.add(saved.data.id);
    changedIds.add(saved.data.id);
    byExternalId.set(externalId, savedAthlete);
    byName.set(normalize(name), [savedAthlete]);
    if (local) updated += 1; else created += 1;
  }

  const removedIds = new Set<string>();
  retiredExternalIds.forEach((externalId) => {
    const local = byExternalId.get(externalId);
    if (local) removedIds.add(local.id);
  });
  if (input.full === true) {
    localAthletes.forEach((athlete) => {
      if (!seenLocalIds.has(athlete.id)) removedIds.add(athlete.id);
    });
  }
  if (removedIds.size) {
    const removed = await service.from("athletes").update({
      active: false,
      registration_status: "withdrawn",
      updated_at: new Date().toISOString(),
    }).in("id", [...removedIds]);
    if (removed.error) errors.push(`No se pudieron ocultar atletas retirados: ${removed.error.message}`);
  }

  const stateSaved = await service.from("wnbf_sync_state").upsert({
    competition_id: input.competition_id,
    external_competition_id: WNBF_COMPETITION_ID,
    last_generated_at: generatedAt,
    last_synced_at: new Date().toISOString(),
    last_error: errors.length ? errors.slice(0, 10).join(" | ") : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "competition_id" });
  if (stateSaved.error) return json({ error: stateSaved.error.message }, 500);

  const changed = changedIds.size
    ? await service.from("athletes").select("id,competition_id,category_id,bib,name,active,registered_division,height_cm,weight_kg,registration_status,wnbf_athlete_id,measured_by,measures_complete,external_updated_at").in("id", [...changedIds])
    : { data: [], error: null };
  if (changed.error) errors.push(changed.error.message);
  return json({
    ok: errors.length === 0,
    created,
    updated,
    retired: removedIds.size,
    total: Number(payload?.total ?? activeIncoming.length),
    generated_at: generatedAt,
    athletes: changed.data ?? [],
    removed_ids: [...removedIds],
    errors: errors.slice(0, 10),
  });
});

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value: unknown) {
  const number = numberOrNull(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function validIso(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function saveSyncError(service: SupabaseClient, competitionId: string, message: string) {
  await service.from("wnbf_sync_state").upsert({
    competition_id: competitionId,
    external_competition_id: WNBF_COMPETITION_ID,
    last_error: message,
    updated_at: new Date().toISOString(),
  }, { onConflict: "competition_id" });
}

