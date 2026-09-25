// Ejecuta el widget de cupones de viaje de punta a punta contra un DOM mínimo.
//
// Lo que verifica es lo que el widget HACE con el carrito, que es donde está
// el dinero:
//   · con Pago total, el código va al carrito y los códigos ajenos se conservan;
//   · con Reserva, el código NO va (la reserva se paga completa) y el monto
//     queda anotado para la agencia;
//   · cambiar de Pago total a Reserva QUITA el código.
//
// No reemplaza probar en el tema real: acá no hay CSS. Eso lo mira Jonas.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const SRC = fs.readFileSync(path.join(import.meta.dirname, "widget-tienda.js"), "utf8");

// ─── DOM mínimo ──────────────────────────────────────────────────────────────

type Nodo = {
  tagName: string;
  className: string;
  id: string;
  type: string;
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  style: { cssText: string };
  hijos: Nodo[];
  atributos: Record<string, string>;
  handlers: Record<string, Array<() => void>>;
  textContent: string;
  lastChild: Nodo | null;
  appendChild(n: Nodo): Nodo;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(ev: string, fn: () => void): void;
};

function nodo(tagName: string, texto = ""): Nodo {
  const hijos: Nodo[] = [];
  const atributos: Record<string, string> = {};
  const handlers: Record<string, Array<() => void>> = {};
  let propio = texto;
  const n = {
    tagName,
    className: "",
    id: "",
    type: "",
    name: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    style: { cssText: "" },
    hijos,
    atributos,
    handlers,
    appendChild(h: Nodo) {
      hijos.push(h);
      return h;
    },
    setAttribute(k: string, v: string) {
      atributos[k] = String(v);
    },
    getAttribute(k: string) {
      return k in atributos ? atributos[k] : null;
    },
    addEventListener(ev: string, fn: () => void) {
      (handlers[ev] ??= []).push(fn);
    },
  } as unknown as Nodo;
  Object.defineProperty(n, "textContent", {
    get: () => propio + hijos.map((h) => h.textContent).join(""),
    set: (v: string) => {
      propio = String(v ?? "");
      hijos.length = 0;
    },
  });
  Object.defineProperty(n, "lastChild", { get: () => hijos[hijos.length - 1] ?? null });
  return n;
}

function todos(raiz: Nodo, pred: (n: Nodo) => boolean, acc: Nodo[] = []): Nodo[] {
  if (pred(raiz)) acc.push(raiz);
  for (const h of raiz.hijos) todos(h, pred, acc);
  return acc;
}

const esperar = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// ─── Escenario ───────────────────────────────────────────────────────────────

const PAYLOAD = {
  campaignId: "camp",
  heading: "Cupones de descuento",
  messageFullPayment: "TOTAL: {monto} en el carrito ({cupon})",
  messageReservation: "RESERVA: {monto} del saldo ({cupon})",
  fullPaymentVariantIds: ["11"],
  reservationVariantIds: ["22"],
  coupons: [
    { label: "Cupón 1", amount: 100000, restantes: 0, agotado: true, code: null },
    { label: "Cupón 2", amount: 125000, restantes: 3, agotado: false, code: "DFVDOS" },
  ],
  atributos: {
    cupon: "Cupón de viaje",
    saldo: "Descontar del saldo",
    obsoletos: ["_df_cupon_viaje", "_df_cupon_viaje_calculo"],
  },
};

type LineaDeCarrito = { variant_id: number; quantity: number };

