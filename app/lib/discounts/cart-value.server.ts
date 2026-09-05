// Consultas de servidor que necesita el formulario de valor de carrito.
//
// Separado de `cart-value.ts` porque eso habla con Shopify y esto con Postgres,
// y de `cart-value-client.ts` porque ese lo importa el componente de React.

import { prisma } from "../db";
import type {
  PackParaExcluir,
  CampanasQuePuedenChocar,
} from "../../components/CartValueCampaignForm";

export type { PackParaExcluir, CampanasQuePuedenChocar };

/**
 * Qué otras campañas activas pueden interferir con un descuento por monto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 POR QUÉ VIENEN SEPARADAS EN DOS LISTAS
 *
 * Con los PACKS el merchant decide: los dos descuentos se suman salvo que él
 * marque la exclusión. Eso se puede porque el widget de packs deja una marca
 * (`_df_pack`) en cada línea del carrito, y la Function la lee.
 *
 * Con los ESCALONADOS y los BxGy no se puede, y no por falta de ganas: sus
 * descuentos se crean con `combinesWith.orderDiscounts: false` —código que
 * está en producción sirviendo a clientes que pagan— así que Shopify descarta
 * el descuento por monto ANTES de que nuestra Function llegue a opinar. Y
 * cambiarlo no es gratis: ese `false` también bloquea descuentos de orden de
 * OTRAS apps y de la propia Shopify, así que voltearlo cambia el
 * comportamiento de tiendas vivas y es una decisión de producto, no una
 * corrección.
 *
 * Mientras siga así, lo único honesto es DECIRLO en el formulario. Es la mitad
 * del requisito: que no se pierda un descuento sin que nadie se entere.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function campanasQuePuedenChocar(
  shopId: string
): Promise<CampanasQuePuedenChocar> {
  const campanas = await prisma.campaign.findMany({
    where: {
      shopId,
      type: { in: ["PACK", "TIERED", "BXGY"] },
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, type: true, status: true },
  });

  const etiqueta = (c: { name: string; status: string }) =>
    c.status === "PAUSED" ? `${c.name} (pausada)` : c.name;

  return {
    // Se incluyen las PAUSADAS a propósito: un pack pausado hoy puede volver
    // mañana, y si al reactivarlo la exclusión ya no estuviera guardada, el
    // merchant tendría que acordarse de volver a marcarla — que es justo el
    // tipo de paso que nadie recuerda y termina en un descuento perdido.
    // Los borradores quedan fuera: todavía no existen como descuento en
    // Shopify y no pueden estar aplicando en ningún carrito.
    packs: campanas
      .filter((c) => c.type === "PACK")
      .map((c): PackParaExcluir => ({ id: c.id, name: etiqueta(c) })),
    bloqueantes: campanas
      .filter((c) => c.type !== "PACK")
      .map((c) => etiqueta(c)),
  };
}
