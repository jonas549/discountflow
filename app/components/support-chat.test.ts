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

const COMPONENTE = "app/components/SupportChat.tsx";
const SHELL = "app/routes/app.tsx";

test("el chat solo se monta con el flag encendido", () => {
  const shell = leer(SHELL);
  assert.match(
    shell,
    /hasFeature\(shop,\s*"chat:tawk"\)/,
    "el shell debe decidir con hasFeature('chat:tawk'), que falla cerrado",
  );
  assert.match(
    shell,
    /\{chatSoporte && \(/,
    "el componente no puede renderizarse sin comprobar el flag",
  );
});

test("el flag es el UNICO control, y se apaga sin desplegar", () => {
  const shell = leer(SHELL);
  // Durante la prueba en dev hubo una guardia de entorno; se quitó el 2026-09-19
  // porque el chat va para todas las tiendas. Lo que NO puede volver es que el
  // control pase a una variable de entorno: en Vercel esas no surten efecto sin
  // un deployment nuevo, y el apagado de emergencia dejaría de ser inmediato.
  assert.ok(
    !shell.includes("isProduction"),
    "el chat no puede depender del entorno: el apagado tiene que ser un UPDATE",
  );
  assert.match(
    shell,
    /const chatSoporte = hasFeature\(shop, "chat:tawk"\)/,
    "la decision vive en el flag de la base, que falla cerrado",
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