function montar(
  opciones: {
    payload?: unknown;
    variante?: string;
    formato?: string;
    /** Cantidad en el selector de la ficha. `null` = el tema no tiene selector. */
    pasajeros?: number | null;
    /** Líneas que ya están en el carrito. */
    carrito?: LineaDeCarrito[];
    /** Atributos que ya tiene el carrito. */
    atributos?: Record<string, string>;
    /** Monta el MODO CARRITO (página del carrito) en vez de la ficha. */
    modoCarrito?: boolean;
    /** Lo que ya guardó el navegador. `false` = sin almacenamiento (modo privado). */
    almacen?: Record<string, string> | false;
    /** El almacenamiento de la visita (pestaña), compartible entre montajes. */
    sesion?: Record<string, string>;
  } = {}
) {
  const root = nodo("div");
  root.setAttribute(opciones.modoCarrito ? "data-df-cupones-viaje-carrito" : "data-df-cupones-viaje", "");
  root.setAttribute("data-product-id", "555");
  root.setAttribute("data-money-format", opciones.formato ?? "${{amount_no_decimals_with_comma_separator}}");

  const campoVariante = nodo("input");
  campoVariante.value = opciones.variante ?? "11";
  // El selector de cantidad de la ficha: en GeoTerra, los pasajeros. El tema de
  // la tienda de dev NO lo tiene (pedido #1022), de ahí la opción `null`.
  const campoCantidad = opciones.pasajeros === null ? null : nodo("input");
  if (campoCantidad) campoCantidad.value = String(opciones.pasajeros ?? 1);

  // El carrito: líneas, códigos y atributos que se conservan entre llamadas,
  // como en Shopify.
  const carrito = {
    items: [...(opciones.carrito ?? [])],
    attributes: { ...(opciones.atributos ?? {}) } as Record<string, string>,
    codigos: [{ code: "OTRO10" }, { code: "DFVVIEJO" }],
  };
  const actualizaciones: Array<{ attributes: Record<string, string>; discount?: string }> = [];
  const intervalos: Array<() => void> = [];

  const sandbox: Record<string, unknown> = {};
  const document = {
    readyState: "complete",
    hidden: false,
    head: nodo("head"),
    documentElement: nodo("html"),
    createElement: (t: string) => nodo(t),
    createTextNode: (t: string) => nodo("#text", t),
    getElementById: () => null,
    addEventListener() {},
    querySelector(sel: string) {
      if (sel.includes('[name="id"]')) return campoVariante;
      if (sel.includes('[name="quantity"]')) return campoCantidad;
      return null;
    },
    querySelectorAll(sel: string) {
      const marca = opciones.modoCarrito ? "[data-df-cupones-viaje-carrito]" : "[data-df-cupones-viaje]";
      if (sel.startsWith(marca) && root.getAttribute("data-df-iniciado") === null) return [root];
      return [];
    },
  };

  // 🔴 El fetch del navegador exige que el receptor sea `window`. Node no, y
  // eso dejó pasar el bug que rompió el fetch de la página entera en packs.
  function fetchDeNavegador(this: unknown, url: string, init?: { body?: string }) {
    // Se compara contra el `window` que VE EL SCRIPT, no contra `sandbox`: en
    // un contexto de `vm` son objetos distintos, y comparar contra el de afuera
    // hacía fallar la llamada correcta (el instrumento roto, no el widget).
    if (this !== windowDelScript) throw new TypeError("Illegal invocation");
    const responder = (data: unknown, status = 200) =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(data) });
    const payload = opciones.payload === undefined ? PAYLOAD : opciones.payload;
    if (url.startsWith("/apps/discountflow/cupones-viaje?product=555"))
      return responder({ campana: payload });
    if (url === "/apps/discountflow/cupones-viaje?modo=carrito")
      return responder({ atributos: PAYLOAD.atributos });
    if (url.startsWith("/apps/discountflow/cupones-viaje?codigo=")) return responder({ campana: payload });
    if (url === "/cart.js")
      return responder({
        attributes: { ...carrito.attributes },
        discount_codes: carrito.codigos,
        // El producto de cada línea: el guardián lo usa para pedir la campaña.
        items: carrito.items.map((i) => ({ product_id: 555, ...i })),
      });
    if (url === "/cart/update.js") {
      const body = JSON.parse(init?.body ?? "{}");
      actualizaciones.push(body);
      for (const [k, v] of Object.entries(body.attributes ?? {}) as Array<[string, string]>)
        if (v === "") delete carrito.attributes[k];
        else carrito.attributes[k] = v;
      if (typeof body.discount === "string")
        carrito.codigos = body.discount ? body.discount.split(",").map((code: string) => ({ code })) : [];
      return responder({});
    }
    return responder({}, 404);
  }

  // El almacenamiento del navegador: el recuerdo del cupón vive acá.
  const almacen: Record<string, string> = { ...(opciones.almacen || {}) };
  const localStorage =
    opciones.almacen === false
      ? {
          getItem() {
            throw new Error("SecurityError");
          },
          setItem() {
            throw new Error("SecurityError");
          },
          removeItem() {
            throw new Error("SecurityError");
          },
        }
      : {
          getItem: (k: string) => (k in almacen ? almacen[k] : null),
          setItem: (k: string, v: string) => void (almacen[k] = String(v)),
          removeItem: (k: string) => void delete almacen[k],
        };

  const sesion = opciones.sesion ?? {};
  const sessionStorage = {
    getItem: (k: string) => (k in sesion ? sesion[k] : null),
    setItem: (k: string, v: string) => void (sesion[k] = String(v)),
    removeItem: (k: string) => void delete sesion[k],
  };

  Object.assign(sandbox, {
    localStorage,
    sessionStorage,
    document,
    fetch: fetchDeNavegador,
    location: { search: "" },
    URLSearchParams,
    Promise,
    JSON,
    console: { warn: (...a: unknown[]) => process.env.DF_DEBUG && console.error("WIDGET:", ...a) },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (fn: () => void) => {
      intervalos.push(fn);
      return intervalos.length;
    },
    MutationObserver: class {
      observe() {}
    },
  });
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const windowDelScript: unknown = vm.runInContext("window", sandbox);
  vm.runInContext(SRC, sandbox);

  /** Una vuelta de todos los sondeos del widget (variante, cantidad y carrito). */
  const tick = () => {
    for (const fn of intervalos) fn();
  };

  return {
    root,
    carrito,
    almacen,
    actualizaciones,
    tick,
    cambiarVariante(v: string) {
      campoVariante.value = v;
      tick();
    },
    cambiarPasajeros(n: number) {
      if (campoCantidad) campoCantidad.value = String(n);
      tick();
    },
    estado: () => todos(root, (n) => n.className === "df-cv__estado")[0]?.textContent ?? "",
    botones: () => todos(root, (n) => n.tagName === "button"),
    mensaje: () => todos(root, (n) => n.className === "df-cv__msg")[0]?.textContent ?? "",
    pinchar(i: number) {
      const r = todos(root, (n) => n.tagName === "button")[i];
      for (const fn of r.handlers.click ?? []) fn();
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("pinta los cupones: el agotado apagado con «Agotado», el disponible con lo que queda", async () => {
  const w = montar();
  await esperar();
  const botones = w.botones();
  assert.equal(botones.length, 2);
  assert.equal(botones[0].disabled, true);
  assert.equal(botones[1].disabled, false);
  const texto = w.root.textContent;
  assert.match(texto, /Cupón 1Agotado/);
  assert.match(texto, /Cupón 2\$125\.000 · quedan 3/);
  assert.equal(w.root.getAttribute("data-df-estado"), "listo");
});

test("🔴 los cupones son botones que no envían ningún formulario", async () => {
  const w = montar();
  await esperar();
  // Sin esto el test pasaría en vacío con cero botones — ya pasó una vez.
  assert.equal(w.botones().length, 2);
  for (const b of w.botones()) assert.equal(b.type, "button");
});

test("con Pago total el mensaje es el de Pago total, con el monto formateado como el tema", async () => {
  const w = montar({ variante: "11" });
  await esperar();
  assert.equal(w.mensaje(), "TOTAL: $125.000 en el carrito (Cupón 2)");
});

test("🔴 PAGO TOTAL: el código va al carrito y se conservan los códigos que NO son nuestros", async () => {
  const w = montar({ variante: "11" });
  await esperar();
  w.pinchar(1);
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.discount, "OTRO10,DFVDOS"); // DFVVIEJO (nuestro, viejo) se quita
  assert.equal(u.attributes["Cupón de viaje"], "Cupón 2 · $125.000 por pasajero");
  // 🔴 Nada técnico: la agencia solo ve «Cupón de viaje» y «Descontar del saldo».
  assert.deepEqual(Object.keys(u.attributes).sort(), ["Cupón de viaje", "Descontar del saldo"]);
  assert.equal(u.attributes["Descontar del saldo"], ""); // en Pago total no se anota saldo
});

test("🔴 RESERVA: el código NO va al carrito y el monto queda anotado para la agencia", async () => {
  const w = montar({ variante: "22" });
  await esperar();
  assert.equal(w.mensaje(), "RESERVA: $125.000 del saldo (Cupón 2)");
  w.pinchar(1);
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.discount, "OTRO10");
  assert.equal(u.attributes["Cupón de viaje"], "Cupón 2 · $125.000 por pasajero");
  assert.deepEqual(Object.keys(u.attributes).sort(), ["Cupón de viaje", "Descontar del saldo"]);
  assert.equal(u.attributes["Descontar del saldo"], "$125.000");
});

