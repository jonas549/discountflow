// Atribución de pedidos para BXGY, CUPÓN SOBRE PRECIO ORIGINAL y MONTO DE COMPRA.
//
// ─── Por qué existe este módulo, y por qué NO toca a los que ya funcionan ─────
//
// El 2026-09-07 el diagnóstico encontró tres huecos distintos:
//
//   BXGY            bloque escrito, roto desde el día uno: comparaba el título
//                   de la aplicación contra `campaign.name`, y el descuento se
//                   crea con `[DiscountFlow] ` delante. Nunca cruzó un pedido.
//   CUPÓN           sin bloque. Nunca se construyó.
//   MONTO DE COMPRA sin bloque. Nunca se construyó.
//
// PERCENTAGE, RANGE y TIERED sí atribuyen —902 pedidos en Greta, 10 en las
// escalonadas de SkinUp— y su código en `webhooks.orders.create.tsx` queda
// **intacto**. Este módulo se suma; no reemplaza nada.
//
// ─── Por qué es un módulo PURO, con tests, y no código dentro de la ruta ──────
//
// Igual que `pack-attribution.ts`, y por el mismo motivo: **esto no se puede
// ejercitar en dev**. El webhook `orders/create` está sin suscribir en la app
// Dev por falta de Protected Customer Data. La primera vez que corre de verdad
// es en producción, sobre el pedido de un cliente. Ese es justo el código que
// no puede vivir dentro de una ruta sin tests.
//
// ─── La regla que gobierna todo el módulo: ante la duda, no se atribuye ───────
//
// Es la misma decisión que tomó el bloque de escalonados en 2026-07-25 y la que
// pidió Jonas explícitamente para monto de compra: **mejor un cero honesto que
// un número inventado**. Un hueco en Analytics se ve y se pregunta; un importe
// atribuido a la campaña equivocada se le cobra a alguien.

import type { LineaDePedido } from "./pack-attribution.ts";
import { normalizeDiscountCode } from "./original-price-client.ts";

export type { LineaDePedido };

/**
 * Una entrada de `discount_applications` del payload REST.
 *
 * 🔴 `code` no estaba declarado en la ruta y es el campo que identifica un
 * cupón de código. Sin él, el cupón —cuyo caso de uso ES medir al influencer—
 * no se puede atribuir de ninguna forma.
 */
export type AplicacionDeDescuento = {
  /** "automatic" | "discount_code" | "manual" | "script" */
  type: string;
  title?: string;
  code?: string;
};

export type Atribucion = {
  campaignId: string;
  /** Suma de los precios de línea que este descuento tocó, sin descontar. */
  orderAmount: number;
  /** Suma de las asignaciones de ESTE descuento sobre esas líneas. */
  discountAmount: number;
  lineas: number;
};

export type ResultadoAtribucion = {
  atribuciones: Atribucion[];
  /**
   * Señales que reclamaba más de una campaña. No se atribuyeron a ninguna.
   * Se devuelven para que un cero sea explicable en vez de mudo.
   */
  ambiguas: string[];
  /**
   * Señales de descuentos que no reconoció ninguna campaña nuestra. Lo normal
   * es que sean descuentos del merchant o de otra app —no es un error—, pero si
   * un tipo entero deja de atribuir, acá está el texto real que llegó.
   */
  sinReconocer: string[];
};

/** Cómo se reconoce el descuento de una campaña dentro del pedido. */
export type CampanaConSenal = {
  id: string;
  /**
   * El texto exacto que Shopify publica para el descuento de esta campaña.
   *
   * 🔴 Y acá está la distinción que costó que BXGY no atribuyera nunca:
   *
   *   Descuento NATIVO (BXGY)          → el TÍTULO DEL OBJETO descuento,
   *                                      que creamos como `[DiscountFlow] X`
   *   Descuento de FUNCTION (cupón,    → el `message` que EMITE la Function,
   *   monto, pack, escalonado)           que no lleva prefijo ninguno
   *
   * Son dos campos distintos de dos familias distintas. Quien llama pasa el que
   * corresponde a su tipo; este módulo no lo adivina.
   */
  senal: string;
};

