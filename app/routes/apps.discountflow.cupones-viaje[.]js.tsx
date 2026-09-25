// El script del widget de cupones de viaje, servido por el app proxy:
// `/apps/discountflow/cupones-viaje.js` en la tienda.
//
// Se sirve por acá y no como asset de una extensión de tema para no sacar una
// app version: una extensión de tema viaja con TODAS las Functions y aparece en
// el editor de temas de todas las tiendas. Esto es de una sola.
//
// El código no es secreto (es JavaScript que corre en el navegador del
// comprador), así que no se exige firma: lo que sí la exige es el JSON con los
// cupones (`apps.discountflow.cupones-viaje.tsx`).
//
// 🔴 NADA de este módulo se ejecuta al cargarse: todo vive en el `loader` (ver
// `script-servido.ts`, riesgo A del plan de despliegue).

import widget from "../lib/cupones-viaje/widget-tienda.js?raw";
import { armarScript } from "../lib/cupones-viaje/script-servido";

let armado: string | null = null;

export const loader = async () => {
  if (armado === null) armado = armarScript(widget);
  return new Response(armado, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Corta: un arreglo del widget tiene que llegar a la tienda en minutos,
      // no en un día. Es un archivo chico; el costo de revalidarlo es nada.
      "Cache-Control": "public, max-age=300",
    },
  });
};
