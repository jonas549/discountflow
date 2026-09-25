// El ÚNICO punto que decide si una tienda tiene cupones de viaje.
//
// 🔴 Todo lo que toca esta feature pregunta ACÁ: el listado de campañas, las
// rutas del admin, el app proxy de la tienda y el bloque del webhook. Nadie
// llama a `hasFeature(shop, "cupones:viaje")` por su cuenta.
//
// Es la lección del 2026-08-09: el flag `jobs:batched` se leía en tres sitios
// independientes, y que los tres dijeran lo mismo dependía de la disciplina de
// quien tocara el código. Acá depende de que exista una sola función.
//
// Se enciende para UNA tienda, sin desplegar:
//
//   UPDATE "Shop" SET features = features || '{"cupones:viaje": true}'::jsonb
//   WHERE domain = 'la-tienda.myshopify.com';
//
// Y se apaga con `features = features - 'cupones:viaje'`. Falla CERRADO: sin el
// flag, o con el JSON roto, la feature no existe para esa tienda (404 en sus
// rutas, proxy vacío, el webhook ni la mira).

import { hasFeature } from "../features.server.ts";

export const CUPONES_VIAJE_FLAG = "cupones:viaje" as const;

export function tieneCuponesDeViaje(shop: { features?: unknown } | null | undefined): boolean {
  return hasFeature(shop, CUPONES_VIAJE_FLAG);
}
