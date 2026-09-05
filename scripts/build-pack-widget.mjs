// Compila el cálculo de packs para el widget de la tienda.
//
// 🔴 POR QUÉ EXISTE ESTE SCRIPT
//
// El cálculo de un pack lo consumen TRES entornos: el preview del admin, la
// Shopify Function del checkout, y el widget que corre en el navegador del
// comprador. Los dos primeros importan `app/lib/discounts/pack-calc.ts`
// directamente. El tercero no puede: los assets de una theme app extension son
// archivos estáticos que sirve Shopify, fuera del bundle de la app.
//
// La salida fácil habría sido reescribir a mano las ~40 líneas del cálculo
// dentro del widget. Eso son DOS fuentes de verdad, y el día que alguien toque
// una y no la otra, el comprador ve un precio en la tienda y paga otro en el
// checkout. Este script compila el MISMO archivo a un asset, así que esa
// divergencia no se puede producir.
//
// Se corre con `npm run build:pack-widget`, y también antes de `npm run build`.

import { build } from "esbuild";

/**
 * 🔴 Número de build de los assets del widget.
 *
 * Tiene que coincidir en los cinco sitios que lo llevan: los dos bloques
 * Liquid, los tres JS y el CSS. `pack-widget-build.test.ts` lo comprueba.
 *
 * Existe porque el 2026-09-05 el widget no arrancaba en la tienda y no había
 * forma de distinguir «el asset no llegó», «llegó viejo» y «llegó y falló».
 * Súbelo cada vez que cambien los assets, para que se pueda confirmar de un
 * vistazo qué versión está sirviendo el CDN.
 */
const BUILD = 7;
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(raiz, "app/lib/discounts/pack-calc.ts")],
  outfile: resolve(raiz, "extensions/pack-widget/assets/pack-calc.js"),
  bundle: true,
  format: "iife",
  // El widget lo consume como global. No hay módulos ES en el asset porque el
  // orden de carga de los <script> de un tema no está garantizado.
  globalName: "DiscountFlowPackCalc",
  target: ["es2019"],
  minify: false, // legible a propósito: si algo falla, se depura en la tienda
  // La marca va en el FOOTER, no en el banner: esbuild pone `"use strict";` en
  // la primera línea y anteponer código lo dejaría de ser una directiva.
  footer: {
    js: [
      "",
      "/* Marca de versión — ver BUILD en scripts/build-pack-widget.mjs */",
      "window.DF_PACK_BUILD = " + BUILD + ";",
      'window.DF_PACK_CARGADOS = (window.DF_PACK_CARGADOS || []).concat(["pack-calc"]);',
      "try {",
      '  console.log("[DiscountFlow] build ' + BUILD + ' · pack-calc cargado");',
      "} catch (e) {}",
    ].join(String.fromCharCode(10)),
  },
  banner: {
    js: [
      "/* GENERADO — NO EDITAR A MANO.",
      " * Fuente: app/lib/discounts/pack-calc.ts",
      " * Regenerar: npm run build:pack-widget",
      " * Editar este archivo crea una segunda fuente de verdad del cálculo y",
      " * el precio del widget dejaría de coincidir con el del checkout.",
      " */",
    ].join("\n"),
  },
});

console.log("✓ extensions/pack-widget/assets/pack-calc.js generado desde pack-calc.ts");