test("🔴 pasar de Pago total a Reserva con el cupón elegido QUITA el código del carrito", async () => {
  const w = montar({ variante: "11" });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.match(w.actualizaciones.at(-1)!.discount ?? "", /DFVDOS/);

  w.cambiarVariante("22");
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.discount, "OTRO10");
  assert.equal(u.attributes["Descontar del saldo"], "$125.000");
  assert.equal(w.mensaje(), "RESERVA: $125.000 del saldo (Cupón 2)");
});

test("pinchar el cupón elegido lo quita: sin código y sin anotación", async () => {
  const w = montar({ variante: "22" });
  await esperar();
  w.pinchar(1);
  await esperar();
  w.pinchar(1);
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.discount, "OTRO10");
  assert.equal(u.attributes["Cupón de viaje"], "");
  assert.equal(u.attributes["Descontar del saldo"], "");
});

test("🔴 sin elegir se ve como un BOTÓN: borde visible, espacio interno y esquinas redondeadas", async () => {
  const w = montar();
  await esperar();
  const estilo = w.botones()[1].style.cssText;
  assert.match(estilo, /border:1\.5px solid /);
  assert.match(estilo, /padding:\.75em 1\.25em/);
  assert.match(estilo, /border-radius:8px/);
  assert.match(estilo, /background:transparent/);
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "false");
  // Y separado de lo de arriba y de abajo.
  assert.match(w.root.style.cssText, /margin:1\.5em 0/);
});

