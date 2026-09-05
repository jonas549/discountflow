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
const ASSETS = path.join(RAIZ, "extensions/pack-widget/assets");

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

  const calc = fs.readFileSync(path.join(ASSETS, "pack-calc.js"), "utf8");
  const builder = fs.readFileSync(path.join(ASSETS, "pack-builder.js"), "utf8");

  new Function("window", "document", "setTimeout", "clearTimeout", "fetch", "Intl", calc + "\n;window.DiscountFlowPackCalc = DiscountFlowPackCalc;")(
    win, win.document, win.setTimeout, win.clearTimeout, win.fetch, Intl
  );
  new Function("window", "document", "setTimeout", "clearTimeout", "fetch", "Intl", builder)(
    win, win.document, win.setTimeout, win.clearTimeout, win.fetch, Intl
  );

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
