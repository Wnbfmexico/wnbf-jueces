import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Session } from "@supabase/supabase-js";
import { Activity, AlertTriangle, Archive, CalendarDays, CheckCircle2, Clock3, Gavel, ListChecks, LogOut, MapPin, MessageSquareText, Plus, RefreshCw, Ruler, Search, ShieldCheck, Trash2, Trophy, Users, Weight } from "lucide-react";
import { isConfigured, supabase } from "./lib/supabase";

type Role = "admin" | "head_judge" | "judge" | "pending";
type Profile = { id: string; email: string; full_name: string | null; role: Role };
type Competition = { id: string; name: string; event_date: string; venue: string; status: "draft" | "live" | "closed"; registration_open: boolean; created_by: string | null };
type JudgeAssignment = { competition_id: string; judge_id: string; panel_position: string };
type ScoringRound = { key: string; name: string; weight: number };
type Category = { id: string; competition_id: string; name: string; division: string; status: string; order_index: number; rounds: ScoringRound[]; tie_break_round: string; is_test: boolean };
type Athlete = { id: string; competition_id: string; category_id: string | null; bib: number | null; name: string; active: boolean; registered_division: string; height_cm: number | null; weight_kg: number | null; registration_status: "confirmed" | "checked_in" | "withdrawn"; wnbf_athlete_id: string | null; measured_by: string | null; measures_complete: boolean; external_updated_at: string | null };
type Ballot = { id: string; category_id: string; judge_id: string; status: "draft" | "submitted"; submitted_at: string | null; updated_at: string; included_in_results: boolean; review_status: "none" | "requested"; review_note: string | null; review_requested_at: string | null };
type Placement = { id: string; ballot_id: string; athlete_id: string; place: number; round_key: string };
type AthleteFeedback = { id: string; category_id: string; athlete_id: string; judge_id: string; strengths: string; improvements: string; notes: string; updated_at: string };
type AthleteFeedbackReport = { id: string; category_id: string; athlete_id: string; author_id: string; strengths: string; improvements: string; updated_at: string };
type Abstention = { id: string; category_id: string; judge_id: string; reason: string };
type AuditEntry = { id: string; ballot_id: string | null; category_id: string; judge_id: string | null; actor_id: string; action: string; reason: string; created_at: string };
type ScoringPreset = { label: string; rounds: ScoringRound[]; tieBreak: string };
type PoseSection = { title: string; poses: string[] };
type AthleteGender = "women" | "men" | "";
type WnbfAthleteMeta = {
  source: "wnbf_mexico";
  athleteId: string;
  dorsalStatus: "pendiente" | "asignado";
  finalCategory: string;
  registeredCategories: string[];
  cutDivision: string;
  heightClass: string;
  heightClassStatus: "pendiente" | "definida";
  affiliationYear: string;
  registrationComplete: boolean;
  polygraphApproved: boolean;
  importedCategoryIds: string[];
  importedModalityKeys: string[];
  updatedAt: string;
};
type AthleteRegistrationMeta = { categoryIds: string[]; modalityKeys: string[]; subcategories: Record<string, string>; absoluteQualifications: Record<string, string[]>; legacyDivision: string; gender: AthleteGender; external: WnbfAthleteMeta | null };
type PanelTab = "control" | "ballot" | "measurements" | "monitoring" | "results" | "feedback" | "admin";
type SavedPanelLocation = { competitionId?: string; categoryId?: string; tab?: PanelTab };
type MeasurementQueueItem = {
  athleteId: string;
  competitionId: string;
  peso_kg?: number | null;
  estatura_cm?: number | null;
  updatedAt: string;
  status: "pending" | "failed";
  error?: string;
};
type MeasurementGroup = "Bikini" | "Figure" | "Men's Physique Novice" | "Men's Physique Open" | "Classic Physique" | "Bodybuilding Novice" | "Bodybuilding Open";

const athleteRegistrationPrefix = "WNBF_REGISTRATION_V1:";
const athleteSelect = "id,competition_id,category_id,bib,name,active,registered_division,height_cm,weight_kg,registration_status,wnbf_athlete_id,measured_by,measures_complete,external_updated_at";
const panelTabs = new Set<PanelTab>(["control", "ballot", "measurements", "monitoring", "results", "feedback", "admin"]);
const measurementGroupOrder: MeasurementGroup[] = ["Bikini", "Figure", "Men's Physique Novice", "Men's Physique Open", "Classic Physique", "Bodybuilding Novice", "Bodybuilding Open"];