test("elegido: fondo con el color del texto y texto con el fondo (oscuro sobre claro)", async () => {
  const w = montar({ variante: "22" });
  await esperar();
  w.pinchar(1);
  await esperar();
  const b = w.botones()[1];
  assert.equal(b.getAttribute("aria-pressed"), "true");
  // Sin estilos computados (este DOM mínimo) caen a los de reserva.
  assert.match(b.style.cssText, /background:#121212/);
  assert.match(b.style.cssText, /color:#ffffff/);
  // Deseleccionar lo devuelve al estado de botón sin elegir.
  w.pinchar(1);
  await esperar();
  assert.match(w.botones()[1].style.cssText, /background:transparent/);
});

test("agotado: borde punteado, apagado y sin cursor de clic", async () => {
  const w = montar();
  await esperar();
  const estilo = w.botones()[0].style.cssText;
  assert.match(estilo, /border:1\.5px dashed /);
  assert.match(estilo, /opacity:\.45/);
  assert.match(estilo, /cursor:not-allowed/);
});

test("🔴 el monto va SIN decimales aunque la tienda los use (USD, como la de dev)", async () => {
  const w = montar({ variante: "22", formato: "${{amount}}" });
  await esperar();
  assert.match(w.root.textContent, /\$125,000 · quedan 3/);
  assert.doesNotMatch(w.root.textContent, /125,000\.00/);
  w.pinchar(1);
  await esperar();
  assert.equal(w.actualizaciones.at(-1)!.attributes["Descontar del saldo"], "$125,000");
});

test("un cupón agotado no se puede pinchar", async () => {
  const w = montar();
  await esperar();
  w.pinchar(0);
  await esperar();
  assert.equal(w.actualizaciones.length, 0);
});

test("sin campaña para el producto, el bloque se oculta y no toca el carrito", async () => {
  const w = montar({ payload: null });
  await esperar();
  assert.equal(w.root.hidden, true);
  assert.equal(w.actualizaciones.length, 0);
});

test("🔴 no parchea nada del tema ni usa posición fija", () => {
  const sinComentarios = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(sinComentarios, /window\.fetch\s*=|XMLHttpRequest\.prototype/);
  assert.doesNotMatch(sinComentarios, /position\s*:\s*fixed/);
  // Las claves de los atributos llegan en el payload: si el widget las
  // escribiera a mano, podrían divergir del webhook sin que nadie se entere.
  assert.doesNotMatch(sinComentarios, /_df_cupon_viaje|Descontar del saldo/);
});

// ─── Por pasajero (decisión de Jonas, 2026-09-25) ────────────────────────────

test("🔴 RESERVA con 2 pasajeros anota el TOTAL: $250.000 (2 × $125.000)", async () => {
  // El bug del pedido #1020: 2 reservas con un cupón de $1.000 anotaron $1,000.
  const w = montar({ variante: "22", pasajeros: 2 });
  await esperar();
  w.pinchar(1);
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.attributes["Descontar del saldo"], "$250.000 (2 pasajeros × $125.000)");
  assert.equal(u.attributes["Cupón de viaje"], "Cupón 2 · $125.000 por pasajero");
  assert.match(w.estado(), /anotado en tu reserva: \$250\.000 \(2 pasajeros\)/);
});

test("🔴 cambiar la cantidad de pasajeros con el cupón elegido vuelve a anotar el total", async () => {
  const w = montar({ variante: "22", pasajeros: 1 });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.equal(w.actualizaciones.at(-1)!.attributes["Descontar del saldo"], "$125.000");
  w.cambiarPasajeros(3);
  await esperar();
  assert.equal(
    w.actualizaciones.at(-1)!.attributes["Descontar del saldo"],
    "$375.000 (3 pasajeros × $125.000)"
  );
});

test("🔴 sin cupos para todos los pasajeros, el cupón NO se aplica y se dice por qué", async () => {
  // El Cupón 2 tiene 3 cupos; 4 pasajeros no entran.
  const w = montar({ variante: "11", pasajeros: 4 });
  await esperar();
  w.pinchar(1);
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.attributes["Cupón de viaje"], "");
  assert.doesNotMatch(u.discount ?? "", /DFVDOS/);
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "false");
  assert.match(w.estado(), /tiene 3 cupos: no alcanza para 4 pasajeros/);
});

