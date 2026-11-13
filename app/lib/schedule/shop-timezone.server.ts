// Zona horaria de la tienda: se lee de Shopify una vez y se guarda en Shop.
import prisma from "../../db.server.ts";
import { isValidTimeZone } from "./shop-time.ts";

type AdminLike = { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> };

/**
 * Devuelve la zona IANA de la tienda ("America/Santiago"). Si no está guardada la
 * pide a Shopify (`shop.ianaTimezone`, no requiere permisos extra) y la persiste.
 *
 * Nunca lanza: si Shopify no responde devuelve "UTC", que es lo que hacía el
 * código antes de existir esto, y no guarda nada para reintentar la próxima vez.
 */
export async function shopTimezone(
  admin: unknown,
  shop: { id: string; ianaTimezone?: string | null }
): Promise<string> {
  if (isValidTimeZone(shop.ianaTimezone)) return shop.ianaTimezone;
  try {
    const res = await (admin as AdminLike).graphql(`#graphql
      query ZonaHorariaDeLaTienda { shop { ianaTimezone } }`);
    const json = (await res.json()) as { data?: { shop?: { ianaTimezone?: string } } };
    const tz = json.data?.shop?.ianaTimezone;
    if (!isValidTimeZone(tz)) return "UTC";
    await prisma.shop.update({ where: { id: shop.id }, data: { ianaTimezone: tz } });
    return tz;
  } catch (err) {
    console.error("[schedule] no se pudo leer la zona horaria de la tienda:", err);
    return "UTC";
  }
}
