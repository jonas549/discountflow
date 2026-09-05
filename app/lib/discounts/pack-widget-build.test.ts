// Los assets del widget de packs: que existan, que sean los que el Liquid pide,
// y que el número de build coincida en todos lados.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ ESTE ARCHIVO ES EL MÁS IMPORTANTE DE LOS DEL WIDGET
//
// Durante tres rondas (2026-09-05) el navegador recibió un JavaScript que NO
// era el del repo. El widget se quedaba en «Cargando tu pack…» sin error, sin
// petición de red y sin ninguna línea en consola. Cada vez se encontró una
// causa distinta, cada arreglo se verificó, y volvía a pasar.
//
// La causa de fondo era el NOMBRE del archivo: `pack-builder.js` produce siempre
// la misma URL de CDN. El contenido cambiaba, la URL no, y el CDN seguía
// sirviendo la copia vieja — un `Ctrl+Shift+R` no la alcanza.
//
// El arreglo estructural: el build va en el NOMBRE (`pack-8.js`). Cada versión
// es una URL distinta y no hay nada que cachear. Estos tests son lo que impide
// que esa disciplina se rompa sin que nadie se entere.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const EXT = path.join(RAIZ, "extensions/pack-widget");
const ASSETS = path.join(EXT, "assets");
const BLOQUES = ["pack-builder.liquid", "pack-notice.liquid"];

const leerBloque = (n: string) =>
  fs.readFileSync(path.join(EXT, "blocks", n), "utf8");

/** El BUILD declarado en el script que genera los assets. Es la autoridad. */
function buildDelScript(): number {
  const src = fs.readFileSync(
    path.join(RAIZ, "scripts/build-pack-widget.mjs"),
    "utf8"
  );
  const m = src.match(/const BUILD = (\d+);/);
  assert.ok(m, "scripts/build-pack-widget.mjs tiene que declarar `const BUILD = N;`");
  return Number(m![1]);
}

/** Los assets que un bloque pide, tal como los escribe en su Liquid. */
function assetsPedidos(bloque: string): string[] {
  const refs = [
    ...leerBloque(bloque).matchAll(/'([\w.-]+\.(?:js|css))'\s*\|\s*asset_url/g),
  ].map((m) => m[1]);
  return [...new Set(refs)].sort();
}

// ─── Lo que de verdad protege ────────────────────────────────────────────────

test("🔴 el archivo que pide el Liquid EXISTE en assets/", () => {
  // Éste es el test que habría cazado el problema de las tres rondas. Si el
  // Liquid pide algo que no está, el navegador se come un 404 — y aunque un 404
  // es ruidoso y por tanto mejor que el silencio, no tiene por qué llegar a la
  // tienda.
  const enDisco = fs.readdirSync(ASSETS);
  for (const bloque of BLOQUES) {
    for (const asset of assetsPedidos(bloque)) {
      assert.ok(
        enDisco.includes(asset),
        `${bloque} pide "${asset}" y no está en assets/ (hay: ${enDisco.join(", ")}). ` +
          "Corré `npm run build:pack-widget`."
      );
    }
  }
});

test("🔴 el nombre del asset LLEVA el número de build", () => {
  // Un nombre sin versión produce una URL estable, y una URL estable la puede
  // cachear el CDN indefinidamente. Es la causa de fondo de las tres rondas.
  const build = buildDelScript();
  for (const bloque of BLOQUES) {
    const pedidos = assetsPedidos(bloque);
    assert.ok(pedidos.length > 0, `${bloque} no pide ningún asset`);
    for (const asset of pedidos) {
      assert.match(
        asset,
        new RegExp(`^pack-${build}\\.(js|css)$`),
        `${bloque} pide "${asset}": el nombre tiene que incluir el build ${build}. ` +
          "Sin versión en el nombre, el CDN puede servir una copia vieja para siempre."
      );
    }
  }
});

test("en assets/ NO queda ningún build viejo", () => {
  // Archivos de builds anteriores no los pide nadie, engordan el bundle, y
  // alguien podría depurar mirando el equivocado.
  const build = buildDelScript();
  const sobrantes = fs
    .readdirSync(ASSETS)
    .filter((f) => /^pack-\d+\.(js|css)$/.test(f))
    .filter((f) => !f.startsWith(`pack-${build}.`));
  assert.deepEqual(sobrantes, [], "el script de build tendría que haberlos borrado");
});

test("assets/ contiene SOLO lo generado", () => {
  // Las fuentes viven en scripts/pack-widget-src/. Que no haya nada más acá es
  // lo que quita toda duda sobre qué archivo se está sirviendo.
  const inesperados = fs
    .readdirSync(ASSETS)
    .filter((f) => !/^pack-\d+\.(js|css)$/.test(f));
  assert.deepEqual(
    inesperados,
    [],
    "en assets/ solo puede haber los assets generados con el build en el nombre"
  );
});