test("si con el cupón elegido suben los pasajeros por encima de los cupos, se suelta el cupón", async () => {
  const w = montar({ variante: "11", pasajeros: 2 });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.match(w.actualizaciones.at(-1)!.discount ?? "", /DFVDOS/);
  w.cambiarPasajeros(5);
  await esperar();
  assert.doesNotMatch(w.actualizaciones.at(-1)!.discount ?? "", /DFVDOS/);
  assert.match(w.estado(), /no alcanza para 5 pasajeros/);
});

// ─── Los pasajeros salen del CARRITO (pedido #1022) ──────────────────────────

test("🔴 #1022: sin selector de cantidad en la ficha, las 2 reservas del carrito anotan $250.000", async () => {
  // Así estaba la tienda de dev: el tema no tiene selector de cantidad y las 2
  // reservas se sumaron en el carrito. El widget anotaba 1 pasajero.
  const w = montar({ variante: "22", pasajeros: null, carrito: [{ variant_id: 22, quantity: 2 }] });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.equal(
    w.actualizaciones.at(-1)!.attributes["Descontar del saldo"],
    "$250.000 (2 pasajeros × $125.000)"
  );
});

test("🔴 si el carrito cambia con el cupón elegido (se agrega otra vez), el total se corrige solo", async () => {
  const w = montar({ variante: "22", pasajeros: 1, carrito: [{ variant_id: 22, quantity: 1 }] });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.equal(w.actualizaciones.at(-1)!.attributes["Descontar del saldo"], "$125.000");
  // El comprador agrega otra reserva: el carrito pasa a 2.
  w.carrito.items[0].quantity = 2;
  w.tick();
  await esperar();
  assert.equal(
    w.actualizaciones.at(-1)!.attributes["Descontar del saldo"],
    "$250.000 (2 pasajeros × $125.000)"
  );
});

