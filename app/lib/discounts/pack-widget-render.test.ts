// Ejecuta el widget de packs de punta a punta contra un DOM mínimo.
//
// Por qué existe: dos de los bugs que llegaron a la tienda de dev —la barra de
// progreso vacía y el widget que no leía el carrito— son de RENDERIZADO, y
// ninguna de las pruebas que había podía verlos. Los tests del cálculo pasaban
// con los números correctos mientras la pantalla mostraba otra cosa.
//
// Esto no reemplaza probar en un tema real: no hay CSS acá, así que un problema
// de estilos del merchant sigue sin poder detectarse. Lo que sí verifica es que
// el widget PRODUZCA el DOM correcto, que es la mitad que sí está en nuestras
// manos.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const SRC = path.join(RAIZ, "scripts/pack-widget-src");
const ASSETS = path.join(RAIZ, "extensions/pack-widget/assets");
/** El unico JS generado, con el build en el nombre. */
const JS_GENERADO = fs
  .readdirSync(ASSETS)
  .filter((f) => /^pack-\d+\.js$/.test(f))[0];

// ─── Un DOM mínimo, solo lo que el widget usa ────────────────────────────────

type Nodo = {
  tagName: string;
  className: string;
  style: Record<string, string> & { setProperty(k: string, v: string): void };
  textContent: string;
  hijos: Nodo[];
  atributos: Record<string, string>;
  dataset: Record<string, string>;
  hidden: boolean;
  disabled: boolean;
  type: string;
  appendChild(n: Nodo): Nodo;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(): void;
  innerHTML: string;
};

function crearNodo(tagName: string): Nodo {
  // El estilo necesita `setProperty` porque el widget lo usa para las custom
  // properties (`--df-pack-cols`), que no se pueden escribir como propiedad.
  const style = {} as Record<string, string> & {
    setProperty(k: string, v: string): void;
  };
  style.setProperty = function (k: string, v: string) {
    style[k] = v;
  };

  const hijos: Nodo[] = [];
  const atributos: Record<string, string> = {};

  const n = {
    tagName,
    className: "",
    style,
    textContent: "",
    hijos,
    atributos,
    dataset: {} as Record<string, string>,
    hidden: false,
    disabled: false,
    type: "",
    // Se cierra sobre `hijos`/`atributos` en vez de usar `this`: dentro de un
    // literal que después se castea, TypeScript infiere `this` como `{}`.
    appendChild(h: Nodo) {
      hijos.push(h);
      return h;
    },
    setAttribute(k: string, v: string) {
      atributos[k] = String(v);
    },
    getAttribute(k: string) {
      return atributos[k] ?? null;
    },
    addEventListener() {},
  } as unknown as Nodo;
  Object.defineProperty(n, "innerHTML", {
    get() {
      return "";
    },
    set() {
      hijos.length = 0;
    },
  });
  return n;
}

/** Recorre el árbol buscando el primer nodo cuya clase contenga `cls`. */
function buscar(raiz: Nodo, cls: string): Nodo | null {
  if ((raiz.className || "").split(/\s+/).includes(cls)) return raiz;
  for (const h of raiz.hijos) {
    const r = buscar(h, cls);
    if (r) return r;
  }
  return null;
}

function textos(raiz: Nodo, acc: string[] = []): string[] {
  if (raiz.textContent) acc.push(raiz.textContent);
  for (const h of raiz.hijos) textos(h, acc);
  return acc;
}

const CAMPANA = "camp_test";
const P = (n: number) => `gid://shopify/Product/${n}`;

const PACK = {
  campaignId: CAMPANA,
  heading: "Armá tu rutina",
  mode: "PACK_SIZE",
  tiers: [
    { minProducts: 2, percent: 10 },
    { minProducts: 3, percent: 20 },
    { minProducts: 4, percent: 30 },
  ],
  minProducts: 2,
  attribute: "_df_pack",
  currency: "USD",
  items: [1, 2, 3, 4, 5].map((i) => ({
    productId: P(i),
    handle: `p${i}`,
    title: `Producto ${i}`,
    variantId: `gid://shopify/ProductVariant/${100 + i}`,
    price: 70,
    image: null,
  })),
};

/**
 * Monta el entorno y corre el widget. `lineasEnCarrito` son los product ids que
 * ya están en el carrito marcados con este pack.
 */
