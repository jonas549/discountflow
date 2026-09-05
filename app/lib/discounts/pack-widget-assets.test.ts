// Tests de los assets del widget de packs.
//
// Son archivos que corren en el NAVEGADOR DEL COMPRADOR, dentro del tema de un
// merchant. No hay forma de ejecutarlos en CI con un navegador de verdad, pero
// las dos cosas que más caro cuestan sí se pueden comprobar desde acá, y las dos
// ya fallaron una vez:
//
//   1. Que el parcheo de `fetch` no rompa el `fetch` de la página.
//   2. Que el cálculo compilado para el widget siga siendo el MISMO que el que
//      usa la Function del checkout.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const SRC = path.join(RAIZ, "scripts/pack-widget-src");

// ─── 1. El parcheo de fetch ───────────────────────────────────────────────────

/**
 * Monta un `window` de mentira cuyo `fetch` se comporta como el del NAVEGADOR:
 * comprueba el receptor y lanza si no es `window`.
 *
 * 🔴 Esto es lo que Node NO hace, y por eso la regresión del 2026-09-05 pasó
 * desapercibida: en Node la llamada con `this` mal simplemente funcionaba.
 * `window.fetch` es una operación WebIDL con comprobación de receptor —
 * invocarla con cualquier otra cosa da «Illegal invocation».
 */
function montarWindowComoNavegador() {
  const win: Record<string, unknown> = {};
  win.window = win;
  win.document = {
    querySelector: () => ({ dataset: {} }),
    addEventListener: () => {},
    readyState: "complete",
    documentElement: { lang: "es" },
  };
  const XHR = function () {} as unknown as { prototype: Record<string, unknown> };
  XHR.prototype = { open: function () {} };
  win.XMLHttpRequest = XHR;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.fetch = function (this: unknown) {
    if (this !== win)
      throw new TypeError(
        "Failed to execute 'fetch' on 'Window': Illegal invocation"
      );
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return win;
}

test("🔴 el parcheo de fetch no rompe las llamadas sin calificar", () => {
  // La regresión: `pack-notice.js` está en modo estricto, así que en una llamada
  // `fetch(url)` sin calificar —como las cinco de `pack-builder.js` y como las
  // del tema y las de cualquier otra app— el receptor era `undefined`, y el
  // envoltorio se lo pasaba tal cual al fetch nativo. Resultado: se rompía el
  // fetch de TODA la página, no solo el nuestro.
  const win = montarWindowComoNavegador();
  const src = fs.readFileSync(path.join(SRC, "pack-notice.js"), "utf8");

  new Function(
    "window",
    "document",
    "XMLHttpRequest",
    "setTimeout",
    "clearTimeout",
    "fetch",
    src
  )(
    win,
    win.document,
    win.XMLHttpRequest,
    win.setTimeout,
    win.clearTimeout,
    win.fetch
  );

  // Referencia suelta: exactamente lo que hace `fetch(url)` en código estricto.
  const sinCalificar = win.fetch as (u: string) => unknown;
  assert.doesNotThrow(
    () => sinCalificar("/apps/discountflow/pack"),
    "el envoltorio tiene que llamar al fetch nativo con `window` como receptor"
  );
});

test("el parcheo solo se instala si hay un aviso en la página", () => {
  // Sin bloque de aviso no hay nada que refrescar, así que no se toca el `fetch`
  // de nadie. Es lo que acota el radio de daño de una técnica invasiva.
  const win = montarWindowComoNavegador();
  (win.document as { querySelector: () => unknown }).querySelector = () => null;
  const fetchOriginal = win.fetch;
  const src = fs.readFileSync(path.join(SRC, "pack-notice.js"), "utf8");

  new Function(
    "window",
    "document",
    "XMLHttpRequest",
    "setTimeout",
    "clearTimeout",
    "fetch",
    src
  )(
    win,
    win.document,
    win.XMLHttpRequest,
    win.setTimeout,
    win.clearTimeout,
    win.fetch
  );

  assert.equal(
    win.fetch,
    fetchOriginal,
    "sin nodo de aviso, `window.fetch` debe quedar intacto"
  );
});

// ─── 2. La sintonía del cálculo se comprueba en pack-widget-build.test.ts ────
//
// El test que vivía acá leía , que ya no existe: los tres
// JS se concatenan en un único . La misma comprobación —que el
// generado contenga el cálculo compilado desde — vive ahora junto
// al resto de invariantes de los assets, en pack-widget-build.test.ts.

// ─── 3. La clave de la propiedad, escrita en tres sitios ─────────────────────

test("la clave _df_pack coincide en la Function, el widget y el aviso", () => {
  // `attribute` exige la clave escrita a mano en la input query de la Function y
  // no hay forma de listar los atributos. Si estas tres se desincronizan, la
  // Function deja de ver las líneas y el pack no descuenta — sin ningún error.
  const query = fs.readFileSync(
    path.join(RAIZ, "extensions/pack-discount/src/cart_lines_discounts_generate_run.graphql"),
    "utf8"
  );
  const cliente = fs.readFileSync(
    path.join(RAIZ, "app/lib/discounts/pack-client.ts"),
    "utf8"
  );
  const aviso = fs.readFileSync(path.join(SRC, "pack-notice.js"), "utf8");

  assert.ok(
    query.includes('attribute(key: "_df_pack")'),
    "la input query de la Function tiene que pedir _df_pack por su clave exacta"
  );
  assert.ok(
    cliente.includes('PACK_LINE_ATTRIBUTE = "_df_pack"'),
    "pack-client.ts tiene que declarar la misma clave"
  );
  assert.ok(
    aviso.includes('"_df_pack"'),
    "el aviso del carrito tiene que buscar la misma clave"
  );
});
