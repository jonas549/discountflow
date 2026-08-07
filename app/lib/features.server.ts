// Flags por tienda. Se guardan en Shop.features (JSON) y se cambian con un UPDATE,
// sin desplegar: es un interruptor de emergencia que actúa en segundos.
//
// 🔒 REGLA DE ORO: falla CERRADO.
//    Ausencia, tipo inesperado, JSON corrupto o error de lectura → flag APAGADO →
//    camino estable. Un flag que "falla abierto" convierte cualquier incidencia de
//    datos en un despliegue accidental de código nuevo sobre clientes que pagan.
//
// 🔴 SEGUNDA REGLA: el flag gobierna solo la ENTRADA (crear jobs nuevos), NUNCA al
//    worker. Si se apaga con jobs en vuelo, esos jobs DEBEN terminar. Si el
//    interruptor matara también a los workers, sería él mismo quien generase los
//    estados parciales que todo este sistema existe para evitar.

export type FeatureFlag = "jobs:batched";

type ShopLike = { features?: unknown } | null | undefined;

export function hasFeature(shop: ShopLike, flag: FeatureFlag): boolean {
  try {
    const raw = shop?.features;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    return (raw as Record<string, unknown>)[flag] === true;
  } catch {
    return false;
  }
}

/** Todos los flags activos de una tienda. Solo para mostrar en pantallas internas. */
export function activeFeatures(shop: ShopLike): string[] {
  try {
    const raw = shop?.features;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  } catch {
    return [];
  }
}
