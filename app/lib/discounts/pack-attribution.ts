// Atribución de pedidos a campañas PACK.
//
// Módulo PURO, sin Prisma ni red, a propósito.
//
// ─── Por qué está extraído ───────────────────────────────────────────────────
//
// Esta lógica **no se puede ejercitar en el ambiente de desarrollo**: el webhook
// `orders/create` está deliberadamente sin suscribir en la app Dev porque no
// tiene aprobación de Protected Customer Data (comentado en
// `shopify.app.dev.toml` desde el 2026-07-24). En dev el pedido se completa, el
// descuento se aplica, y el webhook **no llega nunca** — no es un fallo, es una
// limitación del entorno.
//
// Consecuencia: la primera vez que este código corre de verdad es en
// PRODUCCIÓN, sobre el pedido de un cliente real. Eso es exactamente el tipo de
// código que no puede estar dentro de una ruta sin tests. Es la misma decisión
// que se tomó con `plan-decision.ts` durante el caso 116943, y por el mismo
// motivo.
//
// Lo que los tests SÍ cubren: la forma del payload, el cruce, la suma, y los
// casos hostiles. Lo que NO pueden cubrir: que Shopify entregue el webhook y que
// el `title` de la aplicación de descuento sea el que esperamos. Eso solo se
// confirma con un pedido real — y para que ese día sea diagnosticable en un
// minuto, el resultado incluye `titulosNoReconocidos`.

/** Una línea del pedido, tal como llega en el payload REST del webhook. */
export type LineaDePedido = {
  product_id: number | null;
  quantity: number;
  price: string;
  /**
   * 🔴 En el payload REST del pedido esto es un ARRAY de `{name, value}`, NO el
   * objeto `{clave: valor}` que devuelve la Ajax Cart API del storefront.
   *
   * Es el mismo dato con dos formas distintas según por dónde se lea, y
   * confundirlas no da ningún error: da CERO atribuciones en silencio.
   */
  properties?: Array<{ name: string; value: string }> | Record<string, string> | null;
  discount_allocations?: Array<{
    amount: string;
    discount_application_index: number;
  }>;
};

export type AplicacionDeDescuento = {
  /** "automatic" | "code" | "manual" | "script" */
  type: string;
  title?: string;
};

/** Lo que el llamador sabe de cada campaña de pack de la tienda. */
export type CampanaPack = {
  id: string;
  name: string;
  /** El `message` de la Function, que es lo que Shopify publica como `title`. */
  message: string;
};

export type AtribucionPack = {
  campaignId: string;
  /** Suma de los precios de línea del pack, sin descontar. */
  orderAmount: number;
  /** Suma de las asignaciones de NUESTRO descuento sobre esas líneas. */
  discountAmount: number;
  /** Cuántas líneas del pedido pertenecen a este pack. */
  lineas: number;
};

export type ResultadoAtribucion = {
  atribuciones: AtribucionPack[];
  /** Líneas que declaran pertenecer a algún pack. */
  lineasConMarca: number;
  /**
   * Líneas que declaran un pack cuya campaña ya no existe. No es un error —el
   * merchant pudo borrarla— pero conviene que quede contado.
   */
  lineasHuerfanas: number;
  /**
   * 🔴 Títulos de descuentos automáticos que caían sobre líneas del pack y NO
   * coincidieron con el `message` de su campaña.
   *
   * Si esto viene lleno y `discountAmount` sale 0, la suposición de que Shopify
   * publica el `message` de la Function como `title` es falsa para PACK, y acá
   * está el valor real para arreglarlo en una línea. Sin este campo, ese fallo
   * sería un cero silencioso — el patrón que este repo ya arregló cuatro veces.
   */
  titulosNoReconocidos: string[];
};

/**
 * Lee una propiedad de línea sin depender de su forma.
 *
 * El payload REST manda `[{name, value}]`; la Ajax Cart API, `{clave: valor}`.
 * Este webhook solo ve la primera, pero aceptar las dos cuesta tres líneas y
 * evita que un cambio de forma vuelva a producir un cero silencioso.
 */
export function leerPropiedadDeLinea(
  properties: LineaDePedido["properties"],
  clave: string
): string | null {
  if (!properties) return null;
  if (Array.isArray(properties)) {
    const encontrada = properties.find((p) => p && p.name === clave);
    return encontrada?.value ?? null;
  }
  const valor = properties[clave];
  return typeof valor === "string" && valor ? valor : null;
}

/**
 * Reparte un pedido entre las campañas de pack que lo explican.
 *
 * Es la atribución más exacta de los cuatro tipos de campaña: la línea lleva
 * escrito el id de la campaña en su propiedad, así que no hay que deducir nada.
 * (PERCENTAGE y RANGE cruzan variantes; TIERED cruza productos, descarta por
 * título y renuncia a atribuir si hay ambigüedad.)
 *
 * El importe sale de las `discount_allocations` filtradas por el título de
 * NUESTRO descuento: una línea puede llevar encima descuentos de otras apps o
 * del merchant, y sumarlos todos inflaría el ahorro atribuido.
 */
export function atribuirPacks(
  lineItems: LineaDePedido[],
  applications: AplicacionDeDescuento[],
  campanas: CampanaPack[],
  claveDeLinea: string
): ResultadoAtribucion {
  const porId = new Map(campanas.map((c) => [c.id, c]));
  const totales = new Map<string, AtribucionPack>();
  const titulosNoReconocidos = new Set<string>();
  let lineasConMarca = 0;
  let lineasHuerfanas = 0;

  for (const lineItem of lineItems) {
    const campaignId = leerPropiedadDeLinea(lineItem.properties, claveDeLinea);
    if (!campaignId) continue;
    lineasConMarca++;

    const campana = porId.get(campaignId);
    if (!campana) {
      lineasHuerfanas++;
      continue;
    }

    const acc = totales.get(campana.id) ?? {
      campaignId: campana.id,
      orderAmount: 0,
      discountAmount: 0,
      lineas: 0,
    };

    // El precio de línea entra UNA vez por línea, aunque la línea reciba varias
    // asignaciones de descuento.
    const precio = Number(lineItem.price);
    const cantidad = Number(lineItem.quantity);
    if (Number.isFinite(precio) && Number.isFinite(cantidad) && precio > 0 && cantidad > 0) {
      acc.orderAmount += precio * cantidad;
    }
    acc.lineas++;

    for (const allocation of lineItem.discount_allocations ?? []) {
      const app = applications[allocation.discount_application_index];
      if (!app || app.type !== "automatic") continue;

      if (app.title !== campana.message) {
        // No es nuestro descuento —o el título no es lo que creemos—. Se anota
        // para que el caso sea diagnosticable en vez de un cero mudo.
        if (app.title) titulosNoReconocidos.add(app.title);
        continue;
      }

      const importe = Number(allocation.amount);
      if (Number.isFinite(importe) && importe > 0) acc.discountAmount += importe;
    }

    totales.set(campana.id, acc);
  }

  return {
    atribuciones: [...totales.values()].filter((a) => a.orderAmount > 0),
    lineasConMarca,
    lineasHuerfanas,
    titulosNoReconocidos: [...titulosNoReconocidos],
  };
}