function savedPanelLocation(userId: string): SavedPanelLocation {
  try {
    const raw = window.localStorage.getItem(`wnbf-panel-location:${userId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SavedPanelLocation;
    return {
      competitionId: typeof parsed.competitionId === "string" ? parsed.competitionId : undefined,
      categoryId: typeof parsed.categoryId === "string" ? parsed.categoryId : undefined,
      tab: parsed.tab && panelTabs.has(parsed.tab) ? parsed.tab : undefined,
    };
  } catch {
    return {};
  }
}

function savedMeasurementQueue(userId: string): Record<string, MeasurementQueueItem> {
  try {
    const raw = window.localStorage.getItem(`wnbf-measurement-queue:${userId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, MeasurementQueueItem>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function athleteRegistration(athlete: Athlete): AthleteRegistrationMeta {
  let categoryIds: string[] = [];
  let modalityKeys: string[] = [];
  let subcategories: Record<string, string> = {};
  let absoluteQualifications: Record<string, string[]> = {};
  let gender: AthleteGender = "";
  let external: WnbfAthleteMeta | null = null;
  let legacyDivision = athlete.registered_division && athlete.registered_division !== "Por definir" ? athlete.registered_division : "";
  if (athlete.registered_division?.startsWith(athleteRegistrationPrefix)) {
    try {
      const saved = JSON.parse(athlete.registered_division.slice(athleteRegistrationPrefix.length)) as Partial<AthleteRegistrationMeta>;
      categoryIds = Array.isArray(saved.categoryIds) ? saved.categoryIds.filter((id): id is string => typeof id === "string") : [];
      modalityKeys = Array.isArray(saved.modalityKeys) ? saved.modalityKeys.filter((key): key is string => typeof key === "string") : [];
      subcategories = saved.subcategories && typeof saved.subcategories === "object" ? saved.subcategories : {};
      absoluteQualifications = saved.absoluteQualifications && typeof saved.absoluteQualifications === "object"
        ? Object.fromEntries(Object.entries(saved.absoluteQualifications).map(([categoryId, sourceIds]) => [categoryId, Array.isArray(sourceIds) ? sourceIds.filter((id): id is string => typeof id === "string") : []]))
        : {};
      gender = saved.gender === "women" || saved.gender === "men" ? saved.gender : "";
      const savedExternal = saved.external as Partial<WnbfAthleteMeta> | null | undefined;
      external = savedExternal?.source === "wnbf_mexico" && typeof savedExternal.athleteId === "string"
        ? {
            source: "wnbf_mexico",
            athleteId: savedExternal.athleteId,
            dorsalStatus: savedExternal.dorsalStatus === "asignado" ? "asignado" : "pendiente",
            finalCategory: typeof savedExternal.finalCategory === "string" ? savedExternal.finalCategory : "",
            registeredCategories: Array.isArray(savedExternal.registeredCategories) ? savedExternal.registeredCategories.filter((item): item is string => typeof item === "string") : [],
            cutDivision: typeof savedExternal.cutDivision === "string" ? savedExternal.cutDivision : "",
            heightClass: typeof savedExternal.heightClass === "string" ? savedExternal.heightClass : "",
            heightClassStatus: savedExternal.heightClassStatus === "definida" ? "definida" : "pendiente",
            affiliationYear: typeof savedExternal.affiliationYear === "string" ? savedExternal.affiliationYear : "",
            registrationComplete: savedExternal.registrationComplete === true,
            polygraphApproved: savedExternal.polygraphApproved === true,
            importedCategoryIds: Array.isArray(savedExternal.importedCategoryIds) ? savedExternal.importedCategoryIds.filter((item): item is string => typeof item === "string") : [],
            importedModalityKeys: Array.isArray(savedExternal.importedModalityKeys) ? savedExternal.importedModalityKeys.filter((item): item is string => typeof item === "string") : [],
            updatedAt: typeof savedExternal.updatedAt === "string" ? savedExternal.updatedAt : "",
          }
        : null;
      legacyDivision = typeof saved.legacyDivision === "string" ? saved.legacyDivision : "";
    } catch {
      categoryIds = [];
      modalityKeys = [];
      subcategories = {};
      absoluteQualifications = {};
      gender = "";
      external = null;
    }
  }
  if (athlete.category_id && !categoryIds.includes(athlete.category_id)) categoryIds.unshift(athlete.category_id);
  return { categoryIds: [...new Set(categoryIds)], modalityKeys: [...new Set(modalityKeys)], subcategories, absoluteQualifications, legacyDivision, gender, external };
}

function encodeAthleteRegistration(categoryIds: string[], subcategories: Record<string, string>, legacyDivision = "", modalityKeys: string[] = [], absoluteQualifications: Record<string, string[]> = {}, gender: AthleteGender = "", external: WnbfAthleteMeta | null = null) {
  const uniqueCategoryIds = [...new Set(categoryIds)];
  const filteredQualifications = Object.fromEntries(Object.entries(absoluteQualifications)
    .filter(([categoryId]) => uniqueCategoryIds.includes(categoryId))
    .map(([categoryId, sourceIds]) => [categoryId, [...new Set(sourceIds)]]));
  return `${athleteRegistrationPrefix}${JSON.stringify({ categoryIds: uniqueCategoryIds, modalityKeys: [...new Set(modalityKeys)], subcategories, absoluteQualifications: filteredQualifications, legacyDivision, gender, external })}`;
}

function athleteCategoryIds(athlete: Athlete) {
  return athleteRegistration(athlete).categoryIds;
}

function athleteInCategory(athlete: Athlete, categoryId?: string) {
  return Boolean(categoryId && athleteCategoryIds(athlete).includes(categoryId));
}

function athleteSubcategory(athlete: Athlete, categoryId?: string) {
  if (!categoryId) return "";
  return athleteRegistration(athlete).subcategories[categoryId]?.trim() ?? "";
}

function athleteBibText(athlete: Athlete, withHash = true) {
  if (athlete.bib) return `${withHash ? "#" : ""}${athlete.bib}`;
  return athleteRegistration(athlete).external?.dorsalStatus === "pendiente" ? "Pendiente" : "S/N";
}

function isWnbfIntegratedCompetition(competition?: Competition) {
  return Boolean(competition && competition.name.toLocaleUpperCase("es-MX").includes("THE FORGE"));
}

function measurementGroupsForAthlete(athlete: Athlete): MeasurementGroup[] {
  const external = athleteRegistration(athlete).external;
  if (!external) return [];
  const labels = external.registeredCategories.length
    ? external.registeredCategories
    : [external.finalCategory, external.cutDivision].filter(Boolean);
  const groups = new Set<MeasurementGroup>();
  labels.forEach((label) => {
    const normalized = label.toLocaleLowerCase("es-MX").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ");
    if (normalized.includes("bikini")) groups.add("Bikini");
    if (normalized.includes("figure")) groups.add("Figure");
    if (normalized.includes("classic physique")) groups.add("Classic Physique");
    if (normalized.includes("mens physique") || normalized.includes("men s physique")) {
      groups.add(normalized.includes("novice") || normalized.includes("novato") ? "Men's Physique Novice" : "Men's Physique Open");
    }
    if (normalized.includes("bodybuilding") || normalized.includes("culturismo")) {
      groups.add(normalized.includes("novice") || normalized.includes("novato") ? "Bodybuilding Novice" : "Bodybuilding Open");
    }
  });
  return measurementGroupOrder.filter((group) => groups.has(group));
}

async function enqueueWnbfWebhook(action: "papeleta_enviada" | "resultado_confirmado", targetId: string) {
  const body = action === "papeleta_enviada" ? { action, ballot_id: targetId } : { action, category_id: targetId };
  const result = await supabase.functions.invoke("wnbf-webhooks", { body });
  return result.error?.message || "";
}

const scoringPresets: Record<string, ScoringPreset> = {
  figure: { label: "Figure", rounds: [{ key: "symmetry", name: "Simetría", weight: 0.5 }, { key: "muscle_tone", name: "Tono muscular", weight: 0.5 }], tieBreak: "symmetry" },
  bikini: { label: "Bikini", rounds: [{ key: "symmetry", name: "Simetría", weight: 0.5 }, { key: "presentation", name: "Presentación", weight: 0.5 }], tieBreak: "symmetry" },
  bodybuilding: { label: "Bodybuilding", rounds: [{ key: "symmetry", name: "Simetría", weight: 0.5 }, { key: "condition_muscularity", name: "Condición / Muscularidad", weight: 0.5 }], tieBreak: "symmetry" },
  classic_physique: { label: "Classic Physique", rounds: [{ key: "symmetry", name: "Simetría", weight: 0.5 }, { key: "muscularity", name: "Muscularidad", weight: 0.25 }, { key: "presentation", name: "Presentación", weight: 0.25 }], tieBreak: "symmetry" },
  mens_physique: { label: "Men's Physique", rounds: [{ key: "symmetry", name: "Simetría / Tono muscular", weight: 0.5 }, { key: "presentation", name: "Presentación", weight: 0.5 }], tieBreak: "symmetry" },
};

const symmetryPoses = [
  "Semirrelajado de frente",
  "Perfil izquierdo",
  "Semirrelajado de espaldas",
  "Perfil derecho",
];

const poseGuides: Record<string, PoseSection[]> = {
  figure: [{ title: "Comparaciones reglamentarias", poses: symmetryPoses }],
  bikini: [{ title: "Comparaciones reglamentarias", poses: symmetryPoses }],
  mens_physique: [{ title: "Comparaciones reglamentarias", poses: symmetryPoses }],
  classic_physique: [
    { title: "Simetría", poses: symmetryPoses },
    {
      title: "Muscularidad / Presentación",
      poses: [
        "Doble bíceps de frente",
        "Perfil caja torácica clásico",
        "Perfil tríceps clásico",
        "Doble bíceps de espaldas",
        "Abdominales y piernas",
        "2 poses clásicas",
      ],
    },
  ],
  bodybuilding: [
    { title: "Simetría", poses: symmetryPoses },
    {
      title: "Muscularidad / Condición",
      poses: [
        "Doble bíceps de frente",
        "Expansión dorsal de frente",
        "Perfil caja torácica",
        "Perfil tríceps",
        "Doble bíceps de espaldas",
        "Expansión dorsal de espaldas",
        "Abdominales y piernas",
        "Más musculado con manos en las caderas",
        "Crab most muscular",
      ],
    },
  ],
};

function categoryPresetKey(category: Category): keyof typeof scoringPresets | undefined {
  const value = `${category.division} ${category.name}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (value.includes("classic")) return "classic_physique";
  if (value.includes("men's physique") || value.includes("mens physique") || value.includes("men’s physique")) return "mens_physique";
  if (value.includes("bodybuilding") || value.includes("culturismo")) return "bodybuilding";
  if (value.includes("figure")) return "figure";
  if (value.includes("bikini")) return "bikini";
  return undefined;
}

function athleteModalityKeys(athlete: Athlete, categories: Category[]) {
  const registration = athleteRegistration(athlete);
  const keysFromClasses = registration.categoryIds
    .map((categoryId) => categories.find((category) => category.id === categoryId))
    .map((category) => category ? categoryPresetKey(category) : undefined)
    .filter((key): key is string => Boolean(key));
  return [...new Set([...registration.modalityKeys, ...keysFromClasses])].filter((key) => Boolean(scoringPresets[key]));
}

function athleteInModality(athlete: Athlete, modalityKey: string, categories: Category[]) {
  return athleteModalityKeys(athlete, categories).includes(modalityKey);
}

type AthleteGenderGroup = "women" | "men" | "pending";

function athleteGenderGroup(athlete: Athlete, categories: Category[]): AthleteGenderGroup {
  const savedGender = athleteRegistration(athlete).gender;
  if (savedGender) return savedGender;
  const modalityKeys = athleteModalityKeys(athlete, categories);
  const hasWomenModality = modalityKeys.some((key) => key === "bikini" || key === "figure");
  const hasMenModality = modalityKeys.some((key) => key === "bodybuilding" || key === "classic_physique" || key === "mens_physique");
  if (hasWomenModality && !hasMenModality) return "women";
  if (hasMenModality && !hasWomenModality) return "men";
  return "pending";
}

function presetForCategory(category: Category): ScoringPreset | undefined {
  const key = categoryPresetKey(category);
  return key ? scoringPresets[key] : undefined;
}

function poseGuideForCategory(category: Category): PoseSection[] {
  const key = categoryPresetKey(category);
  return key ? poseGuides[key] ?? [] : [];
}

function applyScoringPreset(category: Category): Category {
  const correctedCategory = {
    ...category,
    name: category.name.replace(/ligh\s*weight/gi, "LIGHTWEIGHT"),
  };
  const preset = presetForCategory(correctedCategory);
  return preset ? { ...correctedCategory, rounds: preset.rounds, tie_break_round: preset.tieBreak } : correctedCategory;
}

const eventCategoryItinerary = [
  "Bodybuilding Novice",
  "Men's Physique Novice",
  "Bikini Short",
  "Bikini Tall",
  "Figure Open",
  "Men's Physique Short",
  "Men's Physique Medium",
  "Men's Physique Tall",
  "Classic Physique Short",
  "Classic Physique Medium",
  "Classic Physique Medium-Tall",
  "Classic Physique Tall",
  "Bodybuilding Lightweight",
  "Bodybuilding Middleweight",
  "Bodybuilding Heavyweight",
  "Bikini Absoluto",
  "Men's Physique Absoluto",
  "Classic Physique Absoluto",
  "Bodybuilding Absoluto",
] as const;

const absoluteCategorySpecs = [
  { name: "Bikini Absoluto", modalityKey: "bikini", sources: ["Bikini Short", "Bikini Tall"] },
  { name: "Men's Physique Absoluto", modalityKey: "mens_physique", sources: ["Men's Physique Short", "Men's Physique Medium", "Men's Physique Tall"] },
  { name: "Classic Physique Absoluto", modalityKey: "classic_physique", sources: ["Classic Physique Short", "Classic Physique Medium", "Classic Physique Medium-Tall", "Classic Physique Tall"] },
  { name: "Bodybuilding Absoluto", modalityKey: "bodybuilding", sources: ["Bodybuilding Lightweight", "Bodybuilding Middleweight", "Bodybuilding Heavyweight"] },
] as const;

function normalizedCategoryName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function categoryItineraryPosition(category: Category) {
  const value = normalizedCategoryName(`${category.division} ${category.name}`);
  const modality = value.includes("classic")
    ? "Classic Physique"
    : value.includes("mensphysique")
      ? "Men's Physique"
      : value.includes("bodybuilding") || value.includes("culturismo")
        ? "Bodybuilding"
        : value.includes("figure")
          ? "Figure"
          : value.includes("bikini")
            ? "Bikini"
            : "";
  const className = value.includes("absoluto") || value.includes("absolute")
    ? "Absoluto"
    : value.includes("lightweight") || value.includes("lighweight") || value.includes("pesoligero")
    ? "Lightweight"
    : value.includes("middleweight") || value.includes("pesomedio")
      ? "Middleweight"
      : value.includes("heavyweight") || value.includes("pesopesado")
        ? "Heavyweight"
        : value.includes("novice") || value.includes("novato")
          ? "Novice"
          : value.includes("mediumtall") || value.includes("mediumheighttall") || value.includes("medianalta")
            ? "Medium-Tall"
          : value.includes("medium") || value.includes("mediana")
            ? "Medium"
            : value.includes("short") || value.includes("baja")
              ? "Short"
              : value.includes("tall") || value.includes("alta")
                ? "Tall"
                : value.includes("open") || value.includes("abierta")
                  ? "Open"
                  : "";
  const itineraryKey = normalizedCategoryName(`${modality} ${className}`);
  return eventCategoryItinerary.findIndex((scheduledName) => normalizedCategoryName(scheduledName) === itineraryKey);
}

function absoluteSpecForSource(category: Category) {
  const position = categoryItineraryPosition(category);
  if (position === -1) return undefined;
  const scheduledName = eventCategoryItinerary[position];
  return absoluteCategorySpecs.find((spec) => spec.sources.some((source) => source === scheduledName));
}

function absoluteSpecForCategory(category: Category) {
  const position = categoryItineraryPosition(category);
  if (position === -1) return undefined;
  const scheduledName = eventCategoryItinerary[position];
  return absoluteCategorySpecs.find((spec) => spec.name === scheduledName);
}

function isAbsoluteCategory(category: Category) {
  return Boolean(absoluteSpecForCategory(category));
}

function categoriesInEventOrder(categories: Category[]) {
  return [...categories].sort((a, b) => {
    const aPosition = categoryItineraryPosition(a);
    const bPosition = categoryItineraryPosition(b);
    if (aPosition !== -1 || bPosition !== -1) {
      if (aPosition === -1) return 1;
      if (bPosition === -1) return -1;
      if (aPosition !== bPosition) return aPosition - bPosition;
    }
    return (a.order_index ?? 0) - (b.order_index ?? 0) || a.name.localeCompare(b.name, "es");
  });
}

const roleNames: Record<Role, string> = {
  admin: "Administrador",
  head_judge: "Juez principal",
  judge: "Juez",
  pending: "Acceso pendiente",
};

function formatCategoryDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function categoryTiming(category: Category, auditLog: AuditEntry[], now: number) {
  const events = auditLog
    .filter((entry) => entry.category_id === category.id && (entry.action === "category_reopened" || entry.action === "category_closed"))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let openedAt: number | null = null;
  let firstOpenedAt: number | null = null;
  let finishedAt: number | null = null;
  let durationMs = 0;
  events.forEach((entry) => {
    const timestamp = new Date(entry.created_at).getTime();
    if (!Number.isFinite(timestamp)) return;
    if (entry.action === "category_reopened") {
      if (openedAt === null) openedAt = timestamp;
      if (firstOpenedAt === null) firstOpenedAt = timestamp;
      return;
    }
    if (openedAt !== null) {
      durationMs += Math.max(0, timestamp - openedAt);
      openedAt = null;
    }
    finishedAt = timestamp;
  });
  if (openedAt !== null) durationMs += Math.max(0, now - openedAt);
  if (firstOpenedAt === null) return null;
  return { durationMs, firstOpenedAt, finishedAt, running: openedAt !== null && category.status === "judging" };
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const search = new URLSearchParams(window.location.search);
    return hash.get("type") === "recovery" || search.get("type") === "recovery";
  });

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
      setSession(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!isConfigured) return <SetupNotice />;
  if (checking) return <Loading />;
  if (passwordRecovery) return <ResetPassword onComplete={() => {
    window.history.replaceState({}, "", `${window.location.origin}${import.meta.env.BASE_URL}`);
    setPasswordRecovery(false);
  }} />;
  if (!session) return <Access />;
  return <Panel session={session} />;
}

function SetupNotice() {
  return <div className="center-page"><div className="notice-card"><div className="brand large">W</div><h1>Panel de Jueces WNBF México</h1><p>La aplicación está construida. Falta conectar las dos variables públicas de tu proyecto Supabase.</p><span className="pill warning">Configuración pendiente</span></div></div>;
}

function Loading() {
  return <div className="center-page"><div className="spinner" /><p>Verificando acceso…</p></div>;
}

function Access() {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback("");
    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      });
      setBusy(false);
      if (error) return setFeedback(error.message);
      setFeedback("Si el correo está registrado, recibirás un enlace para crear una contraseña nueva. Revisa también la carpeta de spam.");
      return;
    }
    const result = mode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
    setBusy(false);
    if (result.error) return setFeedback(result.error.message);
    if (mode === "register" && !result.data.session) setFeedback("Registro creado. Revisa tu correo para confirmar la cuenta.");
  }

  const title = mode === "login" ? "Iniciar sesión" : mode === "register" ? "Crear cuenta" : "Recuperar contraseña";
  return <div className="access-page"><section className="access-brand"><img className="access-logo" src={`${import.meta.env.BASE_URL}brand/wnbf-mexico-logo-dark.png`} alt="WNBF México" /><p className="eyebrow">PANEL OFICIAL DE JUECES</p><h1>Decisiones precisas.<br />Resultados protegidos.</h1><p>Acceso exclusivo para el panel oficial de jueces.</p></section><section className="access-form"><div className="form-card"><div><p className="eyebrow red">PANEL PRIVADO</p><h2>{title}</h2><p className="muted">{mode === "forgot" ? "Escribe el correo de tu cuenta y te enviaremos un enlace seguro." : "Utiliza el correo autorizado para el evento."}</p></div><form onSubmit={submit}>{mode === "register" && <label>Nombre completo<input value={name} onChange={(e) => setName(e.target.value)} required /></label>}<label>Correo electrónico<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>{mode !== "forgot" && <label>Contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>}{feedback && <p className="feedback">{feedback}</p>}<button className="primary" disabled={busy}>{busy ? "Procesando…" : mode === "login" ? "Entrar al panel" : mode === "register" ? "Registrar cuenta" : "Enviar enlace de recuperación"}</button></form>{mode === "login" && <button className="text-button" onClick={() => { setMode("forgot"); setFeedback(""); }}>¿Olvidaste tu contraseña?</button>}<button className="text-button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setFeedback(""); }}>{mode === "login" ? "¿Primera vez? Crear cuenta" : "Volver a iniciar sesión"}</button></div></section></div>;
}

function ResetPassword({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFeedback("");
    if (password !== confirmation) return setFeedback("Las contraseñas no coinciden.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setFeedback(error.message);
    onComplete();
  }

  return <div className="access-page"><section className="access-brand"><img className="access-logo" src={`${import.meta.env.BASE_URL}brand/wnbf-mexico-logo-dark.png`} alt="WNBF México" /><p className="eyebrow">PANEL OFICIAL DE JUECES</p><h1>Protege tu acceso.<br />Crea una contraseña nueva.</h1><p>El enlace de recuperación fue validado de forma segura.</p></section><section className="access-form"><div className="form-card"><div><p className="eyebrow red">RECUPERACIÓN DE ACCESO</p><h2>Nueva contraseña</h2><p className="muted">Debe tener por lo menos 8 caracteres.</p></div><form onSubmit={submit}><label>Nueva contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" required /></label><label>Confirmar contraseña<input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} minLength={8} autoComplete="new-password" required /></label>{feedback && <p className="feedback">{feedback}</p>}<button className="primary" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button></form></div></section></div>;
}

function Panel({ session }: { session: Session }) {
  const initialLocation = useMemo(() => savedPanelLocation(session.user.id), [session.user.id]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [ballots, setBallots] = useState<Ballot[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [feedback, setFeedback] = useState<AthleteFeedback[]>([]);
  const [feedbackReports, setFeedbackReports] = useState<AthleteFeedbackReport[]>([]);
  const [abstentions, setAbstentions] = useState<Abstention[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [judgeAssignments, setJudgeAssignments] = useState<JudgeAssignment[]>([]);
  const [competitionId, setCompetitionId] = useState(initialLocation.competitionId ?? "");
  const [seasonYear, setSeasonYear] = useState("");
  const [categoryId, setCategoryId] = useState(initialLocation.categoryId ?? "");
  const [rankings, setRankings] = useState<Record<string, string[]>>({});
  const [tab, setTab] = useState<PanelTab>(initialLocation.tab ?? "ballot");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [syncingWnbf, setSyncingWnbf] = useState(false);
  const [lastWnbfSync, setLastWnbfSync] = useState<string | null>(null);
  const [measurementQueue, setMeasurementQueue] = useState<Record<string, MeasurementQueueItem>>(() => savedMeasurementQueue(session.user.id));
  const autoSaveTimer = useRef<number | null>(null);
  const syncInFlight = useRef(false);
  const measurementQueueRef = useRef(measurementQueue);
  const measurementSending = useRef(new Set<string>());

  const load = useCallback(async () => {
    setBusy(true);
    const [profileResult, competitionResult, categoryResult, athleteResult, ballotResult, placementResult, feedbackResult, feedbackReportResult, abstentionResult, auditResult, assignmentResult] = await Promise.all([
      supabase.from("profiles").select("id,email,full_name,role").eq("id", session.user.id).single(),
      supabase.from("competitions").select("id,name,event_date,venue,status,registration_open,created_by").order("event_date"),
      supabase.from("categories").select("id,competition_id,name,division,status,order_index,rounds,tie_break_round,is_test").order("order_index"),
      supabase.from("athletes").select(athleteSelect).order("name"),
      supabase.from("ballots").select("id,category_id,judge_id,status,submitted_at,updated_at,included_in_results,review_status,review_note,review_requested_at"),
      supabase.from("placements").select("id,ballot_id,athlete_id,place,round_key"),
      supabase.from("athlete_feedback").select("id,category_id,athlete_id,judge_id,strengths,improvements,notes,updated_at"),
      supabase.from("athlete_feedback_reports").select("id,category_id,athlete_id,author_id,strengths,improvements,updated_at"),
      supabase.from("judge_abstentions").select("id,category_id,judge_id,reason"),
      supabase.from("ballot_audit_log").select("id,ballot_id,category_id,judge_id,actor_id,action,reason,created_at").order("created_at", { ascending: false }).limit(500),
      supabase.from("judge_assignments").select("competition_id,judge_id,panel_position"),
    ]);
    if (profileResult.error) setMessage(profileResult.error.message);
    const nextProfile = profileResult.data as Profile | null;
    setProfile(nextProfile);
    setCompetitions((competitionResult.data ?? []) as Competition[]);
    setCategories(((categoryResult.data ?? []) as Category[]).map(applyScoringPreset));
    setAthletes((athleteResult.data ?? []) as Athlete[]);
    setBallots((ballotResult.data ?? []) as Ballot[]);
    setPlacements((placementResult.data ?? []) as Placement[]);
    setFeedback((feedbackResult.data ?? []) as AthleteFeedback[]);
    setFeedbackReports((feedbackReportResult.data ?? []) as AthleteFeedbackReport[]);
    setAbstentions((abstentionResult.data ?? []) as Abstention[]);
    setAuditLog((auditResult.data ?? []) as AuditEntry[]);
    setJudgeAssignments((assignmentResult.data ?? []) as JudgeAssignment[]);
    if (nextProfile?.role === "admin" || nextProfile?.role === "head_judge") {
      const allProfiles = await supabase.from("profiles").select("id,email,full_name,role").order("created_at");
      setProfiles((allProfiles.data ?? []) as Profile[]);
    }
    setBusy(false);
  }, [session.user.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current); }, []);
  useEffect(() => {
    measurementQueueRef.current = measurementQueue;
    try {
      window.localStorage.setItem(`wnbf-measurement-queue:${session.user.id}`, JSON.stringify(measurementQueue));
    } catch {
      // La cola sigue viva en memoria aunque el navegador bloquee localStorage.
    }
  }, [measurementQueue, session.user.id]);
  useEffect(() => {
    if (!competitionId) return;
    try {
      window.localStorage.setItem(`wnbf-panel-location:${session.user.id}`, JSON.stringify({ competitionId, categoryId, tab } satisfies SavedPanelLocation));
    } catch {
      // La navegación sigue funcionando aunque el navegador bloquee el almacenamiento local.
    }
  }, [categoryId, competitionId, session.user.id, tab]);
  useEffect(() => {
    if (profile?.role === "judge" && tab !== "ballot" && tab !== "measurements") setTab("ballot");
  }, [profile?.role, tab]);
  useEffect(() => {
    if (profile?.role !== "judge") return;
    const timer = window.setInterval(async () => {
      const [ballotResult, categoryResult, auditResult] = await Promise.all([
        supabase.from("ballots").select("id,category_id,judge_id,status,submitted_at,updated_at,included_in_results,review_status,review_note,review_requested_at"),
        supabase.from("categories").select("id,competition_id,name,division,status,order_index,rounds,tie_break_round,is_test").order("order_index"),
        supabase.from("ballot_audit_log").select("id,ballot_id,category_id,judge_id,actor_id,action,reason,created_at").order("created_at", { ascending: false }).limit(500),
      ]);
      if (!ballotResult.error) setBallots((ballotResult.data ?? []) as Ballot[]);
      if (!categoryResult.error) setCategories(((categoryResult.data ?? []) as Category[]).map(applyScoringPreset));
      if (!auditResult.error) setAuditLog((auditResult.data ?? []) as AuditEntry[]);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [profile?.role]);
  const accessibleCompetitions = useMemo(() => profile?.role === "judge"
    ? competitions.filter((competition) => judgeAssignments.some((assignment) => assignment.competition_id === competition.id && assignment.judge_id === session.user.id))
    : competitions, [competitions, judgeAssignments, profile?.role, session.user.id]);
  const seasonYears = useMemo(() => [...new Set(accessibleCompetitions.map((competition) => competition.event_date.slice(0, 4)))].sort((a, b) => b.localeCompare(a)), [accessibleCompetitions]);
  const competitionsForSeason = accessibleCompetitions.filter((competition) => competition.event_date.startsWith(seasonYear));

  useEffect(() => {
    if (!accessibleCompetitions.length) return;
    const selected = accessibleCompetitions.find((competition) => competition.id === competitionId);
    if (selected) {
      const year = selected.event_date.slice(0, 4);
      if (seasonYear !== year) setSeasonYear(year);
      return;
    }
    const preferred = accessibleCompetitions.find((competition) => competition.status === "live")
      ?? [...accessibleCompetitions].sort((a, b) => b.event_date.localeCompare(a.event_date))[0];
    setCompetitionId(preferred.id);
    setSeasonYear(preferred.event_date.slice(0, 4));
  }, [accessibleCompetitions, competitionId, seasonYear]);

  const currentCompetition = competitions.find((item) => item.id === competitionId);
  const visibleCategories = categories.filter((item) => item.competition_id === competitionId);
  const currentCategory = visibleCategories.find((item) => item.id === categoryId) ?? visibleCategories[0];
  const currentAthletes = athletes.filter((item) => athleteInCategory(item, currentCategory?.id) && item.active);
  const ownBallot = ballots.find((item) => item.category_id === currentCategory?.id && item.judge_id === session.user.id);
  const ownAbstention = abstentions.find((item) => item.category_id === currentCategory?.id && item.judge_id === session.user.id);

  const syncWnbfAthletes = useCallback(async (full: boolean, announce: boolean) => {
    if (!currentCompetition || !isWnbfIntegratedCompetition(currentCompetition) || syncInFlight.current) return;
    syncInFlight.current = true;
    if (announce) setSyncingWnbf(true);
    const result = await supabase.functions.invoke("sync-wnbf-athletes", { body: { competition_id: currentCompetition.id, full } });
    syncInFlight.current = false;
    if (announce) setSyncingWnbf(false);
    if (result.error) {
      if (announce) setMessage(`No se pudieron sincronizar los atletas: ${result.error.message}`);
      return;
    }
    const summary = (result.data ?? {}) as {
      created?: number;
      updated?: number;
      retired?: number;
      total?: number;
      generated_at?: string;
      athletes?: Athlete[];
      removed_ids?: string[];
    };
    const removed = new Set(summary.removed_ids ?? []);
    const pendingIds = new Set(Object.keys(measurementQueueRef.current));
    setAthletes((current) => {
      const next = current.filter((athlete) => !removed.has(athlete.id));
      const positions = new Map(next.map((athlete, index) => [athlete.id, index]));
      (summary.athletes ?? []).forEach((incoming) => {
        const index = positions.get(incoming.id);
        if (index === undefined) {
          positions.set(incoming.id, next.length);
          next.push(incoming);
          return;
        }
        const previous = next[index];
        next[index] = pendingIds.has(incoming.id)
          ? { ...incoming, height_cm: previous.height_cm, weight_kg: previous.weight_kg, measured_by: previous.measured_by, measures_complete: previous.measures_complete }
          : incoming;
      });
      return next;
    });
    if (removed.size) {
      setMeasurementQueue((current) => Object.fromEntries(Object.entries(current).filter(([athleteId]) => !removed.has(athleteId))));
    }
    setLastWnbfSync(summary.generated_at || new Date().toISOString());
    if (announce) setMessage(`Sincronización terminada: ${summary.total ?? 0} atletas activos, ${summary.created ?? 0} nuevos, ${summary.updated ?? 0} actualizados y ${summary.retired ?? 0} retirados ocultos.`);
  }, [currentCompetition?.id, currentCompetition?.name]);

  useEffect(() => {
    if (!profile || !isWnbfIntegratedCompetition(currentCompetition)) {
      setLastWnbfSync(null);
      return;
    }
    void syncWnbfAthletes(true, false);
    const timer = window.setInterval(() => void syncWnbfAthletes(false, false), 5000);
    return () => window.clearInterval(timer);
  }, [currentCompetition?.id, profile?.id, syncWnbfAthletes]);

  const deliverMeasurement = useCallback(async (item: MeasurementQueueItem) => {
    if (measurementSending.current.has(item.athleteId) || item.status !== "pending") return;
    measurementSending.current.add(item.athleteId);
    const body: Record<string, unknown> = { action: "medidas_registradas", athlete_id: item.athleteId };
    if (Object.prototype.hasOwnProperty.call(item, "peso_kg")) body.peso_kg = item.peso_kg;
    if (Object.prototype.hasOwnProperty.call(item, "estatura_cm")) body.estatura_cm = item.estatura_cm;
    const result = await supabase.functions.invoke("wnbf-webhooks", { body });
    measurementSending.current.delete(item.athleteId);
    if (result.error) {
      setMeasurementQueue((current) => {
        const saved = current[item.athleteId];
        if (!saved || saved.updatedAt !== item.updatedAt) return current;
        return { ...current, [item.athleteId]: { ...saved, error: result.error?.message || "Sin conexión con el servidor" } };
      });
      return;
    }
    const data = (result.data ?? {}) as { delivery_status?: "pending" | "sent" | "failed"; error?: string | null; athlete?: Athlete };
    if (data.athlete) {
      setAthletes((current) => current.map((athlete) => athlete.id === data.athlete?.id ? data.athlete : athlete));
    }
    setMeasurementQueue((current) => {
      const saved = current[item.athleteId];
      if (!saved || saved.updatedAt !== item.updatedAt) return current;
      if (data.delivery_status === "sent") {
        const { [item.athleteId]: _sent, ...remaining } = current;
        return remaining;
      }
      return {
        ...current,
        [item.athleteId]: {
          ...saved,
          status: data.delivery_status === "failed" ? "failed" : "pending",
          error: data.error || (data.delivery_status === "failed" ? "WNBF rechazó la medida" : "Pendiente de enviar"),
        },
      };
    });
  }, []);

  useEffect(() => {
    const flush = () => Object.values(measurementQueueRef.current).filter((item) => item.status === "pending").forEach((item) => void deliverMeasurement(item));
    flush();
    const timer = window.setInterval(flush, 5000);
    return () => window.clearInterval(timer);
  }, [deliverMeasurement]);

  function queueMeasurement(athleteId: string, values: { peso_kg?: number | null; estatura_cm?: number | null }) {
    const athlete = athletes.find((item) => item.id === athleteId);
    if (!athlete || !profile) return;
    const previous = measurementQueueRef.current[athleteId];
    const item: MeasurementQueueItem = {
      ...previous,
      athleteId,
      competitionId: athlete.competition_id,
      ...values,
      updatedAt: new Date().toISOString(),
      status: "pending",
      error: undefined,
    };
    setMeasurementQueue((current) => ({ ...current, [athleteId]: item }));
    setAthletes((current) => current.map((row) => {
      if (row.id !== athleteId) return row;
      const weight = Object.prototype.hasOwnProperty.call(values, "peso_kg") ? values.peso_kg ?? null : row.weight_kg;
      const height = Object.prototype.hasOwnProperty.call(values, "estatura_cm") ? values.estatura_cm ?? null : row.height_cm;
      return { ...row, weight_kg: weight, height_cm: height, measured_by: profile.full_name || profile.email, measures_complete: weight !== null && height !== null };
    }));
    void deliverMeasurement(item);
  }

  useEffect(() => {
    if (!currentCategory) return;
    setCategoryId(currentCategory.id);
    const next: Record<string, string[]> = {};
    currentCategory.rounds.forEach((round) => {
      const saved = ownBallot ? placements.filter((item) => item.ballot_id === ownBallot.id && item.round_key === round.key) : [];
      const slots = Array<string>(currentAthletes.length).fill("");
      saved.forEach((item) => { if (item.place >= 1 && item.place <= slots.length) slots[item.place - 1] = item.athlete_id; });
      next[round.key] = slots;
    });
    setRankings(next);
  }, [currentCategory?.id, ownBallot?.id, placements.length, currentAthletes.length]);

  const submitted = ballots.filter((item) => item.category_id === currentCategory?.id && item.status === "submitted" && item.included_in_results !== false && !abstentions.some((entry) => entry.category_id === item.category_id && entry.judge_id === item.judge_id));
  const results = useMemo(() => currentAthletes.map((athlete) => {
    const roundTotals = (currentCategory?.rounds ?? []).map((round) => ({ key: round.key, name: round.name, total: submitted.reduce((sum, ballot) => sum + (placements.find((item) => item.ballot_id === ballot.id && item.athlete_id === athlete.id && item.round_key === round.key)?.place ?? 0) * round.weight, 0) }));
    const total = roundTotals.reduce((sum, round) => sum + round.total, 0);
    const tieValue = roundTotals.find((round) => round.key === currentCategory?.tie_break_round)?.total ?? total;
    return { athlete, total, tieValue, judges: submitted.length, roundTotals };
  }).sort((a, b) => a.total - b.total || a.tieValue - b.tieValue || (a.athlete.bib ?? 9999) - (b.athlete.bib ?? 9999)), [currentAthletes, submitted, placements, currentCategory]);

  async function persistScoreDraft(snapshot: Record<string, string[]>) {
    if (!currentCategory || ownBallot?.status === "submitted" || currentCategory.status !== "judging") return;
    const ballotResult = await supabase.from("ballots").upsert({ category_id: currentCategory.id, judge_id: session.user.id, status: "draft" }, { onConflict: "category_id,judge_id" }).select("id").single();
    if (ballotResult.error) return setMessage(`No se pudo autoguardar: ${ballotResult.error.message}`);
    const ballotId = ballotResult.data.id as string;
    const deleted = await supabase.from("placements").delete().eq("ballot_id", ballotId);
    if (deleted.error) return setMessage(`No se pudo autoguardar: ${deleted.error.message}`);
    const rows = currentCategory.rounds.flatMap((round) => (snapshot[round.key] ?? []).map((id, index) => ({ ballot_id: ballotId, athlete_id: id, round_key: round.key, place: index + 1 })).filter((item) => item.athlete_id));
    if (rows.length) {
      const inserted = await supabase.from("placements").insert(rows);
      if (inserted.error) setMessage(`No se pudo autoguardar: ${inserted.error.message}`);
    }
  }

  function scheduleScoreDraft(snapshot: Record<string, string[]>) {
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => void persistScoreDraft(snapshot), 900);
  }

  function setPlace(roundKey: string, athleteId: string, place: number) {
    const current = [...(rankings[roundKey] ?? [])];
    const from = current.indexOf(athleteId);
    if (place === 0) {
      if (from >= 0) current[from] = "";
      const next = { ...rankings, [roundKey]: current };
      setRankings(next);
      scheduleScoreDraft(next);
      return;
    }
    const destination = place - 1;
    if (destination < 0 || destination >= current.length || from === destination || current[destination]) return;
    if (from >= 0) current[from] = "";
    current[destination] = athleteId;
    const next = { ...rankings, [roundKey]: current };
    setRankings(next);
    scheduleScoreDraft(next);
  }

  async function saveBallot(submit: boolean, feedbackDrafts: Record<string, { strengths: string; improvements: string; notes: string }>) {
    if (!currentCategory || ownBallot?.status === "submitted" || currentCategory.status !== "judging") return;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    setBusy(true);
    setMessage("");
    const ballotResult = await supabase.from("ballots").upsert({ category_id: currentCategory.id, judge_id: session.user.id, status: "draft" }, { onConflict: "category_id,judge_id" }).select("id").single();
    if (ballotResult.error) { setMessage(ballotResult.error.message); setBusy(false); return; }
    const ballotId = ballotResult.data.id as string;
    const deleted = await supabase.from("placements").delete().eq("ballot_id", ballotId);
    if (deleted.error) { setMessage(deleted.error.message); setBusy(false); return; }
    const placementRows = currentCategory.rounds.flatMap((round) => (rankings[round.key] ?? []).map((athleteId, index) => ({ ballot_id: ballotId, athlete_id: athleteId, round_key: round.key, place: index + 1 })).filter((item) => item.athlete_id));
    if (placementRows.length) {
      const inserted = await supabase.from("placements").insert(placementRows);
      if (inserted.error) { setMessage(inserted.error.message); setBusy(false); return; }
    }
    const savedFeedbackResult = await supabase
      .from("athlete_feedback")
      .select("athlete_id,strengths,improvements,notes")
      .eq("category_id", currentCategory.id)
      .eq("judge_id", session.user.id);
    if (savedFeedbackResult.error) { setMessage(`No se pudieron recuperar las observaciones anteriores: ${savedFeedbackResult.error.message}`); setBusy(false); return; }
    const savedFeedback = new Map((savedFeedbackResult.data ?? []).map((item) => [item.athlete_id as string, item]));
    const feedbackRows = Object.entries(feedbackDrafts).map(([athleteId, values]) => {
      const previous = savedFeedback.get(athleteId);
      return {
        category_id: currentCategory.id,
        athlete_id: athleteId,
        judge_id: session.user.id,
        strengths: values.strengths.trim() ? values.strengths : previous?.strengths ?? "",
        improvements: values.improvements.trim() ? values.improvements : previous?.improvements ?? "",
        notes: values.notes.trim() ? values.notes : previous?.notes ?? "",
      };
    }).filter((item) => item.strengths.trim() || item.improvements.trim() || item.notes.trim());
    if (feedbackRows.length) {
      const feedbackSaved = await supabase.from("athlete_feedback").upsert(feedbackRows, { onConflict: "category_id,athlete_id,judge_id" });
      if (feedbackSaved.error) { setMessage(feedbackSaved.error.message); setBusy(false); return; }
    }
    if (submit) {
      const submittedResult = await supabase.from("ballots").update({ status: "submitted", submitted_at: new Date().toISOString(), review_status: "none", review_note: null }).eq("id", ballotId);
      if (submittedResult.error) setMessage(submittedResult.error.message);
      else {
        const integrationError = await enqueueWnbfWebhook("papeleta_enviada", ballotId);
        setMessage(integrationError ? `Papeleta enviada y bloqueada. El envío a WNBF quedó pendiente: ${integrationError}` : "Papeleta enviada y puesta en la cola segura de WNBF.");
      }
    } else setMessage("Borrador guardado.");
    await load();
  }

  async function abstain(reason: string) {
    if (!currentCategory || ownAbstention) return;
    const created = await supabase.from("judge_abstentions").insert({ category_id: currentCategory.id, judge_id: session.user.id, reason });
    if (created.error) return setMessage(created.error.message);
    setMessage("Abstención registrada. Tu papeleta no contará en esta categoría.");
    await load();
  }

  if (busy && !profile) return <Loading />;
  if (!profile) return <div className="center-page"><p>No se encontró el perfil. Cierra sesión y vuelve a entrar.</p></div>;
  if (profile.role === "pending") return <div className="center-page"><div className="notice-card"><ShieldCheck size={36} /><h1>Acceso pendiente</h1><p>Tu cuenta está registrada. El administrador debe asignarte como juez antes de entrar al evento.</p><button className="secondary" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div></div>;

  return <div className="app-shell">
    <header className="topbar"><div className="topbar-inner"><div className="brand-row"><img className="topbar-logo" src={`${import.meta.env.BASE_URL}brand/wnbf-mexico-logo-dark.png`} alt="WNBF México" /><div><p className="eyebrow tricolor-text">WNBF MÉXICO</p><h1>Panel oficial de jueces</h1></div></div><div className="account"><div><strong>{profile.full_name || profile.email}</strong><span>{roleNames[profile.role]}</span></div><button className="icon-button" aria-label="Cerrar sesión" onClick={() => supabase.auth.signOut()}><LogOut /></button></div></div>{currentCompetition && <div className="eventbar"><div className="event-identity"><strong>{currentCompetition.name}</strong><span><CalendarDays />{new Date(`${currentCompetition.event_date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })}</span><span><MapPin />{currentCompetition.venue}</span></div><div className="event-switcher no-print"><label>Temporada<select value={seasonYear} onChange={(event) => { const year = event.target.value; setSeasonYear(year); const next = accessibleCompetitions.filter((item) => item.event_date.startsWith(year)).sort((a, b) => b.event_date.localeCompare(a.event_date))[0]; if (next) { setCompetitionId(next.id); setCategoryId(""); } }}>{seasonYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label><label>Evento<select value={competitionId} onChange={(event) => { setCompetitionId(event.target.value); setCategoryId(""); }}>{competitionsForSeason.map((competition) => <option key={competition.id} value={competition.id}>{competition.name}</option>)}</select></label><span className={`pill ${currentCompetition.status}`}>{currentCompetition.status === "live" ? "En vivo" : currentCompetition.status === "closed" ? "Histórico" : "Preparación"}</span></div></div>}</header>
    <main className="workspace">
      <nav className="tabs">{profile.role !== "judge" && <button className={tab === "control" ? "active" : ""} onClick={() => setTab("control")}><ShieldCheck />Centro de control</button>}<button className={tab === "ballot" ? "active" : ""} onClick={() => setTab("ballot")}><Gavel />Papeleta</button><button className={tab === "measurements" ? "active" : ""} onClick={() => setTab("measurements")}><Weight />Medidas / Pesaje</button>{profile.role !== "judge" && <button className={tab === "monitoring" ? "active" : ""} onClick={() => setTab("monitoring")}><Activity />Monitoreo en vivo</button>}{profile.role !== "judge" && <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}><Trophy />Resultados</button>}{profile.role !== "judge" && <button className={tab === "feedback" ? "active" : ""} onClick={() => setTab("feedback")}><MessageSquareText />Feedback</button>}{profile.role !== "judge" && <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}><Users />Administración</button>}</nav>
      {message && <div className="message"><CheckCircle2 />{message}</div>}
      {accessibleCompetitions.length === 0 && tab !== "admin" ? <EmptyAdmin onOpen={() => setTab("admin")} /> : tab === "control" ? <ControlCenter competition={currentCompetition} categories={visibleCategories} athletes={athletes.filter((item) => item.competition_id === currentCompetition?.id)} profiles={profiles.filter((item) => judgeAssignments.some((assignment) => assignment.competition_id === competitionId && assignment.judge_id === item.id))} ballots={ballots.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} placements={placements} abstentions={abstentions.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} reports={feedbackReports.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} auditLog={auditLog.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} openCategory={(id, destination) => { setCategoryId(id); setTab(destination); }} openAdmin={() => setTab("admin")} refresh={load} setMessage={setMessage} /> : tab === "ballot" ? <BallotView category={currentCategory} categories={visibleCategories} categoryId={currentCategory?.id || ""} setCategoryId={setCategoryId} athletes={currentAthletes} rankings={rankings} setPlace={setPlace} locked={ownBallot?.status === "submitted" || currentCategory?.status !== "judging" || currentCompetition?.status === "closed"} ballot={ownBallot} abstention={ownAbstention} existingFeedback={feedback.filter((item) => item.category_id === currentCategory?.id && item.judge_id === session.user.id)} auditLog={auditLog.filter((item) => item.category_id === currentCategory?.id)} showPoseGuide={profile.role === "admin"} busy={busy} save={saveBallot} abstain={abstain} /> : tab === "measurements" ? <MeasurementsView competition={currentCompetition} athletes={athletes.filter((item) => item.competition_id === currentCompetition?.id && item.active && item.registration_status !== "withdrawn")} queue={measurementQueue} lastSync={lastWnbfSync} syncing={syncingWnbf} saveMeasurement={queueMeasurement} syncNow={() => void syncWnbfAthletes(true, true)} /> : tab === "monitoring" ? <MonitoringView competition={currentCompetition} category={currentCategory} categories={visibleCategories} categoryId={currentCategory?.id || ""} setCategoryId={setCategoryId} athletes={currentAthletes} eventAthletes={athletes.filter((item) => item.competition_id === currentCompetition?.id)} ballots={ballots.filter((item) => item.category_id === currentCategory?.id)} eventBallots={ballots.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} placements={placements} abstentions={abstentions.filter((item) => item.category_id === currentCategory?.id)} eventAbstentions={abstentions.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} profiles={profiles.filter((item) => judgeAssignments.some((assignment) => assignment.competition_id === competitionId && assignment.judge_id === item.id))} auditLog={auditLog.filter((item) => item.category_id === currentCategory?.id)} refresh={load} setMessage={setMessage} /> : tab === "results" ? <ResultsView category={currentCategory} categories={visibleCategories} categoryId={currentCategory?.id || ""} setCategoryId={setCategoryId} rows={results} ballots={ballots.filter((item) => item.category_id === currentCategory?.id)} abstentions={abstentions.filter((item) => item.category_id === currentCategory?.id)} profiles={profiles.filter((item) => judgeAssignments.some((assignment) => assignment.competition_id === competitionId && assignment.judge_id === item.id))} /> : tab === "feedback" ? <FeedbackView userId={session.user.id} competition={currentCompetition} categories={visibleCategories} categoryId={currentCategory?.id || ""} setCategoryId={setCategoryId} athletes={athletes.filter((item) => item.competition_id === currentCompetition?.id && item.active)} feedback={feedback.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} reports={feedbackReports.filter((item) => visibleCategories.some((category) => category.id === item.category_id))} profiles={profiles} refresh={load} setMessage={setMessage} /> : <AdminView userId={session.user.id} competition={currentCompetition} competitions={competitions} setCompetitionId={setCompetitionId} profiles={profiles} assignments={judgeAssignments} athletes={athletes.filter((item) => item.competition_id === currentCompetition?.id)} categories={visibleCategories} refresh={load} setMessage={setMessage} syncWnbfAthletes={syncWnbfAthletes} syncingAthletes={syncingWnbf} lastWnbfSync={lastWnbfSync} />}
    </main>
  </div>;
}

