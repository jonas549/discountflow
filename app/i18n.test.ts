// Ningún tipo ni estado de campaña puede llegar al merchant escrito en crudo.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ EXISTE
//
// `tipoLabel` termina en `?? type`. Es un fallback silencioso: cuando falta una
// entrada no rompe nada, solo escribe la constante del enum en la pantalla.
// Pasó DOS VECES seguidas —«PACK» primero y «CART_VALUE» después— en el
// listado, el panel y analítica a la vez, y las dos veces lo encontró Jonas
// mirando la app, no un test.
//
// Es la misma familia de bug que este repo ya arregló cuatro veces en otro
// sitio (`?? []` convirtiendo un fallo en "no hay nada"): lo que no se queja se
// entrega roto.
//
// La fuente de verdad es el enum de Prisma, no una lista escrita acá: si mañana
// alguien agrega un tipo a `schema.prisma` y se olvida del texto, esto falla
// antes de que llegue a una pantalla.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tipoLabel, estadoLabel } from "./i18n.ts";

const RAIZ = path.resolve(import.meta.dirname, "..");

/** Los valores de un enum del schema de Prisma. */
function valoresDelEnum(nombre: string): string[] {
  const schema = fs.readFileSync(path.join(RAIZ, "prisma/schema.prisma"), "utf8");
  const m = schema.match(new RegExp(`enum ${nombre} \\{([^}]*)\\}`));
  assert.ok(m, `no se encontró el enum ${nombre} en schema.prisma`);
  return m![1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
}

test("🔴 todo tipo de campaña del enum tiene su texto en español", () => {
  const tipos = valoresDelEnum("CampaignType");
  assert.ok(tipos.length >= 6, `se esperaban al menos 6 tipos, hay ${tipos.length}`);

  const sinTexto = tipos.filter((t) => tipoLabel(t) === t);
  assert.deepEqual(
    sinTexto,
    [],
    `estos tipos saldrían EN CRUDO en el listado, el panel y analítica: ` +
      `${sinTexto.join(", ")}. Agregalos al mapa de \`tipoLabel\` en i18n.ts.`
  );
});

test("todo estado de campaña del enum tiene su texto en español", () => {
  const estados = valoresDelEnum("CampaignStatus");
  const sinTexto = estados.filter((e) => estadoLabel(e) === e);
  assert.deepEqual(sinTexto, [], `estados sin texto: ${sinTexto.join(", ")}`);
});

test("🔴 el tipo nunca se pinta en crudo en una pantalla", () => {
  // El mapa completo no sirve de nada si alguien escribe `{c.type}` a mano.
  // Pasó en el panel interno de pausa, que mostraba «CART_VALUE» tal cual.
  const pantallas = [
    "app/routes/app.campaigns._index.tsx",
    "app/routes/app.analytics.tsx",
    "app/routes/app._index.tsx",
    "app/routes/api.internal.pause-over-limit.tsx",
  ];

  for (const ruta of pantallas) {
    const src = fs.readFileSync(path.join(RAIZ, ruta), "utf8");
    // El `(?<!\$)` deja fuera las plantillas `${campaign.type}` de los logs, y
    // eso es correcto: un log tiene que decir la constante del enum, no el
    // texto bonito. Lo que no puede salir en crudo es lo que ve el merchant.
    const crudos = [...src.matchAll(/(?<!\$)\{(\w+)\.type\}/g)].map((m) => m[0]);
    assert.deepEqual(
      crudos,
      [],
      `${ruta} pinta el tipo sin traducir: ${crudos.join(", ")}. Usá \`tipoLabel()\`.`
    );
  }
});

test("los nombres son los que ya usan los formularios", () => {
  // El listado y el resumen del formulario tienen que llamar a lo mismo de la
  // misma forma. «Monto de compra» en un sitio y «Valor de carrito» en el otro
  // es la clase de detalle que hace que el producto parezca de dos personas.
  assert.equal(tipoLabel("CART_VALUE"), "Monto de compra");

  const i18n = fs.readFileSync(path.join(RAIZ, "app/i18n.ts"), "utf8");
  assert.match(
    i18n,
    /resumenTipoValorCarrito: "Monto de compra"/,
    "el resumen del formulario tiene que decir lo mismo que el listado"
  );
});