async function montarWidget(lineasEnCarrito: number[]) {
  const raiz = crearNodo("div");
  raiz.dataset.campaign = CAMPANA;
  raiz.dataset.proxy = "/apps/discountflow/pack";
  raiz.dataset.columns = "2";

  const win: Record<string, unknown> = {};
  win.window = win;
  win.document = {
    querySelectorAll: (sel: string) => (sel === "[data-df-pack]" ? [raiz] : []),
    querySelector: () => null,
    addEventListener: () => {},
    createElement: crearNodo,
    readyState: "complete",
    documentElement: { lang: "es" },
  };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.Intl = Intl;
  win.addEventListener = () => {};

  win.fetch = (url: string) => {
    if (String(url).indexOf("/apps/discountflow/pack") === 0)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ pack: PACK }) });
    if (String(url) === "/cart.js")
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            items: lineasEnCarrito.map((i) => ({
              key: `k${i}`,
              product_id: i,
              quantity: 1,
              price: 7000,
              properties: { _df_pack: CAMPANA },
            })),
          }),
      });
    // Los precios en vivo: se deja fallar para quedarnos con la foto.
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  };

  // Un solo archivo: calculo + armador + aviso, tal como lo sirve el tema.
  const todo = fs.readFileSync(path.join(ASSETS, JS_GENERADO), "utf8");

  // El archivo generado declara `var DiscountFlowPackCalc`; en un <script> real
  // eso crea la global. Dentro de `new Function` no, así que se asigna a mano
  // justo antes de la marca de versión, que va después del cálculo.
  new Function(
    "window",
    "document",
    "setTimeout",
    "clearTimeout",
    "fetch",
    "Intl",
    todo.replace(
      "window.DF_PACK_BUILD",
      "window.DiscountFlowPackCalc = DiscountFlowPackCalc; window.DF_PACK_BUILD"
    )
  )(win, win.document, win.setTimeout, win.clearTimeout, win.fetch, Intl);

  // Dejar correr las promesas encadenadas.
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));

  return raiz;
}

// ─── 1. La barra de progreso ─────────────────────────────────────────────────

test("🔴 la barra de progreso se pinta con un ancho real, no vacía", async () => {
  // Cuatro de cinco productos: nivel máximo (el tope de niveles es 4), así que
  // la barra tiene que estar LLENA. Se veía vacía en la tienda con dos
  // implementaciones distintas; ahora la geometría va en línea desde el JS y
  // ninguna hoja del tema puede anularla.
  const raiz = await montarWidget([1, 2, 3, 4]);

  const pista = buscar(raiz, "df-pack__bar");
  assert.ok(pista, "tiene que existir el carril de la barra");

  assert.equal(pista!.getAttribute("data-df-progress"), "100");
  assert.equal(pista!.style.height, "6px", "el carril lleva su alto EN LÍNEA");

  const relleno = buscar(raiz, "df-pack__bar-fill");
  assert.ok(relleno, "tiene que existir el relleno");
  assert.equal(relleno!.style.width, "100%", "🔴 el relleno NO puede quedar vacío");
  assert.equal(relleno!.style.height, "6px", "el relleno lleva su alto EN LÍNEA");
  assert.equal(relleno!.style.background, "currentColor");
  assert.equal(
    relleno!.style.transform,
    undefined,
    "ya no depende de transform: un reset del tema podía anularlo"
  );
});

test("la barra avanza de forma proporcional", async () => {
  const dos = await montarWidget([1, 2]);
  assert.equal(buscar(dos, "df-pack__bar")!.getAttribute("data-df-progress"), "50");
  assert.equal(buscar(dos, "df-pack__bar-fill")!.style.width, "50%");

  const tres = await montarWidget([1, 2, 3]);
  assert.equal(buscar(tres, "df-pack__bar")!.getAttribute("data-df-progress"), "75");
  assert.equal(buscar(tres, "df-pack__bar-fill")!.style.width, "75%");
});

// ─── 2. Leer el carrito existente ────────────────────────────────────────────

test("🔴 el widget precarga el pack que ya está en el carrito", async () => {
  // El caso reportado: armar el pack, ir al carrito, borrar dos líneas y volver.
  // El widget mostraba «0 productos» mientras el carrito enseñaba los 3 con su
  // descuento — dos verdades distintas sobre lo mismo en la misma pantalla.
  const raiz = await montarWidget([1, 2, 3]);
  const todos = textos(raiz).join(" | ");

  assert.match(todos, /3 productos/, "tiene que reconocer los 3 del carrito");
  assert.doesNotMatch(todos, /Agregá 2 productos más/);
  assert.match(todos, /Ya tenés 3 productos de este pack en el carrito/);

  // Los tres van marcados como elegidos.
  const elegidos = JSON.stringify(raiz).match(/is-selected/g) ?? [];
  assert.equal(elegidos.length, 3, "las tres tarjetas tienen que estar marcadas");
});

