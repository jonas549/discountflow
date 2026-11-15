import test from "node:test";
import assert from "node:assert/strict";

import { readSkipReport } from "./manual-discounts.ts";
import {
  appendOverlap,
  composeSkipReport,
  decideRevert,
  readOverlapReport,
  OVERLAP_REPORT_CAP,
  type Holder,
} from "./price-claims.ts";

const T0 = new Date("2026-11-01T00:00:00Z");
const T1 = new Date("2026-11-02T00:00:00Z");
const holder = (rowCreatedAt: Date, name = "Otra"): Holder => ({
  campaignId: `c-${name}`,
  campaignName: name,
  rowCreatedAt,
});

// ─── decideRevert ─────────────────────────────────────────────────────────────

test("sin otra campaña sobre la variante: se restaura, como siempre", () => {
  assert.deepEqual(decideRevert(true, T0, undefined), { write: true, inheritTo: [] });
  assert.deepEqual(decideRevert(true, T0, []), { write: true, inheritTo: [] });
  // Eliminar una campaña pausada sin solapes también restaura (repara pausas sucias).
  assert.deepEqual(decideRevert(false, T0, undefined), { write: true, inheritTo: [] });
});

test("🔴 eliminar una campaña PAUSADA no pisa la variante que hoy tiene otra campaña", () => {
  assert.deepEqual(decideRevert(false, T0, [holder(T1)]), { write: false, inheritTo: [] });
  assert.deepEqual(decideRevert(false, T1, [holder(T0)]), { write: false, inheritTo: [] });
});

test("🔴 solape heredado: la que se apiló DESPUÉS hereda el original bueno", () => {
  const nueva = holder(T1, "B");
  const d = decideRevert(true, T0, [nueva]);
  assert.equal(d.write, true);
  assert.deepEqual(d.inheritTo, [nueva]);
});

test("solape heredado al revés: si la otra es ANTERIOR no hereda nada (mi original es su precio)", () => {
  assert.deepEqual(decideRevert(true, T1, [holder(T0, "A")]), { write: true, inheritTo: [] });
});

test("con tres apiladas solo heredan las posteriores", () => {
  const a = holder(T0, "A");
  const c = holder(new Date("2026-11-03T00:00:00Z"), "C");
  assert.deepEqual(decideRevert(true, T1, [a, c]).inheritTo, [c]);
});

// ─── Reporte ──────────────────────────────────────────────────────────────────

const item = (n: number, campaignName = "Verano") => ({
  id: `gid://shopify/Product/${n}`,
  title: `Producto ${n}`,
  variants: 2,
  campaignName,
});

test("appendOverlap acumula entre páginas y no repite un producto", () => {
  let r = appendOverlap(null, [item(1), item(2)]);
  assert.equal(r?.total, 2);
  r = appendOverlap(r, [item(2), item(3)]);
  assert.equal(r?.total, 3);
  assert.deepEqual(r?.products.map((p) => p.id), [1, 2, 3].map((n) => `gid://shopify/Product/${n}`));
  // Reintentar la misma página (reanudación) no infla el total.
  assert.equal(appendOverlap(r, [item(3)]), r);
  assert.equal(appendOverlap(null, []), null);
});

test("appendOverlap corta la lista en el tope pero cuenta el total entero", () => {
  const muchos = Array.from({ length: OVERLAP_REPORT_CAP + 5 }, (_, i) => item(i));
  const r = appendOverlap(null, muchos)!;
  assert.equal(r.total, OVERLAP_REPORT_CAP + 5);
  assert.equal(r.products.length, OVERLAP_REPORT_CAP);
  assert.equal(r.truncated, true);
});

test("el reporte de solapes convive con el de descuentos manuales en el mismo JSON", () => {
  const manual = {
    reason: "manual-discount",
    total: 1,
    products: [{ id: "gid://shopify/Product/9", title: "Nueve", price: "80", compareAtPrice: "100", variants: 1 }],
    truncated: false,
    at: "2026-11-15T00:00:00.000Z",
  };
  const overlap = appendOverlap(null, [item(1)]);
  const guardado = composeSkipReport(manual, overlap);
  // Ida y vuelta por JSON, como en la base.
  const leido = JSON.parse(JSON.stringify(guardado));
  assert.equal(readSkipReport(leido)?.total, 1);
  assert.equal(readSkipReport(leido)?.products[0].id, "gid://shopify/Product/9");
  assert.equal(readOverlapReport(leido)?.total, 1);
  assert.equal(readOverlapReport(leido)?.products[0].campaignName, "Verano");
});

test("solo solapes: el lector de descuentos manuales (el de antes) no ve nada", () => {
  const guardado = JSON.parse(JSON.stringify(composeSkipReport(null, appendOverlap(null, [item(1)]))));
  assert.equal(readSkipReport(guardado), null);
  assert.equal(readOverlapReport(guardado)?.total, 1);
});

test("composeSkipReport sin nada que guardar devuelve null; un reporte viejo no tiene solapes", () => {
  assert.equal(composeSkipReport(null, null), null);
  assert.equal(readOverlapReport(null), null);
  assert.equal(readOverlapReport({ reason: "manual-discount", total: 2, products: [] }), null);
  assert.equal(readOverlapReport({ overlap: { total: 0, products: [] } }), null);
  assert.equal(readOverlapReport({ overlap: "basura" }), null);
});
