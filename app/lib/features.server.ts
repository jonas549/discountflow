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

export type FeatureFlag =
  | "jobs:batched"
  // Cupones de viaje: feature de UNA tienda (GeoTerraViajes). Se lee SOLO a
  // través de `tieneCuponesDeViaje()` (app/lib/cupones-viaje/acceso.server.ts).
  | "cupones:viaje";

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

/**
 * ¿Va esta tienda por el motor de jobs (la barra de progreso)?
 *
 * 🟢 ENCENDIDO DE FÁBRICA (decisión de Jonas, 2026-11-13). Una tienda que
 * instala la app tiene la barra desde el primer momento, sin que nadie toque la
 * base. Se apaga SOLO si la tienda tiene `"jobs:batched": false` explícito: ese
 * es el interruptor de emergencia por tienda, y sigue siendo un UPDATE.
 *
 * Es la excepción deliberada a la regla de arriba ("falla cerrado"): aquí el
 * camino estable ES el motor —lo usan todas las tiendas que pagan desde agosto—
 * y el síncrono es el que revienta a los 300 s con campañas grandes. Ausencia,
 * JSON raro o error de lectura → motor.
 *
 * ÚNICO punto de lectura: nadie más debe mirar `jobs:batched` por su cuenta (la
 * lección del 2026-08-09, cuando se leía en tres sitios).
 */
export function jobsEnabled(shop: ShopLike): boolean {
  try {
    const raw = shop?.features;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    return (raw as Record<string, unknown>)["jobs:batched"] !== false;
  } catch {
    return true;
  }
}
