// Cupones de viaje — base de datos y Shopify.
//
// Las REGLAS (qué se publica, qué consume un pedido) están en `cupones-viaje.ts`,
// que es puro y tiene sus tests. Acá está lo que no se puede probar sin una base:
// guardar, sincronizar los códigos nativos y consumir stock sin pasarse.

import { Prisma } from "@prisma/client";
import prisma from "../../db.server.ts";
import type { AdminClient } from "../discounts/discount-mutation.ts";
import { readQueryData } from "../shopify/admin-api.ts";
import {
  ATRIBUTO_CUPON,
  ATRIBUTO_SALDO,
  ATRIBUTOS_DEL_CARRITO,
  clasificarVariantes,
  cuponesAMostrar,
  cuponesPublicados,
  decidirConsumos,
  estaAgotado,
  generarCodigo,
  limiteDeUsoEnShopify,
  repartirPasajeros,
  usosRestantes,
  type CampanaParaPedido,
  type Consumo,
  type CuponDelFormulario,
  type DatosDelFormulario,
  type OpcionDeProducto,
  type PedidoParaCupones,
  type VarianteConOpciones,
} from "./cupones-viaje.ts";
import {
  activarCodigo,
  actualizarCodigo,
  crearCodigo,
  desactivarCodigo,
  eliminarCodigo,
} from "./codigos-shopify.ts";

// ─── El producto ──────────────────────────────────────────────────────────────

export type ProductoDeViaje = {
  id: string;
  title: string;
  options: OpcionDeProducto[];
  variants: VarianteConOpciones[];
};

/**
 * Lee el viaje de la Admin API: sus opciones y sus variantes con las opciones
 * elegidas. Es la ÚNICA fuente de las listas de variantes que se guardan.
 *
 * 🔴 Lanza si no puede leerlo. Un `?? []` acá convertiría un token vencido en
 * «el producto no tiene variantes de pago total», y el cupón quedaría
 * guardado sin aplicar a nada — el patrón que este repo ya arregló cinco veces.
 */
export async function leerProductoDeViaje(
  admin: AdminClient,
  productId: string
): Promise<ProductoDeViaje> {
  const res = await admin.graphql(
    `#graphql
    query ProductoDeViaje($id: ID!) {
      product(id: $id) {
        id
        title
        options { name values }
        variants(first: 250) { nodes { id title price selectedOptions { name value } } }
      }
    }`,
    { variables: { id: productId } }
  );
  // `readQueryData` lanza ante `errors` o una respuesta sin datos; solo un
  // producto que de verdad no existe llega acá como null.
  const product = readQueryData<{
    id: string;
    title: string;
    options: OpcionDeProducto[];
    variants: { nodes: VarianteConOpciones[] };
  }>(await res.json(), "product", "ProductoDeViaje");
  if (!product) throw new Error("El producto ya no existe en la tienda.");
  return {
    id: product.id,
    title: product.title,
    options: product.options,
    variants: product.variants.nodes,
  };
}

// ─── Lectura para el admin ────────────────────────────────────────────────────

const conCupones = {
  coupons: { orderBy: { position: "asc" as const } },
} satisfies Prisma.TravelCouponCampaignInclude;

export type CampanaConCupones = Prisma.TravelCouponCampaignGetPayload<{
  include: typeof conCupones;
}>;

