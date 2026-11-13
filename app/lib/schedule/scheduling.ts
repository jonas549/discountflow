// Reglas de la programación de campañas. Puro: sin BD ni red.
//
// Hasta el 2026-11-13 las fechas se guardaban y no hacían nada: una campaña con
// inicio futuro quedaba como borrador para siempre y una con fin nunca terminaba.
//
// Cómo funciona ahora:
//  - Al guardar, la app enciende `autoStart` y/o `autoEnd` en la campaña.
//  - Un cron (cada 5 min) busca campañas con marca encendida y fecha vencida y
//    encola el job que corresponde en el motor. La marca se apaga al dispararse,
//    así que cada fecha actúa UNA sola vez.
//  - 🔒 Las campañas guardadas antes de esto tienen las dos marcas en false: sus
//    fechas viejas, aunque estén vencidas, no disparan nada.

export type ScheduleIntent = "draft" | "activate";

export type ScheduleFlags = {
  /** El inicio es futuro: no se activa ahora. */
  isScheduled: boolean;
  /** Activar sola al llegar `startsAt`. Solo si el merchant pidió activar. */
  autoStart: boolean;
  /** Pausar sola al llegar `endsAt`. */
  autoEnd: boolean;
};

/** Qué marcas guardar según lo que el merchant puso en el formulario. */
export function scheduleFlags(input: {
  intent: ScheduleIntent;
  startsAt: Date | null;
  endsAt: Date | null;
  now: Date;
}): ScheduleFlags {
  const { intent, startsAt, endsAt, now } = input;
  const isScheduled = startsAt !== null && startsAt.getTime() > now.getTime();
  return {
    isScheduled,
    // "Guardar como borrador" con fecha futura NO programa nada: borrador es borrador.
    autoStart: intent === "activate" && isScheduled,
    // Un fin ya pasado al guardar no se programa: dispararía en el próximo tick.
    autoEnd: endsAt !== null && endsAt.getTime() > now.getTime(),
  };
}

export type DueCampaign = {
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  autoStart: boolean;
  autoEnd: boolean;
  activeJobId: string | null;
};

export type DueAction =
  /** Llegó la hora de inicio: activar. */
  | "start"
  /** Llegó la hora de fin: pausar. */
  | "end"
  /** El inicio venció pero el fin también: ya no tiene sentido arrancar. */
  | "expired"
  /** La marca quedó sin efecto (el merchant ya la activó o pausó a mano). */
  | "clear-start"
  | "clear-end"
  | null;

/**
 * Qué hacer con una campaña en este tick, o null si nada.
 *
 * Con una operación en curso (`activeJobId`) no se toca: se reintenta en el
 * próximo tick, cinco minutos después.
 */
export function dueAction(c: DueCampaign, now: Date): DueAction {
  if (c.activeJobId) return null;
  const t = now.getTime();
  const startDue = c.autoStart && c.startsAt !== null && c.startsAt.getTime() <= t;
  const endDue = c.autoEnd && c.endsAt !== null && c.endsAt.getTime() <= t;

  if (startDue) {
    if (c.status === "ACTIVE") return "clear-start"; // ya la activaron a mano
    if (c.endsAt !== null && c.endsAt.getTime() <= t) return "expired";
    if (c.status === "DRAFT" || c.status === "PAUSED") return "start";
    return "clear-start";
  }
  if (endDue) return c.status === "ACTIVE" ? "end" : "clear-end";
  return null;
}

/** Texto corto para la fila del listado, o null si no hay nada programado. */
export function scheduleLabel(
  c: {
    status: string;
    startsAt: Date | null;
    endsAt: Date | null;
    autoStart: boolean;
    autoEnd: boolean;
  },
  now: Date,
  fmt: (d: Date) => string
): string | null {
  const t = now.getTime();
  if (c.autoStart && c.startsAt && c.status !== "ACTIVE") {
    const fin = c.autoEnd && c.endsAt ? ` · termina el ${fmt(c.endsAt)}` : "";
    return `Programada: empieza el ${fmt(c.startsAt)}${fin}`;
  }
  // Descuentos que Shopify enciende solo (BxGy, escalonado, pack…): activos con
  // inicio futuro.
  if (c.status === "ACTIVE" && c.startsAt && c.startsAt.getTime() > t) {
    const fin = c.endsAt ? ` · termina el ${fmt(c.endsAt)}` : "";
    return `Programada: empieza el ${fmt(c.startsAt)}${fin}`;
  }
  if (c.status === "ACTIVE" && c.autoEnd && c.endsAt) return `Termina el ${fmt(c.endsAt)}`;
  return null;
}

// ─── Lo que se guarda para aplicar al llegar la hora de inicio ────────────────

export type SelectionInput = {
  selectionMode: string;
  selectedProducts?: unknown[];
  collectionIds?: string[];
  selectedTags?: string[];
  selectedVendors?: string[];
  selectedProductTypes?: string[];
};

/** Valor JSON: lo que admite la columna `config`. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** La selección en la forma exacta que espera el APPLY del motor. */
export function buildSelection(i: SelectionInput): { [k: string]: Json } {
  const raw = {
    selectionMode: i.selectionMode,
    selectedProducts: i.selectionMode === "products" ? i.selectedProducts : undefined,
    collectionIds: i.selectionMode === "collections" ? i.collectionIds : undefined,
    selectedTags: i.selectionMode === "tags" ? i.selectedTags : undefined,
    selectedVendors: i.selectionMode === "vendors" ? i.selectedVendors : undefined,
    selectedProductTypes: i.selectionMode === "productTypes" ? i.selectedProductTypes : undefined,
  };
  // Ida y vuelta por JSON: quita los `undefined` y deja solo datos serializables.
  return JSON.parse(JSON.stringify(raw)) as { [k: string]: Json };
}

/**
 * Trozo de config que deja guardada la selección de una campaña PROGRAMADA, para
 * que el cron la aplique a su hora sin el merchant delante. Sin programación no
 * añade nada (y así una edición posterior borra el pendiente anterior).
 */
export function pendingApplyConfig(
  autoStart: boolean,
  selection: SelectionInput,
  excludedVariantIds?: Iterable<string>
): { pendingApply?: { selection: { [k: string]: Json }; excludedVariantIds: string[] } } {
  if (!autoStart) return {};
  return {
    pendingApply: {
      selection: buildSelection(selection),
      excludedVariantIds: [...(excludedVariantIds ?? [])],
    },
  };
}
