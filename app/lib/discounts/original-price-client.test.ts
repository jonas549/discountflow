// El código del cupón, lo que viaja al metafield, y el formulario.
//
// El cálculo está en `original-price-calc.test.ts` y las fixtures contra el
// Wasm real en `extensions/code-original-price/tests/`. Acá va todo lo que
// rodea al cálculo y que puede romperse sin que ninguno de esos dos se entere.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  originalPriceProductsLabel,
  exclusionQueAnulaElCupon,
  toOriginalPriceFunctionConfig,
  originalPriceDiscountMessage,
  originalPriceLabel,
  normalizeDiscountCode,
  ORIGINAL_PRICE_DEFAULT_MESSAGE,
  type OriginalPriceCampaignConfig,
} from "./original-price-client.ts";
import { es } from "../../i18n.ts";
import {
  parseOriginalPriceForm,
  validateOriginalPriceForm,
  buildOriginalPriceConfig,
} from "./original-price-form.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const leer = (p: string) => fs.readFileSync(path.join(RAIZ, p), "utf8");

const BASE: OriginalPriceCampaignConfig = { percent: 10, code: "MARIA10" };

// ─── El código ───────────────────────────────────────────────────────────────

test("🔴 el código se normaliza a una sola forma", () => {
  // Si guardáramos "maria 10" y Shopify "MARIA10", la atribución del pedido no
  // cruzaría y el merchant vería cero ventas de ese influencer — sin ningún
  // error a la vista. Es el mismo tipo de fallo mudo que ya mordió con las
  // propiedades de línea del pack.
  assert.equal(normalizeDiscountCode("  maria 10 "), "MARIA10");
  assert.equal(normalizeDiscountCode("Influ_Ana"), "INFLU_ANA");
  assert.equal(normalizeDiscountCode(""), "");
  assert.equal(normalizeDiscountCode(undefined as unknown as string), "");
});

test("el formulario normaliza el código una sola vez, al parsear", () => {
  const f = formulario({ name: "Cupón", code: " maria 10 ", percent: "10" });
  assert.equal(f.code, "MARIA10");
  assert.equal(buildOriginalPriceConfig(f).code, "MARIA10");
});

// ─── Lo que viaja al metafield ───────────────────────────────────────────────

test("🔴 el CÓDIGO no viaja al metafield", () => {
  // Shopify ya sabe cuál es el código: se lo damos al crear el descuento y solo
  // llama a la Function cuando el comprador lo escribe. Mandarlo otra vez sería
  // un segundo sitio donde puede quedar desincronizado.
  const cfg = toOriginalPriceFunctionConfig({ ...BASE, shopifyDiscountId: "gid://x" });
  assert.deepEqual(Object.keys(cfg).sort(), [
    "excludeIfCartValue",
    "excludeIfPackIds",
    "message",
    "minQuantity",
    "minSubtotal",
    "percent",
    "productIds",
    "scope",
  ]);
});

// ─── Alcance: a qué productos aplica ─────────────────────────────────────────

test("🔴 el alcance viaja EXPLÍCITO, y con 'all' la lista de productos va vacía", () => {
  // Si con "toda la tienda" mandáramos igual los productos que quedaron de una
  // selección anterior, la Function tendría una lista que podría usar y un
  // scope que dice otra cosa. Un solo campo decide.
  const todo = toOriginalPriceFunctionConfig({
    ...BASE,
    selectionMode: "all",
    productIds: ["gid://shopify/Product/1"],
  });
  assert.equal(todo.scope, "all");
  assert.deepEqual(todo.productIds, []);

  const algunos = toOriginalPriceFunctionConfig({
    ...BASE,
    selectionMode: "products",
    productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
  });
  assert.equal(algunos.scope, "selected");
  assert.deepEqual(algunos.productIds, [
    "gid://shopify/Product/1",
    "gid://shopify/Product/2",
  ]);
});

test("una campaña vieja sin selectionMode sigue aplicando a toda la tienda", () => {
  // Compatibilidad: las campañas guardadas antes de que existiera el alcance
  // aplicaban a todo. Cambiarlas en silencio sería cambiarle la campaña al
  // merchant sin avisarle.
  const cfg = toOriginalPriceFunctionConfig(BASE);
  assert.equal(cfg.scope, "all");
});

test("las colecciones NO viajan al metafield: viajan los productos resueltos", () => {
  // La Function solo ve productos. Resolver colecciones dentro del checkout
  // exigiría una consulta que la Discount Function API no permite hacer.
  const cfg = toOriginalPriceFunctionConfig({
    ...BASE,
    selectionMode: "collections",
    collectionIds: ["gid://shopify/Collection/9"],
    productIds: ["gid://shopify/Product/7"],
  });
  assert.equal(cfg.scope, "selected");
  assert.deepEqual(cfg.productIds, ["gid://shopify/Product/7"]);
  assert.ok(!("collectionIds" in cfg));
});

// ─── Requisitos mínimos ──────────────────────────────────────────────────────

