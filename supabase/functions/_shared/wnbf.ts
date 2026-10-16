import { createClient } from "npm:@supabase/supabase-js@2";

export const WNBF_COMPETITION_ID = "7100f2e2-d02b-445e-85f2-8e3ab163f441";
export const WNBF_ATHLETES_URL = "https://app.wnbfmexico.com/api/jueceo/externo/atletas";
export const WNBF_WEBHOOK_URL = "https://app.wnbfmexico.com/api/jueceo/externo/webhook";
export const REGISTRATION_PREFIX = "WNBF_REGISTRATION_V1:";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export async function getWnbfSecret(
  service: ReturnType<typeof serviceClient>,
  name: "WNBF_API_KEY_LECTURA" | "WNBF_API_KEY_WEBHOOK",
) {
  const { data, error } = await service.rpc("get_wnbf_secret", { secret_name: name });
  if (error || typeof data !== "string" || !data) {
    throw new Error(`Falta configurar ${name} en Supabase Vault`);
  }
  return data;
}

export async function requireUser(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return { error: json({ error: "No autorizado" }, 401) };
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: { user }, error } = await authClient.auth.getUser();
  if (error || !user) return { error: json({ error: "Sesión inválida" }, 401) };
  const service = serviceClient();
  const profile = await service.from("profiles").select("id,full_name,email,role").eq("id", user.id).maybeSingle();
  if (profile.error || !profile.data) return { error: json({ error: "Perfil no encontrado" }, 403) };
  return { user, profile: profile.data, service };
}

export async function requireOperator(req: Request) {
  const authenticated = await requireUser(req);
  if ("error" in authenticated) return authenticated;
  if (!["admin", "head_judge"].includes(authenticated.profile.role)) {
    return { error: json({ error: "Solo el administrador o juez principal puede realizar esta acción" }, 403) };
  }
  return authenticated;
}

export function normalize(value: unknown) {
  return String(value ?? "")
    .toLocaleLowerCase("es-MX")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export type RegistrationMeta = {
  categoryIds: string[];
  modalityKeys: string[];
  subcategories: Record<string, string>;
  absoluteQualifications: Record<string, string[]>;
  legacyDivision: string;
  gender: "women" | "men" | "";
  external: null | {
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
};

export function parseRegistration(value: unknown): RegistrationMeta {
  const empty: RegistrationMeta = {
    categoryIds: [], modalityKeys: [], subcategories: {}, absoluteQualifications: {},
    legacyDivision: typeof value === "string" && value !== "Por definir" ? value : "", gender: "", external: null,
  };
  if (typeof value !== "string" || !value.startsWith(REGISTRATION_PREFIX)) return empty;
  try {
    const saved = JSON.parse(value.slice(REGISTRATION_PREFIX.length));
    const external = saved?.external?.source === "wnbf_mexico" && typeof saved.external.athleteId === "string"
      ? {
          source: "wnbf_mexico" as const,
          athleteId: saved.external.athleteId,
          dorsalStatus: saved.external.dorsalStatus === "asignado" ? "asignado" as const : "pendiente" as const,
          finalCategory: String(saved.external.finalCategory ?? ""),
          registeredCategories: strings(saved.external.registeredCategories),
          cutDivision: String(saved.external.cutDivision ?? ""),
          heightClass: String(saved.external.heightClass ?? ""),
          heightClassStatus: saved.external.heightClassStatus === "definida" ? "definida" as const : "pendiente" as const,
          affiliationYear: String(saved.external.affiliationYear ?? ""),
          registrationComplete: saved.external.registrationComplete === true,
          polygraphApproved: saved.external.polygraphApproved === true,
          importedCategoryIds: strings(saved.external.importedCategoryIds),
          importedModalityKeys: strings(saved.external.importedModalityKeys),
          updatedAt: String(saved.external.updatedAt ?? ""),
        }
      : null;
    return {
      categoryIds: strings(saved?.categoryIds),
      modalityKeys: strings(saved?.modalityKeys),
      subcategories: objectOfStrings(saved?.subcategories),
      absoluteQualifications: objectOfStringArrays(saved?.absoluteQualifications),
      legacyDivision: typeof saved?.legacyDivision === "string" ? saved.legacyDivision : "",
      gender: saved?.gender === "women" || saved?.gender === "men" ? saved.gender : "",
      external,
    };
  } catch {
    return empty;
  }
}

export function encodeRegistration(meta: RegistrationMeta) {
  return `${REGISTRATION_PREFIX}${JSON.stringify({
    ...meta,
    categoryIds: [...new Set(meta.categoryIds)],
    modalityKeys: [...new Set(meta.modalityKeys)],
  })}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function objectOfStringArrays(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strings(item)]));
}

export function modalityKey(value: unknown) {
  const name = normalize(value);
  if (name.includes("classicphysique") || name.includes("fisicoclasico")) return "classic_physique";
  if (name.includes("mensphysique") || name.includes("menphysique")) return "mens_physique";
  if (name.includes("bodybuilding") || name.includes("culturismo")) return "bodybuilding";
  if (name.includes("figure")) return "figure";
  if (name.includes("bikini")) return "bikini";
  return "";
}

function categoryClass(value: unknown) {
  const name = normalize(value);
  if (name.includes("lightweight") || name.includes("lighweight") || name.includes("pesoligero")) return "lightweight";
  if (name.includes("middleweight") || name.includes("pesomedio")) return "middleweight";
  if (name.includes("heavyweight") || name.includes("pesopesado")) return "heavyweight";
  if (name.includes("novice") || name.includes("novato")) return "novice";
  if (name.includes("mediumtall") || name.includes("medianalta")) return "mediumtall";
  if (name.includes("medium") || name.includes("mediana")) return "medium";
  if (name.includes("short") || name.includes("baja")) return "short";
  if (name.includes("tall") || name.includes("alta")) return "tall";
  if (name.includes("open") || name.includes("abierta")) return "open";
  return "";
}

export function matchImportedCategories(
  athlete: Record<string, unknown>,
  categories: Array<{ id: string; name: string; division: string; is_test: boolean }>,
) {
  const labels = [String(athlete.categoria_final ?? ""), ...strings(athlete.categorias_inscritas)];
  const divisionCut = String(athlete.division_corte ?? "");
  const heightClass = String(athlete.talla ?? "");
  const divisionClass = categoryClass(`${divisionCut} ${heightClass}`);
  const desired = new Map<string, Set<string>>();
  for (const label of labels) {
    const key = modalityKey(label);
    if (!key) continue;
    const classes = desired.get(key) ?? new Set<string>();
    const explicitClass = categoryClass(label);
    if (explicitClass) classes.add(explicitClass);
    if (!explicitClass && divisionClass) classes.add(divisionClass);
    if (!explicitClass && key === "figure") classes.add("open");
    desired.set(key, classes);
  }
  const categoryIds: string[] = [];
  const subcategories: Record<string, string> = {};
  for (const category of categories) {
    if (category.is_test || normalize(category.name).includes("absolut")) continue;
    const key = modalityKey(`${category.division} ${category.name}`);
    const wantedClasses = desired.get(key);
    if (!key || !wantedClasses) continue;
    const localClass = categoryClass(category.name);
    if (localClass && wantedClasses.has(localClass)) {
      categoryIds.push(category.id);
      subcategories[category.id] = category.name;
    }
  }
  return { categoryIds, modalityKeys: [...desired.keys()], subcategories };
}

export function mazatlanIso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mazatlan", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}-07:00`;
}

