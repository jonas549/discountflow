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
