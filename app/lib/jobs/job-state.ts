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

/** Un job no terminal que dejó de dar señales. Lo mira la UI para re-patearlo. */
export function isStalled(
  status: JobStatus,
  heartbeatAt: Date | null,
  now: Date,
  staleMs: number
): boolean {
  if (isTerminal(status)) return false;
  if (status === "QUEUED" && !heartbeatAt) return false;
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