function EmptyAdmin({ onOpen }: { onOpen: () => void }) {
  return <section className="empty"><h2>Todavía no hay una competencia</h2><p>Crea el primer evento desde Administración.</p><button className="primary compact" onClick={onOpen}>Crear evento</button></section>;
}

function ControlCenter({ competition, categories, athletes, profiles, ballots, placements, abstentions, reports, auditLog, openCategory, openAdmin, refresh, setMessage }: { competition?: Competition; categories: Category[]; athletes: Athlete[]; profiles: Profile[]; ballots: Ballot[]; placements: Placement[]; abstentions: Abstention[]; reports: AthleteFeedbackReport[]; auditLog: AuditEntry[]; openCategory: (id: string, destination: "ballot" | "monitoring" | "results") => void; openAdmin: () => void; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const [categoryReasons, setCategoryReasons] = useState<Record<string, string>>({});
  const [ballotReasons, setBallotReasons] = useState<Record<string, string>>({});
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!competition || competition.status === "closed") return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [competition?.id, competition?.status, refresh]);
  if (!competition) return <EmptyAdmin onOpen={openAdmin} />;
  const competitionId = competition.id;

  const definitiveCategories = categories.filter((item) => !item.is_test);
  const controlCategories = categoriesInEventOrder(definitiveCategories);
  const testCategoryIds = new Set(categories.filter((category) => category.is_test).map((category) => category.id));
  const activeAthletes = athletes.filter((item) => item.active && item.registration_status !== "withdrawn" && !athleteCategoryIds(item).some((id) => testCategoryIds.has(id)));
  const assignedAthletes = activeAthletes.filter((item) => athleteCategoryIds(item).length > 0);
  const panelIds = new Set(profiles.map((profile) => profile.id));
  const panelBallots = ballots.filter((item) => panelIds.has(item.judge_id));
  const submittedBallots = panelBallots.filter((item) => item.status === "submitted");
  const expectedBallots = definitiveCategories.filter((category) => activeAthletes.some((athlete) => athleteInCategory(athlete, category.id))).length * profiles.length;
  const unnamedProfiles = profiles.filter((item) => !item.full_name?.trim());
  const alerts: { tone: "warning" | "danger"; title: string; detail: string; action?: string }[] = [];

  function readinessFor(category: Category) {
    const participants = activeAthletes.filter((athlete) => athleteInCategory(athlete, category.id));
    const bibs = participants.map((athlete) => athlete.bib).filter((bib): bib is number => Boolean(bib));
    const duplicateBibs = [...new Set(bibs.filter((bib, index) => bibs.indexOf(bib) !== index))];
    const weightTotal = category.rounds.reduce((total, round) => total + Number(round.weight || 0), 0);
    const blockers: string[] = [];
    const notices: string[] = [];
    if (!participants.length) blockers.push("No tiene atletas asignados");
    const missingBibs = participants.filter((athlete) => !athlete.bib).length;
    if (missingBibs) blockers.push(`${missingBibs} atleta${missingBibs === 1 ? "" : "s"} sin dorsal`);
    if (duplicateBibs.length) blockers.push(`Dorsales repetidos: ${duplicateBibs.join(", ")}`);
    if (profiles.length < 2) blockers.push("El panel necesita al menos dos cuentas asignadas");
    if (!category.rounds.length || Math.abs(weightTotal - 1) > 0.001) blockers.push("Los criterios o porcentajes no están completos");
    if (!poseGuideForCategory(category).length) blockers.push("No hay poses reglamentarias configuradas");
    if (competition?.status === "closed") blockers.push("El evento está archivado");
    if (unnamedProfiles.length) notices.push(`${unnamedProfiles.length} integrante${unnamedProfiles.length === 1 ? "" : "s"} del panel sin nombre`);
    return { participants, blockers, notices };
  }

  async function startCategory(category: Category) {
    const readiness = readinessFor(category);
    if (readiness.blockers.length) return setMessage(`No se puede iniciar ${category.name}: ${readiness.blockers.join(" · ")}.`);
    if (!window.confirm(`Se abrirá ${category.name} para todo el panel. Los jueces podrán comenzar a puntuar. ¿Continuar?`)) return;
    const updated = await supabase.rpc("set_category_closed", { target_category: category.id, should_close: false, control_reason: "Apertura inicial desde el Centro de control" });
    if (updated.error) return setMessage(updated.error.message);
    setMessage(`${category.name} está abierta para jueceo.`);
    await refresh();
  }

  function judgeStatus(category: Category, judge: Profile) {
    const ballot = panelBallots.find((item) => item.category_id === category.id && item.judge_id === judge.id);
    const abstention = abstentions.find((item) => item.category_id === category.id && item.judge_id === judge.id);
    if (abstention) return { label: "Abstención", tone: "closed", ballot };
    if (ballot?.included_in_results === false) return { label: "Excluida", tone: "closed", ballot };
    if (ballot?.status === "submitted") return { label: "Enviada", tone: "success", ballot };
    if (ballot?.status === "draft") return { label: "Puntuando", tone: "warning", ballot };
    return { label: "Sin iniciar", tone: "warning", ballot };
  }

  function pendingJudges(category: Category) {
    return profiles.filter((judge) => {
      const status = judgeStatus(category, judge);
      return status.label === "Sin iniciar" || status.label === "Puntuando";
    });
  }

  async function ballotControl(action: "review" | "reopen" | "include", ballot: Ballot, include = true) {
    const reason = ballotReasons[ballot.id]?.trim();
    if (!reason) return setMessage("Escribe el motivo o la indicación técnica antes de intervenir la papeleta.");
    if (action !== "review" && !window.confirm("Esta intervención quedará registrada en la bitácora. ¿Deseas continuar?")) return;
    const result = action === "review"
      ? await supabase.rpc("request_ballot_review", { target_ballot: ballot.id, review_reason: reason })
      : action === "reopen"
        ? await supabase.rpc("reopen_ballot", { target_ballot: ballot.id, reopen_reason: reason })
        : await supabase.rpc("set_ballot_inclusion", { target_ballot: ballot.id, should_include: include, inclusion_reason: reason });
    if (result.error) return setMessage(result.error.message);
    setBallotReasons((current) => ({ ...current, [ballot.id]: "" }));
    setMessage(action === "review" ? "Solicitud de revisión enviada." : action === "reopen" ? "Papeleta reabierta para corrección." : include ? "Papeleta reincorporada al consolidado." : "Papeleta excluida del consolidado.");
    await refresh();
  }

  async function closeCategory(category: Category, goToNext = false, force = false) {
    const pending = pendingJudges(category);
    if (pending.length && !force) return setMessage(`Todavía faltan ${pending.length} juez${pending.length === 1 ? "" : "ces"}: ${pending.map((judge) => judge.full_name || judge.email).join(", ")}.`);
    const typedReason = categoryReasons[category.id]?.trim();
    if (force && !typedReason) return setMessage("Escribe el motivo obligatorio para cerrar con papeletas pendientes.");
    const reason = typedReason || "Cierre normal: todas las papeletas fueron recibidas.";
    const confirmation = pending.length
      ? `Faltan ${pending.length} jueces. La categoría se cerrará de todas formas y sus papeletas quedarán bloqueadas. ¿Continuar?`
      : `Todas las decisiones fueron recibidas. ¿Cerrar ${category.name}?`;
    if (!window.confirm(confirmation)) return;
    const result = await supabase.rpc("set_category_closed", { target_category: category.id, should_close: true, control_reason: reason });
    if (result.error) return setMessage(result.error.message);
    const absoluteSync = await syncAbsoluteQualifier({ competitionId, sourceCategory: category, categories: definitiveCategories, athletes: activeAthletes, ballots: panelBallots, placements, abstentions });
    if (absoluteSync.error) {
      setMessage(`${category.name} quedó cerrada, pero falló la clasificación al absoluto: ${absoluteSync.error}`);
      await refresh();
      return;
    }
    const integrationError = await enqueueWnbfWebhook("resultado_confirmado", category.id);
    setCategoryReasons((current) => ({ ...current, [category.id]: "" }));
    const currentIndex = controlCategories.findIndex((item) => item.id === category.id);
    const nextCategory = controlCategories.slice(currentIndex + 1).find((item) => item.status !== "complete");
    const closingMessage = goToNext && nextCategory ? `${category.name} finalizada. La siguiente categoría es ${nextCategory.name}.` : `${category.name} quedó cerrada y registrada.`;
    setMessage(`${closingMessage}${absoluteSync.message ? ` ${absoluteSync.message}` : ""}${integrationError ? ` El envío a WNBF quedó pendiente: ${integrationError}` : " Resultado puesto en la cola segura de WNBF."}`);
    await refresh();
    if (goToNext && nextCategory) window.setTimeout(() => document.getElementById(`control-category-${nextCategory.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  }

  async function reopenCategory(category: Category) {
    const reason = categoryReasons[category.id]?.trim();
    if (!reason) return setMessage("Escribe el motivo para reabrir la categoría.");
    if (!window.confirm(`Se reabrirá ${category.name} y los jueces podrán volver a trabajar en sus papeletas. ¿Continuar?`)) return;
    const result = await supabase.rpc("set_category_closed", { target_category: category.id, should_close: false, control_reason: reason });
    if (result.error) return setMessage(result.error.message);
    const absoluteSync = await syncAbsoluteQualifier({ competitionId, sourceCategory: category, categories: definitiveCategories, athletes: activeAthletes, ballots: panelBallots, placements, abstentions, removeOnly: true });
    if (absoluteSync.error) {
      setMessage(`${category.name} fue reabierta, pero falló la actualización del absoluto: ${absoluteSync.error}`);
      await refresh();
      return;
    }
    setCategoryReasons((current) => ({ ...current, [category.id]: "" }));
    setMessage(`${category.name} fue reabierta para jueceo.${absoluteSync.message ? ` ${absoluteSync.message}` : ""}`);
    await refresh();
  }

  async function syncAllAbsolutes() {
    const prepared = await ensureAllAbsoluteCategories(competitionId, definitiveCategories);
    if (prepared.error) return setMessage(`No se pudieron preparar los absolutos: ${prepared.error}`);
    const completedSources = controlCategories.filter((category) => category.status === "complete" && absoluteSpecForSource(category));
    const messages: string[] = [];
    for (const sourceCategory of completedSources) {
      const athleteResult = await supabase.from("athletes").select(athleteSelect).eq("competition_id", competitionId);
      if (athleteResult.error) return setMessage(`No se pudieron leer los atletas para sincronizar absolutos: ${athleteResult.error.message}`);
      const absoluteSync = await syncAbsoluteQualifier({ competitionId, sourceCategory, categories: prepared.categories, athletes: (athleteResult.data ?? []) as Athlete[], ballots: panelBallots, placements, abstentions });
      if (absoluteSync.error) return setMessage(`Falló la sincronización de ${sourceCategory.name}: ${absoluteSync.error}`);
      if (absoluteSync.message) messages.push(absoluteSync.message);
    }
    setMessage(completedSources.length
      ? `Absolutos sincronizados correctamente. ${messages.join(" ")}`
      : prepared.createdNames.length
        ? "Las cuatro papeletas absolutas fueron creadas. Los campeones aparecerán automáticamente al cerrar sus categorías de origen."
        : "Los absolutos están preparados. Todavía no hay categorías de origen cerradas para clasificar campeones.");
    await refresh();
  }

  if (!definitiveCategories.length) alerts.push({ tone: "danger", title: "No hay categorías definitivas", detail: "Crea las categorías oficiales antes de comenzar el evento.", action: "Abrir Administración" });
  const pendingCategory = activeAthletes.filter((item) => athleteCategoryIds(item).length === 0).length;
  if (pendingCategory) alerts.push({ tone: "warning", title: `${pendingCategory} atleta${pendingCategory === 1 ? "" : "s"} sin categoría`, detail: "Asígnales su categoría antes de iniciar el jueceo.", action: "Completar atletas" });
  const pendingBib = assignedAthletes.filter((item) => !item.bib).length;
  if (pendingBib) alerts.push({ tone: "warning", title: `${pendingBib} atleta${pendingBib === 1 ? "" : "s"} sin dorsal`, detail: "El dorsal es necesario para identificarlos correctamente en la papeleta.", action: "Completar dorsales" });
  if (profiles.length < 2) alerts.push({ tone: "danger", title: "Panel incompleto", detail: "Solamente hay una cuenta asignada a este evento.", action: "Asignar jueces" });
  if (unnamedProfiles.length) alerts.push({ tone: "warning", title: `${unnamedProfiles.length} integrante${unnamedProfiles.length === 1 ? "" : "s"} sin nombre`, detail: "Completa sus nombres para identificarlos durante el monitoreo.", action: "Completar nombres" });
  definitiveCategories.filter((category) => !activeAthletes.some((athlete) => athleteInCategory(athlete, category.id))).forEach((category) => alerts.push({ tone: "warning", title: `${category.name} no tiene atletas`, detail: "La categoría está creada, pero todavía no tiene participantes asignados." }));

  const categoryTimes = definitiveCategories.map((category) => ({ category, timing: categoryTiming(category, auditLog, clockNow) }));
  const activeCategoryTime = categoryTimes.find((entry) => entry.timing?.running);
  const completedCategoryTimes = categoryTimes
    .filter((entry): entry is { category: Category; timing: NonNullable<ReturnType<typeof categoryTiming>> } => entry.category.status === "complete" && Boolean(entry.timing?.durationMs))
    .sort((a, b) => a.timing.durationMs - b.timing.durationMs);
  const fastestCategory = completedCategoryTimes[0];
  const slowestCategory = completedCategoryTimes.length > 1 ? completedCategoryTimes[completedCategoryTimes.length - 1] : undefined;

  const competitionStatus = competition.status === "live" ? "Evento en vivo" : competition.status === "closed" ? "Evento histórico" : "Evento en preparación";
  return <section className="control-center">
    <div className="panel control-hero">
      <div><p className="eyebrow red">CENTRO DE CONTROL</p><h2>{competition.name}</h2><p>Supervisa la preparación y el avance del campeonato desde una sola pantalla.</p></div>
      <div className="control-hero-status"><span className={`pill ${competition.status}`}>{competitionStatus}</span><button className="primary compact" onClick={syncAllAbsolutes}><Trophy /> Preparar absolutos</button><button className="secondary compact" onClick={openAdmin}>Configurar evento</button></div>
    </div>

    <div className="control-metrics">
      <article className="panel control-metric"><span>Atletas activos</span><strong>{activeAthletes.length}</strong><small>{pendingCategory ? `${pendingCategory} pendientes de categoría` : "Todos asignados"}</small></article>
      <article className="panel control-metric"><span>Categorías oficiales</span><strong>{definitiveCategories.length}</strong><small>{definitiveCategories.filter((item) => item.status === "complete").length} terminadas</small></article>
      <article className="panel control-metric"><span>Panel asignado</span><strong>{profiles.length}</strong><small>{unnamedProfiles.length ? `${unnamedProfiles.length} sin nombre` : "Identificación completa"}</small></article>
      <article className="panel control-metric"><span>Papeletas enviadas</span><strong>{submittedBallots.length}</strong><small>{expectedBallots ? `de ${expectedBallots} esperadas` : "Sin categorías listas"}</small></article>
      <article className="panel control-metric"><span>Feedbacks oficiales</span><strong>{reports.length}</strong><small>Reportes guardados</small></article>
      <article className={`panel control-metric control-time-metric ${activeCategoryTime ? "running" : ""}`}><span><Clock3 /> Tiempo de categoría</span><strong>{activeCategoryTime?.timing ? formatCategoryDuration(activeCategoryTime.timing.durationMs) : fastestCategory ? formatCategoryDuration(fastestCategory.timing.durationMs) : "00:00"}</strong><small>{activeCategoryTime ? `${activeCategoryTime.category.name} · en curso` : fastestCategory ? `Más rápida: ${fastestCategory.category.name}` : "Comenzará al iniciar una categoría"}</small></article>
    </div>

    <div className="control-main-grid">
      <div className="panel control-alerts">
        <div className="panel-title-row"><div><h2>Alertas de preparación</h2><p className="muted">Elementos que conviene resolver antes de iniciar.</p></div><span className={`pill ${alerts.length ? "warning" : "success"}`}>{alerts.length ? `${alerts.length} pendientes` : "Todo listo"}</span></div>
        {alerts.length ? <div className="control-alert-list">{alerts.map((alert, index) => <article className={alert.tone} key={`${alert.title}-${index}`}><AlertTriangle /><span><strong>{alert.title}</strong><small>{alert.detail}</small></span>{alert.action && <button className="text-button" onClick={openAdmin}>{alert.action}</button>}</article>)}</div> : <div className="control-ready"><CheckCircle2 /><div><strong>Configuración básica completa</strong><p>No se detectaron pendientes en atletas, categorías ni jueces.</p></div></div>}
      </div>

      <aside className="panel control-panel-summary"><h2>Panel del evento</h2><p className="muted">Integrantes asignados actualmente.</p><div className="control-judge-list">{profiles.map((judge) => <div key={judge.id}><span><strong>{judge.full_name || "Sin nombre"}</strong><small>{judge.email}</small></span><span className={`pill ${judge.full_name ? "success" : "warning"}`}>{roleNames[judge.role]}</span></div>)}</div>{!profiles.length && <p className="empty-copy">Todavía no hay jueces asignados.</p>}</aside>
    </div>

    <div className="panel control-categories">
      <div className="panel-title-row"><div><h2>Avance por categoría</h2><p className="muted">Ordenado según el itinerario del día. Revisa atletas, papeletas, estado y duración de cada categoría oficial.</p></div>{fastestCategory && <div className="category-time-summary"><span><Clock3 /><small>Más rápida</small><strong>{fastestCategory.category.name} · {formatCategoryDuration(fastestCategory.timing.durationMs)}</strong></span>{slowestCategory && <span><Clock3 /><small>Más larga</small><strong>{slowestCategory.category.name} · {formatCategoryDuration(slowestCategory.timing.durationMs)}</strong></span>}</div>}</div>
      {!controlCategories.length ? <p className="empty-copy">Todavía no hay categorías definitivas.</p> : <div className="control-category-list">{controlCategories.map((category) => {
        const categoryAthletes = activeAthletes.filter((athlete) => athleteInCategory(athlete, category.id));
        const categoryBallots = panelBallots.filter((ballot) => ballot.category_id === category.id);
        const sent = categoryBallots.filter((ballot) => ballot.status === "submitted").length;
        const absent = abstentions.filter((entry) => entry.category_id === category.id).length;
        const readiness = readinessFor(category);
        const pending = pendingJudges(category);
        const timing = categoryTimes.find((entry) => entry.category.id === category.id)?.timing;
        const itineraryPosition = categoryItineraryPosition(category);
        const status = category.status === "complete" ? "Terminada" : category.status === "judging" ? "En jueceo" : "Preparación";
        return <article key={category.id} id={`control-category-${category.id}`}>
          <div className="control-category-name"><span className={`control-itinerary-number ${itineraryPosition === -1 ? "unscheduled" : ""}`}>{itineraryPosition === -1 ? "—" : itineraryPosition + 1}</span><span className={`control-status-dot ${category.status}`} /><span><strong>{category.name}</strong><small>{itineraryPosition === -1 ? `${category.division} · Fuera del itinerario` : category.division}</small></span></div>
          <div className="control-category-stat"><strong>{categoryAthletes.length}</strong><small>Atletas</small></div>
          <div className="control-category-stat"><strong>{sent}/{profiles.length}</strong><small>Papeletas</small></div>
          <div className="control-category-stat"><strong>{absent}</strong><small>Abstenciones</small></div>
          <div className={`control-category-time ${timing?.running ? "running" : ""}`}><Clock3 /><span><strong>{timing ? formatCategoryDuration(timing.durationMs) : "00:00"}</strong><small>{timing?.running ? "En curso" : category.status === "complete" ? "Duración total" : "Sin iniciar"}</small></span></div>
          <span className={`pill ${category.status === "complete" ? "success" : category.status === "judging" ? "live" : "warning"}`}>{status}</span>
          <div className="control-category-actions">{category.status === "pending" ? <button className="primary compact" disabled={readiness.blockers.length > 0} onClick={() => startCategory(category)}>Iniciar categoría</button> : <button className="secondary compact" onClick={() => openCategory(category.id, "monitoring")}>Monitorear</button>}<button className="secondary compact" onClick={() => openCategory(category.id, "results")}>Resultados</button></div>
          {category.status === "pending" && <div className={`category-readiness ${readiness.blockers.length ? "blocked" : "ready"}`}>
            <strong>{readiness.blockers.length ? "Requisitos pendientes" : "Lista para iniciar"}</strong>
            {readiness.blockers.length ? <ul>{readiness.blockers.map((item) => <li key={item}>{item}</li>)}</ul> : <span><CheckCircle2 /> Atletas, dorsales, panel, porcentajes y poses verificados.</span>}
            {readiness.notices.length > 0 && <small>{readiness.notices.join(" · ")}</small>}
          </div>}
          {(category.status === "judging" || category.status === "complete") && <div className="category-operations">
            <div className="category-operations-head">
              <div><strong>Mesa de operación</strong><small>{category.status === "complete" ? "Categoría bloqueada" : pending.length ? `${pending.length} juez${pending.length === 1 ? " pendiente" : "ces pendientes"}` : "Panel completo: lista para cerrar"}</small></div>
              <button className="text-button" onClick={() => openCategory(category.id, "monitoring")}>Ver puntuaciones completas</button>
            </div>
            <div className="category-judge-statuses">{profiles.map((judge) => {
              const judgeState = judgeStatus(category, judge);
              const ballot = judgeState.ballot;
              return <div className="category-judge-row" key={judge.id}>
                <span className="category-judge-name"><strong>{judge.full_name || judge.email}</strong><small>{roleNames[judge.role]}{ballot?.updated_at ? ` · ${new Date(ballot.updated_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}` : ""}</small></span>
                <span className={`pill ${judgeState.tone}`}>{judgeState.label}</span>
                {ballot && !abstentions.some((entry) => entry.category_id === category.id && entry.judge_id === judge.id) ? <div className="category-judge-controls">
                  <input value={ballotReasons[ballot.id] || ""} onChange={(event) => setBallotReasons((current) => ({ ...current, [ballot.id]: event.target.value }))} placeholder="Motivo o indicación técnica" />
                  {ballot.status === "draft" && <button className="secondary compact" onClick={() => ballotControl("review", ballot)}>Solicitar revisión</button>}
                  {ballot.status === "submitted" && <button className="secondary compact" onClick={() => ballotControl("reopen", ballot)}>Reabrir</button>}
                  <button className={ballot.included_in_results === false ? "secondary compact" : "danger-button compact"} onClick={() => ballotControl("include", ballot, ballot.included_in_results === false)}>{ballot.included_in_results === false ? "Reincorporar" : "Excluir"}</button>
                </div> : <span className="category-judge-empty">{judgeState.label === "Abstención" ? "Decisión registrada" : "Sin controles disponibles"}</span>}
              </div>;
            })}</div>
            <div className="category-close-controls">
              <input value={categoryReasons[category.id] || ""} onChange={(event) => setCategoryReasons((current) => ({ ...current, [category.id]: event.target.value }))} placeholder={category.status === "complete" ? "Motivo obligatorio para reabrir" : pending.length ? "Motivo obligatorio para cierre forzado" : "Motivo del cierre (opcional)"} />
              {category.status === "complete" ? <button className="secondary compact" onClick={() => reopenCategory(category)}>Reabrir categoría</button> : <>
                <button className="secondary compact" disabled={pending.length > 0} onClick={() => closeCategory(category)}>Cerrar categoría</button>
                <button className="primary compact" disabled={pending.length > 0} onClick={() => closeCategory(category, true)}>Finalizar y siguiente</button>
                {pending.length > 0 && <button className="danger-button compact" disabled={!categoryReasons[category.id]?.trim()} onClick={() => closeCategory(category, false, true)}>Cerrar de todas formas</button>}
              </>}
            </div>
          </div>}
        </article>;
      })}</div>}
    </div>
    <div className="panel control-audit"><div className="panel-title-row"><div><h2>Actividad reciente</h2><p className="muted">Aperturas, cierres y controles de papeletas registrados automáticamente.</p></div><span className="pill success">Bitácora protegida</span></div><div className="control-audit-list">{auditLog.length ? auditLog.slice(0, 10).map((entry) => {
      const judge = profiles.find((item) => item.id === entry.judge_id);
      const actor = profiles.find((item) => item.id === entry.actor_id);
      const category = categories.find((item) => item.id === entry.category_id);
      const actionNames: Record<string, string> = { review_requested: "Revisión solicitada", ballot_reopened: "Papeleta reabierta", ballot_excluded: "Papeleta excluida", ballot_included: "Papeleta reincorporada", category_closed: "Categoría cerrada", category_reopened: "Categoría abierta o reabierta" };
      return <div key={entry.id}><span><strong>{actionNames[entry.action] || entry.action}</strong><small>{category?.name || "Categoría"}{judge ? ` · ${judge.full_name || judge.email}` : ""}</small></span><span><time>{new Date(entry.created_at).toLocaleString("es-MX")}</time><small>{entry.reason} · por {actor?.full_name || actor?.email || "Juez principal"}</small></span></div>;
    }) : <p className="empty-copy">Todavía no hay intervenciones registradas.</p>}</div></div>
  </section>;
}

function BallotView({ category, categories, categoryId, setCategoryId, athletes, rankings, setPlace, locked, ballot, abstention, existingFeedback, auditLog, showPoseGuide, busy, save, abstain }: { category?: Category; categories: Category[]; categoryId: string; setCategoryId: (id: string) => void; athletes: Athlete[]; rankings: Record<string, string[]>; setPlace: (roundKey: string, athleteId: string, place: number) => void; locked: boolean; ballot?: Ballot; abstention?: Abstention; existingFeedback: AthleteFeedback[]; auditLog: AuditEntry[]; showPoseGuide: boolean; busy: boolean; save: (submit: boolean, feedback: Record<string, { strengths: string; improvements: string; notes: string }>) => void; abstain: (reason: string) => void }) {
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, { strengths: string; improvements: string; notes: string }>>({});
  const [reason, setReason] = useState("");
  const [blockedPlace, setBlockedPlace] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const athleteSignature = athletes.map((athlete) => athlete.id).join("|");
  const feedbackSignature = existingFeedback
    .map((item) => `${item.id}:${item.athlete_id}:${item.updated_at}:${item.strengths}:${item.improvements}:${item.notes}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (!category) return;
    const next: Record<string, { strengths: string; improvements: string; notes: string }> = {};
    athletes.forEach((athlete) => {
      const saved = existingFeedback.find((item) => item.athlete_id === athlete.id);
      next[athlete.id] = { strengths: saved?.strengths || "", improvements: saved?.improvements || "", notes: saved?.notes || "" };
    });
    setFeedbackDrafts(next);
  }, [category?.id, athleteSignature, feedbackSignature]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!category) return <section className="empty"><h2>No hay una categoría de jueceo activa</h2><p>El juez principal debe crear o activar una simulación.</p></section>;
  if (abstention) return <section className="notice-card"><ShieldCheck size={36} /><h2>Abstención registrada</h2><p>Tu papeleta no contará en {category.name}.</p><small>{abstention.reason}</small></section>;

  const complete = category.rounds.every((round) => (rankings[round.key] ?? []).filter(Boolean).length === athletes.length) && athletes.length > 0;
  const provisionalResults = athletes.map((athlete) => {
    const places = category.rounds.map((round) => (rankings[round.key] ?? []).indexOf(athlete.id) + 1);
    const completeAthlete = places.every((place) => place > 0);
    const total = completeAthlete ? places.reduce((sum, place, index) => sum + place * category.rounds[index].weight, 0) : Number.POSITIVE_INFINITY;
    const symmetryPlace = places[0] || Number.POSITIVE_INFINITY;
    return { athleteId: athlete.id, total, symmetryPlace, completeAthlete, bib: athlete.bib ?? 9999 };
  }).sort((a, b) => a.total - b.total || a.symmetryPlace - b.symmetryPlace || a.bib - b.bib);
  const provisionalRank = new Map<string, number>(
    complete ? provisionalResults.map((item, index) => [item.athleteId, index + 1]) : [],
  );
  const displayedAthletes = [...athletes].sort((a, b) =>
    (a.bib ?? 9999) - (b.bib ?? 9999) || a.name.localeCompare(b.name),
  );
  const poseSections = showPoseGuide ? poseGuideForCategory(category) : [];
  const timing = categoryTiming(category, auditLog, clockNow);

  function changeFeedback(athleteId: string, field: "strengths" | "improvements" | "notes", value: string) {
    setFeedbackDrafts({ ...feedbackDrafts, [athleteId]: { ...(feedbackDrafts[athleteId] ?? { strengths: "", improvements: "", notes: "" }), [field]: value } });
  }

  function choosePlace(roundKey: string, athleteId: string, place: number) {
    const ranking = rankings[roundKey] ?? [];
    const occupied = place > 0 && ranking[place - 1] && ranking[place - 1] !== athleteId;
    if (occupied) {
      const key = `${athleteId}-${roundKey}-${place}`;
      setBlockedPlace(key);
      if ("vibrate" in navigator) navigator.vibrate(80);
      window.setTimeout(() => setBlockedPlace((current) => current === key ? "" : current), 500);
      return;
    }
    setPlace(roundKey, athleteId, place);
  }

  return <section className="stage-ballot panel">
    {ballot?.review_status === "requested" && <div className="review-alert"><AlertTriangle /><div><strong>El juez principal solicita una revisión</strong><p>{ballot.review_note}</p></div></div>}
    <div className="panel-head ballot-head"><div><p className="eyebrow red">PAPELETA DIGITAL · VISTA DE TARIMA</p><h2>{category.name}</h2><p>Las dos rondas y tus observaciones permanecen visibles en la misma pantalla.</p></div><div className="ballot-head-actions"><div className={`ballot-category-timer ${timing?.running ? "running" : category.status === "complete" ? "complete" : ""}`}><Clock3 /><span><small>Tiempo de categoría</small><strong>{timing ? formatCategoryDuration(timing.durationMs) : "00:00"}</strong></span></div><span className={`pill ${ballot?.status === "submitted" || category.status === "complete" ? "success" : "warning"}`}>{ballot?.status === "submitted" ? "Enviada" : category.status === "complete" ? "Categoría cerrada" : category.status !== "judging" ? "Esperando apertura" : "En preparación"}</span><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((item) => <option key={item.id} value={item.id}>{item.is_test ? "PRUEBA · " : ""}{item.name}</option>)}</select></div></div>
    {showPoseGuide && <section className="pose-guide" aria-label={`Poses reglamentarias de ${category.name}`}>
      <div className="pose-guide-title"><div><p className="eyebrow tricolor-text">GUÍA DEL ADMINISTRADOR</p><h3>Poses reglamentarias</h3></div><span>{poseSections.reduce((total, section) => total + section.poses.length, 0)} poses</span></div>
      {poseSections.length ? <div className={`pose-sections ${poseSections.length > 1 ? "split" : ""}`}>{poseSections.map((section) => <div className="pose-section" key={section.title}><h4>{section.title}</h4><ol>{section.poses.map((pose) => <li key={pose}>{pose}</li>)}</ol></div>)}</div> : <p className="empty-copy">Todavía no hay poses configuradas para esta modalidad.</p>}
    </section>}
    <div className="stage-guide"><strong>0 = sin asignar · 1 = mejor colocación</strong><span>{complete ? "Ranking completo. Las filas permanecen fijas por dorsal." : "Ranking en edición: falta completar uno o más lugares. Las filas no se moverán."}</span></div>
    <div className="athlete-score-list">
      {displayedAthletes.map((athlete) => <article className="score-card" key={athlete.id}>
        <header><strong className="score-bib">{athleteBibText(athlete)}</strong><span className={`live-rank ${complete && provisionalRank.has(athlete.id) ? "ranked" : ""}`}><strong>{complete && provisionalRank.has(athlete.id) ? `${provisionalRank.get(athlete.id)}.º` : "—"}</strong><small>{complete ? "Ranking" : "En edición"}</small></span><span className="athlete-identity"><strong>{athlete.name}</strong><small>{athleteSubcategory(athlete, category.id) || category.name}</small></span></header>
        <div className="criteria-grid" style={{ "--round-count": category.rounds.length } as CSSProperties}>
          {category.rounds.map((round) => { const ranking = rankings[round.key] ?? []; const index = ranking.indexOf(athlete.id); return <fieldset className="criterion" key={round.key} disabled={locked}><legend>{round.name}<small>{Math.round(round.weight * 100)}%</small></legend><div className="place-buttons"><button type="button" className={index < 0 ? "selected zero" : "zero"} onClick={() => choosePlace(round.key, athlete.id, 0)} aria-label={`${athlete.name}, ${round.name}, sin asignar`}>0</button>{ranking.map((occupant, placeIndex) => { const place = placeIndex + 1; const selected = occupant === athlete.id; const occupied = Boolean(occupant) && !selected; const attemptKey = `${athlete.id}-${round.key}-${place}`; return <button type="button" key={place} className={`${selected ? "selected" : ""} ${occupied ? "occupied" : ""} ${blockedPlace === attemptKey ? "blocked-attempt" : ""}`} onClick={() => choosePlace(round.key, athlete.id, place)} aria-label={`${athlete.name}, ${round.name}, lugar ${place}${occupied ? ", ocupado" : ""}`} title={occupied ? "Lugar ocupado" : `Asignar lugar ${place}`}>{place}</button>; })}</div></fieldset>; })}
        </div>
        <label className="quick-note"><span>Observación rápida</span><textarea rows={1} value={feedbackDrafts[athlete.id]?.notes || ""} onChange={(e) => changeFeedback(athlete.id, "notes", e.target.value)} placeholder="Anota aquí el detalle que observaste…" disabled={locked} /></label>
      </article>)}
      {athletes.length === 0 && <p className="empty-copy">No hay atletas asignados a esta categoría.</p>}
    </div>
    <details className="conflict-details"><summary>Registrar conflicto de interés o abstención</summary><div><p>Si tienes una relación con un atleta de esta categoría, tu papeleta completa quedará fuera del resultado.</p><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo de la abstención" disabled={locked} /><button className="secondary compact" disabled={!reason.trim() || locked} onClick={() => abstain(reason.trim())}>Registrar abstención</button></div></details>
    <div className="stage-actions"><span>{category.status !== "judging" && ballot?.status !== "submitted" ? "El juez principal todavía no ha abierto esta categoría." : locked ? "Tu decisión quedó enviada y bloqueada." : complete ? "Papeleta completa y lista para revisar." : "Puedes guardar aunque todavía existan posiciones en 0."}</span><div><button className="secondary" disabled={busy || locked || athletes.length === 0} onClick={() => save(false, feedbackDrafts)}>Guardar borrador</button><button className="primary compact" disabled={busy || locked || !complete} onClick={() => save(true, feedbackDrafts)}>{ballot?.status === "submitted" ? "Papeleta enviada" : category.status !== "judging" ? "Categoría sin abrir" : "Revisar y enviar"}</button></div></div>
  </section>;
}