test("solo viaja el mínimo que el merchant eligió", () => {
  // Los dos campos se conservan en la config para repintar el formulario, pero
  // al metafield va solo el activo: si viajaran los dos, cambiar de "monto" a
  // "cantidad" dejaría el mínimo viejo aplicando también.
  const monto = toOriginalPriceFunctionConfig({
    ...BASE,
    minimumType: "subtotal",
    minSubtotal: 100,
    minQuantity: 5,
  });
  assert.equal(monto.minSubtotal, 100);
  assert.equal(monto.minQuantity, null);

  const cantidad = toOriginalPriceFunctionConfig({
    ...BASE,
    minimumType: "quantity",
    minSubtotal: 100,
    minQuantity: 5,
  });
  assert.equal(cantidad.minSubtotal, null);
  assert.equal(cantidad.minQuantity, 5);

  const ninguno = toOriginalPriceFunctionConfig({
    ...BASE,
    minimumType: "none",
    minSubtotal: 100,
    minQuantity: 5,
  });
  assert.equal(ninguno.minSubtotal, null);
  assert.equal(ninguno.minQuantity, null);
});

test("la lista de exclusiones llega al metafield, y vacía si no hay", () => {
  assert.deepEqual(
    toOriginalPriceFunctionConfig({ ...BASE, excludedPackCampaignIds: ["p1", "p2"] })
      .excludeIfPackIds,
    ["p1", "p2"]
  );
  assert.deepEqual(toOriginalPriceFunctionConfig(BASE).excludeIfPackIds, []);
});

test("el mensaje por defecto es el mismo que el de la Function", () => {
  assert.equal(originalPriceDiscountMessage(BASE), ORIGINAL_PRICE_DEFAULT_MESSAGE);
  assert.equal(
    originalPriceDiscountMessage({ ...BASE, message: "  " }),
    ORIGINAL_PRICE_DEFAULT_MESSAGE
  );

  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.ok(
    fn.includes(`'${ORIGINAL_PRICE_DEFAULT_MESSAGE}'`),
    "🔴 el texto por defecto tiene que coincidir con el de la Function: es el que " +
      "ve el comprador si el merchant no escribe ninguno"
  );
});

test("el resumen del listado dice sobre qué se calcula", () => {
  assert.equal(originalPriceLabel(BASE), "10% sobre el precio original");
});

// ─── El formulario ───────────────────────────────────────────────────────────

function formulario(campos: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return parseOriginalPriceForm(fd);
}

test("el formulario exige nombre, código y porcentaje", () => {
  const vacio = formulario({});
  const e = validateOriginalPriceForm(vacio);
  assert.ok(e.name);
  assert.ok(e.code);
  assert.ok(e.percent);

  const bueno = formulario({ name: "Cupón de María", code: "MARIA10", percent: "10" });
  assert.deepEqual(validateOriginalPriceForm(bueno), {});
});

test("🔴 un código que no se puede dictar por teléfono se rechaza", () => {
  // Shopify acepta más, pero un código con acentos o símbolos raros es un
  // código que el influencer va a dictar mal y el comprador va a escribir mal.
  for (const malo of ["AB", "MARÍA10", "MARIA#10", "MARIA/10"]) {
    const f = formulario({ name: "Cupón", code: malo, percent: "10" });
    assert.ok(validateOriginalPriceForm(f).code, `debería rechazar "${malo}"`);
  }
  for (const bueno of ["ABC", "MARIA-10", "MARIA_10", "MARIA.10", "INFLU10"]) {
    const f = formulario({ name: "Cupón", code: bueno, percent: "10" });
    assert.equal(validateOriginalPriceForm(f).code, undefined, `debería aceptar "${bueno}"`);
  }
});

test("quitar todas las exclusiones se puede guardar", () => {
  const f = formulario({
    name: "Cupón",
    code: "MARIA10",
    percent: "10",
    excludedPacksJson: "[]",
  });
  assert.deepEqual(buildOriginalPriceConfig(f).excludedPackCampaignIds, []);
});

test("un JSON roto no revienta el guardado", () => {
  const f = formulario({
    name: "Cupón",
    code: "MARIA10",
    percent: "10",
    excludedPacksJson: "{{{roto",
  });
  assert.deepEqual(f.excludedPackCampaignIds, []);
  assert.deepEqual(validateOriginalPriceForm(f), {});
});

test("la fecha de fin tiene que ser posterior a la de inicio", () => {
  const f = formulario({
    name: "Cupón",
    code: "MARIA10",
    percent: "10",
    startsAt: "2026-10-01T10:00",
    endsAt: "2026-09-01T10:00",
  });
  assert.ok(validateOriginalPriceForm(f).dates);
});

// ─── Las mutaciones ──────────────────────────────────────────────────────────