test("con el carrito sin cambios, el sondeo no reescribe nada", async () => {
  const w = montar({ variante: "22", carrito: [{ variant_id: 22, quantity: 2 }] });
  await esperar();
  w.pinchar(1);
  await esperar();
  const antes = w.actualizaciones.length;
  w.tick();
  await esperar();
  w.tick();
  await esperar();
  assert.equal(w.actualizaciones.length, antes);
});

test("las reservas de otra fecha del mismo viaje también cuentan; las de Pago total no", async () => {
  const payload = { ...PAYLOAD, reservationVariantIds: ["22", "23"] };
  const w = montar({
    payload,
    variante: "22",
    carrito: [
      { variant_id: 22, quantity: 1 },
      { variant_id: 23, quantity: 2 },
      { variant_id: 11, quantity: 5 },
    ],
  });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.equal(
    w.actualizaciones.at(-1)!.attributes["Descontar del saldo"],
    "$375.000 (3 pasajeros × $125.000)"
  );
});

// ─── Modo carrito: la página del carrito ─────────────────────────────────────

test("🔴 MODO CARRITO: si en la página del carrito suben las reservas, reescribe el total", async () => {
  const w = montar({
    modoCarrito: true,
    carrito: [{ variant_id: 22, quantity: 3 }],
    // Sin nada guardado en el navegador: pide la campaña del producto del carrito.
    atributos: { "Cupón de viaje": "Cupón 2 · $125.000 por pasajero", "Descontar del saldo": "$125.000" },
  });
  await esperar();
  const u = w.actualizaciones.at(-1)!;
  assert.equal(u.attributes["Descontar del saldo"], "$375.000 (3 pasajeros × $125.000)");
  // No toca los códigos de descuento: solo el total.
  assert.equal(u.discount, undefined);
  assert.equal(w.root.hidden, true);
});

test("MODO CARRITO: con el total ya correcto no escribe nada", async () => {
  const w = montar({
    modoCarrito: true,
    carrito: [{ variant_id: 22, quantity: 2 }],
    atributos: {
      "Cupón de viaje": "Cupón 2 · $125.000 por pasajero",
      "Descontar del saldo": "$250.000 (2 pasajeros × $125.000)",
    },
  });
  await esperar();
  w.tick();
  await esperar();
  assert.equal(w.actualizaciones.length, 0);
});

test("MODO CARRITO: sin cupón anotado no hace nada", async () => {
  const w = montar({ modoCarrito: true, carrito: [{ variant_id: 22, quantity: 2 }] });
  await esperar();
  assert.equal(w.actualizaciones.length, 0);
});

// ─── Pedido limpio: solo lo que ve la agencia (2026-09-25) ────────────────────

test("🔴 los atributos técnicos de antes se BORRAN del carrito al elegir el cupón", async () => {
  const w = montar({
    variante: "22",
    carrito: [{ variant_id: 22, quantity: 2 }],
    atributos: { _df_cupon_viaje: "DFVVIEJO", _df_cupon_viaje_calculo: "1000|22" },
  });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.deepEqual(Object.keys(w.carrito.attributes).sort(), ["Cupón de viaje", "Descontar del saldo"]);
});

test("al elegir el cupón, el cálculo queda en el NAVEGADOR (no en el carrito); al soltarlo, se borra", async () => {
  const w = montar({ variante: "22", carrito: [{ variant_id: 22, quantity: 2 }] });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.deepEqual(JSON.parse(w.almacen["df-cupon-viaje"]), {
    nombre: "cupón 2",
    monto: 125000,
    reservas: PAYLOAD.reservationVariantIds,
  });
  w.pinchar(1);
  await esperar();
  assert.equal(w.almacen["df-cupon-viaje"], undefined);
});

test("🔴 #1023: MODO CARRITO con el cálculo guardado en el navegador corrige sin ir al servidor", async () => {
  const w = montar({
    modoCarrito: true,
    payload: null, // el proxy no tiene campaña: lo guardado alcanza
    carrito: [{ variant_id: 22, quantity: 3 }],
    almacen: { "df-cupon-viaje": JSON.stringify({ nombre: "cupón 2", monto: 125000, reservas: ["22"] }) },
    atributos: { "Cupón de viaje": "Cupón 2 · $125.000 por pasajero", "Descontar del saldo": "$125.000" },
  });
  await esperar();
  assert.equal(w.actualizaciones.at(-1)!.attributes["Descontar del saldo"], "$375.000 (3 pasajeros × $125.000)");
});

