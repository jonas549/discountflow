// El chat de soporte no puede tumbar la app, y no puede llegar a producción sola.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ EXISTE
//
// El widget se monta en `app/routes/app.tsx`, el layout que envuelve las cinco
// pantallas de los tres clientes que pagan. Es el archivo más caro del repo: lo
// que falle ahí no rompe una pantalla, las rompe todas.
//
// Estas comprobaciones fijan las tres cosas que hacen que la prueba sea
// reversible: que el chat esté detrás del flag, que no pueda montarse en
// producción, y que un fallo suyo se quede dentro de un try/catch.
//
// Lo que NO puede comprobar: que el widget se vea bien dentro del iframe del
// admin. Eso se mira en el navegador — regla nº 1.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../..");
// `core.autocrlf=true` reescribe el árbol en cada checkout: se normaliza para
// que los literales de este test no dependan de en qué rama se estuvo antes.
const leer = (p: string) =>
  fs.readFileSync(path.join(RAIZ, p), "utf8").replace(/\r\n/g, "\n");

/**
 * El fuente SIN comentarios.
 *
 * Los comentarios de este repo explican lo que se quitó y por qué —el flag, la
 * guardia de entorno, qué pasa si un `throw` sube hasta el shell— y eso es
 * memoria que hay que conservar. Pero si las aserciones los leen, la nota
 * histórica hace fallar al test: el instrumento midiendo mal, no el producto.
 * Pasó justo al escribir estas pruebas.
 */
const codigoDe = (p: string) =>
  leer(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // `(?<!:)` salva las URLs — si no, `https://embed.tawk.to/...` se corta.
    .replace(/(?<!:)\/\/.*$/gm, "");

const COMPONENTE = "app/components/SupportChat.tsx";
const SHELL = "app/routes/app.tsx";

test("el chat se monta SIEMPRE, sin depender de ningun interruptor", () => {
  const shell = leer(SHELL);

  // Decisión de Jonas (2026-09-19): el chat va para todas las tiendas, incluidas
  // las que instalen la app de ahora en adelante. Ni flag por tienda ni guardia
  // de entorno: si vuelve a aparecer cualquiera de los dos, una tienda nueva
  // nacería sin chat y nadie se enteraría hasta que un merchant no encuentre por
  // dónde escribir.
  const codigo = codigoDe(SHELL);
  assert.ok(
    !codigo.includes("hasFeature"),
    "el flag por tienda se retiró: el chat no puede volver a depender de él",
  );
  assert.ok(
    !codigo.includes("isProduction"),
    "tampoco puede depender del entorno",
  );
  assert.match(
    shell,
    /<SupportChat\s+shopDomain=\{chatSoporte\.shopDomain\}\s+plan=\{chatSoporte\.plan\}\s*\/>/,
    "se monta sin condición delante",
  );
});

test("🔴 sin interruptor, las defensas del componente son lo unico que queda", () => {
  // Con flag, un fallo del chat se apagaba con un UPDATE en segundos. Sin flag,
  // la vuelta atrás es un revert + build de ~4 min. Estas tres defensas pasan a
  // ser lo que evita que el chat tumbe la app de los tres clientes que pagan.
  const src = codigoDe(COMPONENTE);
  assert.ok(src.includes("try {"), "los efectos van protegidos");
  assert.ok(src.includes("return null;"), "no puede dejar un hueco en pantalla");
  assert.ok(
    !src.includes("throw "),
    "el chat nunca lanza: un throw aquí sube hasta el shell",
  );
});

test("el id de la cuenta de Tawk vive en UN solo archivo", () => {
  const id = "6aae966baaf7f5343d673729";
  const sospechosos = [
    COMPONENTE,
    SHELL,
    "app/i18n.ts",
    "app/entry.server.tsx",
    "app/root.tsx",
  ].filter((p) => fs.existsSync(path.join(RAIZ, p)));

  const conElId = sospechosos.filter((p) => leer(p).includes(id));
  assert.deepEqual(
    conElId,
    [COMPONENTE],
    "duplicar este id es como nacen los bugs silenciosos de este repo",
  );
});

test("el componente no pinta nada propio", () => {
  assert.match(
    leer(COMPONENTE),
    /return null;/,
    "si el script no carga no puede quedar un hueco en la pantalla del merchant",
  );
});

test("todo lo que toca el widget esta dentro de un try/catch", () => {
  const src = leer(COMPONENTE);
  // Un throw dentro de un useEffect SÍ propaga y tumba el árbol de React.
  const efectos = src.split("useEffect(").slice(1);
  assert.equal(efectos.length, 2, "se esperan dos efectos: carga y navegacion");
  for (const [i, efecto] of efectos.entries()) {
    const cuerpo = efecto.slice(0, efecto.indexOf("}, ["));
    assert.ok(
      cuerpo.includes("try {") || cuerpo.includes("aplicarAtributos("),
      `el efecto ${i + 1} tiene que estar protegido`,
    );
  }
  assert.ok(
    src.includes("function aplicarAtributos") && src.split("catch").length >= 3,
    "aplicarAtributos tambien se llama desde onLoad: necesita su propio catch",
  );
});
