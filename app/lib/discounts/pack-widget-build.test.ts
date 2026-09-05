// El número de build de los assets del widget tiene que coincidir en los seis
// sitios que lo llevan.
//
// Por qué existe: el 2026-09-05 el widget no arrancó en la tienda dos rondas
// seguidas, y no había manera de distinguir tres situaciones muy distintas —
// «el asset no llegó», «llegó una versión vieja» y «llegó y falló»— sin abrir
// la pestaña de red y comparar archivos a mano.
//
// La marca de versión resuelve eso, pero solo si está sincronizada. Si el Liquid
// dice 6 y el JS dice 5, el diagnóstico miente y es peor que no tenerlo. Este
// test es lo que impide que se desincronicen.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const EXT = path.join(RAIZ, "extensions/pack-widget");

/** Los seis sitios que llevan el número, con cómo se extrae de cada uno. */
const FUENTES: Array<{ archivo: string; patron: RegExp }> = [
  { archivo: "scripts/build-pack-widget.mjs", patron: /const BUILD = (\d+);/ },
  { archivo: "extensions/pack-widget/blocks/pack-builder.liquid", patron: /data-df-build="(\d+)"/ },
  { archivo: "extensions/pack-widget/blocks/pack-notice.liquid", patron: /data-df-build="(\d+)"/ },
  { archivo: "extensions/pack-widget/assets/pack-builder.js", patron: /window\.DF_PACK_BUILD = (\d+);/ },
  { archivo: "extensions/pack-widget/assets/pack-notice.js", patron: /window\.DF_PACK_BUILD = (\d+);/ },
  { archivo: "extensions/pack-widget/assets/pack-builder.css", patron: /--df-build: (\d+);/ },
];

test("el número de build coincide en todos los assets del widget", () => {
  const leidos = FUENTES.map(({ archivo, patron }) => {
    const contenido = fs.readFileSync(path.join(RAIZ, archivo), "utf8");
    const m = contenido.match(patron);
    assert.ok(m, `${archivo}: no se encontró la marca de versión (${patron})`);
    return { archivo, build: m![1] };
  });

  const primero = leidos[0].build;
  for (const l of leidos) {
    assert.equal(
      l.build,
      primero,
      `${l.archivo} dice build ${l.build} y ${leidos[0].archivo} dice ${primero} — ` +
        "hay que subirlos todos a la vez o el diagnóstico de la consola miente"
    );
  }
});

test("pack-calc.js lleva la marca que le pone el script de build", () => {
  // Este asset es GENERADO: su marca no se escribe a mano, la emite el footer de
  // esbuild. Si falta, es que el asset está sin regenerar.
  const generado = fs.readFileSync(
    path.join(EXT, "assets/pack-calc.js"),
    "utf8"
  );
  const script = fs.readFileSync(
    path.join(RAIZ, "scripts/build-pack-widget.mjs"),
    "utf8"
  );
  const esperado = script.match(/const BUILD = (\d+);/)![1];

  assert.match(
    generado,
    new RegExp("window\\.DF_PACK_BUILD = " + esperado + ";"),
    "pack-calc.js no lleva la marca actual — corré `npm run build:pack-widget`"
  );
  // El `"use strict"` de esbuild tiene que seguir siendo la primera sentencia:
  // por eso la marca va en el footer y no en el banner.
  const sinComentarios = generado.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  assert.ok(
    sinComentarios.indexOf('"use strict";') === 0,
    'la marca no puede desplazar el "use strict" de esbuild'
  );
});

// ─── El apaño del fallo de Shopify con varios bloques ────────────────────────