function rankBallot(category: Category, athletes: Athlete[], ballot: Ballot | undefined, placements: Placement[]) {
  const ballotPlacements = ballot ? placements.filter((item) => item.ballot_id === ballot.id) : [];
  const rows = athletes.map((athlete) => {
    const places = category.rounds.map((round) => ballotPlacements.find((item) => item.athlete_id === athlete.id && item.round_key === round.key)?.place ?? 0);
    const complete = places.every((place) => place > 0);
    const total = complete ? places.reduce((sum, place, index) => sum + place * category.rounds[index].weight, 0) : Number.POSITIVE_INFINITY;
    const tieValue = places[category.rounds.findIndex((round) => round.key === category.tie_break_round)] || Number.POSITIVE_INFINITY;
    return { athlete, places, complete, total, tieValue, rank: 0 };
  }).sort((a, b) => Number(b.complete) - Number(a.complete) || a.total - b.total || a.tieValue - b.tieValue || (a.athlete.bib ?? 9999) - (b.athlete.bib ?? 9999));
  let rank = 0;
  rows.forEach((row) => { if (row.complete) row.rank = ++rank; });
  return rows;
}

function consolidatedCategoryWinner(category: Category, athletes: Athlete[], ballots: Ballot[], placements: Placement[], abstentions: Abstention[]) {
  const participants = athletes.filter((athlete) => athlete.active && athlete.registration_status !== "withdrawn" && athleteInCategory(athlete, category.id));
  const validBallots = ballots.filter((ballot) => ballot.category_id === category.id
    && ballot.status === "submitted"
    && ballot.included_in_results !== false
    && !abstentions.some((entry) => entry.category_id === category.id && entry.judge_id === ballot.judge_id));
  if (!participants.length || !validBallots.length) return undefined;
  return participants.map((athlete) => {
    const roundTotals = category.rounds.map((round) => ({
      key: round.key,
      total: validBallots.reduce((sum, ballot) => sum + (placements.find((item) => item.ballot_id === ballot.id && item.athlete_id === athlete.id && item.round_key === round.key)?.place ?? 0) * round.weight, 0),
    }));
    const total = roundTotals.reduce((sum, round) => sum + round.total, 0);
    const tieValue = roundTotals.find((round) => round.key === category.tie_break_round)?.total ?? total;
    return { athlete, total, tieValue };
  }).sort((a, b) => a.total - b.total || a.tieValue - b.tieValue || (a.athlete.bib ?? 9999) - (b.athlete.bib ?? 9999))[0]?.athlete;
}