test("el build coincide en el script, los dos Liquid y el JS generado", () => {
  const build = buildDelScript();

  for (const bloque of BLOQUES) {
    const src = leerBloque(bloque);
    const m = src.match(/data-df-build="(\d+)"/);
    assert.ok(m, `${bloque} tiene que llevar data-df-build`);
    assert.equal(
      Number(m![1]),
      build,
      `${bloque} dice build ${m![1]} y el script dice ${build}`
    );
    // El comentario HTML es el diagnóstico que NO depende del JavaScript.
    assert.match(
      src,
      new RegExp(`<!-- DiscountFlow[\\s\\S]*?BUILD ${build}`),
      `${bloque} tiene que llevar el comentario HTML con el build — es lo único ` +
        "que se puede leer sin ejecutar nada"
    );
  }

  const js = fs.readFileSync(path.join(ASSETS, `pack-${build}.js`), "utf8");
  assert.match(js, new RegExp(`window\\.DF_PACK_BUILD = ${build};`));
});

test("🔴 el diagnóstico se puede leer SIN ejecutar JavaScript", () => {
  // La lección más cara de las tres rondas: el diagnóstico vivía dentro del
  // archivo que no llegaba. Ahora el build y la URL del JS salen en el HTML,
  // que lo renderiza el servidor y se lee con Ctrl+U.
  for (const bloque of BLOQUES) {
    const src = leerBloque(bloque);
    assert.match(src, /<!-- DiscountFlow/, `${bloque}: falta el comentario en el HTML`);
    assert.match(
      src,
      /data-df-js="\{\{ 'pack-\d+\.js' \| asset_url \}\}"/,
      `${bloque}: falta data-df-js con la URL resuelta del asset`
    );
  }
});

test("🔴 los dos bloques piden EXACTAMENTE los mismos assets", () => {
  // Fallo documentado de Shopify: con varios bloques de una misma theme app
  // extension activos, los assets del segundo en adelante pueden no servirse.
  assert.deepEqual(
    assetsPedidos("pack-notice.liquid"),
    assetsPedidos("pack-builder.liquid"),
    "ver el comentario de pack-builder.liquid"
  );
});

test("un solo archivo JS: menos URLs, menos formas de desincronizarse", () => {
  const js = assetsPedidos("pack-builder.liquid").filter((a) => a.endsWith(".js"));
  assert.equal(js.length, 1, `se esperaba un único JS, hay ${js.length}: ${js}`);
});

// ─── El cálculo compilado sigue siendo el mismo que el del checkout ──────────

