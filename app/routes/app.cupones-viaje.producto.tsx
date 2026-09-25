// Lee las opciones y variantes de un viaje para que el formulario pueda
// proponer qué opción es la modalidad y contar cuántas variantes caen en cada una.
//
// Solo informa a la pantalla. Lo que se GUARDA se vuelve a resolver en el
// servidor al guardar (`guardarCampana`), nunca se toma de esta respuesta.

import type { LoaderFunctionArgs } from "react-router";
import { abrirCuponesDeViaje } from "../lib/cupones-viaje/admin.server";
import { leerProductoDeViaje } from "../lib/cupones-viaje/cupones-viaje.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await abrirCuponesDeViaje(request);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id.startsWith("gid://shopify/Product/"))
    return Response.json({ error: "Producto inválido." }, { status: 400 });
  try {
    return Response.json({ producto: await leerProductoDeViaje(admin, id) });
  } catch (err) {
    return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502 });
  }
};
