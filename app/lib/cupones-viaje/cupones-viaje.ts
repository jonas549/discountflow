// Cupones de viaje — las reglas, en un módulo PURO (sin Prisma, sin Shopify).
//
// Feature de UNA tienda (GeoTerraViajes), detrás del flag `cupones:viaje`. Lo
// usan el admin, el app proxy de la tienda y el webhook de pedidos: por eso las
// reglas viven acá una sola vez y los tres las importan.
//
// ═══════════════════════════════════════════════════════════════════════════
// EL NEGOCIO, PARA QUIEN LLEGUE SIN CONTEXTO
//
// Cada viaje es un producto. Cada fecha de salida tiene DOS variantes: «Pago
// total» (ej. $4.000.000) y «Reserva» ($500.000). El saldo de una reserva se
// cobra SIEMPRE por fuera de Shopify (transferencia o Webpay armado a mano), y
// la agencia lo calcula restando los $500.000 NOMINALES al precio del viaje.
//
// Un mismo cupón se comporta distinto según la modalidad:
//
//   · PAGO TOTAL → el descuento se aplica DE VERDAD en el checkout. Es un
//     código de descuento nativo de Shopify, de monto fijo, limitado a las
//     variantes «Pago total» del producto. El comprador paga $3.900.000.
//
//   · RESERVA → la reserva NO se descuenta: paga sus $500.000 completos. El
//     cupón queda anotado en los atributos del carrito, que Shopify copia al
//     pedido, y la agencia resta el monto del saldo al cobrarlo por fuera.
//
// Los cupones se liberan EN ORDEN y solos: se publica el de menor posición que
// no esté agotado (o los N primeros, si el merchant eligió mostrar varios a la
// vez). Cuando se agota, aparece el siguiente sin que nadie toque nada. El
// stock cuenta los usos de LAS DOS modalidades juntos, por eso vive en nuestra
// base y no en Shopify (Shopify solo ve los usos de Pago total).
// ═══════════════════════════════════════════════════════════════════════════

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type Modalidad = "FULL_PAYMENT" | "RESERVATION";

/** Un cupón tal como lo necesitan las reglas. `amount` va en UNIDADES de la moneda. */
export type Cupon = {
  id: string;
  position: number;
  label: string;
  amount: number;
  stock: number;
  used: number;
  code: string;
};

/** Una opción del producto, como la devuelve la Admin API. */
export type OpcionDeProducto = { name: string; values: string[] };

