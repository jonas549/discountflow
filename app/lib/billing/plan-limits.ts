// Client-safe constants — no server imports.
// DB query helpers are in plan-limits.server.ts

export const PLANS = ["FREE", "LITE", "ESSENTIAL", "PROFESSIONAL"] as const;
export type Plan = (typeof PLANS)[number];

/**
 * Tipos de campaña que se gobiernan por PLAN, no por variantes.
 *
 * PERCENTAGE y RANGE quedan fuera a propósito: están en todos los planes y se
 * topan por cantidad de variantes, que es otro eje.
 */
export type TypeLimitedCampaign =
  | "BXGY"
  | "TIERED"
  | "PACK"
  | "CART_VALUE"
  | "CODE_ORIGINAL_PRICE";

/**
 * Qué puede hacer un plan con un tipo de campaña.
 *
 * 🔴 Antes esto NO existía. `PLAN_LIMITS` solo sabía de CANTIDADES
 * (`maxBxgy`/`maxTiered`), y `null` significaba "sin sublímite" — que las rutas
 * interpretaban como *saltarse la comprobación entera*. Consecuencia real:
 * FREE tenía `maxBxgy: null`, así que **una tienda del plan gratuito podía
 * crear y activar campañas BxGy y Escalonadas**, acotada solo por el tope
 * general de 2. La tabla de planes decía lo contrario desde hacía meses.
 *
 * Por eso ahora "no incluido" y "incluido sin tope" son dos estados DISTINTOS y
 * explícitos, en vez de compartir el valor `null`. Esto no es solo el eje que
 * necesitan los tipos nuevos: cierra ese agujero.
 */
export type TypeRule =
  /** El plan no incluye este tipo de campaña. */
  | { incluido: false }
  /** Incluido. `max` = máximo de ACTIVAS simultáneas; `null` = sin sublímite. */
  | { incluido: true; max: number | null };

// `types` es la ÚNICA autoridad. Los campos `maxBxgy`/`maxTiered` que había
// antes se quitaron: eran los mismos números escritos en un segundo sitio, que
// es exactamente el problema que este cambio elimina.
// Pausadas y borradores NO cuentan: pausar una para activar otra es válido.
export const PLAN_LIMITS = {
  FREE: {
    campaigns: 2,
    variants: 50,
    types: {
      BXGY: { incluido: false },
      TIERED: { incluido: false },
      PACK: { incluido: false },
      CART_VALUE: { incluido: false },
      CODE_ORIGINAL_PRICE: { incluido: false },
    },
    price: 0,
    trialDays: 0,
    handle: "free",
    label: "Gratis",
  },
  LITE: {
    campaigns: 5,
    variants: 750,
    types: {
      BXGY: { incluido: true, max: 4 },
      TIERED: { incluido: true, max: 2 },
      PACK: { incluido: false },
      // 🔴 SUPUESTO, no una decision tomada por Jonas. Es el tipo mas simple de
      // los tres de pago y el mejor gancho para salir de FREE, asi que entra
      // desde LITE con un tope bajo. Si la tabla real dice otra cosa, se cambia
      // este renglon y el de `plan-limits.test.ts`: no hay un tercer sitio.
      CART_VALUE: { incluido: true, max: 2 },
      // Decision de Jonas del 2026-09-05: solo ESSENTIAL y PROFESSIONAL.
      CODE_ORIGINAL_PRICE: { incluido: false },
    },
    price: 9.99,
    trialDays: 0,
    handle: "lite",
    label: "Lite",
  },
  ESSENTIAL: {
    campaigns: 50,
    variants: 6000,
    types: {
      BXGY: { incluido: true, max: 10 },
      TIERED: { incluido: true, max: 10 },
      // Sin sublímite propio: lo acota el tope general de 50 campañas.
      PACK: { incluido: true, max: null },
      CART_VALUE: { incluido: true, max: null },
      // Sin sublimite propio: un merchant puede tener un cupon por influencer.
      CODE_ORIGINAL_PRICE: { incluido: true, max: null },
    },
    price: 27.99,
    trialDays: 0,
    handle: "essential",
    label: "Essential",
  },
  PROFESSIONAL: {
    campaigns: 100,
    variants: 10000,
    types: {
      BXGY: { incluido: true, max: null },
      TIERED: { incluido: true, max: null },
      PACK: { incluido: true, max: null },
      CART_VALUE: { incluido: true, max: null },
      // Sin sublimite propio: un merchant puede tener un cupon por influencer.
      CODE_ORIGINAL_PRICE: { incluido: true, max: null },
    },
    price: 44.99,
    trialDays: 0,
    handle: "professional",
    label: "Professional",
  },
} as const;

/**
 * Los tipos que dependen del plan. Cualquier otro (PERCENTAGE, RANGE) devuelve
 * `null` y no pasa por este eje.
 */
export function esTipoLimitadoPorPlan(type: string): type is TypeLimitedCampaign {
  return (
    type === "BXGY" ||
    type === "TIERED" ||
    type === "PACK" ||
    type === "CART_VALUE" ||
    type === "CODE_ORIGINAL_PRICE"
  );
}

/**
 * 🔴 LA ÚNICA fuente de verdad de "¿este plan puede tener esta campaña activa?".
 *
 * Se colapsó aquí a propósito. La comprobación vivía copiada en cinco sitios, y
 * con los tipos nuevos habrían sido nueve: cada copia es un lugar donde alguien
 * puede desincronizarla mañana. Es la misma lección que dejó el flag
 * `jobs:batched` leído en tres lugares el 2026-08-09 — la inconsistencia se
 * evita por construcción, no por disciplina.
 */
export function reglaDeTipo(plan: Plan, type: TypeLimitedCampaign): TypeRule {
  return PLAN_LIMITS[plan].types[type];
}

export function handleToPlan(handle: string | null | undefined): Plan {
  if (!handle) return "FREE";
  const up = handle.toUpperCase();
  return (PLANS as readonly string[]).includes(up) ? (up as Plan) : "FREE";
}

/**
 * Igual que `handleToPlan`, pero devuelve `null` cuando el handle NO se reconoce,
 * en vez de caer a FREE.
 *
 * 🔴 Por qué hacen falta las dos: `handleToPlan` responde `"FREE"` tanto para el
 * handle `"free"` (que Shopify sí manda: al bajar al plan gratuito crea una
 * suscripción ACTIVE con `planHandle: "free"`) como para un handle que no
 * conocemos. Quien tiene que decidir si una tienda baja de plan no puede
 * confundir esos dos casos: el primero es una instrucción explícita de Shopify y
 * el segundo es ambigüedad, y la ambigüedad nunca debe mover el plan. Con `null`
 * se distinguen.
 *
 * La comparación es EXACTA (sin subcadenas, sin heurísticas). Matear por
 * aproximación es lo que causó el bug de junio con `name`. Si el Partner
 * Dashboard tuviera un handle distinto a estos cuatro, esto devuelve `null`, el
 * plan se conserva y el motivo queda en el log para añadirlo a mano.
 */
export function planFromHandle(handle: string | null | undefined): Plan | null {
  if (!handle) return null;
  const up = handle.trim().toUpperCase();
  return (PLANS as readonly string[]).includes(up) ? (up as Plan) : null;
}

export function getPlanLimits(plan: Plan) {
  return PLAN_LIMITS[plan];
}
