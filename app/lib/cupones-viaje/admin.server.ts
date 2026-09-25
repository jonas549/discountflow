// Entrada común de las pantallas de cupones de viaje en el admin.
//
// Autentica, trae la tienda y CORTA con 404 si la tienda no tiene el flag. Así
// ninguna ruta de esta feature puede olvidarse de la puerta: todas empiezan acá.
// Un 404 y no un 403 a propósito — para las demás tiendas esto no existe.
//
// La tienda se LEE, no se crea: el layout `app.tsx` ya hace el `getOrCreateShop`
// en cada carga. Repetirlo acá sería otra escritura por pantalla sin ganar nada.

import { authenticate } from "../../shopify.server";
import { prisma } from "../db";
import { tieneCuponesDeViaje } from "./acceso.server";

export async function abrirCuponesDeViaje(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop || !tieneCuponesDeViaje(shop)) throw new Response("No encontrado", { status: 404 });
  return { admin, shop };
}

/** La simulación de pedidos existe solo fuera de producción. */
export const esProduccion = () => process.env.NODE_ENV === "production";
