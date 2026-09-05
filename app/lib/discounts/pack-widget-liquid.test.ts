// El primer pintado: qué viaja en el metafield y qué resuelve el bloque Liquid.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ ESTE ARCHIVO
//
// El widget mostraba «Cargando tu pack…» en cada visita porque el JavaScript
// tenía que pedirle la configuración a nuestro servidor antes de saber qué
// pintar. El arreglo fue mover el renderizado al servidor de Shopify, y eso
// introdujo dos riesgos nuevos que estos tests son los que sostienen:
//
//   1. Que alguien meta el CÁLCULO DEL DESCUENTO en el Liquid. Habría dos
//      calculadoras y el día que difirieran el comprador vería un precio en la
//      tienda y pagaría otro. `pack-calc` es el único dueño de esa aritmética.
//
//   2. Que el PRECIO se sirva desde el metafield en vez de desde
//      `all_products`. El metafield lo cachea Shopify en Liquid durante horas;
//      un precio viejo sería visible y vergonzoso.
//
// Lo que NO puede comprobar: que Liquid renderice. Eso solo se ve en un
// navegador — buscar «BUILD 11» con Ctrl+U.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { construirMetafieldDeWidget } from "./pack-widget-metafield.ts";
import { MAX_PACK_CATALOG } from "./pack-validate.ts";
import type { PackWidgetPayload } from "./pack-client.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const BLOQUE = fs.readFileSync(
  path.join(RAIZ, "extensions/pack-widget/blocks/pack-builder.liquid"),
  "utf8"
);

// ─── El contenido del metafield ──────────────────────────────────────────────

function payload(n: number): PackWidgetPayload {
  return {
    campaignId: "camp_" + n,
    heading: "Pack " + n,
    mode: "PACK_SIZE",
    tiers: [{ minProducts: 2, percent: 10 }],
    minProducts: 2,
    attribute: "_df_pack",
    currency: "CLP",
    items: Array.from({ length: 3 }, (_, i) => ({
      productId: `gid://shopify/Product/${n}${i}`,
      handle: `p-${n}-${i}`,
      title: `Producto ${i}`,
      variantId: `gid://shopify/ProductVariant/${n}${i}`,
      price: 1000 + i,
      image: null,
      percent: i,
    })),
  };
}

test("🔴 el metafield NO lleva precio, título, foto ni variante", () => {
  // Es la decisión que hace que un metafield cacheado horas no pueda mostrar un
  // precio viejo: esos cuatro campos los resuelve `all_products` en cada
  // renderizado.
  const mf = construirMetafieldDeWidget([payload(1)]);
  const texto = JSON.stringify(mf);

  assert.doesNotMatch(texto, /"price"/);
  assert.doesNotMatch(texto, /"title"/);
  assert.doesNotMatch(texto, /"image"/);
  assert.doesNotMatch(texto, /"variantId"/);

  // Y sí lleva lo que Liquid no puede saber por su cuenta.
  const item = mf.packs["camp_1"].items[0];
  assert.deepEqual(Object.keys(item).sort(), ["handle", "percent", "productId"]);
});

test("el primer pack activo es el que usa un bloque sin campaña", () => {
  const mf = construirMetafieldDeWidget([payload(1), payload(2)]);
  assert.equal(mf.default, "camp_1");
  assert.deepEqual(Object.keys(mf.packs).sort(), ["camp_1", "camp_2"]);
  assert.equal(mf.v, 1);
});

test("sin packs activos el metafield queda vacío, no ausente", () => {
  // Vacío y escrito es lo correcto: si el merchant pausó su único pack, el
  // bloque tiene que dejar de ofrecerlo. Un metafield ausente se confundiría
  // con "todavía no se escribió nunca" y el widget caería al proxy.
  const mf = construirMetafieldDeWidget([]);
  assert.equal(mf.default, null);
  assert.deepEqual(mf.packs, {});
});

test("🔴 el catálogo se corta en MAX_PACK_CATALOG, que es el límite de Liquid", () => {
  // `all_products` solo resuelve 20 handles por página. Una campaña guardada
  // antes de esa decisión puede tener 24: los sobrantes se cortan acá, no en el
  // bloque, porque un handle de más deja un hueco silencioso.
  const grande = payload(9);
  grande.items = Array.from({ length: MAX_PACK_CATALOG + 6 }, (_, i) => ({
    productId: `gid://shopify/Product/${i}`,
    handle: `h-${i}`,
    title: `P${i}`,
    variantId: `gid://shopify/ProductVariant/${i}`,
    price: 100,
    image: null,
  }));

  const mf = construirMetafieldDeWidget([grande]);
  assert.equal(mf.packs["camp_9"].items.length, MAX_PACK_CATALOG);
  assert.equal(MAX_PACK_CATALOG, 20, "el límite de `all_products` es 20 por página");
});