test("con el pack ya en el carrito, el botón dice actualizar", async () => {
  const conPack = await montarWidget([1, 2, 3]);
  assert.match(textos(conPack).join(" | "), /Actualizar mi pack/);

  const sinPack = await montarWidget([]);
  const t = textos(sinPack).join(" | ");
  assert.match(t, /Agregar pack al carrito/);
  assert.doesNotMatch(t, /Ya tenés/);
});

test("solo se precargan productos que sigan en el catálogo del pack", async () => {
  // Si el merchant sacó un producto del pack, lo que quedó en el carrito de un
  // comprador NO debe reaparecer como parte del pack.
  const raiz = await montarWidget([1, 2, 99]);
  const t = textos(raiz).join(" | ");
  // Se comprueba el aviso de «ya tenés», no el contador: «2 productos» a secas
  // también encaja con «Agregá 2 productos más», y entonces el test pasaría con
  // el widget SIN precargar nada. Pasó al escribirlo.
  assert.match(
    t,
    /Ya tenés 2 productos de este pack en el carrito/,
    "el 99 no está en el catálogo y no cuenta"
  );
  assert.equal(buscar(raiz, "df-pack__bar")!.getAttribute("data-df-progress"), "50");
});

// ─── 3. El estado vacío sigue funcionando ────────────────────────────────────

test("sin nada en el carrito arranca vacío y pide el mínimo", async () => {
  const raiz = await montarWidget([]);
  const t = textos(raiz).join(" | ");
  assert.match(t, /0 productos/);
  assert.match(t, /Agregá 2 productos más/);
  assert.equal(buscar(raiz, "df-pack__bar-fill")!.style.width, "0%");
});

// ─── 4. La estructura del wireframe móvil ────────────────────────────────────
//
// El widget se entregó tres veces sin coincidir con el wireframe: faltaba el
// botón de comprar, el panel «Tu pack» no tenía desglose y las tarjetas eran
// altas en vez de filas compactas. Estas pruebas fijan los ELEMENTOS; el sitio
// donde caen es CSS y sigue sin poder comprobarse sin un navegador.

/** Todos los nodos del árbol cuya clase contenga `cls`. */
function buscarTodos(raiz: Nodo, cls: string, acc: Nodo[] = []): Nodo[] {
  if ((raiz.className || "").split(/\s+/).includes(cls)) acc.push(raiz);
  for (const h of raiz.hijos) buscarTodos(h, cls, acc);
  return acc;
}

test("el panel se llama «Tu pack» y trae el contador al lado", async () => {
  const raiz = await montarWidget([1, 2]);
  const cabecera = buscar(raiz, "df-pack__panel-head");
  assert.ok(cabecera, "falta el encabezado del panel");
  assert.equal(buscar(cabecera!, "df-pack__panel-title")!.textContent, "Tu pack");
  assert.equal(buscar(cabecera!, "df-pack__count")!.textContent, "2 productos");
});

test("🔴 sin nada elegido sale la caja de «Tu pack está vacío»", async () => {
  // Antes acá solo había «0 PRODUCTOS» y una frase suelta, que en móvil se leía
  // como si el widget no hubiera terminado de cargar.
  const raiz = await montarWidget([]);
  const caja = buscar(raiz, "df-pack__empty-box");
  assert.ok(caja, "falta la caja de vacío");
  assert.equal(buscar(caja!, "df-pack__empty-title")!.textContent, "Tu pack está vacío");
  assert.match(textos(caja!).join(" | "), /Agregá 2 productos más/);
});

test("🔴 cada línea del pack lleva foto, ahorro, precio y «Quitar»", async () => {
  const raiz = await montarWidget([1, 2, 3]);
  const lineas = buscarTodos(raiz, "df-pack__item");
  assert.equal(lineas.length, 3, "una línea por producto elegido");

  for (const li of lineas) {
    assert.ok(buscar(li, "df-pack__item-media"), "falta la foto de la línea");
    assert.ok(buscar(li, "df-pack__item-name"), "falta el nombre");
    assert.ok(buscar(li, "df-pack__item-price"), "falta el precio");
    const quitar = buscar(li, "df-pack__item-remove");
    assert.ok(quitar, "🔴 sin «Quitar» la única forma de sacar algo del pack es " +
      "volver a encontrarlo en la lista de abajo");
    assert.equal(quitar!.textContent, "Quitar");
    assert.match(quitar!.getAttribute("aria-label") || "", /^Quitar del pack: /);
  }

  // 3 productos = 20%, y cada uno vale 70: el ahorro por línea tiene que verse.
  assert.match(textos(buscar(raiz, "df-pack__items")!).join(" | "), /Ahorrás/);
});

