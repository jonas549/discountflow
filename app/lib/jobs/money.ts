// Aritmética de dinero en centavos enteros.
//
// Módulo puro y sin dependencias a propósito: el cálculo de precios es lo único
// del motor que se puede equivocar sin que falle nada —no lanza, no rompe un test
// de integración, solo cobra mal— así que vive aparte y se prueba solo.
//
// El problema que resuelve: un `Number` no representa 38,675. El más cercano es
// 38,674999999999997158, de modo que `base * (1 - pct/100)` seguido de
// `toFixed(2)` devolvía 38,67 en vez de 38,68 para 45,50 al 15 %.
// `Math.round(x * 100) / 100` tampoco lo arregla: hereda el mismo error de origen.

/** Pesos → centavos enteros. Absorbe el ruido binario de la entrada. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Centavos enteros → "38.68". No vuelve a pasar por coma flotante. */
export function centsToString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Aplica un porcentaje de descuento sobre un importe en centavos.
 *
 * El medio centavo se resuelve AL ALZA (4550 al 15 % → 3867,5 → 3868), que es lo
 * que espera quien mira el precio: 45,50 menos 15 % es 38,68.
 */
export function applyPercentCents(baseCents: number, percent: number): number {
  return Math.round((baseCents * (100 - percent)) / 100);
}
