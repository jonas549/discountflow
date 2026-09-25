// App proxy: los cupones de viaje de un producto, para el widget de la tienda.
//
// Ruta pública en el STOREFRONT: `/apps/discountflow/cupones-viaje?product=<id>`
// Shopify la reenvía firmada a esta ruta (ver `[app_proxy]` en el .toml).
//
// Sin el flag `cupones:viaje` responde 404 y el widget se oculta: para las
// demás tiendas esta ruta no existe.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { tieneCuponesDeViaje } from "../lib/cupones-viaje/acceso.server";
import { payloadDeLaTienda, payloadPorCodigo } from "../lib/cupones-viaje/cupones-viaje.server";
import { ATRIBUTOS_DEL_CARRITO } from "../lib/cupones-viaje/cupones-viaje";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Caché CORTA a propósito: el stock cambia con cada compra, y un cupón
      // agotado que la tienda sigue mostrando como disponible es exactamente lo
      // que el comprador no tiene que ver. 15 s bastan para absorber ráfagas.
      "Cache-Control": "public, max-age=15",
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verifica la firma HMAC que pone Shopify: sin esto cualquiera podría leer
  // los cupones —y sus códigos— de cualquier tienda pasando `?shop=`.
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = url.searchParams.get("shop");
  if (!domain) return json({ campana: null }, 400);

  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true, features: true },
  });
  if (!shop || !tieneCuponesDeViaje(shop)) return json({ campana: null }, 404);

  // Modo carrito del widget (página del carrito): primero pide qué atributos
  // leer, y después la campaña del código que encontró anotado.
  if (url.searchParams.get("modo") === "carrito")
    return json({ atributos: ATRIBUTOS_DEL_CARRITO });
  const codigo = url.searchParams.get("codigo");
  if (codigo !== null) {
    if (!/^[A-Z0-9]{4,40}$/i.test(codigo)) return json({ campana: null }, 400);
    return json({ campana: await payloadPorCodigo(shop.id, codigo) });
  }

  const product = url.searchParams.get("product") ?? "";
  if (!/^\d+$/.test(product)) return json({ campana: null }, 400);
  return json({ campana: await payloadDeLaTienda(shop.id, product) });
};