test("🔴 el botón de la tarjeta lleva ícono, etiqueta y aria-label", async () => {
  // El ícono es para la fila compacta del móvil y la etiqueta para escritorio:
  // los dos están siempre en el DOM y el CSS esconde el que no toca. El
  // `aria-label` lleva la frase entera para que nadie escuche solo «más».
  const raiz = await montarWidget([1]);
  const botones = buscarTodos(raiz, "df-pack__toggle");
  assert.equal(botones.length, 5, "un botón por producto del catálogo");

  const elegido = botones[0];
  assert.equal(elegido.getAttribute("aria-pressed"), "true");
  assert.equal(buscar(elegido, "df-pack__toggle-icon")!.textContent, "−");
  assert.equal(buscar(elegido, "df-pack__toggle-label")!.textContent, "Quitar del pack");
  assert.equal(elegido.getAttribute("aria-label"), "Quitar del pack: Producto 1");

  const libre = botones[1];
  assert.equal(libre.getAttribute("aria-pressed"), "false");
  assert.equal(buscar(libre, "df-pack__toggle-icon")!.textContent, "+");
  assert.equal(buscar(libre, "df-pack__toggle-label")!.textContent, "Agregar al pack");
  assert.equal(libre.getAttribute("aria-label"), "Agregar al pack: Producto 2");
});

test("🔴 el botón de agregar al carrito SIEMPRE está en el DOM", async () => {
  // Es el punto 1 de lo que faltaba: en el móvil de la tienda no aparecía
  // ningún botón y no había forma de completar la compra.
  for (const carrito of [[], [1], [1, 2, 3]]) {
    const raiz = await montarWidget(carrito);
    const cta = buscar(raiz, "df-pack__cta");
    assert.ok(cta, `sin botón con ${carrito.length} en el carrito`);
    assert.ok(buscar(raiz, "df-pack__cta-wrap"), "el botón va dentro de su envoltorio");
    // Deshabilitado mientras no llegue al mínimo, pero presente y visible.
    assert.equal(cta!.disabled, carrito.length < 2);
  }
});

// ─── 5. El primer pintado sin pedir nada ─────────────────────────────────────
//
// El bloque Liquid deja la configuración y los precios ya resueltos dentro de la
// página. Estas pruebas fijan que el widget la use y que NO dependa del app
// proxy para tener algo en pantalla — que es lo que producía el «Cargando tu
// pack…» en cada visita.

const DATOS_INCRUSTADOS = {
  campaignId: CAMPANA,
  heading: "Armá tu rutina",
  mode: "PACK_SIZE",
  tiers: [
    { minProducts: 2, percent: 10 },
    { minProducts: 3, percent: 20 },
    { minProducts: 4, percent: 30 },
  ],
  minProducts: 2,
  attribute: "_df_pack",
  currency: "CLP",
  completo: true,
  seleccionados: [] as string[],
  items: [1, 2, 3, 4, 5].map((i) => ({
    productId: P(i),
    handle: `p${i}`,
    title: `Producto ${i}`,
    variantId: `gid://shopify/ProductVariant/${100 + i}`,
    liveVariantId: 100 + i,
    available: true,
    price: 7000,
    image: null,
    percent: 0,
  })),
};

/** Un entorno mínimo con el nodo de datos que deja Liquid. */
function entorno(
  datos: unknown,
  fetchFalso: (url: string) => Promise<unknown>,
  formatoDinero?: string
) {
  const raiz = crearNodo("div");
  raiz.dataset.campaign = CAMPANA;
  raiz.dataset.proxy = "/apps/discountflow/pack";
  raiz.dataset.columns = "2";
  if (formatoDinero) raiz.dataset.moneyFormat = formatoDinero;

  const nodoDatos = crearNodo("script");
  nodoDatos.textContent = JSON.stringify(datos);
  (raiz as unknown as { querySelector: (s: string) => Nodo | null }).querySelector = (
    sel: string
  ) => (sel === "[data-df-pack-data]" ? nodoDatos : null);

  const win: Record<string, unknown> = {};
  win.window = win;
  win.document = {
    querySelectorAll: (sel: string) => (sel === "[data-df-pack]" ? [raiz] : []),
    querySelector: () => null,
    addEventListener: () => {},
    createElement: crearNodo,
    readyState: "complete",
    documentElement: { lang: "es" },
  };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.Intl = Intl;
  win.addEventListener = () => {};
  win.fetch = fetchFalso;
  return { raiz, win };
}

