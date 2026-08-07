// Errores del motor de jobs.
//
// La distinción que importa es una sola: ¿reintentar o morir?
//
//   - Un fallo TRANSITORIO (red, throttling agotado, un 500 de Shopify) merece
//     reintento: el runner encadena otra vez y el freno de MAX_ATTEMPTS decide.
//   - Un fallo FATAL no mejora reintentando. Superar la cuota del plan o quedarse
//     sin selección que resolver van a fallar exactamente igual las cinco veces,
//     y mientras tanto el merchant mira una barra que no avanza. Se corta ya, con
//     el motivo a la vista.
//
// Se detecta por `name` y no con `instanceof`, igual que PlanLimitError: entre el
// bundle de servidor y el runner de tests puede haber dos copias de la clase y
// `instanceof` falla en silencio.

export class JobFatalError extends Error {
  readonly name = "JobFatalError";
  /** true si el motivo es la cuota del plan: la UI ofrece el enlace a Planes. */
  readonly planLimit: boolean;

  constructor(message: string, opts?: { planLimit?: boolean }) {
    super(message);
    this.planLimit = opts?.planLimit ?? false;
  }
}

export function isJobFatal(err: unknown): err is JobFatalError {
  return err instanceof Error && err.name === "JobFatalError";
}

export function isPlanLimitFailure(err: unknown): boolean {
  return isJobFatal(err) && err.planLimit;
}