async function ensureAbsoluteCategory(competitionId: string, categories: Category[], spec: typeof absoluteCategorySpecs[number]) {
  const existing = categories.find((category) => absoluteSpecForCategory(category)?.name === spec.name);
  if (existing) return { category: existing };
  const preset = scoringPresets[spec.modalityKey];
  const created = await supabase.from("categories").insert({
    competition_id: competitionId,
    name: spec.name,
    division: preset.label,
    status: "pending",
    is_test: false,
    rounds: preset.rounds,
    tie_break_round: preset.tieBreak,
    order_index: eventCategoryItinerary.indexOf(spec.name),
  }).select("id,competition_id,name,division,status,order_index,rounds,tie_break_round,is_test").single();
  if (created.error) return { error: created.error.message };
  return { category: applyScoringPreset(created.data as Category) };
}

async function ensureAllAbsoluteCategories(competitionId: string, categories: Category[]) {
  let availableCategories = [...categories];
  const createdNames: string[] = [];
  for (const spec of absoluteCategorySpecs) {
    const ensured = await ensureAbsoluteCategory(competitionId, availableCategories, spec);
    if (!ensured.category) return { categories: availableCategories, createdNames, error: ensured.error || `No se pudo preparar ${spec.name}.` };
    if (!availableCategories.some((category) => category.id === ensured.category?.id)) {
      availableCategories = [...availableCategories, ensured.category];
      createdNames.push(spec.name);
    }
  }
  return { categories: availableCategories, createdNames };
}

async function resetAbsoluteBallots(category: Category) {
  const ballotResult = await supabase.from("ballots").select("id").eq("category_id", category.id);
  if (ballotResult.error) return ballotResult.error.message;
  const ballotIds = (ballotResult.data ?? []).map((item) => item.id as string);
  if (ballotIds.length) {
    const placementsResult = await supabase.from("placements").delete().in("ballot_id", ballotIds);
    if (placementsResult.error) return placementsResult.error.message;
    const ballotsResult = await supabase.from("ballots").update({ status: "draft", submitted_at: null, included_in_results: true, review_status: "none", review_note: null, review_requested_at: null }).eq("category_id", category.id);
    if (ballotsResult.error) return ballotsResult.error.message;
  }
  if (category.status !== "pending") {
    const categoryResult = await supabase.from("categories").update({ status: "pending" }).eq("id", category.id);
    if (categoryResult.error) return categoryResult.error.message;
  }
  return "";
}

async function syncAbsoluteQualifier({ competitionId, sourceCategory, categories, athletes, ballots, placements, abstentions, removeOnly = false }: { competitionId: string; sourceCategory: Category; categories: Category[]; athletes: Athlete[]; ballots: Ballot[]; placements: Placement[]; abstentions: Abstention[]; removeOnly?: boolean }) {
  const spec = absoluteSpecForSource(sourceCategory);
  if (!spec) return { handled: false, message: "" };
  const prepared = await ensureAllAbsoluteCategories(competitionId, categories);
  if (prepared.error) return { handled: true, error: prepared.error, message: "" };
  const absoluteCategory = prepared.categories.find((category) => absoluteSpecForCategory(category)?.name === spec.name);
  if (!absoluteCategory) return { handled: true, error: `No se pudo preparar ${spec.name}.`, message: "" };
  const allCategories = prepared.categories;
  const winner = removeOnly ? undefined : consolidatedCategoryWinner(sourceCategory, athletes, ballots, placements, abstentions);
  let rosterChanged = false;

  for (const athlete of athletes) {
    const registration = athleteRegistration(athlete);
    const currentSources = registration.absoluteQualifications[absoluteCategory.id] ?? [];
    const nextSources = currentSources.filter((sourceId) => sourceId !== sourceCategory.id);
    if (winner?.id === athlete.id) nextSources.push(sourceCategory.id);
    const uniqueSources = [...new Set(nextSources)];
    const sourceChanged = currentSources.length !== uniqueSources.length || currentSources.some((sourceId) => !uniqueSources.includes(sourceId));
    if (!sourceChanged) continue;

    const categoryIds = uniqueSources.length
      ? [...new Set([...registration.categoryIds, absoluteCategory.id])]
      : registration.categoryIds.filter((categoryId) => categoryId !== absoluteCategory.id);
    const absoluteQualifications = { ...registration.absoluteQualifications };
    const subcategories = { ...registration.subcategories };
    if (uniqueSources.length) {
      absoluteQualifications[absoluteCategory.id] = uniqueSources;
      const sourceNames = uniqueSources.map((sourceId) => allCategories.find((category) => category.id === sourceId)?.name).filter((name): name is string => Boolean(name));
      subcategories[absoluteCategory.id] = `Campeón: ${sourceNames.join(" · ")}`;
    } else {
      delete absoluteQualifications[absoluteCategory.id];
      delete subcategories[absoluteCategory.id];
    }
    const updated = await supabase.from("athletes").update({
      category_id: athlete.category_id === absoluteCategory.id && !uniqueSources.length ? categoryIds[0] || null : athlete.category_id || categoryIds[0] || null,
      registered_division: encodeAthleteRegistration(categoryIds, subcategories, registration.legacyDivision, registration.modalityKeys, absoluteQualifications, registration.gender, registration.external),
    }).eq("id", athlete.id);
    if (updated.error) return { handled: true, error: updated.error.message, message: "" };
    rosterChanged = true;
  }

  if (rosterChanged) {
    const resetError = await resetAbsoluteBallots(absoluteCategory);
    if (resetError) return { handled: true, error: `Los clasificados se actualizaron, pero no se pudo reiniciar ${absoluteCategory.name}: ${resetError}`, message: "" };
  }
  if (removeOnly) return { handled: true, message: rosterChanged ? `${sourceCategory.name} fue retirada temporalmente de ${absoluteCategory.name} hasta confirmar nuevamente su campeón.` : "" };
  return {
    handled: true,
    message: winner
      ? `${winner.name} clasificó automáticamente a ${absoluteCategory.name} como campeón de ${sourceCategory.name}.`
      : `${sourceCategory.name} se cerró sin papeletas válidas; no se asignó clasificado a ${absoluteCategory.name}.`,
  };
}