/**
 * De qué aplicaciones sale la señal, según cómo se identifique el tipo.
 *
 * Se pasa como función y no como un `type` fijo porque los tres casos leen
 * campos distintos del payload.
 */
export type LectorDeSenal = (app: AplicacionDeDescuento) => string | null;

/**
 * BXGY y las Functions automáticas: la señal es el `title`, y solo cuenta si la
 * aplicación es automática.
 */
export const senalPorTituloAutomatico: LectorDeSenal = (app) => {
  if (app.type !== "automatic") return null;
  const titulo = (app.title ?? "").trim();
  return titulo === "" ? null : titulo;
};

/**
 * Cupón con código: la señal es el código, normalizado igual que al guardarlo.
 *
 * 🔴 Se acepta el código venga en `code` o en `title`, y NO se filtra por
 * `type`. Motivo: no está confirmado con un payload real qué manda Shopify para
 * un descuento de app con código —el pedido #1013 mostró "PRODUCCION" en el
 * desglose, que es el código, pero el desglose no es el payload—. Exigir
 * `type === "discount_code"` y acertar con el campo son dos apuestas, y fallar
 * cualquiera de las dos da un cero mudo. Aceptar los dos campos no puede
 * producir un falso positivo: **Shopify obliga a que el código sea único en la
 * tienda**, así que ese texto no puede pertenecer a otro descuento.
 */
export const senalPorCodigo: LectorDeSenal = (app) => {
  const crudo = app.code ?? app.title ?? "";
  const codigo = normalizeDiscountCode(crudo);
  return codigo === "" ? null : codigo;
};

/**
 * Reparte un pedido entre las campañas que lo explican.
 *
 * El importe sale SIEMPRE de las `discount_allocations` de las líneas que este
 * descuento tocó — nunca de `total_price` / `total_discounts`.
 *
 * 🔴 Esa diferencia es el segundo arreglo de BXGY, y es el que evita cobrarle
 * de más a una campaña. El bloque viejo atribuía `order.total_price` y
 * `order.total_discounts`: **el pedido entero**. En un pedido con dos
 * descuentos, la campaña BXGY se llevaba también el ahorro del otro, y contaba
 * como recaudación suya productos en los que no había participado. Con las
 * asignaciones, una campaña solo puede reclamar lo que Shopify le asignó.
 *
 * @param senalesAjenas Señales que también reclama alguna campaña de OTRO tipo.
 *        Ver `senalesReclamadasMasDeUnaVez`. Se descartan sin atribuir.
 */
export function atribuirPorSenal(
  lineItems: LineaDePedido[],
  applications: AplicacionDeDescuento[],
  campanas: CampanaConSenal[],
  leerSenal: LectorDeSenal,
  senalesAjenas: ReadonlySet<string> = new Set()
): ResultadoAtribucion {
  // Una señal puede ser reclamada por más de una campaña nuestra: dos BXGY con
  // el mismo nombre, o dos campañas de monto con el mensaje por defecto. Es
  // exactamente el caso que no se atribuye.
  const porSenal = new Map<string, string[]>();
  for (const c of campanas) {
    const senal = (c.senal ?? "").trim();
    if (senal === "") continue;
    const ids = porSenal.get(senal);
    if (ids) ids.push(c.id);
    else porSenal.set(senal, [c.id]);
  }

  const indicesPorCampana = new Map<string, Set<number>>();
  const ambiguas = new Set<string>();
  const sinReconocer = new Set<string>();

  for (const [indice, app] of applications.entries()) {
    if (!app) continue;
    const senal = leerSenal(app);
    if (senal === null) continue;

    if (senalesAjenas.has(senal)) {
      ambiguas.add(senal);
      continue;
    }

    const ids = porSenal.get(senal);
    if (!ids || ids.length === 0) {
      sinReconocer.add(senal);
      continue;
    }
    if (ids.length > 1) {
      ambiguas.add(senal);
      continue;
    }

    const set = indicesPorCampana.get(ids[0]) ?? new Set<number>();
    set.add(indice);
    indicesPorCampana.set(ids[0], set);
  }

  const atribuciones: Atribucion[] = [];
  for (const [campaignId, indices] of indicesPorCampana) {
    const totales = sumarLineas(lineItems, indices);
    if (totales.orderAmount > 0) atribuciones.push({ campaignId, ...totales });
  }

  return {
    atribuciones,
    ambiguas: [...ambiguas],
    sinReconocer: [...sinReconocer],
  };
}