test("🔴 el cupón usa LAS DOS familias de mutaciones, una por método", () => {
  // Desde el 2026-09-06 el merchant elige entre código y automático, así que el
  // cupón usa las dos familias a propósito. Lo que hay que impedir ya no es que
  // aparezca `discountAutomatic*` —eso ahora es correcto— sino que falte alguna
  // de las diez mutaciones, que es lo que dejaría un método a medias.
  const src = leer("app/lib/discounts/original-price.ts");
  for (const m of [
    "discountCodeAppCreate",
    "discountCodeAppUpdate",
    "discountCodeActivate",
    "discountCodeDeactivate",
    "discountCodeDelete",
    "discountAutomaticAppCreate",
    "discountAutomaticAppUpdate",
    "discountAutomaticActivate",
    "discountAutomaticDeactivate",
    "discountAutomaticDelete",
  ]) {
    assert.match(src, new RegExp(m), `falta ${m}`);
  }
});

test("🔴 la mutación AUTOMÁTICA no manda `code` ni los límites de uso", () => {
  // Ninguno de los tres existe en `DiscountAutomaticAppInput` (verificado por
  // introspección contra la tienda el 2026-09-06). Mandarlos no da un
  // descuento sin límite: hace fallar la mutación entera, y el merchant lee un
  // error de la API sobre campos que no vio en ninguna pantalla.
  const src = leer("app/lib/discounts/original-price.ts");

  // El bloque de variables de cada mutación automática, hasta el nombre de la
  // raíz que `runDiscountMutation` recibe al final.
  for (const raiz of ["discountAutomaticAppCreate", "discountAutomaticAppUpdate"]) {
    const desde = src.indexOf(`mutation ${raiz === "discountAutomaticAppCreate" ? "CreateOriginalPriceAutomatic" : "UpdateOriginalPriceAutomatic"}`);
    assert.ok(desde > 0, `no se halló la mutación de ${raiz}`);
    const hasta = src.indexOf(`"${raiz}"`, desde);
    assert.ok(hasta > desde, `no se halló el cierre de ${raiz}`);
    const bloque = src.slice(desde, hasta);

    assert.doesNotMatch(bloque, /limitesDeUso/, `${raiz} no puede mandar los límites`);
    assert.doesNotMatch(bloque, /^\s*code,$/m, `${raiz} no puede mandar el código`);
  }
});

test("🔴 el ciclo de vida empareja cada método con SU familia", () => {
  // Llamar a `discountCodeDelete` sobre un descuento automático no borra nada:
  // Shopify devuelve un userError. La tabla es la única fuente de ese
  // emparejamiento, así que se comprueba entrada por entrada.
  const src = leer("app/lib/discounts/original-price.ts");
  const tabla = src.slice(
    src.indexOf("const CICLO_DE_VIDA"),
    src.indexOf("async function operarCicloDeVida")
  );
  assert.ok(tabla.length > 0, "no se halló la tabla del ciclo de vida");

  for (const [operacion, code, auto] of [
    ["activar", "discountCodeActivate", "discountAutomaticActivate"],
    ["pausar", "discountCodeDeactivate", "discountAutomaticDeactivate"],
    ["eliminar", "discountCodeDelete", "discountAutomaticDelete"],
  ] as const) {
    const bloque = tabla.slice(tabla.indexOf(`${operacion}: {`));
    const fin = bloque.indexOf("},");
    const trozo = bloque.slice(0, fin);
    assert.match(trozo, new RegExp(`CODE: \\[[^\\]]*${code}`), `${operacion}/CODE`);
    assert.match(trozo, new RegExp(`AUTOMATIC: \\[[^\\]]*${auto}`), `${operacion}/AUTOMATIC`);
  }
});

test("🔴 pasar a AUTOMÁTICO conserva el código, no lo borra", () => {
  // Bug reportado el 2026-09-06: se guardaba vacío, y volver al método de
  // código dejaba al merchant sin el código que había escrito. La config guarda
  // lo que el merchant escribió; qué se le manda a Shopify lo decide la
  // mutación, que en automático no manda `code` porque ese campo no existe.
  const cfg = buildOriginalPriceConfig(
    formulario({
      name: "Cupón",
      code: "MARIA10",
      percent: "10",
      metodo: "AUTOMATIC",
      limitarUsos: "on",
      usageLimit: "5",
      oncePerCustomer: "on",
    })
  );
  assert.equal(cfg.metodo, "AUTOMATIC");
  assert.equal(cfg.code, "MARIA10", "el código tiene que sobrevivir");

  // Los límites SÍ se ponen en null, y por otro motivo: no son algo que el
  // merchant escribió y que se le esté guardando aparte, son campos que la
  // pantalla no mostró en automático. Dejarlos puestos haría reaparecer un
  // límite que nadie vio al volver al método de código.
  assert.equal(cfg.usageLimit, null);
  assert.equal(cfg.oncePerCustomer, false);
});

