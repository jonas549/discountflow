// Máquina de estados de los jobs. Pura y sin dependencias: se puede probar sin BD
// y la usan tanto el worker (servidor) como la barra (cliente).
//
// La regla que sostiene todo el sistema: TODA transición a un estado terminal debe
// poner Campaign.activeJobId a null EN LA MISMA TRANSACCIÓN. Si no, la campaña
// queda bloqueada para siempre por un job muerto. Eso se garantiza en
// jobs.server.ts (finishJob), no aquí; aquí solo se define qué es terminal.

export type JobStatus =
  | "QUEUED"
  | "RESOLVING"
  | "RUNNING"
  | "CANCELLING"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "FAILED"
  | "CANCELLED";

export type JobOperation = "NOOP" | "APPLY" | "REACTIVATE" | "REVERT" | "DELETE";

export type JobPhase = "RESOLVING" | "APPLYING" | "FINALIZING";

const TERMINAL: ReadonlySet<JobStatus> = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);

/**
 * Transiciones válidas. Cualquier par que no esté aquí se rechaza.
 *
 * RUNNING -> QUEUED existe y NO es un error: es el vigilante devolviendo al ruedo
 * un job cuyo heartbeat quedó rancio (el worker anterior murió). Es la única
 * transición "hacia atrás" del sistema y está acotada por MAX_ATTEMPTS.
 */
const TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  QUEUED: new Set(["RESOLVING", "RUNNING", "CANCELLING", "FAILED"] as JobStatus[]),
  RESOLVING: new Set(["RUNNING", "QUEUED", "CANCELLING", "FAILED"] as JobStatus[]),
  RUNNING: new Set([
    "RUNNING",
    "QUEUED",
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "CANCELLING",
    "FAILED",
  ] as JobStatus[]),
  CANCELLING: new Set(["CANCELLED", "FAILED"] as JobStatus[]),
  COMPLETED: new Set([] as JobStatus[]),
  COMPLETED_WITH_ERRORS: new Set([] as JobStatus[]),
  FAILED: new Set([] as JobStatus[]),
  CANCELLED: new Set([] as JobStatus[]),
};

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

/** Lanza si la transición no es válida. Se usa en el servidor antes de escribir. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to))
    throw new Error(`Transición de job inválida: ${from} -> ${to}`);
}

/**
 * ¿Puede otro worker reclamar este job?
 *
 * Sí en dos casos: nunca arrancó (QUEUED), o arrancó y su worker murió sin dejar
 * rastro (heartbeat rancio). El segundo es la definición operativa de ZOMBI.
 */
export function isClaimable(
  status: JobStatus,
  heartbeatAt: Date | null,
  now: Date,
  staleMs: number
): boolean {
  if (status === "QUEUED") return true;
  if (status !== "RUNNING" && status !== "RESOLVING") return false;
  if (!heartbeatAt) return true;
  return now.getTime() - heartbeatAt.getTime() > staleMs;
}

/**
 * Margen para un job recién creado: lo normal es que arranque en menos de un
 * segundo. Despertarlo dos veces no hace daño (solo un worker gana el reclamo).
 */
export const QUEUED_GRACE_MS = 15_000;

/** Un job no terminal que dejó de dar señales. Lo mira la UI para re-patearlo. */
export function isStalled(
  status: JobStatus,
  heartbeatAt: Date | null,
  now: Date,
  staleMs: number,
  /**
   * Cuándo se creó el job. Con este dato, un job que sigue EN COLA sin haber
   * latido nunca pasado el margen de gracia cuenta como colgado: se creó pero
   * la llamada que debía arrancarlo se perdió (pasa con el paso 2 de una
   * edición grande), y sin esto nadie lo despertaba jamás. Sin el dato se
   * conserva el comportamiento anterior (no se toca un job recién creado).
   */
  createdAt?: Date | null
): boolean {
  if (isTerminal(status)) return false;
  if (status === "QUEUED" && !heartbeatAt)
    return !!createdAt && now.getTime() - createdAt.getTime() > QUEUED_GRACE_MS;
  if (!heartbeatAt) return false;
  return now.getTime() - heartbeatAt.getTime() > staleMs;
}

/**
 * Porcentaje para la barra.
 *
 * Devuelve null mientras no se sabe el total: durante la resolución del catálogo no
 * hay denominador, y un 0 % inmóvil durante 30 segundos se lee como un cuelgue.
 * null = barra indeterminada + "Buscando productos…".
 */
export function percentOf(
  processed: number,
  total: number,
  status: JobStatus
): number | null {
  if (isTerminal(status)) return status === "COMPLETED" || status === "COMPLETED_WITH_ERRORS" ? 100 : null;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((processed / total) * 100)));
}

// ---------------------------------------------------------------------------
// Edición en dos pasos (solo para la barra)
// ---------------------------------------------------------------------------

/**
 * En qué paso de una EDICIÓN va un job, o null si el job no forma parte de una
 * edición en dos pasos (crear, pausar, activar, eliminar: un paso solo).
 *
 * Editar una campaña activa son dos jobs seguidos sobre la misma campaña:
 *   1) un REVERT que lleva la edición en `payload.editNext` (con `activate`);
 *   2) el APPLY/REACTIVATE que el motor encola al terminar, marcado `editStep: 2`.
 *
 * Es solo información para la pantalla: el motor no decide nada con esto.
 */
export type EditStep = { current: 1 | 2; total: 2 };

export function editStepOf(operation: string, payload: unknown): EditStep | null {
  const p = (payload ?? {}) as { editNext?: { activate?: unknown }; editStep?: unknown };
  if (operation === "REVERT" && p.editNext?.activate === true)
    return { current: 1, total: 2 };
  if ((operation === "APPLY" || operation === "REACTIVATE") && p.editStep === 2)
    return { current: 2, total: 2 };
  return null;
}

/**
 * Texto de la barra para un job que es un paso de una edición. Devuelve null
 * cuando el texto de siempre ya sirve (cancelado, fallido, con incidencias…).
 */
export function editStepMessage(
  step: EditStep,
  status: JobStatus,
  phase: string,
  processedVariants: number,
  totalVariants: number
): string | null {
  const n = (v: number) => v.toLocaleString("es-CL");
  const paso = `Paso ${step.current} de ${step.total}`;
  const tarea =
    step.current === 1 ? "devolviendo los precios originales" : "aplicando el descuento nuevo";

  if (status === "QUEUED" || status === "RESOLVING" || (status === "RUNNING" && phase === "RESOLVING"))
    return `${paso}: ${tarea}…`;
  if (status === "RUNNING")
    return `${paso}: ${tarea} — ${n(processedVariants)} de ${n(totalVariants)} variantes`;
  if (status === "COMPLETED")
    return step.current === 1
      ? "Paso 1 de 2 listo: precios originales devueltos. Ahora empieza el paso 2…"
      : `Paso 2 de 2 listo: descuento nuevo aplicado a ${n(totalVariants)} variantes`;
  return null;
}
