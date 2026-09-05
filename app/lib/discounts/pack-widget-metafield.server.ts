// Escribe en Shopify el metafield que lee el bloque de tema.
//
// Que va DENTRO del metafield y por que, en `pack-widget-metafield.ts`, que es
// puro y esta cubierto por tests. Aca solo estan las llamadas a la API.

import type { AdminClient } from "./discount-mutation";
import { runDiscountMutation } from "./discount-mutation";
import { prisma } from "../db";
import { packsActivosDeLaTienda } from "./pack-widget-payload.server";
import {
  PACK_WIDGET_NAMESPACE,
  PACK_WIDGET_KEY,
  construirMetafieldDeWidget,
} from "./pack-widget-metafield";

export { PACK_WIDGET_NAMESPACE, PACK_WIDGET_KEY, construirMetafieldDeWidget };

const DEFINICION = `#graphql
  mutation dfPackWidgetDefinicion($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { code field message }
    }
  }`;

const ESCRIBIR = `#graphql
  mutation dfPackWidgetSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message }
    }
  }`;

const ID_DE_TIENDA = `#graphql
  query dfShopId { shop { id } }`;

/**
 * Crea la definición del metafield. Idempotente: si ya existe, no es un error.
 *
 * Hace falta —o al menos hay reportes de que hace falta— para que un metafield
 * del namespace reservado `$app:` sea legible desde Liquid: la definición es la
 * que declara `storefront: PUBLIC_READ`. Como no se puede zanjar leyendo la
 * documentación, se crea siempre y se ignora el "ya existe".
 */
export async function asegurarDefinicionDeWidget(admin: AdminClient): Promise<void> {
  const res = await admin.graphql(DEFINICION, {
    variables: {
      definition: {
        name: "DiscountFlow · configuración del widget de packs",
        namespace: PACK_WIDGET_NAMESPACE,
        key: PACK_WIDGET_KEY,
        ownerType: "SHOP",
        type: "json",
        access: { storefront: "PUBLIC_READ" },
      },
    },
  });
  const json = await res.json();

  const errores =
    (json.data?.metafieldDefinitionCreate?.userErrors as
      | Array<{ code?: string; message: string }>
      | undefined) ?? [];
  // TAKEN = la definición ya existe. Es el caso normal a partir de la segunda
  // vez y no tiene nada de malo.
  const reales = errores.filter((e) => e.code !== "TAKEN");
  if (reales.length)
    throw new Error(
      `No se pudo crear la definición del metafield del widget: ${reales
        .map((e) => e.message)
        .join(", ")}`
    );
}

/**
 * Reescribe el metafield con TODOS los packs activos de la tienda.
 *
 * Se llama después de cada guardado, activación, pausa y borrado. No es
 * incremental a propósito: recalcular desde Postgres el estado completo es una
 * consulta barata y no puede dejar el metafield describiendo un mundo que ya no
 * existe, que es lo que pasa cuando se parchea campo a campo.
 *
 * 🔴 NUNCA LANZA. Si Shopify rechaza la escritura, la campaña ya está guardada y
 * el descuento ya está creado: hacer fallar la operación entera por el camino
 * rápido del widget sería cambiar un problema de rendimiento por uno de datos.
 * El widget cae al app proxy, que sigue funcionando.
 */
export async function sincronizarMetafieldDeWidget(
  admin: AdminClient,
  shopId: string
): Promise<{ ok: boolean; packs: number; error?: string }> {
  try {
    // La moneda se busca acá y no la pasa el llamador: es un parámetro más que
    // seis sitios distintos podrían pasar mal, y ninguno de ellos la tiene a
    // mano en todos los caminos.
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { currency: true },
    });
    if (!shop) throw new Error(`No existe la tienda ${shopId}.`);

    const payloads = await packsActivosDeLaTienda(shopId, shop.currency);
    const valor = construirMetafieldDeWidget(payloads);

    await asegurarDefinicionDeWidget(admin);

    const res = await admin.graphql(ID_DE_TIENDA);
    const json = await res.json();
    const ownerId = json.data?.shop?.id as string | undefined;
    if (!ownerId) throw new Error("Shopify no devolvió el id de la tienda.");

    await runDiscountMutation(
      admin,
      ESCRIBIR,
      {
        metafields: [
          {
            ownerId,
            namespace: PACK_WIDGET_NAMESPACE,
            key: PACK_WIDGET_KEY,
            type: "json",
            value: JSON.stringify(valor),
          },
        ],
      },
      "metafieldsSet"
    );

    return { ok: true, packs: Object.keys(valor.packs).length };
  } catch (err) {
    console.error("[pack-widget-metafield] no se pudo sincronizar", err);
    return { ok: false, packs: 0, error: String(err) };
  }
}