async function correr(win: Record<string, unknown>) {
  const todo = fs.readFileSync(path.join(ASSETS, JS_GENERADO), "utf8");
  new Function(
    "window",
    "document",
    "setTimeout",
    "clearTimeout",
    "fetch",
    "Intl",
    todo.replace(
      "window.DF_PACK_BUILD",
      "window.DiscountFlowPackCalc = DiscountFlowPackCalc; window.DF_PACK_BUILD"
    )
  )(win, win.document, win.setTimeout, win.clearTimeout, win.fetch, Intl);

  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
}

/** Responde el carrito y deja elegir si el app proxy contesta o se cae. */
function redFalsa(lineas: number[], proxyRoto = false) {
  return (url: string) => {
    if (String(url).indexOf("/apps/discountflow/pack") === 0) {
      if (proxyRoto) return Promise.reject(new Error("proxy caído"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ pack: PACK }) });
    }
    if (String(url) === "/cart.js")
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            items: lineas.map((i) => ({
              key: `k${i}`,
              product_id: i,
              quantity: 1,
              price: 700000,
              properties: { _df_pack: CAMPANA },
            })),
          }),
      });
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  };
}

test("🔴 con los datos de Liquid el widget se pinta aunque el proxy esté caído", async () => {
  // Es la prueba del cambio entero: el primer pintado no depende de nuestro
  // servidor. Antes, sin proxy, el bloque se quedaba en «Cargando tu pack…».
  const { raiz, win } = entorno(DATOS_INCRUSTADOS, redFalsa([], true));
  await correr(win);

  assert.equal(raiz.hidden, false, "el widget no puede esconderse");
  assert.ok(buscar(raiz, "df-pack__grid"), "falta el catálogo");
  assert.equal(buscarTodos(raiz, "df-pack__card").length, 5, "los cinco productos");
  assert.ok(buscar(raiz, "df-pack__cta"), "falta el botón de comprar");
  assert.ok(buscar(raiz, "df-pack__empty-box"), "falta la caja de vacío");

  const t = textos(raiz).join(" | ");
  assert.match(t, /Armá tu rutina/);
  assert.doesNotMatch(t, /Cargando/, "🔴 no puede quedar ningún estado de carga");
});

test("🔴 la preselección de Liquid se respeta si /cart.js no contesta", async () => {
  // Liquid ya leyó el carrito en el servidor. Si la comprobación de fondo falla,
  // lo pintado vale más que nada: borrar la selección sería empeorar.
  const datos = { ...DATOS_INCRUSTADOS, seleccionados: [P(1), P(2), P(3)] };
  const { raiz, win } = entorno(datos, () => Promise.reject(new Error("sin red")));
  await correr(win);

  assert.match(textos(raiz).join(" | "), /3 productos/, "la selección del servidor sobrevive");
  assert.equal(buscarTodos(raiz, "df-pack__item").length, 3);
});

test("el carrito real gana sobre lo que pintó Liquid", async () => {
  // El caso inverso: la página pudo servirse de una caché del tema con un
  // carrito viejo. Si /cart.js contesta, manda /cart.js.
  const datos = { ...DATOS_INCRUSTADOS, seleccionados: [P(1), P(2), P(3)] };
  const { raiz, win } = entorno(datos, redFalsa([1]));
  await correr(win);

  assert.match(textos(raiz).join(" | "), /1 producto/);
  assert.equal(buscarTodos(raiz, "df-pack__item").length, 1);
});

test("🔴 el dinero se escribe con el formato del TEMA, no con el nuestro", async () => {
  // El widget usaba `Intl` mientras la tienda usa `money_format`. En una tienda
  // chilena eso ponía «$7,000.00» al lado de «$7.000» en la misma pantalla.
  const datos = { ...DATOS_INCRUSTADOS, seleccionados: [P(1), P(2)] };
  const { raiz, win } = entorno(
    datos,
    redFalsa([1, 2]),
    "${{amount_no_decimals_with_comma_separator}}"
  );
  await correr(win);

  const t = textos(raiz).join(" | ");
  assert.match(t, /\$7\.000/, "7000 con el formato chileno es $7.000");
  assert.doesNotMatch(t, /7,000\.00/, "eso sería Intl, no el tema");
  // Dos productos al 10%: 14.000 − 1.400 = 12.600.
  assert.match(t, /\$12\.600/);
});
