// Lee las opciones y variantes de un viaje para que el formulario pueda
// proponer qué opción es la modalidad y contar cuántas variantes caen en cada una.
//
// Solo informa a la pantalla. Lo que se GUARDA se vuelve a resolver en el
// servidor al guardar (`guardarCampana`), nunca se toma de esta respuesta.

import type { LoaderFunctionArgs } from "react-router";
import { abrirCuponesDeViaje } from "../lib/cupones-viaje/admin.server";
import { leerProductoDeViaje, nombresUsadosEnElViaje } from "../lib/cupones-viaje/cupones-viaje.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop } = await abrirCuponesDeViaje(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  // La campaña que se está editando no cuenta: sus propios nombres no chocan.
  const excepto = url.searchParams.get("excepto") || undefined;
  if (!id.startsWith("gid://shopify/Product/"))
    return Response.json({ error: "Producto inválido." }, { status: 400 });
  try {
    const [producto, nombresUsados] = await Promise.all([
      leerProductoDeViaje(admin, id),
      nombresUsadosEnElViaje(shop.id, id, excepto),
    ]);
    return Response.json({ producto, nombresUsados });
  } catch (err) {
    return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502 });
  }
};