/**
 * Suma las líneas que recibieron alguna de estas asignaciones.
 *
 * El precio de línea entra UNA sola vez aunque la línea reciba dos asignaciones
 * del mismo descuento — es la misma precaución que ya tomaba el bloque de
 * escalonados con su `Set<number>` de líneas.
 */
function sumarLineas(
  lineItems: LineaDePedido[],
  indices: ReadonlySet<number>
): { orderAmount: number; discountAmount: number; lineas: number } {
  let orderAmount = 0;
  let discountAmount = 0;
  let lineas = 0;

  for (const lineItem of lineItems) {
    const asignaciones = (lineItem.discount_allocations ?? []).filter((a) =>
      indices.has(a.discount_application_index)
    );
    if (asignaciones.length === 0) continue;

    const precio = Number(lineItem.price);
    const cantidad = Number(lineItem.quantity);

    // 🔴 Si la línea no es utilizable, se salta ENTERA: ni recaudación ni
    // ahorro. Contar su descuento y no su precio dejaría el par descuadrado y
    // el ROI de esa campaña saldría disparado — un número inventado, que es
    // justo lo que este módulo no hace.
    if (
      !Number.isFinite(precio) ||
      !Number.isFinite(cantidad) ||
      precio <= 0 ||
      cantidad <= 0
    ) {
      continue;
    }

    orderAmount += precio * cantidad;
    lineas++;

    for (const a of asignaciones) {
      const importe = Number(a.amount);
      if (Number.isFinite(importe) && importe > 0) discountAmount += importe;
    }
  }

  return { orderAmount, discountAmount, lineas };
}

/**
 * Señales que reclama más de una campaña, mirando TODOS los tipos a la vez.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 Es la salvaguarda contra el único modo en que estos bloques nuevos podrían
 * atribuir de más, y responde a la condición que puso Jonas: *"confirmá que un
 * pedido con varios descuentos no le atribuya de más a ninguna campaña"*.
 *
 * Los tipos que van por Function se reconocen por su `message`, y el `message`
 * lo escribe el merchant. Nada le impide poner el mismo texto en una campaña de
 * monto de compra y en un cupón automático. Si eso pasa, una sola aplicación de
 * descuento encajaría en los dos bloques y **el mismo ahorro se contaría dos
 * veces**.
 *
 * Con esta función, esa señal queda marcada y **ninguno de los dos bloques
 * nuevos atribuye**. El cero se explica; el número inflado no se explicaría.
 *
 * ⚠️ Los mensajes de ESCALONADO y PACK entran en el recuento a propósito, pero
 * el efecto es de una sola dirección: si un cupón automático comparte mensaje
 * con una escalonada, **el que se aparta es el cupón**. Los bloques que ya
 * atribuyen hoy en Greta y SkinUp no cambian de comportamiento ni un ápice —
 * no leen esta función siquiera.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function senalesReclamadasMasDeUnaVez(
  listas: ReadonlyArray<ReadonlyArray<string>>
): Set<string> {
  const cuenta = new Map<string, number>();
  for (const lista of listas) {
    for (const senal of lista) {
      const limpia = (senal ?? "").trim();
      if (limpia === "") continue;
      cuenta.set(limpia, (cuenta.get(limpia) ?? 0) + 1);
    }
  }
  return new Set([...cuenta.entries()].filter(([, n]) => n > 1).map(([s]) => s));
}