test("un producto sin handle no viaja: en Liquid no se puede resolver", () => {
  const p = payload(3);
  p.items[1].handle = "";
  const mf = construirMetafieldDeWidget([p]);
  assert.equal(mf.packs["camp_3"].items.length, 2);
});

test("un pack cuyo catálogo entero quedó fuera no se ofrece", () => {
  const p = payload(4);
  p.items.forEach((i) => (i.handle = ""));
  const mf = construirMetafieldDeWidget([p]);
  assert.deepEqual(mf.packs, {});
  assert.equal(mf.default, null);
});

// ─── El bloque Liquid ────────────────────────────────────────────────────────

test("🔴 el precio sale de `all_products`, NUNCA del metafield", () => {
  assert.match(
    BLOQUE,
    /all_products\[df_item\.handle\]/,
    "el bloque tiene que resolver cada producto contra all_products"
  );
  assert.match(
    BLOQUE,
    /df_v\.price \| money/,
    "el precio visible tiene que salir de la variante que resolvió Liquid"
  );
  assert.match(
    BLOQUE,
    /selected_or_first_available_variant/,
    "la variante también sale en vivo: la que el widget agrega al carrito"
  );
});

test("🔴 el bloque NO calcula descuentos", () => {
  // La regla que sostiene «el precio que ve el comprador es el que paga».
  // Liquid resuelve estructura y precios; los porcentajes, los ahorros y los
  // totales son de `pack-calc`, que es el módulo que corre en el checkout.
  const cuerpo = BLOQUE.replace(/\{%-?\s*comment[\s\S]*?endcomment\s*-?%\}/g, "").replace(
    /\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g,
    ""
  );

  for (const prohibido of [/times:\s*df_t\.percent/, /divided_by:\s*100\s*\|\s*times/, /df_ahorro/, /df_total/]) {
    assert.doesNotMatch(cuerpo, prohibido, `el bloque hace aritmética de descuento: ${prohibido}`);
  }
  // El texto del progreso lo escribe el JS porque nombra un porcentaje.
  assert.match(cuerpo, /class="df-pack__progress-text"><\/span>/);
});

test("el bloque deja los datos incrustados para que el JS no pida nada", () => {
  assert.match(BLOQUE, /<script type="application\/json" data-df-pack-data>/);
  const js = fs.readFileSync(
    path.join(RAIZ, "scripts/pack-widget-src/pack-builder.js"),
    "utf8"
  );
  assert.match(js, /\[data-df-pack-data\]/, "el JS tiene que leer ese nodo");
});

test("🔴 el «Cargando» solo existe en el camino sin metafield", () => {
  // Es la comprobación del pedido: el estado de carga no se acortó, se sacó del
  // camino normal. Solo queda donde de verdad hay una vuelta a la red.
  // Sin los comentarios: ahí la frase aparece varias veces contando la historia.
  const cuerpo = BLOQUE.replace(/\{%-?\s*comment[\s\S]*?endcomment\s*-?%\}/g, "").replace(
    /\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g,
    ""
  );
  const cargas = cuerpo.match(/Cargando tu pack/g) ?? [];
  assert.equal(cargas.length, 1, "solo puede quedar UN «Cargando tu pack»");

  const sinMetafield = BLOQUE.slice(
    BLOQUE.indexOf("{%- if df_pack == nil -%}"),
    BLOQUE.indexOf("{%- else -%}")
  );
  assert.match(sinMetafield, /Cargando tu pack/, "y tiene que estar en la rama del proxy");
});

test("la preselección sale de `cart.items`, en el servidor", () => {
  assert.match(BLOQUE, /for df_line in cart\.items/);
  assert.match(
    BLOQUE,
    /df_line\.properties\[df_pack\.attribute\]/,
    "se compara contra la propiedad que la Function busca, no contra un literal"
  );
});

test("el bloque prueba las DOS formas de leer el metafield y lo dice", () => {
  // La documentación oficial dice `app.metafields`; los reportes de la comunidad
  // dicen que en una theme app extension a veces solo responde `shop.metafields`
  // con el namespace completo. Se prueban las dos y el diagnóstico dice cuál
  // contestó, que es lo que hace la diferencia entre depurar y adivinar.
  assert.match(BLOQUE, /app\.metafields\.discountflow\.pack_widget/);
  assert.match(BLOQUE, /shop\.metafields\["\$app:discountflow"\]\.pack_widget/);
  assert.match(BLOQUE, /metafield = \{\{ df_fuente \}\}/, "y sale en el comentario de Ctrl+U");
});

test("el bloque avisa cuando `all_products` no le alcanzó", () => {
  // El cupo de 20 handles es POR PÁGINA: si el tema ya gastó parte, acá faltan
  // productos. El bloque lo marca y el JS lo repara contra el proxy.
  assert.match(BLOQUE, /data-df-incompleto/);
  assert.match(BLOQUE, /data-df-resueltos="\{\{ df_resueltos \}\}\/\{\{ df_esperados \}\}"/);
});