test("🔴 el viaje completo CÓDIGO → AUTOMÁTICO → CÓDIGO no pierde el código", () => {
  // Es la reproducción exacta del bug, en los tres guardados que hizo Jonas.
  const guardar = (campos: Record<string, string>) =>
    buildOriginalPriceConfig(formulario(campos));

  const base = { name: "Cupón", percent: "10" };

  // 1. Se crea con método de código.
  const paso1 = guardar({ ...base, metodo: "CODE", code: "TEST" });
  assert.equal(paso1.code, "TEST");

  // 2. Se edita a automático. El formulario reenvía el código que tenía —viaja
  //    en un input oculto arriba del Form, fuera de las secciones plegables— y
  //    el guardado tiene que respetarlo.
  const paso2 = guardar({ ...base, metodo: "AUTOMATIC", code: paso1.code! });
  assert.equal(paso2.code, "TEST", "acá se perdía");

  // 3. Se vuelve al método de código: sigue ahí, sin volver a escribirlo.
  const paso3 = guardar({ ...base, metodo: "CODE", code: paso2.code! });
  assert.equal(paso3.code, "TEST");
  assert.equal(paso3.metodo, "CODE");
  // Y valida bien: un código conservado es un código usable.
  assert.equal(validateOriginalPriceForm(
    formulario({ ...base, metodo: "CODE", code: paso2.code! })
  ).code, undefined);
});

test("el formulario reenvía el código aunque su sección esté escondida", () => {
  // El campo del código solo se pinta en el método de código, pero su `input
  // hidden` vive ARRIBA del Form, fuera de las secciones. Si alguien lo moviera
  // adentro, el código dejaría de viajar en automático y el bug volvería por la
  // puerta de atrás.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");
  const arriba = src.slice(0, src.indexOf("<Section"));
  assert.match(arriba, /name="code"/, "el código tiene que serializarse arriba");
});

test("🔴 el pie del panel dice una cosa distinta según el método", () => {
  // Con un solo texto, el panel decía "Método: Automático" y debajo "cuando el
  // comprador escribe el código". Las dos no pueden ser ciertas.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");
  assert.match(src, /usaCodigo \? t\.avisoCarrito : t\.avisoCarritoAutomatico/);
  assert.ok("avisoCarritoAutomatico" in es.nuevoCupon);
  assert.notEqual(es.nuevoCupon.avisoCarrito, es.nuevoCupon.avisoCarritoAutomatico);
  // El de automático no puede AFIRMAR que el comprador escribe un código.
  // (Decir "no hay código que escribir" sí está bien: es justo la aclaración.)
  assert.doesNotMatch(es.nuevoCupon.avisoCarritoAutomatico, /escribe el c[oó]digo/i);
  assert.match(es.nuevoCupon.avisoCarrito, /escribe el c[oó]digo/i);
});

test("con método automático se avisa que el código quedó guardado", () => {
  // Que se conserve no alcanza si el merchant no puede saberlo: el campo
  // desaparece de la pantalla.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");
  assert.match(src, /!usaCodigo && code\.trim\(\)\.length > 0/);
  assert.match(src, /t\.codigoConservado\(code\)/);
  assert.match(es.nuevoCupon.codigoConservado("TEST"), /TEST/);
});

test("el automático no exige código; el de código sí", () => {
  const base = { name: "Cupón", percent: "10" };
  assert.equal(
    validateOriginalPriceForm(formulario({ ...base, metodo: "AUTOMATIC" })).code,
    undefined
  );
  assert.ok(validateOriginalPriceForm(formulario({ ...base, metodo: "CODE" })).code);
});

// ─── Exclusión por monto de compra ───────────────────────────────────────────

test("🔴 el cupón solo puede excluir descuentos por MONTO DE COMPRA", () => {
  // La razón está en `combinesWith`, que es bilateral, y es lo que hace que
  // ofrecer una casilla para escalonados o BxGy sería mentir:
  //
  //   Cupón           order:true   product:true
  //   Monto de compra order:false  product:true   → conviven
  //   Pack            order:true   product:false  → no conviven
  //   Escalonado      order:false  product:false  → no conviven
  //   BxGy            order:false  product:false  → no conviven
  const server = leer("app/lib/discounts/cart-value.server.ts");

  // Las de monto se devuelven como excluibles, con su umbral.
  assert.match(server, /montosDeCompra:/);
  assert.match(server, /minSubtotal: cartValueMinimum/);

  // Escalonados y BxGy van a la lista de AVISO, no a la de exclusión.
  assert.match(server, /bloqueantes: campanas[\s\S]{0,200}TIERED[\s\S]{0,40}BXGY/);
});

test("los IDs de monto excluidos llegan a la config y al metafield", () => {
  const cfg = buildOriginalPriceConfig(
    formulario({
      name: "Cupón",
      code: "MARIA10",
      percent: "10",
      excludedMontosJson: JSON.stringify(["camp_a", "camp_b"]),
    })
  );
  assert.deepEqual(cfg.excludedCartValueCampaignIds, ["camp_a", "camp_b"]);

  // Al metafield viaja lo que el SERVIDOR resolvió, no los IDs sueltos: la
  // Function necesita el umbral, y el umbral vive en la otra campaña.
  const conUmbral = toOriginalPriceFunctionConfig(cfg, [
    { campaignId: "camp_a", minSubtotal: 50 },
  ]);
  assert.deepEqual(conUmbral.excludeIfCartValue, [
    { campaignId: "camp_a", minSubtotal: 50 },
  ]);

  // Sin resolver, no viaja nada: una exclusión sin umbral no excluye.
  assert.deepEqual(toOriginalPriceFunctionConfig(cfg).excludeIfCartValue, []);
});