export async function campanasDeLaTienda(shopId: string) {
  return prisma.travelCouponCampaign.findMany({
    where: { shopId },
    include: { ...conCupones, _count: { select: { redemptions: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function campanaDeLaTienda(shopId: string, id: string) {
  return prisma.travelCouponCampaign.findFirst({
    where: { id, shopId },
    include: conCupones,
  });
}

export async function canjesDeLaCampana(campaignId: string) {
  return prisma.travelCouponRedemption.findMany({
    where: { campaignId },
    include: { coupon: { select: { label: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

// ─── Guardar ──────────────────────────────────────────────────────────────────

const ids = (json: unknown): string[] =>
  Array.isArray(json) ? json.filter((x): x is string => typeof x === "string") : [];

/**
 * Crea o edita una campaña con sus cupones, y deja Shopify al día.
 *
 * Qué se protege:
 *
 *   · Las listas de variantes se resuelven ACÁ, contra la Admin API. Lo que
 *     manda el navegador es solo qué opción y qué valores eligió el merchant.
 *   · Un cupón que ya tiene canjes no se puede quitar: es el comprobante de un
 *     saldo que la agencia todavía tiene que cobrar. Se puede editar su
 *     etiqueta, su monto y subir su stock, nada más.
 *   · El orden de los cupones sale del orden de la lista del formulario.
 */
export async function guardarCampana(
  admin: AdminClient,
  shopId: string,
  datos: DatosDelFormulario,
  cupones: CuponDelFormulario[],
  opciones: { campaignId?: string; estado?: "ACTIVE" | "DRAFT" }
): Promise<string> {
  const producto = await leerProductoDeViaje(admin, datos.productId);
  const clasificadas = clasificarVariantes(
    producto.variants,
    datos.optionName,
    datos.fullPaymentValue,
    datos.reservationValue
  );
  if (clasificadas.fullPayment.length === 0 && clasificadas.reservation.length === 0)
    throw new Error(
      `Ninguna variante de «${producto.title}» tiene «${datos.optionName}» igual a ` +
        `«${datos.fullPaymentValue}» o «${datos.reservationValue}». Revisá la opción elegida.`
    );

  const anterior = opciones.campaignId
    ? await prisma.travelCouponCampaign.findFirst({
        where: { id: opciones.campaignId, shopId },
        include: { coupons: { include: { _count: { select: { redemptions: true } } } } },
      })
    : null;
  if (opciones.campaignId && !anterior) throw new Error("La campaña no existe.");

  const quedan = new Set(cupones.map((c) => c.id).filter(Boolean));
  const quitados = (anterior?.coupons ?? []).filter((c) => !quedan.has(c.id));
  const conCanjes = quitados.find((c) => c._count.redemptions > 0 || c.used > 0);
  if (conCanjes)
    throw new Error(
      `«${conCanjes.label}» ya tiene canjes y no se puede quitar: es el comprobante de ` +
        "saldos que la agencia todavía cobra. Podés dejarlo como está."
    );

  const datosCampana = {
    name: datos.name,
    productId: producto.id,
    productTitle: producto.title,
    optionName: datos.optionName,
    fullPaymentValue: datos.fullPaymentValue,
    reservationValue: datos.reservationValue,
    fullPaymentVariantIds: clasificadas.fullPayment,
    reservationVariantIds: clasificadas.reservation,
    visibleCount: datos.visibleCount,
    autoApply: datos.autoApply,
    heading: datos.heading,
    messageFullPayment: datos.messageFullPayment,
    messageReservation: datos.messageReservation,
  };

  // Los códigos de los cupones quitados se borran en Shopify ANTES de tocar la
  // base: si fallara, el cupón sigue en la app y se puede reintentar. Al revés
  // quedaría un código vivo en Shopify que ya nadie administra.
  for (const c of quitados)
    if (c.shopifyDiscountId) await eliminarCodigo(admin, c.shopifyDiscountId);

  const campaignId = await prisma.$transaction(async (tx) => {
    const campana = anterior
      ? await tx.travelCouponCampaign.update({
          where: { id: anterior.id },
          data: { ...datosCampana, ...(opciones.estado ? { status: opciones.estado } : {}) },
        })
      : await tx.travelCouponCampaign.create({
          data: { ...datosCampana, shopId, status: opciones.estado ?? "DRAFT" },
        });

    if (quitados.length)
      await tx.travelCoupon.deleteMany({ where: { id: { in: quitados.map((c) => c.id) } } });

    // Reordenar sin chocar con el único (campaignId, position): primero todas a
    // posiciones negativas —distintas entre sí y de cualquier definitiva— y
    // después cada una a la suya.
    await tx.travelCoupon.updateMany({
      where: { campaignId: campana.id },
      data: { position: { multiply: -1 } },
    });

    for (let i = 0; i < cupones.length; i++) {
      const c = cupones[i];
      const datosCupon = { position: i + 1, label: c.label, amount: c.amount, stock: c.stock };
      const existente = c.id && anterior?.coupons.find((x) => x.id === c.id);
      if (existente)
        await tx.travelCoupon.update({ where: { id: existente.id }, data: datosCupon });
      else
        await tx.travelCoupon.create({
          data: { ...datosCupon, campaignId: campana.id, code: generarCodigo() },
        });
    }
    return campana.id;
  });

  try {
    await sincronizarConShopify(admin, campaignId, {
      actualizarTodos: true,
      variantesAnteriores: ids(anterior?.fullPaymentVariantIds),
    });
  } catch (err) {
    // 🔴 Campaña NUEVA que Shopify rechazó: se deshace entera, igual que en los
    // otros tipos. Si quedara en la base, el merchant vería el error, volvería
    // a guardar desde «Nueva» y tendría DOS campañas — una huérfana y activa
    // sin códigos. Medido: pasó en la primera verificación contra la tienda.
    //
    // En una EDICIÓN no se deshace nada: lo guardado es lo que el merchant
    // pidió, y la próxima sincronización (al abrir la campaña) reintenta.
    if (!anterior) {
      const creados = await prisma.travelCoupon.findMany({
        where: { campaignId, shopifyDiscountId: { not: null } },
        select: { shopifyDiscountId: true },
      });
      for (const c of creados)
        await eliminarCodigo(admin, c.shopifyDiscountId!).catch((e) =>
          console.error("[cupones-viaje] no se pudo borrar un código al deshacer:", e)
        );
      await prisma.travelCouponCampaign.delete({ where: { id: campaignId } });
    }
    throw err;
  }
  return campaignId;
}

// ─── Shopify al día ───────────────────────────────────────────────────────────

/**
 * Pedidos de Pago total de cada cupón: los que Shopify ya contó como usos del
 * código. Ver `limiteDeUsoEnShopify` para por qué hacen falta.
 */
async function pedidosDePagoTotalPorCupon(campaignId: string): Promise<Map<string, number>> {
  const filas = await prisma.travelCouponRedemption.groupBy({
    by: ["couponId"],
    where: { campaignId, mode: "FULL_PAYMENT" },
    _count: { _all: true },
  });
  return new Map(filas.map((f) => [f.couponId, f._count._all]));
}

/**
 * Deja cada código nativo como tiene que estar: activo solo si la campaña está
 * activa Y el cupón está publicado; con el límite de usos que corresponde.
 *
 * Es IDEMPOTENTE y se puede llamar cuantas veces haga falta: al guardar, al
 * activar o pausar, después de cada canje y al abrir la campaña en el admin.
 * Por eso la liberación del siguiente cupón no depende de que un paso concreto
 * salga bien: si algo falló, la próxima llamada lo arregla.
 *
 * `actualizarTodos` reescribe monto, variantes y límite de los códigos que
 * quedan activos. Sin él solo se crean, activan y desactivan (lo barato).
 */
export async function sincronizarConShopify(
  admin: AdminClient,
  campaignId: string,
  opciones: { actualizarTodos?: boolean; variantesAnteriores?: string[] } = {}
): Promise<void> {
  const campana = await prisma.travelCouponCampaign.findUnique({
    where: { id: campaignId },
    include: conCupones,
  });
  if (!campana) return;

  const publicados = new Set(
    cuponesPublicados(campana.coupons, campana.visibleCount).map((c) => c.id)
  );
  const pedidosPagoTotal = await pedidosDePagoTotalPorCupon(campaignId);
  const variantIds = ids(campana.fullPaymentVariantIds);

  for (const c of campana.coupons) {
    const debeEstarActivo = campana.status === "ACTIVE" && publicados.has(c.id);
    const datos = {
      title: `[DiscountFlow] ${campana.name} · ${c.label}`,
      code: c.code,
      amount: Number(c.amount),
      variantIds,
      usageLimit: limiteDeUsoEnShopify(c.stock, c.used, pedidosPagoTotal.get(c.id) ?? 0),
    };

    if (debeEstarActivo) {
      if (!c.shopifyDiscountId) {
        const id = await crearCodigo(admin, datos);
        await prisma.travelCoupon.update({
          where: { id: c.id },
          data: { shopifyDiscountId: id, shopifyActive: true },
        });
        continue;
      }
      if (opciones.actualizarTodos)
        await actualizarCodigo(admin, c.shopifyDiscountId, datos, opciones.variantesAnteriores ?? []);
      if (!c.shopifyActive) {
        await activarCodigo(admin, c.shopifyDiscountId);
        await prisma.travelCoupon.update({ where: { id: c.id }, data: { shopifyActive: true } });
      }
    } else if (c.shopifyDiscountId && c.shopifyActive) {
      await desactivarCodigo(admin, c.shopifyDiscountId);
      await prisma.travelCoupon.update({ where: { id: c.id }, data: { shopifyActive: false } });
    }
  }
}

/** ¿Hay algún código que no está como debería? Barato: solo mira la base. */
export function necesitaSincronizar(campana: CampanaConCupones): boolean {
  const publicados = new Set(
    cuponesPublicados(campana.coupons, campana.visibleCount).map((c) => c.id)
  );
  return campana.coupons.some((c) => {
    const debe = campana.status === "ACTIVE" && publicados.has(c.id);
    return debe ? !c.shopifyDiscountId || !c.shopifyActive : c.shopifyActive;
  });
}

export async function cambiarEstado(
  admin: AdminClient,
  shopId: string,
  campaignId: string,
  estado: "ACTIVE" | "PAUSED"
): Promise<void> {
  const r = await prisma.travelCouponCampaign.updateMany({
    where: { id: campaignId, shopId },
    data: { status: estado },
  });
  if (r.count === 0) throw new Error("La campaña no existe.");
  await sincronizarConShopify(admin, campaignId);
}

/**
 * Elimina una campaña SIN canjes. Con canjes, no: solo se puede pausar.
 *
 * 🔴 Los canjes son lo que la agencia mira para descontar saldos que todavía
 * no cobró. Borrarlos con la campaña —el cascade lo haría— sería borrar la
 * única prueba de que a ese comprador se le prometió un descuento.
 */
export async function eliminarCampana(
  admin: AdminClient,
  shopId: string,
  campaignId: string
): Promise<void> {
  const campana = await prisma.travelCouponCampaign.findFirst({
    where: { id: campaignId, shopId },
    include: { coupons: true, _count: { select: { redemptions: true } } },
  });
  if (!campana) throw new Error("La campaña no existe.");
  if (campana._count.redemptions > 0)
    throw new Error(
      "Esta campaña ya tiene canjes: no se puede eliminar, porque son el comprobante de " +
        "los saldos a descontar. Pausala para que deje de ofrecerse."
    );
  for (const c of campana.coupons)
    if (c.shopifyDiscountId) await eliminarCodigo(admin, c.shopifyDiscountId);
  await prisma.travelCouponCampaign.delete({ where: { id: campana.id } });
}

// ─── Consumir stock ───────────────────────────────────────────────────────────

export type ResultadoDelConsumo = "registrado" | "excedente" | "repetido";

/**
 * Registra un canje SIN pasarse del stock, aunque lleguen dos pedidos a la vez
 * por los últimos cupos. El stock cuenta PASAJEROS: un pedido de 3 consume 3.
 *
 * Cómo: dentro de una transacción, `SELECT … FOR UPDATE` bloquea la fila del
 * cupón; el segundo pedido espera a que el primero termine y lee el `used` ya
 * incrementado. Solo uno encuentra stock.
 *
 * El que llega tarde NO se descarta: el pedido existe y el comprador vio el
 * cupón disponible. Se registra con `excess = true` y la agencia decide. En
 * Pago total el descuento ya lo aplicó Shopify; en Reserva, es la agencia la
 * que resuelve si lo respeta.
 *
 * Idempotente: el mismo pedido dos veces (Shopify reintenta webhooks) no
 * consume dos veces — lo impide el único (couponId, shopifyOrderId).
 */
export async function consumirCupon(
  consumo: Consumo,
  pedido: { id: string; name: string },
  source: "webhook" | "simulado"
): Promise<ResultadoDelConsumo> {
  return prisma.$transaction(async (tx) => {
    const filas = await tx.$queryRaw<Array<{ used: number; stock: number }>>`
      SELECT "used", "stock" FROM "TravelCoupon" WHERE "id" = ${consumo.couponId} FOR UPDATE`;
    if (filas.length === 0) throw new Error(`El cupón ${consumo.couponId} no existe.`);

    const ya = await tx.travelCouponRedemption.findUnique({
      where: {
        couponId_shopifyOrderId: { couponId: consumo.couponId, shopifyOrderId: pedido.id },
      },
      select: { id: true },
    });
    if (ya) return "repetido";

    // Los cupos que quedan se reparten entre los pasajeros del pedido; los que
    // no entran quedan como excedentes (ver `repartirPasajeros`).
    const { cubiertos, excedentes } = repartirPasajeros(
      filas[0].stock - filas[0].used,
      consumo.passengers
    );
    const excess = excedentes > 0;
    await tx.travelCouponRedemption.create({
      data: {
        campaignId: consumo.campaignId,
        couponId: consumo.couponId,
        shopifyOrderId: pedido.id,
        orderName: pedido.name,
        mode: consumo.mode,
        passengers: consumo.passengers,
        excessPassengers: excedentes,
        amount: consumo.amount,
        excess,
        source,
      },
    });
    if (cubiertos > 0)
      await tx.travelCoupon.update({
        where: { id: consumo.couponId },
        data: { used: { increment: cubiertos } },
      });
    return excess ? "excedente" : "registrado";
  },
  // Holgura para esperar el bloqueo: el segundo pedido sobre el mismo cupón
  // ESPERA al primero, y con la latencia de Neon los 5 s por defecto de Prisma
  // pueden no alcanzar. Esperar es lo correcto; abortar perdería el canje.
  { maxWait: 10_000, timeout: 20_000 });
}

/**
 * Lo que hace el webhook `orders/create` con un pedido de una tienda con el flag.
 *
 * Solo mira campañas ACTIVAS o PAUSADAS: una pausada mientras el comprador
 * estaba en el checkout sigue valiendo para ese pedido — vio el cupón
 * disponible. Una en borrador nunca publicó un código.
 */
export async function registrarPedido(
  shopId: string,
  pedido: PedidoParaCupones,
  admin: AdminClient | null,
  source: "webhook" | "simulado" = "webhook"
): Promise<Array<Consumo & { resultado: ResultadoDelConsumo }>> {
  const campanas = await prisma.travelCouponCampaign.findMany({
    where: { shopId, status: { in: ["ACTIVE", "PAUSED"] } },
    include: { coupons: true },
  });
  if (campanas.length === 0) return [];

  const paraDecidir: CampanaParaPedido[] = campanas.map((c) => ({
    id: c.id,
    fullPaymentVariantIds: ids(c.fullPaymentVariantIds),
    reservationVariantIds: ids(c.reservationVariantIds),
    visibleCount: c.visibleCount,
    coupons: c.coupons.map((x) => ({
      id: x.id,
      code: x.code,
      label: x.label,
      amount: Number(x.amount),
      position: x.position,
      used: x.used,
      stock: x.stock,
    })),
  }));

  const consumos = decidirConsumos(pedido, paraDecidir);
  const out: Array<Consumo & { resultado: ResultadoDelConsumo }> = [];
  for (const consumo of consumos) {
    const resultado = await consumirCupon(
      consumo,
      { id: pedido.admin_graphql_api_id, name: pedido.name ?? pedido.admin_graphql_api_id },
      source
    );
    out.push({ ...consumo, resultado });
  }

  // El stock cambió: el siguiente cupón puede quedar publicado y el límite de
  // uso en Shopify tiene que bajar. Si no hay `admin` (webhook sin sesión) lo
  // arregla la próxima sincronización, al abrir la campaña en el admin.
  //
  // 🔴 Un fallo ACÁ no se propaga. El canje ya quedó registrado, que es lo que
  // importa para el dinero; lo que falta es solo poner Shopify al día, y eso lo
  // hace cualquier sincronización posterior. Si lanzara, el webhook pediría a
  // Shopify que reintente y se volvería a procesar un pedido ya procesado.
  if (admin)
    for (const id of new Set(out.filter((o) => o.resultado !== "repetido").map((o) => o.campaignId)))
      try {
        await sincronizarConShopify(admin, id, { actualizarTodos: true });
      } catch (err) {
        console.error(`[cupones-viaje] canje registrado, pero Shopify quedó sin sincronizar (${id}):`, err);
      }

  return out;
}

// ─── Lo que ve la tienda ──────────────────────────────────────────────────────

const numerico = (gid: string) => gid.split("/").pop() ?? "";

export type CuponEnLaTienda = {
  label: string;
  amount: number;
  restantes: number;
  agotado: boolean;
  /** Solo en los publicados. Un agotado no necesita código para pintarse. */
  code: string | null;
};

export type PayloadDeLaTienda = {
  campaignId: string;
  heading: string;
  messageFullPayment: string;
  messageReservation: string;
  /** Ids NUMÉRICOS: es lo que usa el selector de variantes del tema. */
  fullPaymentVariantIds: string[];
  reservationVariantIds: string[];
  /** El cupón disponible llega marcado a la ficha. */
  autoApply: boolean;
  coupons: CuponEnLaTienda[];
  atributos: typeof ATRIBUTOS_DEL_CARRITO;
};

/**
 * La campaña ACTIVA de un viaje, lista para pintar. `null` si no hay ninguna.
 *
 * Si el mismo producto tuviera dos campañas activas, gana la más nueva — la
 * pantalla del admin avisa del choque al guardar.
 */
export async function payloadDeLaTienda(
  shopId: string,
  productIdNumerico: string
): Promise<PayloadDeLaTienda | null> {
  const campana = await prisma.travelCouponCampaign.findFirst({
    where: {
      shopId,
      status: "ACTIVE",
      productId: `gid://shopify/Product/${productIdNumerico}`,
    },
    include: conCupones,
    orderBy: { createdAt: "desc" },
  });
  if (!campana) return null;

  const cupones = campana.coupons.map((c) => ({ ...c, amount: Number(c.amount) }));
  return {
    campaignId: campana.id,
    heading: campana.heading,
    messageFullPayment: campana.messageFullPayment,
    messageReservation: campana.messageReservation,
    fullPaymentVariantIds: ids(campana.fullPaymentVariantIds).map(numerico),
    reservationVariantIds: ids(campana.reservationVariantIds).map(numerico),
    autoApply: campana.autoApply,
    coupons: cuponesAMostrar(cupones, campana.visibleCount).map((c) => ({
      label: c.label,
      amount: c.amount,
      restantes: usosRestantes(c),
      agotado: c.agotado,
      code: estaAgotado(c) ? null : c.code,
    })),
    atributos: ATRIBUTOS_DEL_CARRITO,
  };
}

/**
 * La campaña ACTIVA de un código, para el modo carrito del widget (la página del
 * carrito no sabe de qué producto viene el cupón, solo tiene el código anotado).
 *
 * Solo resuelve códigos que la tienda ya publicó: un cupón agotado sale sin
 * código en el payload, así que por acá no se puede adivinar nada que no se
 * haya mostrado antes.
 */
export async function payloadPorCodigo(
  shopId: string,
  codigo: string
): Promise<PayloadDeLaTienda | null> {
  const cupon = await prisma.travelCoupon.findFirst({
    where: { code: codigo, campaign: { shopId, status: "ACTIVE" } },
    select: { campaign: { select: { productId: true } } },
  });
  if (!cupon) return null;
  return payloadDeLaTienda(shopId, numerico(cupon.campaign.productId));
}

/** Otra campaña ACTIVA sobre el mismo producto, para avisar al guardar. */
export async function otraCampanaActivaDelProducto(
  shopId: string,
  productId: string,
  excepto?: string
) {
  return prisma.travelCouponCampaign.findFirst({
    where: { shopId, productId, status: "ACTIVE", ...(excepto ? { id: { not: excepto } } : {}) },
    select: { id: true, name: true },
  });
}
