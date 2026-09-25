// Arma el script del widget que sirve `/apps/discountflow/cupones-viaje.js`.
//
// 🔴 Nada de esto puede lanzar: ni al cargar el módulo ni al llamarlo. El build
// de servidor importa TODAS las rutas al arrancar, y un `throw` a nivel de
// módulo en la ruta del script tumbaba la app entera, en las 7 tiendas (riesgo A
// del plan de despliegue, 2026-09-26).

import { ATRIBUTOS_DEL_CARRITO } from "./cupones-viaje.ts";

/** Dónde el servidor escribe los nombres de los atributos dentro del widget. */
export const MARCA_ATRIBUTOS = "/*__DF_ATRIBUTOS__*/null";

/**
 * El script listo para servir. Si la marca faltara (alguien la borró del
 * widget), se sirve el widget TAL CUAL: sin los atributos adentro pide sus
 * nombres al proxy (`?modo=carrito`) y funciona igual, un poco más lento. Se
 * registra el error para enterarse, pero la tienda no nota nada.
 */
export function armarScript(fuente: unknown): string {
  try {
    if (typeof fuente !== "string") return "";
    if (!fuente.includes(MARCA_ATRIBUTOS)) {
      console.error("[cupones-viaje] falta la marca de atributos en el widget: se sirve sin ellos");
      return fuente;
    }
    return fuente.replace(MARCA_ATRIBUTOS, JSON.stringify(ATRIBUTOS_DEL_CARRITO));
  } catch (err) {
    console.error("[cupones-viaje] no se pudo armar el script del widget", err);
    return typeof fuente === "string" ? fuente : "";
  }
}