/** Una variante con sus opciones elegidas. */
export type VarianteConOpciones = {
  id: string;
  title?: string;
  /** Precio de la variante, como lo da la Admin API ("4550.00"). */
  price?: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

// ─── Constantes que comparten la tienda, el admin y el webhook ────────────────

/**
 * Los atributos del carrito que escribe el widget y que Shopify copia al pedido.
 * Son SOLO los dos que lee la AGENCIA (admin de Shopify → el pedido →
 * «Detalles adicionales»), en español y legibles, uno debajo del otro.
 *
 * 🔴 Tienen que coincidir en el widget y en el webhook. Si uno cambia solo, el
 * webhook deja de reconocer las reservas con cupón y el stock no se consume —
 * sin ningún error. Por eso salen de acá y el widget los recibe dentro del
 * script servido, no escritos a mano en su código.
 *
 * 🔴 No hay atributos «ocultos»: Shopify esconde los de guion bajo en el
 * checkout, pero los MUESTRA en el pedido del admin (documentación de la Ajax
 * API: «visible on the Order details page»). Hasta el 2026-09-25 se escribían
 * dos técnicos (el código y el cálculo) y la agencia los veía. Ahora el webhook
 * reconoce el cupón por el producto del pedido + el nombre en «Cupón de viaje»
 * (ver `decidirConsumos`), y el cálculo del carrito vive en el navegador.
 */
export const ATRIBUTO_CUPON = "Cupón de viaje";
export const ATRIBUTO_SALDO = "Descontar del saldo";
/**
 * Los dos técnicos de antes. Ya no se escriben: el widget los BORRA del carrito
 * si los encuentra, y el webhook todavía lee el código para los carritos que
 * se armaron antes del cambio.
 */
export const ATRIBUTO_CODIGO = "_df_cupon_viaje";
export const ATRIBUTO_CALCULO = "_df_cupon_viaje_calculo";

/** Como los recibe el widget. */
export const ATRIBUTOS_DEL_CARRITO = {
  cupon: ATRIBUTO_CUPON,
  saldo: ATRIBUTO_SALDO,
  obsoletos: [ATRIBUTO_CODIGO, ATRIBUTO_CALCULO],
};

/**
 * El valor de «Cupón de viaje» es «<nombre> · <monto> por pasajero» (lo arma el
 * widget). Devuelve el nombre: lo que hay antes del ÚLTIMO « · », así un
 * nombre que tenga ese separador no se corta.
 */
export function nombreDelAtributoCupon(valor: string): string {
  const s = String(valor ?? "");
  const i = s.lastIndexOf(" · ");
  return (i > -1 ? s.slice(0, i) : s).trim();
}

/** Para comparar nombres de cupón: sin mayúsculas ni espacios de más. */
export const normalizarNombre = (s: string) =>
  String(s ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");

/** Tope de cupones por campaña. Holgado: el caso real son ~10. */
export const MAX_CUPONES = 30;
/** Cuántos cupones disponibles se pueden mostrar a la vez, como máximo. */
export const MAX_VISIBLES = 5;

/**
 * 🔴 El cupón descuenta POR PASAJERO. Decisión de Jonas, 2026-09-25.
 *
 * En GeoTerra la cantidad de la línea ES la cantidad de pasajeros (el selector
 * de más y menos de la ficha). 2 × $4.550 con un cupón de $1.000 queda en
 * $7.100, y 3 reservas con uno de $100.000 anotan $300.000 a descontar.
 *
 * Lo leen de acá el código nativo de Shopify (`appliesOnEachItem`), el widget
 * (la anotación del carrito) y el webhook (el comprobante del canje).
 *
 * 🔴 Y el STOCK también cuenta pasajeros: 3 pasajeros consumen 3 usos
 * (decisión de Jonas, 2026-09-25). El stock es el presupuesto del cupón:
 * stock × monto es lo máximo que la agencia puede regalar. Si un pedido de 10
 * pasajeros consumiera un solo uso, ese presupuesto dejaría de tener techo.
 */
export const POR_PASAJERO = true;

export const TITULO_POR_DEFECTO = "Cupones de descuento";

export const MENSAJE_PAGO_TOTAL_POR_DEFECTO =
  "Con Pago total, el cupón de {monto} por pasajero se descuenta en el carrito. " +
  "El precio de arriba no cambia: vas a ver el descuento al pasar al carrito.";

export const MENSAJE_RESERVA_POR_DEFECTO =
  "Con Reserva pagás hoy la reserva completa. Los {monto} por pasajero del cupón " +
  "({total} en total) se descuentan del saldo del viaje, que la agencia te cobra " +
  "después. Por eso ni el precio de arriba ni el del carrito cambian.";

// ─── Estado de los cupones ────────────────────────────────────────────────────

export function estaAgotado(c: Pick<Cupon, "used" | "stock">): boolean {
  return c.used >= c.stock;
}

export function usosRestantes(c: Pick<Cupon, "used" | "stock">): number {
  return Math.max(0, c.stock - c.used);
}

function porPosicion<T extends { position: number }>(cupones: T[]): T[] {
  return [...cupones].sort((a, b) => a.position - b.position);
}

/**
 * Los cupones PUBLICADOS: los `visibleCount` primeros, en orden, que no estén
 * agotados. Son los únicos que el comprador puede usar.
 *
 * Es una función del estado y no un campo guardado, a propósito: así no existe
 * el estado inconsistente «agotado pero todavía publicado». La liberación
 * automática no es un proceso que pueda fallar a medias — es esta consulta.
 */
export function cuponesPublicados<T extends Pick<Cupon, "position" | "used" | "stock">>(
  cupones: T[],
  visibleCount: number
): T[] {
  const n = Math.max(1, Math.min(MAX_VISIBLES, Math.floor(visibleCount) || 1));
  return porPosicion(cupones)
    .filter((c) => !estaAgotado(c))
    .slice(0, n);
}

/**
 * Lo que se pinta en la tienda: los agotados (apagados, con «Agotado») y
 * después los publicados. Los que todavía esperan turno NO se muestran.
 *
 * Los agotados se quedan a propósito, pedido del cliente: que el comprador vea
 * que hubo cupones antes y que se acabaron. Desaparecer los haría pensar que el
 * de ahora es el único.
 */
export function cuponesAMostrar<T extends Pick<Cupon, "position" | "used" | "stock">>(
  cupones: T[],
  visibleCount: number
): Array<T & { agotado: boolean }> {
  const publicados = new Set(cuponesPublicados(cupones, visibleCount));
  return porPosicion(cupones)
    .filter((c) => estaAgotado(c) || publicados.has(c))
    .map((c) => ({ ...c, agotado: estaAgotado(c) }));
}

/**
 * El límite de usos que se le pone al código NATIVO en Shopify.
 *
 * 🔴 Shopify cuenta PEDIDOS, no pasajeros: un pedido de 3 pasajeros es UN uso
 * del código. Y el stock cuenta pasajeros. Así que el límite es: los pedidos
 * de Pago total que ya pasaron por el código + los cupos que quedan. Como cada
 * pedido trae al menos un pasajero, Shopify nunca deja pasar más pedidos de los
 * que caben. Lo que no puede frenar es un pedido con MÁS pasajeros que cupos:
 * eso lo frena el widget (no deja elegir el cupón) y, si igual entra, el canje
 * registra cuántos pasajeros quedaron fuera del stock.
 *
 * Con esto, dos compradores de Pago total que llegan a la vez sobre el último
 * cupo los frena SHOPIFY en el checkout, que es el único lugar donde se puede
 * impedir un descuento antes de que ocurra.
 */
export function limiteDeUsoEnShopify(
  stock: number,
  used: number,
  pedidosDePagoTotal: number
): number {
  return Math.max(1, pedidosDePagoTotal + Math.max(0, stock - used));
}

/**
 * Cuántos pasajeros de un pedido entran en el stock y cuántos quedan fuera.
 *
 * Los que quedan fuera NO se descartan: el pedido existe y el comprador vio el
 * cupón disponible. Se registran como excedentes y la agencia decide.
 */
export function repartirPasajeros(
  disponibles: number,
  pasajeros: number
): { cubiertos: number; excedentes: number } {
  const cubiertos = Math.max(0, Math.min(disponibles, pasajeros));
  return { cubiertos, excedentes: Math.max(0, pasajeros - cubiertos) };
}

/** El precio más bajo entre las variantes de Pago total, o null si no hay. */
export function precioPagoTotalMasBarato(
  variantes: VarianteConOpciones[],
  idsDePagoTotal: string[]
): number | null {
  const ids = new Set(idsDePagoTotal);
  const precios = variantes
    .filter((v) => ids.has(v.id))
    .map((v) => Number(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return precios.length ? Math.min(...precios) : null;
}

/**
 * Los cupones cuyo monto alcanza o supera el Pago total más barato.
 *
 * Solo se compara contra Pago total, a propósito: ahí el cupón descuenta DE
 * VERDAD y un cupón más grande que el precio deja el carrito en $0 sin avisar.
 * En Reserva no descuenta nada en el carrito —se resta del saldo—, así que un
 * cupón de $1.000.000 sobre una reserva de $500.000 es perfectamente válido.
 */
export function cuponesQueSuperanElPrecio<T extends { amount: number }>(
  cupones: T[],
  precioMinimo: number | null
): T[] {
  if (precioMinimo === null) return [];
  return cupones.filter((c) => c.amount > 0 && c.amount >= precioMinimo);
}

// ─── Clasificación de variantes ───────────────────────────────────────────────

const normalizar = (s: string) => s.trim().toLocaleLowerCase("es");

/**
 * Propone qué opción del producto es la modalidad y qué valores son cada una.
 *
 * Es solo una SUGERENCIA para rellenar el formulario: el merchant la ve y la
 * confirma. Busca «total» y «reserva» en los valores, que es como está armada
 * la tienda de GeoTerra («Tipo de Reserva: Pago Total / Reserva»).
 */
export function sugerirModalidades(
  opciones: OpcionDeProducto[]
): { optionName: string; fullPaymentValue: string; reservationValue: string } | null {
  for (const o of opciones) {
    const total = o.values.find((v) => /total/i.test(v));
    const reserva = o.values.find((v) => /reserva/i.test(v) && v !== total);
    if (total && reserva)
      return { optionName: o.name, fullPaymentValue: total, reservationValue: reserva };
  }
  return null;
}

/**
 * Separa las variantes del viaje en Pago total, Reserva y las que no encajan.
 *
 * 🔴 Una variante que no encaja en ninguna queda FUERA: ni descuenta ni se
 * anota. Es el fallo seguro — si no se puede afirmar que es un pago total, no
 * se le aplica un descuento real.
 */
export function clasificarVariantes(
  variantes: VarianteConOpciones[],
  optionName: string,
  fullPaymentValue: string,
  reservationValue: string
): { fullPayment: string[]; reservation: string[]; sinClasificar: string[] } {
  const out = { fullPayment: [] as string[], reservation: [] as string[], sinClasificar: [] as string[] };
  const opcion = normalizar(optionName);
  const total = normalizar(fullPaymentValue);
  const reserva = normalizar(reservationValue);

  for (const v of variantes) {
    const valor = v.selectedOptions.find((o) => normalizar(o.name) === opcion)?.value;
    const n = valor === undefined ? undefined : normalizar(valor);
    if (n !== undefined && n === total) out.fullPayment.push(v.id);
    else if (n !== undefined && n === reserva) out.reservation.push(v.id);
    else out.sinClasificar.push(v.id);
  }
  return out;
}

// ─── Montos ───────────────────────────────────────────────────────────────────

/**
 * Lee un monto ENTERO tecleado por el merchant.
 *
 * 🔴 No se usa `parseDecimalInput` y es a propósito. Ese parser trata el punto
 * como separador decimal, y en Chile «100.000» son cien mil pesos: con él, un
 * cupón de cien mil se guardaría como un cupón de CIEN pesos. Acá el punto y el
 * espacio son separadores de miles y se descartan.
 *
 * La coma se rechaza en vez de adivinarse: «100,5» no es un monto en CLP, y
 * adivinar si era un decimal o un separador es como se regalan descuentos.
 *
 *   "100.000" → 100000    "$ 125.000" → 125000    "100000" → 100000
 *   ""        → null      "100,5"     → null      "abc"    → null
 */
export function parseMontoEntero(raw: string): number | null {
  const s = String(raw ?? "").trim().replace(/^\$/, "").replace(/[.\s]/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Monto para mostrar en el admin: separador de miles con punto, sin decimales. */
export function formatoMonto(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CL")}`;
}

/**
 * Rellena los marcadores del mensaje que escribe el merchant.
 *
 *   {monto}  → el monto del cupón POR PASAJERO, ya formateado
 *   {total}  → monto × pasajeros elegidos en la ficha (sin `total`, = {monto})
 *   {cupon}  → la etiqueta del cupón («Cupón 1»)
 *
 * Un marcador desconocido se deja tal cual: si el merchant escribió `{hola}`,
 * que lo vea y lo corrija, en vez de que desaparezca sin explicación.
 */
export function rellenarMensaje(
  mensaje: string,
  valores: { monto: string; cupon: string; total?: string }
): string {
  const v = { ...valores, total: valores.total ?? valores.monto };
  return mensaje.replace(/\{(monto|cupon|total)\}/g, (_, k: "monto" | "cupon" | "total") => v[k]);
}

// ─── Códigos ──────────────────────────────────────────────────────────────────

/** Sin letras que se confundan (0/O, 1/I/L): el código puede terminar en un soporte. */
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Código aleatorio para el descuento nativo. El comprador no lo escribe nunca.
 *
 * Aleatorio y no «KENIA-1, KENIA-2…» porque los cupones que esperan turno no
 * deben poder adivinarse: el siguiente código sería el anterior + 1.
 */
export function generarCodigo(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = "DFV";
  for (const b of bytes) s += ALFABETO[b % ALFABETO.length];
  return s;
}

// ─── El formulario ────────────────────────────────────────────────────────────

/** Lo que manda el formulario del admin, en un solo JSON. */
export type DatosDelFormulario = {
  name: string;
  productId: string;
  productTitle: string;
  optionName: string;
  fullPaymentValue: string;
  reservationValue: string;
  visibleCount: number;
  /** El cupón disponible llega marcado a la ficha. */
  autoApply: boolean;
  heading: string;
  messageFullPayment: string;
  messageReservation: string;
  coupons: Array<{ id?: string; label: string; amount: string; stock: string }>;
};

export type ErroresDelFormulario = Partial<
  Record<"name" | "product" | "modalidades" | "coupons" | "messages" | "general", string>
>;

/** Un cupón del formulario ya leído a números. */
export type CuponDelFormulario = { id?: string; label: string; amount: number; stock: number };

/**
 * Lee el JSON del formulario sin confiar en su forma: viene del navegador.
 *
 * Lo que falta o no tiene el tipo esperado se convierte en cadena vacía, y la
 * validación lo rechaza con un mensaje. Nunca se inventa un valor por defecto
 * que cambie la campaña en silencio — la lección de `Section`, que convertía un
 * campo que no llegaba en «toda la tienda».
 */
export function leerDatosDelFormulario(raw: unknown): DatosDelFormulario {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const cupones = Array.isArray(o.coupons) ? o.coupons : [];
  return {
    name: str(o.name).trim(),
    productId: str(o.productId),
    productTitle: str(o.productTitle),
    optionName: str(o.optionName),
    fullPaymentValue: str(o.fullPaymentValue),
    reservationValue: str(o.reservationValue),
    visibleCount: Number(o.visibleCount) || 0,
    // Solo un `true` explícito lo enciende: lo que falte deja el
    // comportamiento de siempre (el comprador lo pincha).
    autoApply: o.autoApply === true,
    heading: str(o.heading).trim(),
    messageFullPayment: str(o.messageFullPayment).trim(),
    messageReservation: str(o.messageReservation).trim(),
    coupons: cupones.map((c) => {
      const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return {
        id: typeof x.id === "string" && x.id ? x.id : undefined,
        label: str(x.label).trim(),
        amount: str(x.amount),
        stock: str(x.stock),
      };
    }),
  };
}

/**
 * Valida el formulario. Devuelve los errores y, si no hay, los cupones ya leídos.
 *
 * `usadosPorId` son los usos ya consumidos de los cupones existentes: un stock
 * no puede bajar por debajo de lo ya usado — el pedido ya existe y la agencia
 * ya prometió ese descuento.
 */
export function validarFormulario(
  d: DatosDelFormulario,
  usadosPorId: Record<string, number> = {}
): { errores: ErroresDelFormulario; cupones: CuponDelFormulario[] } {
  const errores: ErroresDelFormulario = {};
  const cupones: CuponDelFormulario[] = [];

  if (!d.name) errores.name = "Poné un nombre a la campaña.";
  if (!d.productId) errores.product = "Elegí el viaje (el producto) al que aplican los cupones.";
  if (d.productId && (!d.optionName || !d.fullPaymentValue || !d.reservationValue))
    errores.modalidades = "Indicá qué opción del producto distingue «Pago total» de «Reserva».";
  else if (d.productId && normalizar(d.fullPaymentValue) === normalizar(d.reservationValue))
    errores.modalidades = "«Pago total» y «Reserva» no pueden ser el mismo valor.";

  if (d.coupons.length === 0) errores.coupons = "Agregá al menos un cupón.";
  else if (d.coupons.length > MAX_CUPONES)
    errores.coupons = `Como máximo ${MAX_CUPONES} cupones por campaña.`;
  else {
    for (let i = 0; i < d.coupons.length; i++) {
      const c = d.coupons[i];
      const n = i + 1;
      const amount = parseMontoEntero(c.amount);
      const stock = parseMontoEntero(c.stock);
      if (!c.label) {
        errores.coupons = `El cupón ${n} no tiene nombre.`;
        break;
      }
      if (amount === null || amount <= 0) {
        errores.coupons = `«${c.label}»: el monto tiene que ser un número entero mayor que cero (ej. 100.000).`;
        break;
      }
      // 0 es válido: deja el cupón AGOTADO y se publica el siguiente, igual
      // que si se hubiera consumido con pedidos (decisión de Jonas, 2026-09-25).
      if (stock === null) {
        errores.coupons = `«${c.label}»: los cupos tienen que ser un número entero (0 lo deja agotado).`;
        break;
      }
      const usados = c.id ? usadosPorId[c.id] ?? 0 : 0;
      if (stock < usados) {
        errores.coupons = `«${c.label}» ya se usó ${usados} ${usados === 1 ? "vez" : "veces"}: los cupos no pueden ser menos. Para agotarlo, poné ${usados}.`;
        break;
      }
      // El nombre identifica al cupón en los pedidos de Reserva: no se repite.
      if (d.coupons.slice(0, i).some((o) => normalizarNombre(o.label) === normalizarNombre(c.label))) {
        errores.coupons = `Hay dos cupones llamados «${c.label}»: cada cupón necesita un nombre distinto.`;
        break;
      }
      cupones.push({ id: c.id, label: c.label, amount, stock });
    }
  }

  if (!d.heading || !d.messageFullPayment || !d.messageReservation)
    errores.messages = "El título y los dos mensajes de la tienda no pueden quedar vacíos.";

  return { errores, cupones };
}

// ─── El pedido: qué consume ───────────────────────────────────────────────────

/** Los campos del payload REST de `orders/create` que hacen falta. Sin PII. */
export type PedidoParaCupones = {
  admin_graphql_api_id: string;
  name?: string;
  line_items: Array<{ variant_id: number | null; quantity: number }>;
  discount_codes?: Array<{ code: string }> | null;
  /** 🔴 En el payload REST es un ARRAY de `{name, value}`. */
  note_attributes?: Array<{ name: string; value: string }> | null;
};

/** Una campaña, como la necesita la decisión del webhook. */
export type CampanaParaPedido = {
  id: string;
  fullPaymentVariantIds: string[];
  reservationVariantIds: string[];
  visibleCount: number;
  coupons: Array<Pick<Cupon, "id" | "code" | "amount" | "label" | "position" | "used" | "stock">>;
};

export type Consumo = {
  campaignId: string;
  couponId: string;
  mode: Modalidad;
  /** Pasajeros: la cantidad de las líneas de esa modalidad del viaje. */
  passengers: number;
  /** TOTAL descontado (o a descontar del saldo): monto por pasajero × pasajeros. */
  amount: number;
};

/**
 * Los cupones que la tienda ya publicó alguna vez: hasta el último que hoy está
 * a la venta, incluidos los agotados de antes. Si están todos agotados, todos
 * se publicaron.
 */
function yaPublicados(campana: CampanaParaPedido) {
  const publicados = cuponesPublicados(campana.coupons, campana.visibleCount);
  if (publicados.length === 0) return campana.coupons;
  const hasta = Math.max(...publicados.map((c) => c.position));
  return campana.coupons.filter((c) => c.position <= hasta);
}

const gidVariante = (id: number | null) =>
  id == null ? null : `gid://shopify/ProductVariant/${id}`;

function leerAtributo(pedido: PedidoParaCupones, nombre: string): string | null {
  const attrs = pedido.note_attributes;
  if (!Array.isArray(attrs)) return null;
  const a = attrs.find((x) => x && x.name === nombre);
  return a && typeof a.value === "string" ? a.value.trim() : null;
}

/**
 * Decide qué cupones consume un pedido. PURA: no toca la base.
 *
 * Reglas, en orden:
 *
 *   1. PAGO TOTAL. El pedido trae el código del cupón en `discount_codes` y
 *      tiene una línea de una variante «Pago total» del viaje. Si Shopify
 *      aplicó el código, el descuento ya ocurrió: se consume.
 *
 *   2. RESERVA. El pedido tiene una línea de una variante «Reserva» del viaje
 *      y trae en «Cupón de viaje» el NOMBRE de un cupón de esa campaña (los
 *      nombres no se repiten dentro de una campaña: lo exige el formulario).
 *      Solo vale un cupón que la tienda YA publicó alguna vez — el vigente o
 *      uno anterior, ya agotado —: el nombre se puede adivinar («Cupón 3») y un
 *      cupón que todavía no salió a la venta no se puede reclamar. Los pedidos
 *      armados antes del 2026-09-25 traen el código en `_df_cupon_viaje`: ése
 *      se sigue aceptando.
 *
 *   3. Un canje por pedido y campaña. Si el pedido cumple las dos (pago total
 *      y reserva del mismo viaje con el mismo cupón), cuenta como Pago total:
 *      ese descuento ya es real.
 *
 *   4. POR PASAJERO (`POR_PASAJERO`): el monto del canje es el del cupón por la
 *      cantidad de las líneas de esa modalidad. 3 reservas × $100.000 = $300.000.
 *
 * 🔴 El atributo lo escribe el NAVEGADOR, así que no prueba nada por sí solo.
 * Lo que lo hace válido es que el cupón exista en nuestra base, sea de esta
 * campaña, ya se haya publicado, y que el pedido tenga de verdad una reserva de
 * ese viaje. Un atributo inventado, o sin reserva detrás, no consume nada.
 */
export function decidirConsumos(
  pedido: PedidoParaCupones,
  campanas: CampanaParaPedido[]
): Consumo[] {
  // Cantidad por variante: en GeoTerra la cantidad son los pasajeros.
  const cantidades = new Map<string, number>();
  for (const li of pedido.line_items) {
    const v = gidVariante(li.variant_id);
    if (v && li.quantity > 0) cantidades.set(v, (cantidades.get(v) ?? 0) + li.quantity);
  }
  const variantes = new Set(cantidades.keys());
  const pasajerosDe = (ids: string[]) =>
    POR_PASAJERO ? Math.max(1, ids.reduce((n, v) => n + (cantidades.get(v) ?? 0), 0)) : 1;
  const codigosAplicados = new Set(
    (pedido.discount_codes ?? []).map((d) => normalizar(d?.code ?? "")).filter(Boolean)
  );
  const codigoDelAtributo = normalizar(leerAtributo(pedido, ATRIBUTO_CODIGO) ?? "");
  const nombreDelAtributo = normalizarNombre(nombreDelAtributoCupon(leerAtributo(pedido, ATRIBUTO_CUPON) ?? ""));

  const consumos: Consumo[] = [];
  for (const campana of campanas) {
    const tienePagoTotal = campana.fullPaymentVariantIds.some((v) => variantes.has(v));
    const tieneReserva = campana.reservationVariantIds.some((v) => variantes.has(v));

    const porCodigo = tienePagoTotal
      ? campana.coupons.find((c) => codigosAplicados.has(normalizar(c.code)))
      : undefined;
    if (porCodigo) {
      const passengers = pasajerosDe(campana.fullPaymentVariantIds);
      consumos.push({
        campaignId: campana.id,
        couponId: porCodigo.id,
        mode: "FULL_PAYMENT",
        passengers,
        amount: porCodigo.amount * passengers,
      });
      continue;
    }

    const porAtributo = !tieneReserva
      ? undefined
      : codigoDelAtributo
        ? campana.coupons.find((c) => normalizar(c.code) === codigoDelAtributo)
        : nombreDelAtributo
          ? yaPublicados(campana).find((c) => normalizarNombre(c.label) === nombreDelAtributo)
          : undefined;
    if (porAtributo) {
      const passengers = pasajerosDe(campana.reservationVariantIds);
      consumos.push({
        campaignId: campana.id,
        couponId: porAtributo.id,
        mode: "RESERVATION",
        passengers,
        amount: porAtributo.amount * passengers,
      });
    }
  }
  return consumos;
}
