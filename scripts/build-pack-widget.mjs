// Construye los assets del widget de packs.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ EL NÚMERO DE BUILD VA EN EL NOMBRE DEL ARCHIVO
// ═══════════════════════════════════════════════════════════════════════════
//
// Durante tres rondas seguidas (2026-09-05) el widget se quedó en «Cargando tu
// pack…» y el JavaScript que llegaba al navegador NO era el que había en el
// repo. Cada vez se encontró una causa distinta y cada vez el arreglo se
// verificó… y volvía a pasar.
//
// La causa de fondo era el NOMBRE. `pack-builder.js` produce siempre la misma
// URL de CDN. Dentro de una sesión de `shopify app dev` el contenido del
// archivo cambia, pero la URL no: el CDN y el navegador pueden seguir sirviendo
// la copia vieja, y un `Ctrl+Shift+R` no alcanza a la copia del CDN. De ahí que
// funcionara unas veces sí y otras no, sin patrón — y que arreglos ya
// verificados parecieran no surtir efecto.
//
// Con el build en el nombre (`pack-8.js`), cada versión es una URL DISTINTA.
// No hay nada que cachear, y si el tema sirviera un Liquid viejo apuntando a un
// archivo que ya no existe, el navegador da un **404 visible** en vez de
// silencio. Se cambia un fallo mudo por uno ruidoso.
//
// Y por eso los tres JS se concatenan en UNO: menos archivos son menos URLs
// que puedan quedar desincronizadas, y esquiva de paso el fallo de Shopify con
// varios bloques (los assets del segundo bloque a veces no se sirven).
//
// Las FUENTES viven en `scripts/pack-widget-src/`, fuera de la extensión, para
// que `assets/` contenga solo lo generado y no haya dudas sobre qué se sirve.
// ═══════════════════════════════════════════════════════════════════════════

import { build } from "esbuild";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * 🔴 Número de build. Súbelo CADA VEZ que cambien los assets.
 *
 * Tiene que coincidir con lo que dicen los dos bloques Liquid.
 * `pack-widget-build.test.ts` lo comprueba, y además comprueba que el archivo
 * que el Liquid pide EXISTA de verdad en `assets/`.
 */
const BUILD = 12;

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(raiz, "scripts/pack-widget-src");
const ASSETS = join(raiz, "extensions/pack-widget/assets");

fs.mkdirSync(ASSETS, { recursive: true });

// ── Limpieza: fuera cualquier build anterior ────────────────────────────────
//
// Si quedaran, la extensión serviría archivos que ya nadie pide y el bundle
// crecería sin motivo. Y peor: alguien podría depurar mirando el equivocado.
for (const f of fs.readdirSync(ASSETS)) {
  if (/^pack-\d+\.(js|css)$/.test(f)) fs.unlinkSync(join(ASSETS, f));
}

// ── 1. El cálculo, compilado desde el MISMO módulo que usa la Function ──────
const compilado = await build({
  entryPoints: [join(raiz, "app/lib/discounts/pack-calc.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "DiscountFlowPackCalc",
  target: ["es2019"],
  minify: false,
});

// ── 2. Un solo archivo: cálculo + armador + aviso ───────────────────────────
const marca = [
  "/* ═══════════════════════════════════════════════════════════════════════",
  ` * DiscountFlow · widget de packs · BUILD ${BUILD}`,
  " *",
  " * GENERADO — NO EDITAR A MANO.",
  " * Fuentes: app/lib/discounts/pack-calc.ts + scripts/pack-widget-src/*.js",
  " * Regenerar: npm run build:pack-widget",
  " *",
  " * El número de build va en el NOMBRE del archivo a propósito: cada versión",
  " * es una URL distinta, así que no hay caché de CDN que pueda servir una",
  " * copia vieja. Ver el comentario de scripts/build-pack-widget.mjs.",
  " * ═══════════════════════════════════════════════════════════════════════ */",
  "",
].join("\n");

const registro = [
  "",
  "/* Marca de versión en tiempo de ejecución. La de verdad, la que se puede",
  "   comprobar SIN ejecutar nada, está en el HTML del bloque. */",
  `window.DF_PACK_BUILD = ${BUILD};`,
  "try {",
  `  console.log("[DiscountFlow] widget de packs · build ${BUILD} cargado");`,
  "} catch (e) {}",
  "",
].join("\n");

const js = [
  marca,
  compilado.outputFiles[0].text,
  registro,
  fs.readFileSync(join(SRC, "pack-builder.js"), "utf8"),
  "",
  fs.readFileSync(join(SRC, "pack-notice.js"), "utf8"),
].join("\n");

fs.writeFileSync(join(ASSETS, `pack-${BUILD}.js`), js);

// ── 3. El CSS, con la misma marca en el nombre ──────────────────────────────
const css = fs.readFileSync(join(SRC, "pack-styles.css"), "utf8");
fs.writeFileSync(
  join(ASSETS, `pack-${BUILD}.css`),
  `/* DiscountFlow · widget de packs · BUILD ${BUILD} · GENERADO, no editar.\n` +
    `   Fuente: scripts/pack-widget-src/pack-styles.css */\n\n` +
    css
);

console.log(`✓ assets/pack-${BUILD}.js  (${(js.length / 1024).toFixed(1)} KB)`);
console.log(`✓ assets/pack-${BUILD}.css`);
console.log(`\n  Los bloques Liquid tienen que pedir pack-${BUILD}.js y pack-${BUILD}.css`);