test("el JS generado lleva el cálculo compilado desde pack-calc.ts", async () => {
  // 🔴 La cadena que sostiene «el precio que ve el comprador es el que paga».
  const build = buildDelScript();
  const esbuild = await import("esbuild");
  const compilado = await esbuild.build({
    entryPoints: [path.join(RAIZ, "app/lib/discounts/pack-calc.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "DiscountFlowPackCalc",
    target: ["es2019"],
    minify: false,
  });

  const js = fs.readFileSync(path.join(ASSETS, `pack-${build}.js`), "utf8");
  assert.ok(
    js.includes(compilado.outputFiles[0].text.trim()),
    "pack-" + build + ".js no contiene el cálculo actual — corré `npm run build:pack-widget`"
  );
});

// ─── Invariantes de las fuentes ─────────────────────────────────────────────

const SRC = path.join(RAIZ, "scripts/pack-widget-src");

test("🔴 el widget no usa `position: fixed` en ningún sitio", () => {
  // Dos bugs distintos, los dos en móvil, los dos por `position: fixed`:
  //
  //  1. El panel pasaba a `fixed; bottom: 0` sin anular el `top: 1em` de la
  //     regla de escritorio. Un elemento fijo con `top` Y `bottom` no se
  //     coloca: se ESTIRA de uno a otro, y tapaba las tarjetas.
  //
  //  2. La barra del pie, ya con las cuatro coordenadas bien escritas, NO SE
  //     VEÍA en la tienda. `fixed` deja de medirse contra la ventana en cuanto
  //     un antepasado tiene `transform`/`filter`/`contain`/`will-change`, y los
  //     temas OS 2.0 ponen `transform` en las secciones para sus animaciones de
  //     scroll. El «fijo» se anclaba a la sección y quedaba en su fondo.
  //
  // El segundo no se puede arreglar desde acá: el antepasado es del merchant.
  // Así que la regla es no depender de `fixed`. Si algún día hace falta algo
  // pegado al pie, es `position: sticky`, que se mide contra el contenedor de
  // scroll y cuyo fallo es «no se pega», no «desaparece».
  const css = fs.readFileSync(path.join(SRC, "pack-styles.css"), "utf8");
  const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const reglas = [...sinComentarios.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const fijas = reglas
    .filter((r) => /position:\s*fixed/.test(r[2]))
    .map((r) => r[1].trim().split(/\r?\n/).pop()!.trim());

  assert.deepEqual(
    fijas,
    [],
    "estas reglas usan `position: fixed`: en el tema de un merchant puede no " +
      "medirse contra la ventana. Ver el comentario de arriba."
  );
});

test("🔴 en móvil el botón de comprar existe y está en el flujo", () => {
  // El fallo que lo motivó: en el móvil de la tienda no aparecía NINGÚN botón
  // de agregar al carrito. Había que scrollear entre las tarjetas y no había
  // forma de completar la compra. El botón estaba en el DOM; lo que fallaba era
  // el `position: fixed` de su envoltorio.
  const css = fs.readFileSync(path.join(SRC, "pack-styles.css"), "utf8");
  const movil = css.slice(css.indexOf("@media (max-width: 749px)"));
  assert.doesNotMatch(
    movil,
    /\.df-pack__cta-wrap\s*\{[^}]*position:/,
    "el envoltorio del botón no puede sacarse del flujo en móvil"
  );
  // Y el panel que lo contiene va ARRIBA, así que se ve sin scrollear.
  const oPanel = movil.match(/\.df-pack__summary\s*\{\s*order:\s*(\d+)/);
  const oGrid = movil.match(/\.df-pack__grid\s*\{\s*order:\s*(\d+)/);
  assert.ok(oPanel && oGrid && Number(oPanel[1]) < Number(oGrid[1]));
});

test("🔴 en móvil la tarjeta es una FILA de tres columnas", () => {
  // El wireframe móvil: foto chica a la izquierda, el texto en el medio, y un
  // botón cuadrado a la derecha. La versión anterior apilaba el botón debajo
  // del precio, y las tarjetas ocupaban media pantalla cada una.
  const css = fs.readFileSync(path.join(SRC, "pack-styles.css"), "utf8");
  const movil = css.slice(css.indexOf("@media (max-width: 749px)"));
  assert.match(
    movil,
    /\.df-pack__card\s*\{[^}]*grid-template-areas:\s*"media body action"/,
    "la tarjeta móvil tiene que colocar el botón como tercera columna"
  );
  // Dawn declara `min-width: 12rem` en `.button`. Sin anularlo, el cuadrado
  // saldría de 192 px y echaría el texto fuera de la fila.
  assert.match(
    movil,
    /\.df-pack__toggle\s*\{[^}]*min-width:\s*0/,
    "el botón cuadrado tiene que anular el min-width que los temas ponen a .button"
  );
});

test("el panel del resumen vuelve al flujo en móvil, encima de los productos", () => {
  const css = fs.readFileSync(path.join(SRC, "pack-styles.css"), "utf8");
  const movil = css.slice(css.indexOf("@media (max-width: 749px)"));
  assert.match(movil, /\.df-pack__summary\s*\{[^}]*position:\s*static/);
  assert.match(movil, /\.df-pack__summary\s*\{[^}]*top:\s*auto/);
  const oPanel = movil.match(/\.df-pack__summary\s*\{\s*order:\s*(\d+)/);
  const oGrid = movil.match(/\.df-pack__grid\s*\{\s*order:\s*(\d+)/);
  assert.ok(oPanel && oGrid, "los dos tienen que declarar `order` en móvil");
  assert.ok(Number(oPanel![1]) < Number(oGrid![1]), "el panel va encima");
});

test("el botón del pack es UNO solo, dentro de su envoltorio", () => {
  const js = fs.readFileSync(path.join(SRC, "pack-builder.js"), "utf8");
  const creaciones = js.match(/el\("button", "df-pack__cta /g) ?? [];
  assert.equal(creaciones.length, 1, "solo puede crearse un botón de CTA");
  assert.match(js, /df-pack__cta-wrap/);
});

test("la clave _df_pack coincide en la Function, el cliente y el aviso", () => {
  const query = fs.readFileSync(
    path.join(RAIZ, "extensions/pack-discount/src/cart_lines_discounts_generate_run.graphql"),
    "utf8"
  );
  const cliente = fs.readFileSync(
    path.join(RAIZ, "app/lib/discounts/pack-client.ts"),
    "utf8"
  );
  const aviso = fs.readFileSync(path.join(SRC, "pack-notice.js"), "utf8");

  assert.ok(query.includes('attribute(key: "_df_pack")'));
  assert.ok(cliente.includes('PACK_LINE_ATTRIBUTE = "_df_pack"'));
  assert.ok(aviso.includes('"_df_pack"'));
});