test("una exclusión con umbral 0 no viaja al metafield", () => {
  const cfg = buildOriginalPriceConfig(
    formulario({ name: "Cupón", code: "MARIA10", percent: "10" })
  );
  assert.deepEqual(
    toOriginalPriceFunctionConfig(cfg, [
      { campaignId: "roto", minSubtotal: 0 },
      { campaignId: "bueno", minSubtotal: 25 },
    ]).excludeIfCartValue,
    [{ campaignId: "bueno", minSubtotal: 25 }]
  );
});

test("🔴 la Function evalúa la exclusión por monto ANTES de calcular", () => {
  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  const iExcl = fn.indexOf("evaluarExclusionPorMonto(");
  const iCalc = fn.indexOf("computeOriginalPriceDiscount(");
  assert.ok(iExcl > 0 && iCalc > 0);
  assert.ok(iExcl < iCalc, "la exclusión se evalúa antes de calcular nada");
  assert.match(fn, /motivo=excluido-por-monto-de-compra/);
});

test("🔴 el cupón acepta convivir, para que Shopify no descarte nada solo", () => {
  // La lección del carrito mixto: `combinesWith` en false hace que Shopify elija
  // un ganador en silencio. Quién gana lo decide el merchant con la exclusión.
  const src = leer("app/lib/discounts/original-price.ts");
  assert.match(src, /const COMBINACION_DEL_CUPON = \{\s*orderDiscounts: true/);
  assert.match(src, /const COMBINACION_DEL_CUPON = \{[^}]*productDiscounts: true/);
  const usos = src.match(/combinesWith: COMBINACION_DEL_CUPON/g) ?? [];
  assert.equal(usos.length, 2, "al crear Y al actualizar");
});

test("el código se reescribe al actualizar", () => {
  // El merchant puede cambiarlo. Si no lo mandáramos en el update, quedaría el
  // viejo funcionando y el nuevo sin existir — y el influencer repartiendo un
  // código muerto.
  const src = leer("app/lib/discounts/original-price.ts");
  const update = src.slice(src.indexOf("export async function updateOriginalPriceDiscount"));
  assert.match(update, /^\s*code,$/m, "el update tiene que mandar el código");
});

test("🔴 la Function corta ANTES de calcular, y deja dicho por qué", () => {
  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.match(fn, /motivo=excluido-por-campana/);

  const iExcl = fn.indexOf("excluidos.indexOf(packId)");
  const iCalc = fn.indexOf("computeOriginalPriceDiscount(");
  assert.ok(iExcl > 0 && iCalc > 0);
  assert.ok(iExcl < iCalc, "la exclusión se evalúa antes de calcular nada");
});

test("🔴 la Function emite MONTO FIJO por unidad, nunca un porcentaje", () => {
  // Es todo el tipo de campaña: un porcentaje lo calcularía Shopify sobre el
  // precio ya rebajado y estaríamos donde empezamos. Y sin `appliesToEachItem`
  // el monto se aplicaría una vez por línea en vez de por unidad.
  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.match(fn, /fixedAmount: \{amount: l\.discountPerUnit, appliesToEachItem: true\}/);
  assert.doesNotMatch(fn, /percentage:/, "un porcentaje anularía el propósito del tipo");
});


// ─── Los dos límites de uso: son NATIVOS y hay que mandarlos bien ────────────

test("🔴 el nombre del campo es `appliesOncePerCustomer`, no `appliesToOncePerCustomer`", () => {
  // Verificado por introspección contra la tienda el 2026-09-06 (API 2025-10).
  // La documentación de shopify.dev muestra en algunas páginas
  // `appliesToOncePerCustomer`, que NO existe en el schema: un campo inventado
  // hace fallar la mutación entera y el merchant ve un error de la API sobre un
  // campo que no vio en ninguna pantalla.
  const src = leer("app/lib/discounts/original-price.ts");
  assert.match(src, /appliesOncePerCustomer:/);
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, ""),
    /appliesToOncePerCustomer/,
    "ese campo no existe en el schema de Shopify"
  );
});

test("🔴 los límites de uso se mandan al CREAR y también al ACTUALIZAR", () => {
  // Es la lección del `combinesWith` que no se reescribía, con otro campo: si
  // el update no los mandara, quitar el límite en el formulario dejaría el
  // viejo vivo en Shopify. El merchant leería "sin límite" en la app y el
  // código se agotaría a los 100 usos.
  const src = leer("app/lib/discounts/original-price.ts");
  const usos = src.match(/\.\.\.limitesDeUso\(config\)/g) ?? [];
  assert.equal(usos.length, 2, "al crear Y al actualizar");
});