test("🔴 los dos bloques declaran EXACTAMENTE los mismos assets", () => {
  // Fallo documentado de Shopify: con varios bloques de una misma theme app
  // extension activos, los assets del segundo en adelante pueden no servirse,
  // aunque el bloque sí se renderice. Síntoma real del 2026-09-05: el HTML
  // aparecía, el CSS aplicaba, y el JS no se ejecutaba — sin error, sin
  // petición de red, sin nada.
  //
  // El apaño es que los dos bloques pidan el MISMO conjunto: si Shopify sirve
  // «los del primer bloque», los del primero ya son todos. Este test impide que
  // alguien los separe otra vez sin darse cuenta.
  const assetsDe = (bloque: string) => {
    const src = fs.readFileSync(path.join(EXT, "blocks", bloque), "utf8");
    const refs = [...src.matchAll(/'([\w.-]+\.(?:js|css))'\s*\|\s*asset_url/g)].map(
      (m) => m[1]
    );
    return refs.sort();
  };

  const delArmador = assetsDe("pack-builder.liquid");
  const delAviso = assetsDe("pack-notice.liquid");

  assert.ok(delArmador.length >= 4, "el armador tiene que pedir CSS + los tres JS");
  assert.deepEqual(
    delAviso,
    delArmador,
    "los dos bloques tienen que pedir los mismos assets — ver el comentario de pack-builder.liquid"
  );
});

// ─── El bug del móvil, y el invariante que lo impide ─────────────────────────

test("🔴 toda regla con `position: fixed` declara `top` explícitamente", () => {
  // El 2026-09-05 el móvil del widget estaba roto: no se veía ni un producto y
  // había un bloque blanco enorme tapando la pantalla.
  //
  // La causa: la regla de escritorio deja `.df-pack__summary` en
  // `position: sticky; top: 1em`, y la regla móvil lo pasaba a
  // `position: fixed; bottom: 0` SIN anular ese `top`. Un elemento `fixed` con
  // `top` Y `bottom` a la vez no se coloca: se ESTIRA de uno al otro. El panel
  // pasaba a ocupar toda la pantalla, en blanco y con z-index 20, tapando las
  // tarjetas. En escritorio no se veía porque `sticky` solo usa `top`.
  //
  // El invariante que lo cierra: si una regla fija un elemento, tiene que decir
  // qué pasa con `top` — aunque sea `auto`. Así el estiramiento no puede
  // colarse por herencia de otra regla.
  const css = fs.readFileSync(path.join(EXT, "assets/pack-builder.css"), "utf8");
  // Fuera los comentarios: el porqué de esta regla los menciona.
  const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const reglas = [...sinComentarios.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const fijas = reglas.filter((r) => /position:\s*fixed/.test(r[2]));

  assert.ok(fijas.length > 0, "se esperaba al menos una regla con position: fixed");

  for (const r of fijas) {
    const selector = r[1].trim().split(/\r?\n/).pop()!.trim();
    assert.match(
      r[2],
      /(^|[;{\s])top\s*:/,
      `la regla "${selector}" fija el elemento sin declarar \`top\` — ` +
        "si otra regla le deja un `top`, el elemento se estira en vez de colocarse"
    );
  }
});

test("el panel del resumen vuelve al flujo en móvil, encima de los productos", () => {
  // El wireframe: panel arriba, productos abajo en una columna, barra al pie.
  const css = fs.readFileSync(path.join(EXT, "assets/pack-builder.css"), "utf8");
  const movil = css.slice(css.indexOf("@media (max-width: 749px)"));

  assert.match(movil, /\.df-pack__summary\s*\{[^}]*position:\s*static/);
  assert.match(movil, /\.df-pack__summary\s*\{[^}]*top:\s*auto/);
  // El panel (order 2) tiene que ir ANTES que la rejilla (order 3).
  const orderPanel = movil.match(/\.df-pack__summary\s*\{\s*order:\s*(\d+)/);
  const orderGrid = movil.match(/\.df-pack__grid\s*\{\s*order:\s*(\d+)/);
  assert.ok(orderPanel && orderGrid, "los dos tienen que declarar `order` en móvil");
  assert.ok(
    Number(orderPanel![1]) < Number(orderGrid![1]),
    "el panel va encima de los productos"
  );
});

test("el botón del pack es UNO solo, dentro de su envoltorio", () => {
  // La barra fija del móvil se hace con el envoltorio, no duplicando el botón:
  // dos botones serían dos manejadores y dos estados que mantener en sintonía.
  const js = fs.readFileSync(path.join(EXT, "assets/pack-builder.js"), "utf8");
  const creaciones = js.match(/el\("button", "df-pack__cta /g) ?? [];
  assert.equal(creaciones.length, 1, "solo puede crearse un botón de CTA");
  assert.match(js, /df-pack__cta-wrap/, "y tiene que ir dentro del envoltorio");
});
