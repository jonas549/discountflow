// Todas las campañas se ven igual. Esto lo comprueba.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ EXISTE
//
// La campaña de «monto de compra» se entregó el 2026-09-05 sin panel lateral,
// a ancho completo, con la vista previa enterrada dentro de una sección, y con
// la MISMA ilustración que packs en la pantalla de tipos. Funcionaba y estaba
// probada; parecía otra app.
//
// El look and feel no es una preferencia: es el producto. Y "acordate de
// comparar con las que ya están" no es un mecanismo — esto sí lo es.
//
// Lo que NO puede comprobar: que se vea bien. Eso se mira en el navegador.
// Lo que sí: que nadie entregue una campaña nueva sin la estructura común.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../..");
const leer = (p: string) => fs.readFileSync(path.join(RAIZ, p), "utf8");

/** Los formularios de campaña de la app. Uno por tipo. */
const FORMULARIOS = [
  ["Porcentaje", "app/routes/app.campaigns.new.percentage.tsx"],
  ["Rango", "app/routes/app.campaigns.$id.edit_.range.tsx"],
  ["BxGy", "app/routes/app.campaigns.new.bxgy.tsx"],
  ["Escalonado", "app/components/TieredCampaignForm.tsx"],
  ["Pack", "app/components/PackCampaignForm.tsx"],
  ["Monto de compra", "app/components/CartValueCampaignForm.tsx"],
  ["Cupon sobre precio original", "app/components/OriginalPriceCampaignForm.tsx"],
] as const;

/**
 * Porcentaje y Rango son ANTERIORES al kit compartido.
 *
 * Tienen panel lateral fijo y rejilla de dos columnas —el esqueleto que importa
 * y que estos tests sí les exigen— pero lo pintan con piezas propias:
 * `DiscountPreview` en vez del bloque «Resumen», y una barra de acciones
 * escrita a mano en vez de `ActionBar`.
 *
 * 🔴 Se listan acá EN VEZ de bajarle el listón al test para todos. Es deuda
 * conocida y acotada, no la norma: una campaña nueva no puede acogerse a esto.
 */
const ANTERIORES_AL_KIT = new Set(["Porcentaje", "Rango"]);

test("🔴 toda campaña tiene el formulario a la izquierda y 320px a la derecha", () => {
  for (const [nombre, ruta] of FORMULARIOS) {
    const src = leer(ruta);
    assert.match(
      src,
      /gridTemplateColumns:\s*"(?:minmax\(0,\s*1fr\)|1fr) 320px"/,
      `${nombre} (${ruta}) no usa la rejilla de dos columnas con el panel de 320px`
    );
    assert.match(
      src,
      /alignItems:\s*"start"/,
      `${nombre}: el panel lateral tiene que alinearse arriba, no estirarse`
    );
  }
});

test("🔴 toda campaña tiene el panel lateral fijo", () => {
  for (const [nombre, ruta] of FORMULARIOS) {
    assert.match(
      leer(ruta),
      /position:\s*"sticky",\s*top:\s*"\d+px"/,
      `${nombre}: falta el panel lateral fijo`
    );
  }
});

test("🔴 el panel trae el resumen en vivo de la campaña", () => {
  for (const [nombre, ruta] of FORMULARIOS) {
    if (ANTERIORES_AL_KIT.has(nombre)) continue;
    assert.match(
      leer(ruta),
      /resumenTitulo|resumenNombre/,
      `${nombre}: el panel tiene que traer el resumen en vivo de la campaña`
    );
  }
});

test("toda campaña cierra con la barra de acciones común", () => {
  for (const [nombre, ruta] of FORMULARIOS) {
    if (ANTERIORES_AL_KIT.has(nombre)) continue;
    const src = leer(ruta);
    assert.match(src, /<ActionBar>/, `${nombre}: falta la ActionBar`);
    assert.match(
      src,
      /marginLeft:\s*"auto"/,
      `${nombre}: «Cancelar» va empujado a la derecha, como en las demás`
    );
  }
});

test("🔴 los textos salen de i18n, no incrustados en el componente", () => {
  // Un formulario con los textos a mano se desalinea del resto en el primer
  // cambio de redacción, y nadie se entera hasta que un merchant lo lee.
  for (const [nombre, ruta] of FORMULARIOS) {
    const src = leer(ruta);
    // Vale tanto `es.nuevoPack.titulo` como el atajo `const t = es.nuevoPack`.
    assert.match(src, /\bes\.[a-zA-Z]+/, `${nombre}: no usa el diccionario es.*`);
  }
});

// ─── La pantalla de tipos de campaña ─────────────────────────────────────────

test("🔴 cada tipo de campaña tiene SU PROPIA ilustración", () => {
  // El fallo: «Descuento por monto de compra» salió con el mockup de packs —
  // tres cuadros con tildes y «2 productos · 10%»— que cuenta algo que ese tipo
  // no hace. Dos campañas distintas no pueden verse iguales.
  const src = leer("app/routes/app.campaigns._index.tsx");

  const usados = [...src.matchAll(/mockup=\{<(\w+) \/>\}/g)].map((m) => m[1]);
  assert.ok(usados.length >= 7, `se esperaban 7 tarjetas de tipo, hay ${usados.length}`);

  const repetidos = usados.filter((m, i) => usados.indexOf(m) !== i);
  assert.deepEqual(
    repetidos,
    [],
    `estas ilustraciones se usan en más de una tarjeta: ${repetidos.join(", ")}`
  );

  // Y cada una tiene que existir de verdad.
  for (const m of usados)
    assert.match(src, new RegExp(`function ${m}\\(`), `falta el componente ${m}`);
});

test("las ilustraciones comparten el mismo lenguaje visual", () => {
  // Distintas en lo que cuentan, iguales en cómo se ven: mismo fondo, mismo
  // borde, misma píldora verde.
  const src = leer("app/routes/app.campaigns._index.tsx");
  const nombres = [...src.matchAll(/function (Mockup\w+)\(/g)].map((m) => m[1]);
  assert.ok(nombres.length >= 7, `se esperaban 7 mockups, hay ${nombres.length}`);

  for (const n of nombres) {
    const desde = src.indexOf(`function ${n}(`);
    const hasta = src.indexOf("\nfunction ", desde + 1);
    const cuerpo = src.slice(desde, hasta === -1 ? undefined : hasta);
    assert.match(cuerpo, /background: "#f8fafb"/, `${n}: otro fondo`);
    assert.match(cuerpo, /border: "1px solid #e1e3e5"/, `${n}: otro borde`);
  }
});

test("la ilustración del monto de compra habla de DINERO, no de productos", () => {
  // La diferencia que la tarjeta tiene que comunicar de un vistazo: acá el
  // descuento depende de cuánto dinero hay en el carrito, no de cuántos
  // productos lleve el comprador.
  const src = leer("app/routes/app.campaigns._index.tsx");
  const desde = src.indexOf("function MockupValorCarrito(");
  assert.ok(desde > 0, "falta MockupValorCarrito");
  const hasta = src.indexOf("\nfunction ", desde + 1);
  const cuerpo = src.slice(desde, hasta === -1 ? undefined : hasta);

  assert.match(cuerpo, /\$\d+/, "tiene que mostrar importes");
  assert.doesNotMatch(cuerpo, /productos/, "no puede hablar de cantidad de productos");
});