test("un límite vacío o cero viaja como null, que es lo que Shopify entiende", () => {
  // `usageLimit: 0` sería un cupón que no se puede usar nunca. "Sin límite" es
  // null, y el formulario tiene que poder volver a "sin límite".
  const f = (extra: Record<string, string>) =>
    buildOriginalPriceConfig(
      formulario({ name: "Cupón", code: "MARIA10", percent: "10", ...extra })
    );

  assert.equal(f({}).usageLimit, null);
  assert.equal(f({ usageLimit: "100" }).usageLimit, null, "sin la casilla, no hay límite");
  assert.equal(f({ limitarUsos: "on", usageLimit: "100" }).usageLimit, 100);
  assert.equal(f({ limitarUsos: "on", usageLimit: "0" }).usageLimit, null);
  assert.equal(f({ limitarUsos: "on", usageLimit: "abc" }).usageLimit, null);
});

test("destildar el límite lo borra, aunque el número siga escrito en el campo", () => {
  // El campo y la casilla van separados a propósito. Si el límite se dedujera
  // de que el campo tenga un número, destildar la casilla no lo quitaría.
  const errores = validateOriginalPriceForm(
    formulario({ name: "Cupón", code: "MARIA10", percent: "10", limitarUsos: "on" })
  );
  assert.ok(errores.usageLimit, "con la casilla puesta y sin número, se avisa");
});

// ─── A qué aplica ────────────────────────────────────────────────────────────

test("elegir productos o colecciones sin elegir nada es un error del formulario", () => {
  const base = { name: "Cupón", code: "MARIA10", percent: "10" };

  assert.ok(
    validateOriginalPriceForm(formulario({ ...base, selectionMode: "products" })).selection
  );
  assert.ok(
    validateOriginalPriceForm(formulario({ ...base, selectionMode: "collections" })).selection
  );
  // Y "toda la tienda" no pide nada.
  assert.equal(
    validateOriginalPriceForm(formulario({ ...base, selectionMode: "all" })).selection,
    undefined
  );
});

test("cambiar a 'toda la tienda' no deja atrás la selección anterior", () => {
  // Guardarla "por si vuelve" es lo que deja una lista viva detrás de un scope
  // que dice otra cosa.
  const cfg = buildOriginalPriceConfig(
    formulario({
      name: "Cupón",
      code: "MARIA10",
      percent: "10",
      selectionMode: "all",
      productsJson: JSON.stringify([{ id: "gid://shopify/Product/1" }]),
      collectionIdsJson: JSON.stringify(["gid://shopify/Collection/1"]),
    })
  );
  assert.deepEqual(cfg.productIds, []);
  assert.deepEqual(cfg.collectionIds, []);
});

// ─── Requisitos mínimos ──────────────────────────────────────────────────────

test("el mínimo elegido sin número es un error, y el no elegido no molesta", () => {
  const base = { name: "Cupón", code: "MARIA10", percent: "10" };

  assert.ok(
    validateOriginalPriceForm(formulario({ ...base, minimumType: "subtotal" })).minimum
  );
  assert.ok(
    validateOriginalPriceForm(formulario({ ...base, minimumType: "quantity" })).minimum
  );
  assert.equal(
    validateOriginalPriceForm(formulario({ ...base, minimumType: "none", minSubtotal: "" }))
      .minimum,
    undefined
  );
});

test("el monto mínimo acepta la coma decimal", () => {
  // El merchant chileno escribe "1.500,50". `Number` no entiende ninguno de los
  // dos separadores juntos y habría guardado NaN — o peor, 1.5.
  const f = (v: string) =>
    buildOriginalPriceConfig(
      formulario({
        name: "Cupón",
        code: "MARIA10",
        percent: "10",
        minimumType: "subtotal",
        minSubtotal: v,
      })
    ).minSubtotal;

  assert.equal(f("100"), 100);
  assert.equal(f("100.50"), 100.5);
  assert.equal(f("100,50"), 100.5);
  assert.equal(f("1.500,50"), 1500.5);
  assert.equal(f(""), null);
});

// ─── La Function ─────────────────────────────────────────────────────────────

test("🔴 la Function decide el alcance ANTES de calcular, y falla cerrado", () => {
  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");

  const iAlcance = fn.indexOf("filtrarLineasEnAlcance(");
  const iCalc = fn.indexOf("computeOriginalPriceDiscount(");
  assert.ok(iAlcance > 0 && iCalc > 0);
  assert.ok(iAlcance < iCalc, "el alcance se resuelve antes de calcular nada");

  // Y los dos motivos tienen que quedar en el log, distintos entre sí: "este
  // producto no está en la campaña" y "la campaña no tiene productos" mandan a
  // buscar el problema a sitios distintos.
  assert.match(fn, /motivo=alcance-vacio-sin-all/);
  assert.match(fn, /motivo=fuera-de-alcance/);
});

