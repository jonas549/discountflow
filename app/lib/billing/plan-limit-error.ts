// Error de límite de plan. Sin imports: seguro en cliente y en servidor.
//
// Lo lanzan applyPercentageDiscount / applyRangeDiscount cuando la selección
// resuelta supera la cuota de variantes del plan. Se lanza ANTES de escribir
// nada (ni en la BD ni en Shopify), así que el llamador puede abortar limpio.

export class PlanLimitError extends Error {
  /** Variantes que la selección resolvió. */
  readonly requested: number;
  /** Variantes que aún caben en el plan. Puede ser 0 o negativo. */
  readonly allowed: number;

  constructor(requested: number, allowed: number) {
    super(
      `Límite de plan superado: la selección resuelve ${requested} variantes y solo quedan ${allowed} disponibles.`
    );
    this.name = "PlanLimitError";
    this.requested = requested;
    this.allowed = allowed;
  }
}

/**
 * Comprueba por `name` y no con `instanceof`: si el bundler llegara a duplicar
 * el módulo, `instanceof` fallaría en silencio y el error de límite se
 * reportaría como un 500 genérico, perdiendo el banner de "Ver planes".
 */
export function isPlanLimitError(err: unknown): err is PlanLimitError {
  return err instanceof Error && err.name === "PlanLimitError";
}