function MonitoringView({ competition, category, categories, categoryId, setCategoryId, athletes, eventAthletes, ballots, eventBallots, placements, abstentions, eventAbstentions, profiles, auditLog, refresh, setMessage }: { competition?: Competition; category?: Category; categories: Category[]; categoryId: string; setCategoryId: (id: string) => void; athletes: Athlete[]; eventAthletes: Athlete[]; ballots: Ballot[]; eventBallots: Ballot[]; placements: Placement[]; abstentions: Abstention[]; eventAbstentions: Abstention[]; profiles: Profile[]; auditLog: AuditEntry[]; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [categoryReason, setCategoryReason] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!category) return <section className="empty"><h2>No hay una categoría para monitorear</h2></section>;
  const activeCategory = category;

  const panel = profiles.filter((item) => item.role !== "pending");
  const ballotRows = new Map(ballots.map((ballot) => [ballot.id, rankBallot(category, athletes, ballot, placements)]));
  const consensusSource = ballots.filter((ballot) => ballot.included_in_results !== false && !abstentions.some((item) => item.judge_id === ballot.judge_id));
  const consensus = new Map(athletes.map((athlete) => {
    const ranks = consensusSource.map((ballot) => ballotRows.get(ballot.id)?.find((row) => row.athlete.id === athlete.id)?.rank ?? 0).filter(Boolean).sort((a, b) => a - b);
    const middle = Math.floor(ranks.length / 2);
    const median = ranks.length ? ranks.length % 2 ? ranks[middle] : (ranks[middle - 1] + ranks[middle]) / 2 : 0;
    return [athlete.id, median];
  }));
  const alertThreshold = Math.max(2, Math.ceil(athletes.length * 0.3));

  async function ballotControl(action: "review" | "reopen" | "include", ballot: Ballot, include = true) {
    const reason = reasons[ballot.id]?.trim();
    if (!reason) return setMessage("Escribe el motivo antes de aplicar el control.");
    if (action !== "review" && !window.confirm("Esta acción quedará registrada en la bitácora. ¿Deseas continuar?")) return;
    const result = action === "review"
      ? await supabase.rpc("request_ballot_review", { target_ballot: ballot.id, review_reason: reason })
      : action === "reopen"
        ? await supabase.rpc("reopen_ballot", { target_ballot: ballot.id, reopen_reason: reason })
        : await supabase.rpc("set_ballot_inclusion", { target_ballot: ballot.id, should_include: include, inclusion_reason: reason });
    if (result.error) return setMessage(result.error.message);
    setReasons({ ...reasons, [ballot.id]: "" });
    setMessage(action === "review" ? "Solicitud de revisión enviada." : action === "reopen" ? "Papeleta reabierta para corrección." : include ? "Papeleta reincorporada al consolidado." : "Papeleta excluida del consolidado.");
    await refresh();
  }

  async function controlCategory() {
    const reason = categoryReason.trim();
    if (!reason) return setMessage("Escribe el motivo para cerrar o reabrir la categoría.");
    const shouldClose = activeCategory.status !== "complete";
    if (!window.confirm(`${shouldClose ? "Cerrar" : "Reabrir"} esta categoría quedará registrado. ¿Continuar?`)) return;
    const result = await supabase.rpc("set_category_closed", { target_category: activeCategory.id, should_close: shouldClose, control_reason: reason });
    if (result.error) return setMessage(result.error.message);
    if (competition) {
      const absoluteSync = await syncAbsoluteQualifier({ competitionId: competition.id, sourceCategory: activeCategory, categories: categories.filter((item) => !item.is_test), athletes: eventAthletes, ballots: eventBallots, placements, abstentions: eventAbstentions, removeOnly: !shouldClose });
      if (absoluteSync.error) {
        setMessage(`${shouldClose ? "La categoría quedó cerrada" : "La categoría fue reabierta"}, pero falló la actualización del absoluto: ${absoluteSync.error}`);
        await refresh();
        return;
      }
      const integrationError = shouldClose ? await enqueueWnbfWebhook("resultado_confirmado", activeCategory.id) : "";
      setCategoryReason("");
      setMessage(`${shouldClose ? "Categoría cerrada: ya no admite cambios." : "Categoría reabierta para jueceo."}${absoluteSync.message ? ` ${absoluteSync.message}` : ""}${integrationError ? ` El envío a WNBF quedó pendiente: ${integrationError}` : shouldClose ? " Resultado puesto en la cola segura de WNBF." : ""}`);
      await refresh();
      return;
    }
    setCategoryReason("");
    setMessage(shouldClose ? "Categoría cerrada: ya no admite cambios." : "Categoría reabierta para jueceo.");
    await refresh();
  }

  const actionNames: Record<string, string> = { review_requested: "Revisión solicitada", ballot_reopened: "Papeleta reabierta", ballot_excluded: "Papeleta excluida", ballot_included: "Papeleta reincorporada", category_closed: "Categoría cerrada", category_reopened: "Categoría reabierta" };

  return <section className="monitoring-stack">
    <div className="panel monitoring-head"><div><p className="eyebrow red">JUEZ PRINCIPAL</p><h2>Monitoreo en vivo</h2><p>Las puntuaciones provisionales se actualizan cada 5 segundos. Los jueces no pueden ver las papeletas de los demás.</p></div><div className="monitoring-select"><span className="live-indicator"><i /> EN VIVO</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((item) => <option key={item.id} value={item.id}>{item.is_test ? "PRUEBA · " : ""}{item.name}</option>)}</select></div></div>
    <div className="panel category-control"><div><h3>{category.status === "complete" ? "Categoría cerrada" : "Categoría abierta"}</h3><p>{category.status === "complete" ? "Las papeletas están bloqueadas." : "Los jueces pueden seguir puntuando y corrigiendo borradores."}</p></div><input value={categoryReason} onChange={(event) => setCategoryReason(event.target.value)} placeholder="Motivo obligatorio" /><button className={category.status === "complete" ? "secondary compact" : "primary compact"} onClick={controlCategory}>{category.status === "complete" ? "Reabrir categoría" : "Cerrar categoría"}</button></div>
    <div className="judge-monitor-list">
      {panel.map((judge) => {
        const ballot = ballots.find((item) => item.judge_id === judge.id);
        const abstention = abstentions.find((item) => item.judge_id === judge.id);
        const rows = ballot ? ballotRows.get(ballot.id) ?? [] : [];
        const divergences = rows.filter((row) => row.rank && consensus.get(row.athlete.id) && Math.abs(row.rank - (consensus.get(row.athlete.id) ?? 0)) >= alertThreshold).length;
        const status = abstention ? "Abstención" : ballot?.status === "submitted" ? "Enviada" : ballot ? "Puntuando" : "Sin iniciar";
        return <article className={`panel judge-monitor ${ballot?.included_in_results === false ? "excluded" : ""}`} key={judge.id}>
          <div className="judge-monitor-head"><div><h3>{judge.full_name || judge.email}</h3><p>{roleNames[judge.role]}{ballot?.updated_at ? ` · Último cambio ${new Date(ballot.updated_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</p></div><div className="judge-monitor-badges"><span className={`pill ${status === "Enviada" ? "success" : status === "Abstención" ? "closed" : "warning"}`}>{status}</span>{ballot?.included_in_results === false && <span className="pill closed">Excluida</span>}{divergences > 0 && <span className="pill danger"><AlertTriangle size={14} />{divergences} diferencias</span>}</div></div>
          {ballot ? <div className="table-wrap monitor-table"><table><thead><tr><th>Ranking</th><th>Atleta</th>{category.rounds.map((round) => <th key={round.key}>{round.name}</th>)}<th>Tendencia</th></tr></thead><tbody>{rows.map((row) => { const panelRank = consensus.get(row.athlete.id) ?? 0; const difference = row.rank && panelRank ? row.rank - panelRank : 0; const outlier = Math.abs(difference) >= alertThreshold; return <tr className={outlier ? "outlier-row" : ""} key={row.athlete.id}><td><strong>{row.rank || "—"}</strong></td><td><strong className="bib">{athleteBibText(row.athlete)}</strong> {row.athlete.name}</td>{row.places.map((place, index) => <td key={category.rounds[index].key}>{place || "0"}</td>)}<td>{panelRank || "—"}{difference ? <small className={outlier ? "difference-alert" : ""}>{difference > 0 ? ` +${difference}` : ` ${difference}`}</small> : ""}</td></tr>; })}</tbody></table></div> : <p className="empty-copy">Este juez todavía no ha comenzado a puntuar.</p>}
          {ballot && !abstention && <div className="judge-controls"><textarea rows={2} value={reasons[ballot.id] || ""} onChange={(event) => setReasons({ ...reasons, [ballot.id]: event.target.value })} placeholder="Motivo o indicación técnica obligatoria. Ej.: Revisa la consistencia de Simetría." /><div>{ballot.status === "draft" && <button className="secondary compact" onClick={() => ballotControl("review", ballot)}>Solicitar revisión</button>}{ballot.status === "submitted" && <button className="secondary compact" onClick={() => ballotControl("reopen", ballot)}>Reabrir papeleta</button>}<button className={ballot.included_in_results === false ? "secondary compact" : "danger-button compact"} onClick={() => ballotControl("include", ballot, ballot.included_in_results === false)}>{ballot.included_in_results === false ? "Reincorporar" : "Excluir del resultado"}</button></div></div>}
        </article>;
      })}
    </div>
    <div className="panel audit-panel"><h2>Bitácora de control</h2><p className="muted">Ninguna intervención se borra ni queda anónima.</p><div className="audit-list">{auditLog.length ? auditLog.slice(0, 12).map((entry) => { const judge = profiles.find((item) => item.id === entry.judge_id); const actor = profiles.find((item) => item.id === entry.actor_id); return <div key={entry.id}><span><strong>{actionNames[entry.action] || entry.action}</strong><small>{judge ? `Papeleta de ${judge.full_name || judge.email}` : category.name} · por {actor?.full_name || actor?.email || "Juez principal"}</small></span><span><time>{new Date(entry.created_at).toLocaleString("es-MX")}</time><small>{entry.reason}</small></span></div>; }) : <p className="empty-copy">Todavía no hay intervenciones registradas.</p>}</div></div>
  </section>;
}


function FeedbackView({ userId, competition, categories, categoryId, setCategoryId, athletes, feedback, reports, profiles, refresh, setMessage }: { userId: string; competition?: Competition; categories: Category[]; categoryId: string; setCategoryId: (id: string) => void; athletes: Athlete[]; feedback: AthleteFeedback[]; reports: AthleteFeedbackReport[]; profiles: Profile[]; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const [athleteId, setAthleteId] = useState("");
  const [report, setReport] = useState({ strengths: "", improvements: "" });
  const [saving, setSaving] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState("");
  const category = categories.find((item) => item.id === categoryId) ?? categories[0];
  const categoryAthletes = athletes.filter((item) => athleteInCategory(item, category?.id));

  useEffect(() => {
    if (!categoryAthletes.some((athlete) => athlete.id === athleteId)) setAthleteId(categoryAthletes[0]?.id || "");
  }, [category?.id, categoryAthletes, athleteId]);

  const athlete = categoryAthletes.find((item) => item.id === athleteId);
  const official = reports.find((item) => item.athlete_id === athleteId);
  const observations = feedback.filter((item) => item.athlete_id === athleteId && item.notes.trim());
  const normalizedArchiveSearch = archiveSearch.trim().toLocaleLowerCase("es-MX");
  const archiveEntries = reports.map((savedReport) => {
    const savedAthlete = athletes.find((item) => item.id === savedReport.athlete_id);
    const savedCategory = categories.find((item) => item.id === savedReport.category_id);
    return { report: savedReport, athlete: savedAthlete, category: savedCategory };
  }).filter((entry) => entry.athlete && entry.category && (!normalizedArchiveSearch || [entry.athlete.name, entry.category.name].some((value) => value.toLocaleLowerCase("es-MX").includes(normalizedArchiveSearch))));

  useEffect(() => {
    setReport({ strengths: official?.strengths || "", improvements: official?.improvements || "" });
  }, [athleteId, official?.strengths, official?.improvements]);

  async function saveReport() {
    if (!category || !athlete) return;
    setSaving(true);
    const result = await supabase.from("athlete_feedback_reports").upsert({
      category_id: category.id,
      athlete_id: athlete.id,
      author_id: userId,
      strengths: report.strengths.trim(),
      improvements: report.improvements.trim(),
    }, { onConflict: "category_id,athlete_id" });
    setSaving(false);
    if (result.error) return setMessage(result.error.message);
    setMessage(`Feedback oficial de ${athlete.name} guardado.`);
    await refresh();
  }

  if (!category) return <section className="empty"><h2>No hay una categoría disponible</h2></section>;

  return <section className="feedback-workspace">
    <div className="panel feedback-toolbar no-print">
      <div><p className="eyebrow red">JUEZ PRINCIPAL</p><h2>Feedback para atletas</h2><p>Revisa las observaciones del panel y prepara el reporte oficial.</p></div>
      <div className="feedback-selectors"><label>Categoría<select value={category?.id || ""} onChange={(event) => { setCategoryId(event.target.value); setAthleteId(""); }}>{categories.map((item) => <option key={item.id} value={item.id}>{item.is_test ? "PRUEBA · " : ""}{item.name}</option>)}</select></label><label>Atleta<select value={athleteId} onChange={(event) => setAthleteId(event.target.value)} disabled={!categoryAthletes.length}><option value="">{categoryAthletes.length ? "Seleccionar atleta" : "Sin atletas"}</option>{[...categoryAthletes].sort((a, b) => (a.bib ?? 9999) - (b.bib ?? 9999)).map((item) => <option key={item.id} value={item.id}>{item.bib ? `#${item.bib} · ` : ""}{item.name}</option>)}</select></label></div>
    </div>
    <div className="panel feedback-archive no-print">
      <div className="panel-title-row"><div><p className="eyebrow red">ARCHIVO DEL EVENTO</p><h2>Feedbacks oficiales guardados</h2><p className="muted">{reports.length} reportes en {competition?.name || "este evento"}.</p></div><label className="athlete-search"><Search aria-hidden="true" /><input type="search" value={archiveSearch} onChange={(event) => setArchiveSearch(event.target.value)} placeholder="Buscar atleta o categoría" aria-label="Buscar feedbacks guardados" /></label></div>
      {archiveEntries.length ? <div className="feedback-archive-list">{archiveEntries.map((entry) => <button key={entry.report.id} className={entry.report.athlete_id === athleteId ? "active" : ""} onClick={() => { setCategoryId(entry.report.category_id); setAthleteId(entry.report.athlete_id); }}><span><strong>{entry.athlete?.name}</strong><small>{entry.category?.name}</small></span><span><Archive />Abrir</span></button>)}</div> : <p className="empty-copy">{reports.length ? "No se encontraron feedbacks con esa búsqueda." : "Todavía no hay feedbacks oficiales guardados en este evento."}</p>}
    </div>
    {!athlete ? <div className="panel empty"><h2>Selecciona un atleta</h2><p>No hay atletas asignados a esta categoría.</p></div> : <div className="feedback-columns">
      <aside className="panel judge-observations no-print"><h2>Observaciones de los jueces</h2><p className="muted">{observations.length} comentarios registrados.</p><div className="observation-list">{observations.length ? observations.map((item, index) => { const judge = profiles.find((profile) => profile.id === item.judge_id); return <article key={item.id}><strong>{judge?.full_name || judge?.email || `Juez ${index + 1}`}</strong><p>{item.notes}</p></article>; }) : <p className="empty-copy">Todavía no hay observaciones para este atleta.</p>}</div></aside>
      <article className="panel athlete-feedback-report">
        <header className="feedback-report-head"><img className="report-logo" src={`${import.meta.env.BASE_URL}brand/wnbf-mexico-logo.png`} alt="WNBF México" /><div><p className="eyebrow tricolor-text">WNBF MÉXICO · FEEDBACK OFICIAL</p><h1>{athlete.name}</h1><p>{athlete.bib ? `Dorsal #${athlete.bib} · ` : ""}{category.name}</p></div></header>
        <div className="feedback-event"><strong>{competition?.name || "WNBF México"}</strong><span>{competition ? new Date(`${competition.event_date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : ""}</span><span>{competition?.venue || ""}</span></div>
        <section><h2>Fortalezas observadas</h2><textarea value={report.strengths} onChange={(event) => setReport({ ...report, strengths: event.target.value })} placeholder="Resume los aspectos mejor valorados por el panel…" /></section>
        <section><h2>Aspectos por mejorar</h2><textarea value={report.improvements} onChange={(event) => setReport({ ...report, improvements: event.target.value })} placeholder="Escribe recomendaciones claras y constructivas…" /></section>
        <section className="anonymous-observations"><h2>Observaciones del panel</h2>{observations.length ? <ul>{observations.map((item) => <li key={item.id}>{item.notes}</li>)}</ul> : <p>Sin observaciones adicionales.</p>}</section>
        <footer><span>Documento emitido por el panel oficial de jueces WNBF México.</span><strong>WNBF MÉXICO</strong></footer>
        <div className="feedback-actions no-print"><button className="secondary" onClick={() => window.print()}>Imprimir o guardar PDF</button><button className="primary compact" disabled={saving} onClick={saveReport}>{saving ? "Guardando…" : "Guardar feedback oficial"}</button></div>
      </article>
    </div>}
  </section>;
}

function MeasurementsView({ competition, athletes, queue, lastSync, syncing, saveMeasurement, syncNow }: { competition?: Competition; athletes: Athlete[]; queue: Record<string, MeasurementQueueItem>; lastSync: string | null; syncing: boolean; saveMeasurement: (athleteId: string, values: { peso_kg?: number | null; estatura_cm?: number | null }) => void; syncNow: () => void }) {
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  if (!competition || !isWnbfIntegratedCompetition(competition)) {
    return <section className="empty"><Weight /><h2>Medidas disponibles en THE FORGE</h2><p>Selecciona el evento THE FORGE para abrir el pesaje sincronizado con WNBF México.</p></section>;
  }
  const linkedAthletes = athletes.filter((athlete) => athlete.wnbf_athlete_id || athleteRegistration(athlete).external?.athleteId);
  const completed = linkedAthletes.filter((athlete) => athlete.measures_complete).length;
  const normalizedSearch = search.trim().toLocaleLowerCase("es-MX");
  const visible = linkedAthletes.filter((athlete) => {
    if (missingOnly && athlete.measures_complete) return false;
    return !normalizedSearch || athlete.name.toLocaleLowerCase("es-MX").includes(normalizedSearch);
  });
  const groups = measurementGroupOrder.map((name) => ({
    name,
    athletes: visible.filter((athlete) => measurementGroupsForAthlete(athlete).includes(name)).sort((a, b) => a.name.localeCompare(b.name, "es-MX", { sensitivity: "base" })),
  })).filter((group) => group.athletes.length);

  return <section className="measurements-page">
    <div className="panel measurements-head">
      <div><p className="eyebrow red">SINCRONIZACIÓN BIDIRECCIONAL</p><h2>Medidas / Pesaje</h2><p className="muted">Los cambios se guardan al salir del campo y aparecen en WNBF México en segundos.</p></div>
      <div className="measurement-progress"><strong>{completed} de {linkedAthletes.length}</strong><span>con medidas completas</span></div>
      <div className="measurement-toolbar"><label className="athlete-search"><Search aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar atleta" aria-label="Buscar atleta en pesaje" /></label><label className="missing-toggle"><input type="checkbox" checked={missingOnly} onChange={(event) => setMissingOnly(event.target.checked)} />Solo los que faltan</label><button type="button" className="secondary compact" disabled={syncing} onClick={syncNow}><RefreshCw className={syncing ? "spin" : ""} />{syncing ? "Sincronizando…" : "Sincronizar ahora"}</button></div>
      <div className="wnbf-sync-status"><span className="live-indicator"><i /> CONEXIÓN WNBF</span><span>Actualización automática cada 5 segundos{lastSync ? ` · última consulta ${new Date(lastSync).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</span></div>
    </div>
    {groups.length ? groups.map((group) => <div className="panel measurement-group" key={group.name}><div className="measurement-group-title"><div><h3>{group.name}</h3><span>{group.athletes.length} atleta{group.athletes.length === 1 ? "" : "s"}</span></div><div className="measurement-column-labels"><span>Peso</span><span>Estatura</span><span>Medido por</span><span>Estado</span></div></div><div className="measurement-list">{group.athletes.map((athlete) => <MeasurementRow key={`${group.name}-${athlete.id}`} athlete={athlete} pending={queue[athlete.id]} saveMeasurement={saveMeasurement} />)}</div></div>) : <section className="empty"><Search /><h2>Sin resultados</h2><p>No hay atletas que coincidan con los filtros seleccionados.</p></section>}
  </section>;
}

function MeasurementRow({ athlete, pending, saveMeasurement }: { athlete: Athlete; pending?: MeasurementQueueItem; saveMeasurement: (athleteId: string, values: { peso_kg?: number | null; estatura_cm?: number | null }) => void }) {
  const [weight, setWeight] = useState(athlete.weight_kg?.toString() ?? "");
  const [height, setHeight] = useState(athlete.height_cm?.toString() ?? "");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (editing || pending) return;
    setWeight(athlete.weight_kg?.toString() ?? "");
    setHeight(athlete.height_cm?.toString() ?? "");
  }, [athlete.weight_kg, athlete.height_cm, editing, pending]);

  function saveWeight() {
    setEditing(false);
    const value = weight.trim() === "" ? null : Number(weight);
    if (value !== null && (!Number.isFinite(value) || value < 30 || value > 200)) {
      setError("El peso debe estar entre 30 y 200 kg.");
      setWeight(athlete.weight_kg?.toString() ?? "");
      return;
    }
    setError("");
    if (value === athlete.weight_kg && !pending) return;
    saveMeasurement(athlete.id, { peso_kg: value });
  }

  function saveHeight() {
    setEditing(false);
    const value = height.trim() === "" ? null : Number(height);
    if (value !== null && (!Number.isInteger(value) || value < 120 || value > 230)) {
      setError("La estatura debe ser un entero entre 120 y 230 cm.");
      setHeight(athlete.height_cm?.toString() ?? "");
      return;
    }
    setError("");
    if (value === athlete.height_cm && !pending) return;
    saveMeasurement(athlete.id, { estatura_cm: value });
  }

  const stateLabel = pending?.status === "failed" ? "Error de envío" : pending ? "Pendiente de enviar" : athlete.measures_complete ? "Completo" : "Faltan datos";
  return <div className={`measurement-row ${pending?.status ?? ""}`}>
    <div className="measurement-athlete"><i className={athlete.measures_complete ? "complete" : ""} /><span><strong>{athlete.name}</strong><small>{athleteBibText(athlete)} · {measurementGroupsForAthlete(athlete).join(" · ")}</small></span></div>
    <label><span className="mobile-label">Peso</span><span className="measurement-input"><input aria-label={`Peso de ${athlete.name}`} type="number" min="30" max="200" step="0.1" value={weight} onFocus={() => setEditing(true)} onChange={(event) => setWeight(event.target.value)} onBlur={saveWeight} placeholder="—" /><small>kg</small></span></label>
    <label><span className="mobile-label">Estatura</span><span className="measurement-input"><input aria-label={`Estatura de ${athlete.name}`} type="number" min="120" max="230" step="1" value={height} onFocus={() => setEditing(true)} onChange={(event) => setHeight(event.target.value)} onBlur={saveHeight} placeholder="—" /><small>cm</small></span></label>
    <span className="measured-by">{athlete.measured_by || "—"}</span>
    <span className={`measurement-status ${pending?.status ?? (athlete.measures_complete ? "complete" : "missing")}`}>{pending ? <RefreshCw className={pending.status === "pending" ? "spin" : ""} /> : <i />}{stateLabel}</span>
    {(error || pending?.error) && <small className="measurement-error">{error || pending?.error}</small>}
  </div>;
}

function ResultsView({ category, categories, categoryId, setCategoryId, rows, ballots, abstentions, profiles }: { category?: Category; categories: Category[]; categoryId: string; setCategoryId: (id: string) => void; rows: { athlete: Athlete; total: number; tieValue: number; judges: number; roundTotals: { key: string; name: string; total: number }[] }[]; ballots: Ballot[]; abstentions: Abstention[]; profiles: Profile[] }) {
  if (!category) return <section className="empty"><h2>No hay resultados disponibles</h2></section>;
  const panel = profiles.filter((profile) => profile.role !== "pending");
  return <section className="results-grid"><div className="panel"><div className="panel-head"><div><p className="eyebrow red">JUEZ PRINCIPAL</p><h2>Consolidado de puntuaciones</h2><p>Menor suma obtiene la mejor colocación. Desempate: {category.rounds.find((round) => round.key === category.tie_break_round)?.name || "ronda configurada"}.</p></div><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((item) => <option key={item.id} value={item.id}>{item.is_test ? "PRUEBA · " : ""}{item.name}</option>)}</select></div><div className="table-wrap"><table><thead><tr><th>Lugar</th><th>Atleta</th>{category.rounds.map((round) => <th key={round.key}>{round.name}</th>)}<th>Total</th></tr></thead><tbody>{rows.map((row, index) => { const tied = index > 0 && rows[index - 1].total === row.total; return <tr key={row.athlete.id}><td>{row.judges ? index + 1 : "—"}{tied ? "*" : ""}</td><td><strong className="bib">{athleteBibText(row.athlete)}</strong> {row.athlete.name}</td>{category.rounds.map((round) => <td key={round.key}>{row.judges ? row.roundTotals.find((item) => item.key === round.key)?.total : "—"}</td>)}<td><strong>{row.judges ? row.total : "—"}</strong></td></tr>; })}</tbody></table></div><p className="table-note">{ballots.filter((item) => item.status === "submitted" && item.included_in_results !== false && !abstentions.some((entry) => entry.judge_id === item.judge_id)).length} papeletas válidas · {ballots.filter((item) => item.included_in_results === false).length} excluidas · {abstentions.length} abstenciones</p></div><aside className="panel"><h2>Estado del panel</h2><div className="judge-status-list">{panel.map((judge) => { const ballot = ballots.find((item) => item.judge_id === judge.id); const abstention = abstentions.find((item) => item.judge_id === judge.id); const status = abstention ? "Abstención" : ballot?.included_in_results === false ? "Excluida" : ballot?.status === "submitted" ? "Enviada" : ballot?.status === "draft" ? "Borrador" : "Pendiente"; return <div key={judge.id}><span><strong>{judge.full_name || judge.email}</strong><small>{roleNames[judge.role]}</small></span><span className={`pill ${status === "Enviada" ? "success" : status === "Abstención" || status === "Excluida" ? "closed" : "warning"}`}>{status}</span></div>; })}</div></aside></section>;
}

function AdminView({ userId, competition, competitions, setCompetitionId, profiles, assignments, athletes, categories, refresh, setMessage, syncWnbfAthletes, syncingAthletes, lastWnbfSync }: { userId: string; competition?: Competition; competitions: Competition[]; setCompetitionId: (id: string) => void; profiles: Profile[]; assignments: JudgeAssignment[]; athletes: Athlete[]; categories: Category[]; refresh: () => Promise<void>; setMessage: (value: string) => void; syncWnbfAthletes: (full: boolean, announce: boolean) => Promise<void>; syncingAthletes: boolean; lastWnbfSync: string | null }) {
  const [eventForm, setEventForm] = useState({ name: "", event_date: "", venue: "" });
  const [showEventForm, setShowEventForm] = useState(!competition);
  const [categoryForm, setCategoryForm] = useState({ name: "", division: "" });
  const [athleteForm, setAthleteForm] = useState<{ name: string; gender: AthleteGender }>({ name: "", gender: "" });
  const [athleteSearch, setAthleteSearch] = useState("");
  const [athleteView, setAthleteView] = useState<"all" | "categories">("all");
  const [modalityRosterKey, setModalityRosterKey] = useState("");

  async function createCompetition(event: FormEvent) {
    event.preventDefault();
    const created = await supabase.from("competitions").insert({ ...eventForm, created_by: userId }).select("id").single();
    if (created.error) return setMessage(created.error.message);
    const assignment = await supabase.from("judge_assignments").insert({ competition_id: created.data.id, judge_id: userId, panel_position: "Juez principal" });
    setMessage(assignment.error?.message || "Evento creado.");
    setEventForm({ name: "", event_date: "", venue: "" });
    setShowEventForm(false);
    setCompetitionId(created.data.id);
    await refresh();
  }

  async function changeEventStatus(status: Competition["status"]) {
    if (!competition) return;
    const updated = await supabase.from("competitions").update({ status, registration_open: status === "closed" ? false : competition.registration_open }).eq("id", competition.id);
    if (updated.error) return setMessage(updated.error.message);
    setMessage(status === "closed" ? `${competition.name} quedó guardado como evento histórico.` : status === "live" ? `${competition.name} está ahora en vivo.` : `${competition.name} volvió a preparación.`);
    await refresh();
  }

  async function deleteCompetition() {
    if (!competition || competition.created_by !== userId) return;
    const confirmed = window.confirm(`¿Eliminar definitivamente el evento “${competition.name}”?\n\nSe borrarán sus atletas, categorías, papeletas, resultados y observaciones. Esta acción no se puede deshacer.`);
    if (!confirmed) return;
    const typedName = window.prompt(`Para confirmar, escribe exactamente el nombre del evento:\n\n${competition.name}`);
    if (typedName === null) return;
    if (typedName.trim() !== competition.name) return setMessage("El nombre no coincide. El evento no fue eliminado.");
    const nextCompetition = competitions
      .filter((item) => item.id !== competition.id)
      .sort((a, b) => b.event_date.localeCompare(a.event_date))[0];
    const removed = await supabase
      .from("competitions")
      .delete()
      .eq("id", competition.id)
      .eq("created_by", userId)
      .select("id")
      .maybeSingle();
    if (removed.error) return setMessage(`No se pudo eliminar el evento: ${removed.error.message}`);
    if (!removed.data) return setMessage("El evento no fue eliminado. Solo su creador puede realizar esta acción.");
    setCompetitionId(nextCompetition?.id || "");
    setMessage(`${competition.name} y todos sus datos fueron eliminados definitivamente.`);
    await refresh();
  }

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    if (!competition) return;
    const preset = scoringPresets[categoryForm.division];
    if (!preset) return setMessage("Selecciona una modalidad.");
    const created = await supabase.from("categories").insert({ competition_id: competition.id, name: categoryForm.name, division: preset.label, status: "pending", rounds: preset.rounds, tie_break_round: preset.tieBreak });
    if (created.error) return setMessage(created.error.message);
    setCategoryForm({ name: "", division: "" });
    setMessage("Categoría creada. Ya puedes asignarle atletas.");
    await refresh();
  }

  async function createAbsoluteCategories() {
    if (!competition) return;
    const prepared = await ensureAllAbsoluteCategories(competition.id, categories);
    if (prepared.error) return setMessage(`No se pudieron preparar los absolutos: ${prepared.error}`);
    setMessage(prepared.createdNames.length ? `Categorías creadas: ${prepared.createdNames.join(", ")}.` : "Las cuatro categorías absolutas ya están creadas.");
    await refresh();
  }

  async function registerAthlete(event: FormEvent) {
    event.preventDefault();
    if (!competition || !competition.registration_open) return;
    const created = await supabase.from("athletes").insert({
      competition_id: competition.id,
      category_id: null,
      name: athleteForm.name.trim(),
      registered_division: encodeAthleteRegistration([], {}, "", [], {}, athleteForm.gender),
      bib: null,
    });
    if (created.error) return setMessage(created.error.message);
    setAthleteForm({ name: "", gender: "" });
    setMessage("Atleta registrado. Podrás completar su categoría y dorsal después.");
    await refresh();
  }

  async function toggleRegistrations() {
    if (!competition) return;
    const updated = await supabase.from("competitions").update({ registration_open: !competition.registration_open }).eq("id", competition.id);
    if (updated.error) return setMessage(updated.error.message);
    setMessage(competition.registration_open ? "Inscripciones cerradas." : "Inscripciones reabiertas.");
    await refresh();
  }

  async function createSimulation(presetKey: string) {
    if (!competition) return;
    const preset = scoringPresets[presetKey];
    if (!preset) return;
    const alreadyExists = categories.some((item) => item.is_test && presetForCategory(item)?.label === preset.label);
    if (alreadyExists) return setMessage(`La simulación de ${preset.label} ya existe.`);
    const orderIndex = Object.keys(scoringPresets).indexOf(presetKey) - 100;
    const created = await supabase.from("categories").insert({
      competition_id: competition.id,
      name: `Simulación ${preset.label}`,
      division: preset.label,
      status: "judging",
      is_test: true,
      rounds: preset.rounds,
      tie_break_round: preset.tieBreak,
      order_index: orderIndex,
    });
    if (created.error) return setMessage(created.error.message);
    setMessage(`Simulación de ${preset.label} creada. Ahora añade los atletas que quieras practicar.`);
    await refresh();
  }

  async function createAllSimulations() {
    if (!competition) return;
    const missing = Object.entries(scoringPresets).filter(([, preset]) => !categories.some((item) => item.is_test && presetForCategory(item)?.label === preset.label));
    if (!missing.length) return setMessage("Las cinco simulaciones ya están creadas.");
    const rows = missing.map(([key, preset]) => ({
      competition_id: competition.id,
      name: `Simulación ${preset.label}`,
      division: preset.label,
      status: "judging",
      is_test: true,
      rounds: preset.rounds,
      tie_break_round: preset.tieBreak,
      order_index: Object.keys(scoringPresets).indexOf(key) - 100,
    }));
    const created = await supabase.from("categories").insert(rows);
    if (created.error) return setMessage(created.error.message);
    setMessage("Las simulaciones de Figure, Bikini, Bodybuilding, Classic Physique y Men's Physique fueron creadas.");
    await refresh();
  }

  async function deleteSimulation(category: Category) {
    const removedAthletes = await supabase.from("athletes").delete().eq("category_id", category.id);
    if (removedAthletes.error) return setMessage(removedAthletes.error.message);
    const removedCategory = await supabase.from("categories").delete().eq("id", category.id);
    if (removedCategory.error) return setMessage(removedCategory.error.message);
    setMessage(`${category.name} y sus puntuaciones fueron eliminadas.`);
    await refresh();
  }

  async function assign(profile: Profile) {
    if (!competition) return;
    if (profile.role === "pending") {
      const roleResult = await supabase.from("profiles").update({ role: "judge" }).eq("id", profile.id);
      if (roleResult.error) return setMessage(roleResult.error.message);
    }
    const assignment = await supabase.from("judge_assignments").upsert({ competition_id: competition.id, judge_id: profile.id, panel_position: "Juez" }, { onConflict: "competition_id,judge_id" });
    setMessage(assignment.error?.message || `${profile.full_name || profile.email} fue asignado al panel.`);
    await refresh();
  }

  async function unassign(profile: Profile) {
    if (!competition || profile.id === userId) return;
    const judgeName = profile.full_name || profile.email;
    if (!window.confirm(`¿Desasignar a ${judgeName} de ${competition.name}?\n\nSu cuenta y su historial no se eliminarán.`)) return;
    const removed = await supabase
      .from("judge_assignments")
      .delete()
      .eq("competition_id", competition.id)
      .eq("judge_id", profile.id);
    if (removed.error) return setMessage(removed.error.message);
    setMessage(`${judgeName} fue desasignado de ${competition.name}. Su cuenta y su historial se conservaron.`);
    await refresh();
  }

  const definitiveCategories = categories.filter((item) => !item.is_test);
  const modalityOptions = Object.entries(scoringPresets).map(([key, preset]) => ({ key, label: preset.label }));
  const simulationIds = new Set(categories.filter((item) => item.is_test).map((item) => item.id));
  const registeredAthletes = athletes
    .filter((item) => item.active && item.registration_status !== "withdrawn" && !athleteCategoryIds(item).some((id) => simulationIds.has(id)))
    .sort((a, b) => a.name.localeCompare(b.name, "es-MX", { sensitivity: "base" }));
  const normalizedAthleteSearch = athleteSearch.trim().toLocaleLowerCase("es-MX");
  const filteredRegisteredAthletes = registeredAthletes.filter((athlete) => {
    if (!normalizedAthleteSearch) return true;
    const registration = athleteRegistration(athlete);
    const modalityNames = athleteModalityKeys(athlete, definitiveCategories).map((key) => scoringPresets[key]?.label ?? key).join(" ") || "pendiente de modalidad";
    const genderName = athleteGenderGroup(athlete, definitiveCategories) === "women" ? "mujer mujeres" : athleteGenderGroup(athlete, definitiveCategories) === "men" ? "hombre hombres" : "sexo por definir";
    const categoryNames = definitiveCategories.filter((category) => registration.categoryIds.includes(category.id)).map((category) => category.name).join(" ");
    const subcategories = Object.values(registration.subcategories).join(" ");
    const externalNames = registration.external ? [registration.external.finalCategory, registration.external.cutDivision, registration.external.heightClass, ...registration.external.registeredCategories].join(" ") : "";
    return [athlete.name, athlete.bib?.toString() ?? "", registration.legacyDivision, genderName, modalityNames, categoryNames, subcategories, externalNames, athlete.registration_status]
      .some((value) => value.toLocaleLowerCase("es-MX").includes(normalizedAthleteSearch));
  });
  const athleteGenderSections = [
    { key: "women" as const, label: "Mujeres", detail: "Atletas registradas como mujeres", athletes: filteredRegisteredAthletes.filter((athlete) => athleteGenderGroup(athlete, definitiveCategories) === "women") },
    { key: "men" as const, label: "Hombres", detail: "Atletas registrados como hombres", athletes: filteredRegisteredAthletes.filter((athlete) => athleteGenderGroup(athlete, definitiveCategories) === "men") },
    { key: "pending" as const, label: "Sexo por definir", detail: "Selecciona Hombre o Mujer y guarda el registro", athletes: filteredRegisteredAthletes.filter((athlete) => athleteGenderGroup(athlete, definitiveCategories) === "pending") },
  ];
  const selectedRosterModality = modalityOptions.find((modality) => modality.key === modalityRosterKey) ?? modalityOptions[0];
  const selectedRosterClasses = selectedRosterModality
    ? definitiveCategories.filter((category) => categoryPresetKey(category) === selectedRosterModality.key && !isAbsoluteCategory(category))
    : [];
  const selectedRosterAthletes = selectedRosterModality
    ? registeredAthletes.filter((athlete) => athleteInModality(athlete, selectedRosterModality.key, definitiveCategories) && athlete.registration_status !== "withdrawn")
    : [];
  const simulations = Object.entries(scoringPresets).map(([key, preset]) => ({
    key,
    preset,
    category: categories.find((item) => item.is_test && presetForCategory(item)?.label === preset.label),
  }));

  const eventYears = [...new Set(competitions.map((item) => item.event_date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const currentPanelIds = new Set(assignments.filter((item) => item.competition_id === competition?.id).map((item) => item.judge_id));

  return <section className="admin-grid">
    <div className="panel full-span event-manager">
      <div className="panel-title-row"><div><p className="eyebrow red">TEMPORADAS Y COMPETENCIAS</p><h2>Administración de eventos</h2><p className="muted">Crea regionales o campeonatos futuros. Cada evento conserva sus propios atletas, categorías, resultados y feedbacks.</p></div><button className="primary compact" onClick={() => setShowEventForm(!showEventForm)}><Plus />{showEventForm ? "Cerrar formulario" : "Nuevo evento"}</button></div>
      {(showEventForm || !competition) && <form className="event-create-form" onSubmit={createCompetition}><label>Nombre del evento<input value={eventForm.name} onChange={(e) => setEventForm({ ...eventForm, name: e.target.value })} placeholder="Ej. Regional WNBF Monterrey" required /></label><label>Fecha<input type="date" value={eventForm.event_date} onChange={(e) => setEventForm({ ...eventForm, event_date: e.target.value })} required /></label><label>Ciudad y estado<input value={eventForm.venue} onChange={(e) => setEventForm({ ...eventForm, venue: e.target.value })} placeholder="Monterrey, Nuevo León" required /></label><button className="primary compact">Crear y abrir evento</button></form>}
      {eventYears.map((year) => <div className="event-year-group" key={year}><h3>{year}</h3><div className="event-card-grid">{competitions.filter((item) => item.event_date.startsWith(year)).sort((a, b) => a.event_date.localeCompare(b.event_date)).map((item) => <button key={item.id} className={`event-card ${item.id === competition?.id ? "active" : ""}`} onClick={() => setCompetitionId(item.id)}><span><strong>{item.name}</strong><small>{new Date(`${item.event_date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "short" })} · {item.venue}</small></span><span className={`pill ${item.status}`}>{item.status === "live" ? "En vivo" : item.status === "closed" ? "Histórico" : "Preparación"}</span></button>)}</div></div>)}
      {competition && <div className="event-status-actions"><span><strong>Evento seleccionado:</strong> {competition.name}</span><div><button className="secondary compact" disabled={competition.status === "draft"} onClick={() => changeEventStatus("draft")}>Preparación</button><button className="secondary compact" disabled={competition.status === "live"} onClick={() => changeEventStatus("live")}>Poner en vivo</button><button className="danger-button compact" disabled={competition.status === "closed"} onClick={() => changeEventStatus("closed")}>Cerrar y archivar</button>{competition.created_by === userId && <button type="button" className="danger-button compact event-delete-button" onClick={deleteCompetition}><Trash2 />Eliminar evento</button>}</div></div>}
    </div>
    {!competition ? <div className="panel full-span empty"><h2>Crea tu primer evento</h2><p>Después podrás registrar atletas, categorías y jueces dentro de él.</p></div> : <>
    <div className="panel full-span simulation-manager">
      <div className="panel-title-row">
        <div><p className="eyebrow red">PRÁCTICA DEL PANEL</p><h2>Simulaciones por categoría</h2><p className="muted">Cada modalidad conserva sus porcentajes oficiales y desempate por Simetría. Puedes añadir o quitar atletas antes o durante las prácticas.</p></div>
        <button className="primary compact" onClick={createAllSimulations}>Crear las cinco</button>
      </div>
      <div className="simulation-grid">
        {simulations.map(({ key, preset, category }) => <article className="simulation-category" key={key}>
          <div className="simulation-category-head">
            <div><h3>{preset.label}</h3><p>{preset.rounds.map((round) => `${round.name} ${Math.round(round.weight * 100)}%`).join(" · ")}</p></div>
            <span className={`pill ${category ? "success" : "closed"}`}>{category ? "Lista" : "Sin crear"}</span>
          </div>
          {category ? <SimulationRoster category={category} athletes={athletes.filter((item) => item.category_id === category.id && item.active)} refresh={refresh} setMessage={setMessage} onDelete={() => deleteSimulation(category)} /> : <button className="secondary compact full-button" onClick={() => createSimulation(key)}>Crear simulación</button>}
        </article>)}
      </div>
    </div>
    <div className="panel"><div className="panel-title-row"><div><h2>Registro de atletas</h2><p className="muted">Registra únicamente a los atletas confirmados. La categoría, el dorsal y los demás datos se completan después.</p></div><span className={`pill ${competition.registration_open ? "success" : "closed"}`}>{competition.registration_open ? "Inscripciones abiertas" : "Inscripciones cerradas"}</span></div><form onSubmit={registerAthlete}><label>Nombre completo<input value={athleteForm.name} onChange={(e) => setAthleteForm({ ...athleteForm, name: e.target.value })} placeholder="Nombre y apellidos del atleta" required /></label><label>Sexo<select value={athleteForm.gender} onChange={(e) => setAthleteForm({ ...athleteForm, gender: e.target.value as AthleteGender })} required><option value="">Seleccionar</option><option value="women">Mujer</option><option value="men">Hombre</option></select></label><button className="primary compact" disabled={!competition.registration_open}>Registrar atleta</button></form><button className="text-button danger-text" onClick={toggleRegistrations}>{competition.registration_open ? "Cerrar inscripciones" : "Reabrir inscripciones"}</button></div>
    <div className="panel"><h2>Categorías definitivas</h2><p className="muted">El sistema aplicará automáticamente los criterios, porcentajes y desempate por simetría.</p><form onSubmit={createCategory}><label>Nombre de la clase<input value={categoryForm.name} onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })} placeholder="Ej. Bikini Clase A" required /></label><label>Modalidad<select value={categoryForm.division} onChange={(e) => setCategoryForm({ ...categoryForm, division: e.target.value })} required><option value="">Seleccionar modalidad</option>{Object.entries(scoringPresets).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}</select></label><button className="primary compact">Crear categoría</button></form><button type="button" className="secondary compact full-button" onClick={createAbsoluteCategories}><Trophy /> Preparar los cuatro absolutos</button><p className="muted">Crea Bikini, Men’s Physique, Classic Physique y Bodybuilding Absoluto. Sus atletas se asignan automáticamente al cerrar cada clase de origen.</p></div>
    <div className="panel full-span athlete-registration-panel">
      <div className="panel-title-row athlete-list-head">
        <div><h2>Atletas inscritos</h2><p className="muted">{registeredAthletes.length} registros · {registeredAthletes.filter((item) => athleteModalityKeys(item, definitiveCategories).length === 0 && item.registration_status !== "withdrawn").length} pendientes de modalidad</p></div>
        <div className="athlete-list-actions">{isWnbfIntegratedCompetition(competition) && <button type="button" className="secondary compact" disabled={syncingAthletes} onClick={() => void syncWnbfAthletes(true, true)}><RefreshCw className={syncingAthletes ? "spin" : ""} />{syncingAthletes ? "Sincronizando…" : "Sincronizar atletas"}</button>}{athleteView === "all" && <label className="athlete-search"><Search aria-hidden="true" /><input type="search" value={athleteSearch} onChange={(event) => setAthleteSearch(event.target.value)} placeholder="Buscar atleta, dorsal o modalidad" aria-label="Buscar atletas inscritos" /></label>}</div>
      </div>
      {isWnbfIntegratedCompetition(competition) && <div className="wnbf-sync-status"><span className="live-indicator"><i /> CONEXIÓN WNBF</span><span>Actualización automática cada 5 segundos{lastWnbfSync ? ` · última consulta ${new Date(lastWnbfSync).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</span></div>}
      <div className="athlete-view-tabs" role="tablist" aria-label="Organización de atletas">
        <button type="button" role="tab" aria-selected={athleteView === "all"} className={athleteView === "all" ? "active" : ""} onClick={() => setAthleteView("all")}><Users />Todos los atletas</button>
        <button type="button" role="tab" aria-selected={athleteView === "categories"} className={athleteView === "categories" ? "active" : ""} onClick={() => setAthleteView("categories")}><ListChecks />Por categoría</button>
      </div>
      {athleteView === "all" ? <>
        <div className="athlete-view-explainer"><strong>Lista dividida directamente por sexo</strong><span>La separación entre Mujeres y Hombres utiliza el dato elegido al registrar al atleta, sin depender de su modalidad o categoría.</span></div>
        {registeredAthletes.length === 0 ? <p className="empty-copy">Todavía no hay atletas registrados.</p> : filteredRegisteredAthletes.length === 0 ? <p className="empty-copy">No se encontraron atletas con esa búsqueda.</p> : <div className="athlete-gender-groups">{athleteGenderSections.filter((section) => section.athletes.length > 0).map((section) => <section className={`athlete-gender-group ${section.key}`} key={section.key}>
          <header><span><strong>{section.label}</strong><small>{section.detail}</small></span><b>{section.athletes.length}</b></header>
          <div className="athlete-admin-list">{section.athletes.map((athlete) => <AthleteEditor key={athlete.id} athlete={athlete} categories={definitiveCategories} refresh={refresh} setMessage={setMessage} />)}</div>
        </section>)}</div>}
      </> : <>
        <div className="athlete-view-explainer"><strong>Organización por modalidad y clase</strong><span>Selecciona una modalidad, captura talla y peso, y después asigna la clase o subcategoría exacta. El orden se recalcula automáticamente al guardar.</span></div>
        {modalityOptions.length === 0 ? <p className="empty-copy">No hay modalidades configuradas.</p> : <>
          <div className="category-roster-tabs" role="tablist" aria-label="Modalidades">{modalityOptions.map((modality) => {
            const count = registeredAthletes.filter((athlete) => athleteInModality(athlete, modality.key, definitiveCategories) && athlete.registration_status !== "withdrawn").length;
            const active = selectedRosterModality?.key === modality.key;
            return <button type="button" role="tab" aria-selected={active} className={active ? "active" : ""} key={modality.key} onClick={() => setModalityRosterKey(modality.key)}><span>{modality.label}</span><strong>{count}</strong></button>;
          })}</div>
          {selectedRosterModality && <CategoryRosterEditor modalityKey={selectedRosterModality.key} modalityLabel={selectedRosterModality.label} categories={selectedRosterClasses} athletes={selectedRosterAthletes} allCategories={definitiveCategories} refresh={refresh} setMessage={setMessage} />}
        </>}
      </>}
    </div>
    <div className="panel full-span"><h2>Panel asignado a este evento</h2><p className="muted">Escribe y guarda el nombre completo de cada integrante. Una cuenta puede participar en varios campeonatos, pero sus papeletas siempre quedan separadas por evento.</p><div className="user-list judge-profile-list">{profiles.map((item) => <JudgeProfileEditor key={item.id} profile={item} assigned={currentPanelIds.has(item.id)} isCurrentUser={item.id === userId} onAssign={() => assign(item)} onUnassign={() => unassign(item)} refresh={refresh} setMessage={setMessage} />)}</div></div>
  </>}</section>;
}

function JudgeProfileEditor({ profile, assigned, isCurrentUser, onAssign, onUnassign, refresh, setMessage }: { profile: Profile; assigned: boolean; isCurrentUser: boolean; onAssign: () => Promise<void>; onUnassign: () => Promise<void>; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const [name, setName] = useState(profile.full_name ?? "");
  const [saving, setSaving] = useState(false);
  const savedName = profile.full_name?.trim() ?? "";

  async function saveName() {
    const fullName = name.trim();
    if (!fullName) return setMessage("Escribe el nombre completo del integrante del panel.");
    setSaving(true);
    const updated = await supabase.from("profiles").update({ full_name: fullName }).eq("id", profile.id);
    setSaving(false);
    if (updated.error) return setMessage(updated.error.message);
    setMessage(`Nombre guardado: ${fullName}.`);
    await refresh();
  }

  return <div className="judge-profile-row">
    <span className="judge-profile-identity">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nombre completo" aria-label={`Nombre de ${profile.email}`} />
      <small>{profile.email} · {roleNames[profile.role]}</small>
    </span>
    <span className="judge-profile-actions">
      <button className="secondary compact" disabled={saving || !name.trim() || name.trim() === savedName} onClick={saveName}>{saving ? "Guardando…" : "Guardar nombre"}</button>
      {assigned ? <><span className="pill success">Asignado</span>{!isCurrentUser && <button className="danger-button compact" onClick={onUnassign}>Desasignar</button>}</> : <button className="secondary compact" onClick={onAssign}>Añadir al evento</button>}
    </span>
  </div>;
}

function SimulationRoster({ category, athletes, refresh, setMessage, onDelete }: { category: Category; athletes: Athlete[]; refresh: () => Promise<void>; setMessage: (value: string) => void; onDelete: () => void }) {
  const [form, setForm] = useState({ name: "", bib: "" });

  async function resetBallots() {
    const ballotResult = await supabase.from("ballots").select("id").eq("category_id", category.id);
    if (ballotResult.error) return ballotResult.error.message;
    const ballotIds = (ballotResult.data ?? []).map((item) => item.id);
    if (ballotIds.length) {
      const placementsResult = await supabase.from("placements").delete().in("ballot_id", ballotIds);
      if (placementsResult.error) return placementsResult.error.message;
      const ballotsResult = await supabase.from("ballots").update({ status: "draft", submitted_at: null, included_in_results: true, review_status: "none", review_note: null, review_requested_at: null }).eq("category_id", category.id);
      if (ballotsResult.error) return ballotsResult.error.message;
    }
    return "";
  }

  async function addAthlete(event: FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    const inserted = await supabase.from("athletes").insert({
      competition_id: category.competition_id,
      category_id: category.id,
      name,
      bib: form.bib ? Number(form.bib) : null,
      registered_division: `${category.division} · Simulación`,
      active: true,
      registration_status: "confirmed",
    });
    if (inserted.error) return setMessage(inserted.error.message);
    const resetError = await resetBallots();
    if (resetError) return setMessage(`Atleta añadido, pero no se pudieron reiniciar las papeletas: ${resetError}`);
    setForm({ name: "", bib: "" });
    setMessage(`${name} fue añadido a ${category.name}. Las papeletas de práctica quedaron listas para empezar de nuevo.`);
    await refresh();
  }

  async function removeAthlete(athlete: Athlete) {
    const updated = await supabase.from("athletes").update({ active: false, registration_status: "withdrawn" }).eq("id", athlete.id);
    if (updated.error) return setMessage(updated.error.message);
    const resetError = await resetBallots();
    if (resetError) return setMessage(`Atleta retirado, pero no se pudieron reiniciar las papeletas: ${resetError}`);
    setMessage(`${athlete.name} fue quitado de ${category.name}. Las papeletas de práctica fueron reiniciadas.`);
    await refresh();
  }

  return <div className="simulation-roster">
    <form className="simulation-athlete-form" onSubmit={addAthlete}>
      <input aria-label={`Nombre del atleta para ${category.name}`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Nombre del atleta" required />
      <input aria-label={`Dorsal del atleta para ${category.name}`} type="number" min="1" value={form.bib} onChange={(event) => setForm({ ...form, bib: event.target.value })} placeholder="Dorsal" />
      <button className="primary compact">Añadir</button>
    </form>
    <div className="simulation-athletes">
      {athletes.length === 0 ? <p className="empty-copy">Sin atletas. Añade los que quieras usar en esta práctica.</p> : athletes.sort((a, b) => (a.bib ?? 9999) - (b.bib ?? 9999) || a.name.localeCompare(b.name)).map((athlete) => <div key={athlete.id}><span><strong>{athleteBibText(athlete)}</strong>{athlete.name}</span><button className="text-button danger-text" onClick={() => removeAthlete(athlete)}>Quitar</button></div>)}
    </div>
    <button className="text-button danger-text simulation-delete" onClick={onDelete}>Eliminar esta simulación</button>
  </div>;
}

function AthleteEditor({ athlete, categories, refresh, setMessage }: { athlete: Athlete; categories: Category[]; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const initialGenderGroup = athleteGenderGroup(athlete, categories);
  const [form, setForm] = useState({ name: athlete.name, bib: athlete.bib?.toString() || "", gender: initialGenderGroup === "pending" ? "" as AthleteGender : initialGenderGroup, modalityKeys: athleteModalityKeys(athlete, categories), status: athlete.registration_status });

  useEffect(() => {
    const genderGroup = athleteGenderGroup(athlete, categories);
    setForm({ name: athlete.name, bib: athlete.bib?.toString() || "", gender: genderGroup === "pending" ? "" : genderGroup, modalityKeys: athleteModalityKeys(athlete, categories), status: athlete.registration_status });
  }, [athlete.name, athlete.bib, athlete.registered_division, athlete.category_id, athlete.registration_status]);

  function toggleModality(modalityKey: string) {
    setForm((current) => ({
      ...current,
      modalityKeys: current.modalityKeys.includes(modalityKey)
        ? current.modalityKeys.filter((key) => key !== modalityKey)
        : [...current.modalityKeys, modalityKey],
    }));
  }

  async function save() {
    const registration = athleteRegistration(athlete);
    const modalityKeys = [...new Set(form.modalityKeys)].filter((key) => Boolean(scoringPresets[key]));
    const categoryIds = registration.categoryIds.filter((id) => {
      const category = categories.find((item) => item.id === id);
      const modalityKey = category ? categoryPresetKey(category) : undefined;
      return !modalityKey || modalityKeys.includes(modalityKey);
    });
    const subcategories = Object.fromEntries(Object.entries(registration.subcategories).filter(([id]) => categoryIds.includes(id)));
    const updated = await supabase.from("athletes").update({
      name: form.name.trim(),
      registered_division: encodeAthleteRegistration(categoryIds, subcategories, registration.legacyDivision, modalityKeys, registration.absoluteQualifications, form.gender, registration.external),
      bib: form.bib ? Number(form.bib) : null,
      category_id: categoryIds[0] || null,
      registration_status: form.status,
      active: form.status !== "withdrawn",
    }).eq("id", athlete.id);
    if (updated.error) return setMessage(updated.error.message);
    setMessage(`${form.name} actualizado con ${modalityKeys.length} modalidad${modalityKeys.length === 1 ? "" : "es"}.`);
    await refresh();
  }

  async function remove() {
    const confirmed = window.confirm(`¿Eliminar definitivamente a ${athlete.name}? Esta acción también quitará sus puntuaciones y observaciones guardadas.`);
    if (!confirmed) return;
    const placementResult = await supabase.from("placements").delete().eq("athlete_id", athlete.id);
    if (placementResult.error) return setMessage(placementResult.error.message);
    const feedbackResult = await supabase.from("athlete_feedback").delete().eq("athlete_id", athlete.id);
    if (feedbackResult.error) return setMessage(feedbackResult.error.message);
    const reportResult = await supabase.from("athlete_feedback_reports").delete().eq("athlete_id", athlete.id);
    if (reportResult.error) return setMessage(reportResult.error.message);
    const removed = await supabase.from("athletes").delete().eq("id", athlete.id);
    if (removed.error) return setMessage(removed.error.message);
    setMessage(`${athlete.name} fue eliminado del registro.`);
    await refresh();
  }

  const selectedModalities = Object.entries(scoringPresets).filter(([key]) => form.modalityKeys.includes(key));
  return <div className="athlete-editor athlete-master-editor">
    <label className="athlete-master-name"><span>Atleta</span><input aria-label="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
    <label className="athlete-master-bib"><span>Dorsal</span><input aria-label="Dorsal" type="number" min="1" value={form.bib} onChange={(e) => setForm({ ...form, bib: e.target.value })} placeholder={athleteRegistration(athlete).external?.dorsalStatus === "pendiente" ? "Pendiente" : "S/N"} /></label>
    <label className="athlete-master-gender"><span>Sexo</span><select aria-label="Sexo" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as AthleteGender })}><option value="">Seleccionar</option><option value="women">Mujer</option><option value="men">Hombre</option></select></label>
    <details className="athlete-category-picker">
      <summary><span><strong>Modalidades</strong><small>{selectedModalities.length ? `${selectedModalities.length} seleccionada${selectedModalities.length === 1 ? "" : "s"}` : "Pendiente de asignar"}</small></span><span className="category-picker-count">{selectedModalities.length}</span></summary>
      <div className="athlete-category-options">{Object.entries(scoringPresets).map(([key, preset]) => <label key={key}><input type="checkbox" checked={form.modalityKeys.includes(key)} onChange={() => toggleModality(key)} /><span>{preset.label}<small>Modalidad general</small></span></label>)}</div>
    </details>
    <div className="athlete-selected-categories">{selectedModalities.length ? selectedModalities.map(([key, preset]) => <span key={key}>{preset.label}</span>) : <span className="pending">Sin modalidad</span>}</div>
    {athleteRegistration(athlete).external && <div className="external-category-list"><small>Categorías informadas por WNBF</small><div>{athleteRegistration(athlete).external?.registeredCategories.map((category) => <span key={category}>{category}</span>)}</div><small>{athleteRegistration(athlete).external?.heightClassStatus === "definida" ? `Corte: ${athleteRegistration(athlete).external?.cutDivision || athleteRegistration(athlete).external?.heightClass}` : "Talla / clase pendiente de pesaje"}</small></div>}
    <label className="athlete-master-status"><span>Estado</span><select aria-label="Estado" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Athlete["registration_status"] })}><option value="confirmed">Confirmado</option><option value="checked_in">Registro verificado</option><option value="withdrawn">Retirado</option></select></label>
    <div className="athlete-editor-actions"><button type="button" className="secondary compact" onClick={save}>Guardar</button><button type="button" className="danger-button compact" onClick={remove}>Eliminar</button></div>
  </div>;
}

function CategoryRosterEditor({ modalityKey, modalityLabel, categories, athletes, allCategories, refresh, setMessage }: { modalityKey: string; modalityLabel: string; categories: Category[]; athletes: Athlete[]; allCategories: Category[]; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const orderByWeight = modalityKey === "bodybuilding";
  const sortedAthletes = [...athletes].sort((a, b) => {
    const aValue = orderByWeight ? a.weight_kg : a.height_cm;
    const bValue = orderByWeight ? b.weight_kg : b.height_cm;
    if (aValue == null && bValue != null) return 1;
    if (aValue != null && bValue == null) return -1;
    if (aValue != null && bValue != null && aValue !== bValue) return aValue - bValue;
    return a.name.localeCompare(b.name, "es-MX", { sensitivity: "base" });
  });
  return <section className="category-roster-section">
    <header>
      <div><p className="eyebrow red">ORGANIZACIÓN POR MODALIDAD</p><h3>{modalityLabel}</h3><p>{athletes.length} atleta{athletes.length === 1 ? "" : "s"} · {categories.length} clase{categories.length === 1 ? "" : "s"} disponible{categories.length === 1 ? "" : "s"}</p></div>
      <span className={`roster-order-rule ${orderByWeight ? "weight" : "height"}`}>{orderByWeight ? <Weight /> : <Ruler />}<span><small>Orden automático</small><strong>{orderByWeight ? "Menor a mayor peso" : "Menor a mayor altura"}</strong></span></span>
    </header>
    {categories.length === 0 && <div className="category-class-warning"><AlertTriangle /><span><strong>Faltan las clases de {modalityLabel}</strong><small>Créelas arriba en “Categorías definitivas” para poder asignarlas a los atletas.</small></span></div>}
    {sortedAthletes.length ? <div className="category-athlete-list">{sortedAthletes.map((athlete, index) => <CategoryAthleteEditor key={`${modalityKey}-${athlete.id}`} position={index + 1} athlete={athlete} modalityKey={modalityKey} modalityLabel={modalityLabel} categories={categories} allCategories={allCategories} refresh={refresh} setMessage={setMessage} />)}</div> : <div className="empty-category-roster"><Users /><strong>Sin atletas asignados</strong><span>Regresa a “Todos los atletas” y marca la modalidad {modalityLabel} en las inscripciones correspondientes.</span></div>}
  </section>;
}

function CategoryAthleteEditor({ position, athlete, modalityKey, modalityLabel, categories, allCategories, refresh, setMessage }: { position: number; athlete: Athlete; modalityKey: string; modalityLabel: string; categories: Category[]; allCategories: Category[]; refresh: () => Promise<void>; setMessage: (value: string) => void }) {
  const initialClassIds = athleteCategoryIds(athlete).filter((id) => categories.some((category) => category.id === id));
  const [form, setForm] = useState({ height: athlete.height_cm?.toString() || "", weight: athlete.weight_kg?.toString() || "", classIds: initialClassIds });

  useEffect(() => {
    setForm({ height: athlete.height_cm?.toString() || "", weight: athlete.weight_kg?.toString() || "", classIds: athleteCategoryIds(athlete).filter((id) => categories.some((category) => category.id === id)) });
  }, [athlete.height_cm, athlete.weight_kg, athlete.registered_division, modalityKey]);

  function toggleClass(categoryId: string) {
    setForm((current) => ({
      ...current,
      classIds: current.classIds.includes(categoryId)
        ? current.classIds.filter((id) => id !== categoryId)
        : [...current.classIds, categoryId],
    }));
  }

  async function save() {
    const registration = athleteRegistration(athlete);
    const currentModalityCategoryIds = new Set(allCategories.filter((category) => categoryPresetKey(category) === modalityKey && !isAbsoluteCategory(category)).map((category) => category.id));
    const otherCategoryIds = registration.categoryIds.filter((id) => !currentModalityCategoryIds.has(id));
    const selectedClassIds = [...new Set(form.classIds)].filter((id) => categories.some((category) => category.id === id));
    const categoryIds = [...otherCategoryIds, ...selectedClassIds];
    const subcategories = Object.fromEntries(Object.entries(registration.subcategories).filter(([id]) => !currentModalityCategoryIds.has(id)));
    selectedClassIds.forEach((id) => {
      const category = categories.find((item) => item.id === id);
      if (category) subcategories[id] = category.name;
    });
    const modalityKeys = [...new Set([...athleteModalityKeys(athlete, allCategories), modalityKey])];
    const updated = await supabase.from("athletes").update({
      height_cm: form.height ? Number(form.height) : null,
      weight_kg: form.weight ? Number(form.weight) : null,
      category_id: categoryIds[0] || null,
      registered_division: encodeAthleteRegistration(categoryIds, subcategories, registration.legacyDivision, modalityKeys, registration.absoluteQualifications, registration.gender, registration.external),
    }).eq("id", athlete.id);
    if (updated.error) return setMessage(updated.error.message);
    setMessage(`${athlete.name} actualizado en ${modalityLabel}. El orden fue recalculado.`);
    await refresh();
  }

  const selectedClasses = categories.filter((category) => form.classIds.includes(category.id));
  return <div className="category-athlete-editor">
    <strong className="category-athlete-position">{position}</strong>
    <span className="category-athlete-identity"><strong>{athleteBibText(athlete)} · {athlete.name}</strong><small>{selectedClasses.length ? selectedClasses.map((category) => category.name).join(" · ") : "Clase pendiente"}</small></span>
    <label><span>Altura</span><span className="measurement-input"><input aria-label={`Altura de ${athlete.name}`} type="number" min="1" step="0.01" value={form.height} onChange={(event) => setForm({ ...form, height: event.target.value })} placeholder="0.00" /><small>cm</small></span></label>
    <label><span>Peso</span><span className="measurement-input"><input aria-label={`Peso de ${athlete.name}`} type="number" min="1" step="0.01" value={form.weight} onChange={(event) => setForm({ ...form, weight: event.target.value })} placeholder="0.00" /><small>kg</small></span></label>
    <details className="subcategory-field class-category-picker">
      <summary><span>Clase / subcategoría</span><strong>{selectedClasses.length ? `${selectedClasses.length} seleccionada${selectedClasses.length === 1 ? "" : "s"}` : "Pendiente"}</strong></summary>
      <div>{categories.length ? categories.map((category) => <label key={category.id}><input type="checkbox" checked={form.classIds.includes(category.id)} onChange={() => toggleClass(category.id)} /><span>{category.name}</span></label>) : <p>Primero crea las clases de {modalityLabel}.</p>}</div>
    </details>
    <button type="button" className="secondary compact" onClick={save}>Guardar</button>
  </div>;
}