test("🔴 la Function compara PRODUCTO contra producto, no variante", () => {
  // El merchant elige productos. Comparar contra la variante dejaría fuera a
  // todas las demás variantes del mismo producto, y el merchant vería el cupón
  // fallar solo en algunas tallas.
  const q = leer(
    "extensions/code-original-price/src/cart_lines_discounts_generate_run.graphql"
  );
  assert.match(q, /merchandise\s*\{[\s\S]*ProductVariant[\s\S]*product\s*\{\s*id/);
});

test("🔴 los mínimos los comprueba la Function: Shopify no los soporta", () => {
  // `minimumRequirement` no existe en `DiscountCodeAppInput` (introspección del
  // 2026-09-06). Si alguien lo agrega a la mutación, Shopify rechaza la
  // llamada entera.
  const src = leer("app/lib/discounts/original-price.ts");
  assert.doesNotMatch(src, /minimumRequirement/);

  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.match(fn, /minSubtotal: config\.minSubtotal/);
  assert.match(fn, /minQuantity: config\.minQuantity/);
});


// ─── Los textos ──────────────────────────────────────────────────────────────

test("🔴 todos los textos que pide el formulario existen en i18n", () => {
  // Es la familia de bug de `tipoLabel`: en JavaScript, `t.claveMalEscrita` no
  // se queja — devuelve `undefined` y React pinta un hueco. Con tres secciones
  // nuevas y una treintena de claves nuevas, el hueco lo iba a encontrar Jonas
  // mirando la app, como las dos veces anteriores.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");

  const usadas = new Set<string>();
  for (const m of src.matchAll(/\bt\.([a-zA-Z][a-zA-Z0-9]*)/g)) usadas.add(m[1]);
  // Las que se leen por índice, `t[m.labelKey]`, van declaradas en el propio
  // literal `MODOS` y se recogen aparte.
  for (const m of src.matchAll(/labelKey: "([a-zA-Z][a-zA-Z0-9]*)"/g)) usadas.add(m[1]);

  assert.ok(usadas.size > 40, `se esperaban muchas claves, se hallaron ${usadas.size}`);

  const faltan = [...usadas].filter((k) => !(k in es.nuevoCupon)).sort();
  assert.deepEqual(faltan, [], `claves usadas y no definidas: ${faltan.join(", ")}`);
});

test("las tres secciones nuevas están en la pantalla y en el resumen", () => {
  // Que la clave exista no significa que se pinte. Esto comprueba que las tres
  // secciones que pidió Jonas están puestas Y que el panel de resumen las
  // refleja, que era la mitad del requisito.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");

  for (const seccion of ["secAplicabilidad", "secMinimos", "secUsos"]) {
    assert.match(
      src,
      new RegExp(`Section title=\\{num\\(t\\.${seccion}\\)\\}`),
      `falta la sección ${seccion}`
    );
  }

  for (const fila of ["resumenAplica", "resumenMinimo", "resumenUsos"]) {
    assert.match(src, new RegExp(`t\\.${fila}\\b`), `el resumen no refleja ${fila}`);
  }
});


test("🔴 ningún campo del formulario vive dentro de una sección plegable", () => {
  // `Section` pinta `{open && (...)}`: al plegarse DESMONTA sus hijos, y un
  // input desmontado NO viaja en el FormData.
  //
  // Con los campos dentro, plegar «A qué aplica» antes de guardar dejaba la
  // campaña en «toda la tienda» sin avisar — y «Programación» arranca PLEGADA,
  // así que las fechas se perdían siempre que el merchant no la abriera.
  //
  // El estado va serializado arriba del `<Form>`, como en `TieredCampaignForm`.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");

  const desdeLaPrimeraSeccion = src.slice(src.indexOf("<Section"));
  const dentro = [...desdeLaPrimeraSeccion.matchAll(/name="([a-zA-Z]+)"/g)]
    .map((m) => m[1])
    // `minimumTypeRadio` y `metodoRadio` agrupan radios y NO se envían: el
    // valor viaja en su `input hidden` de arriba, que sí está comprobado abajo.
    // `intent` está en los botones de la ActionBar, que nunca se pliegan.
    .filter((n) => !["minimumTypeRadio", "metodoRadio", "intent"].includes(n));

  assert.deepEqual(dentro, [], `campos dentro de una sección plegable: ${dentro.join(", ")}`);

  // Y al revés: todo lo que el parseo lee tiene que estar serializado arriba.
  const arriba = src.slice(0, src.indexOf("<Section"));
  for (const campo of [
    "name",
    "metodo",
    "code",
    "percent",
    "selectionMode",
    "productsJson",
    "collectionIdsJson",
    "minimumType",
    "minSubtotal",
    "minQuantity",
    "limitarUsos",
    "usageLimit",
    "oncePerCustomer",
    "excludedPacksJson",
    "excludedMontosJson",
    "startsAt",
    "endsAt",
  ]) {
    assert.match(arriba, new RegExp(`name="${campo}"`), `falta serializar ${campo}`);
  }
});


// ─── El alcance que muestra el LISTADO ───────────────────────────────────────

test("🔴 el listado muestra el alcance REAL, no una constante", () => {
  // Bug del 2026-09-06: el listado imprimía `"Toda la tienda"` a mano para
  // todos los cupones. La campaña «TEst cupon» decía «Colecciones → Camisas» al
  // editarla y «Toda la tienda» en la lista. Los tests pasaban verdes porque
  // nadie miraba esa columna.
  assert.equal(originalPriceProductsLabel({ ...BASE }), "Toda la tienda");
  assert.equal(
    originalPriceProductsLabel({ ...BASE, selectionMode: "all", productIds: [] }),
    "Toda la tienda"
  );

  // Ésta es la config REAL de la campaña que reportó Jonas: colecciones, con 7
  // productos resueltos. Tiene que decir 7, no "Toda la tienda".
  assert.equal(
    originalPriceProductsLabel({
      ...BASE,
      selectionMode: "collections",
      collectionIds: ["gid://shopify/Collection/311071441032"],
      productIds: Array.from({ length: 7 }, (_, i) => `gid://shopify/Product/${i}`),
    }),
    "7"
  );

  assert.equal(
    originalPriceProductsLabel({
      ...BASE,
      selectionMode: "products",
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
    }),
    "2"
  );

  // Por colección sin resolver todavía (borrador): "—", no "0". Un 0 haría
  // pensar que no aplica a nada.
  assert.equal(
    originalPriceProductsLabel({
      ...BASE,
      selectionMode: "collections",
      collectionIds: ["gid://x"],
      productIds: [],
    }),
    "—"
  );
});

test("🔴 la columna del listado no puede volver a llevar el alcance escrito a mano", () => {
  const src = leer("app/routes/app.campaigns._index.tsx");
  const rama = src.slice(src.indexOf('c.type === "CODE_ORIGINAL_PRICE"\n                          ?'));
  assert.match(
    rama.slice(0, 300),
    /originalPriceProductsLabel/,
    "el alcance del cupón tiene que salir de la config"
  );
});

// ─── La combinación que no puede aplicar nunca ───────────────────────────────

test("🔴 mínimo >= umbral de la campaña excluida = cupón muerto", () => {
  // Los NÚMEROS EXACTOS de la campaña «TEst cupon» que reportó Jonas, leídos de
  // la base de dev: mínimo de compra $120, y excluye «Monto de compra QA», que
  // descuenta desde $50.
  //
  //   pasar el mínimo  → subtotal >= 120
  //   no estar excluido → subtotal <  50
  //
  // Imposible. El cupón no podía aplicar en NINGÚN carrito, y la app lo guardó
  // sin decir nada.
  const montoQA = { id: "cmtpstqe40039uj7wzpwwijge", name: "Monto de compra QA", minSubtotal: 50 };

  const muerto = exclusionQueAnulaElCupon(
    { minimumType: "subtotal", minSubtotal: 120 },
    [montoQA]
  );
  assert.deepEqual(muerto, { name: "Monto de compra QA", minSubtotal: 50 });

  // Con el mínimo por debajo del umbral hay una ventana real ($30–$49) y no se
  // avisa nada.
  assert.equal(
    exclusionQueAnulaElCupon({ minimumType: "subtotal", minSubtotal: 30 }, [montoQA]),
    null
  );

  // El límite exacto también está muerto: si el mínimo es 50 y la otra
  // descuenta desde 50, cualquier carrito que pase el mínimo la tiene aplicando.
  assert.ok(
    exclusionQueAnulaElCupon({ minimumType: "subtotal", minSubtotal: 50 }, [montoQA])
  );

  // Sin exclusión marcada, o sin mínimo, no hay nada que avisar.
  assert.equal(exclusionQueAnulaElCupon({ minimumType: "subtotal", minSubtotal: 120 }, []), null);
  assert.equal(exclusionQueAnulaElCupon({ minimumType: "none", minSubtotal: 120 }, [montoQA]), null);
  assert.equal(
    exclusionQueAnulaElCupon({ minimumType: "quantity", minSubtotal: null }, [montoQA]),
    null
  );
});

test("con varias excluidas se nombra la que mata primero (el umbral más bajo)", () => {
  const culpable = exclusionQueAnulaElCupon(
    { minimumType: "subtotal", minSubtotal: 200 },
    [
      { id: "a", name: "Alta", minSubtotal: 150 },
      { id: "b", name: "Baja", minSubtotal: 40 },
    ]
  );
  assert.deepEqual(culpable, { name: "Baja", minSubtotal: 40 });
});

test("🔴 el formulario avisa de la combinación imposible, arriba y en rojo", () => {
  // Que la lógica funcione no alcanzó: Jonas no pudo distinguir "excluido a
  // propósito" de "roto" porque no había ninguna señal en la pantalla.
  const src = leer("app/components/OriginalPriceCampaignForm.tsx");
  assert.match(src, /exclusionQueAnulaElCupon\(/);
  assert.match(src, /t\.avisoImposible\(/);
  // Arriba de la rejilla, no enterrado en una sección plegable.
  const arriba = src.slice(0, src.indexOf('gridTemplateColumns: "minmax(0,1fr) 320px"'));
  assert.match(arriba, /avisoImposible/, "el aviso va arriba de la rejilla");
  assert.match(es.nuevoCupon.avisoImposible("X", "$50", "$120"), /X[\s\S]*\$50/);
});