test("MODO CARRITO sin almacenamiento en el navegador (modo privado): pide la campaña y corrige igual", async () => {
  const w = montar({
    modoCarrito: true,
    almacen: false,
    carrito: [{ variant_id: 22, quantity: 2 }],
    atributos: { "Cupón de viaje": "Cupón 2 · $125.000 por pasajero", "Descontar del saldo": "$125.000" },
  });
  await esperar();
  assert.equal(w.actualizaciones.at(-1)!.attributes["Descontar del saldo"], "$250.000 (2 pasajeros × $125.000)");
});

test("MODO CARRITO: si no encuentra el cupón por ningún lado, no inventa un total", async () => {
  const w = montar({
    modoCarrito: true,
    payload: null,
    carrito: [{ variant_id: 22, quantity: 3 }],
    atributos: { "Cupón de viaje": "Cupón 2 · $125.000 por pasajero", "Descontar del saldo": "$125.000" },
  });
  await esperar();
  assert.equal(w.actualizaciones.length, 0);
});

test("🔴 PAGO TOTAL: el estado muestra el total con las personas de la ficha", async () => {
  const w = montar({ variante: "11", pasajeros: 2 });
  await esperar();
  w.pinchar(1);
  await esperar();
  assert.equal(w.estado(), "✓ Cupón 2 aplicado: 2 personas × $125.000 = $250.000");
  w.cambiarPasajeros(1);
  await esperar();
  assert.equal(w.estado(), "✓ Cupón 2 aplicado: $125.000 por persona");
});

test("el cupón elegido se reconoce por su NOMBRE al volver a la ficha", async () => {
  const w = montar({
    variante: "22",
    atributos: { "Cupón de viaje": "Cupón 2 · $125.000 por pasajero" },
  });
  await esperar();
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "true");
});

// ─── «Cupón marcado al entrar» (autoApply) ───────────────────────────────────

test("🔴 con autoApply, el primer cupón disponible se aplica solo al cargar la ficha", async () => {
  const w = montar({ payload: { ...PAYLOAD, autoApply: true }, variante: "11" });
  await esperar();
  await esperar();
  // El Cupón 1 está agotado: se marca el Cupón 2.
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "true");
  assert.equal(w.carrito.attributes["Cupón de viaje"], "Cupón 2 · $125.000 por pasajero");
  assert.deepEqual(w.carrito.codigos.map((c) => c.code), ["OTRO10", "DFVDOS"]);
});

test("sin autoApply (lo de siempre), la ficha no toca el carrito hasta que el comprador pincha", async () => {
  const w = montar({ variante: "11" });
  await esperar();
  await esperar();
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "false");
  assert.equal(w.actualizaciones.filter((u) => "discount" in u).length, 0);
});

test("con autoApply y un cupón ya elegido en el carrito, no se re-aplica nada", async () => {
  const w = montar({
    payload: { ...PAYLOAD, autoApply: true },
    variante: "22",
    atributos: { "Cupón de viaje": "Cupón 2 · $125.000 por pasajero" },
  });
  await esperar();
  await esperar();
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "true");
  assert.equal(w.actualizaciones.filter((u) => "discount" in u).length, 0);
});

test("🔴 si el comprador QUITA el cupón, no se le vuelve a marcar solo en esa visita", async () => {
  const sesion: Record<string, string> = {};
  const w = montar({ payload: { ...PAYLOAD, autoApply: true }, variante: "11", sesion });
  await esperar();
  await esperar();
  w.pinchar(1); // lo quita
  await esperar();
  assert.equal(w.botones()[1].getAttribute("aria-pressed"), "false");
  // Vuelve a la ficha (recarga) en la misma pestaña.
  const otra = montar({ payload: { ...PAYLOAD, autoApply: true }, variante: "11", sesion });
  await esperar();
  await esperar();
  assert.equal(otra.botones()[1].getAttribute("aria-pressed"), "false");
  assert.equal(otra.actualizaciones.filter((u) => "discount" in u).length, 0);
});
