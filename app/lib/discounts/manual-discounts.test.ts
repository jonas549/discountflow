import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSkipped,
  describeSkipped,
  hasManualDiscount,
  looksDiscounted,
  readSkipReport,
  SKIP_REPORT_CAP,
} from "./manual-discounts.ts";

const sin = new Set<string>();
const v = (id: string, price: string, compareAtPrice: string | null = null) => ({ id, price, compareAtPrice });

test("variante rebajada: solo si el comparativo es MAYOR que el precio", () => {
  assert.equal(looksDiscounted(v("a", "80.00", "100.00")), true);
  assert.equal(looksDiscounted(v("a", "100.00", "100.00")), false);
  assert.equal(looksDiscounted(v("a", "100.00", "90.00")), false);
  assert.equal(looksDiscounted(v("a", "100.00", null)), false);
  assert.equal(looksDiscounted(v("a", "100.00", "")), false);
  assert.equal(looksDiscounted(v("a", "abc", "100.00")), false);
});

test("producto con descuento manual: basta UNA variante rebajada para saltarlo entero", () => {
  assert.equal(hasManualDiscount([v("a", "100.00"), v("b", "80.00", "100.00")], sin), true);
  assert.equal(hasManualDiscount([v("a", "100.00"), v("b", "100.00")], sin), false);
  assert.equal(hasManualDiscount([], sin), false);
});

test("una rebaja puesta por OTRA campaña de DiscountFlow no cuenta como manual", () => {
  const nuestras = new Set(["b"]);
  assert.equal(hasManualDiscount([v("a", "100.00"), v("b", "80.00", "100.00")], nuestras), false);
  // …pero si además hay una variante rebajada que no es nuestra, sí.
  assert.equal(
    hasManualDiscount([v("b", "80.00", "100.00"), v("c", "70.00", "100.00")], nuestras),
    true
  );
});

test("el caso de Jonas: 20 productos, 3 con comparativo manual → se saltan 3, quedan 17", () => {
  const productos = Array.from({ length: 20 }, (_, i) => ({
    productId: `p${i + 1}`,
    variants: [v(`p${i + 1}-s`, i < 3 ? "80.00" : "100.00", i < 3 ? "100.00" : null), v(`p${i + 1}-m`, "100.00")],
  }));
  const salteados = productos.filter((p) => hasManualDiscount(p.variants, sin));
  assert.equal(salteados.length, 3);
  assert.equal(productos.length - salteados.length, 17);
});

test("el reporte dice qué producto, con qué precios, y cuántas variantes", () => {
  const d = describeSkipped(
    { productId: "gid://shopify/Product/9", title: "Camisa", variants: [v("a", "100.00"), v("b", "80.00", "100.00")] },
    sin
  );
  assert.deepEqual(d, {
    id: "gid://shopify/Product/9",
    title: "Camisa",
    price: "80.00",
    compareAtPrice: "100.00",
    variants: 2,
  });
});

test("el reporte se acumula entre páginas sin duplicar y con tope", () => {
  const at = new Date("2026-11-20T12:00:00Z");
  const p = (id: string) => ({ id, title: id, price: "80.00", compareAtPrice: "100.00", variants: 1 });
  let r = appendSkipped(null, [p("a"), p("b")], at);
  r = appendSkipped(r, [p("b"), p("c")], at);
  assert.equal(r?.total, 3);
  assert.deepEqual(r?.products.map((x) => x.id), ["a", "b", "c"]);
  assert.equal(r?.truncated, false);
  assert.equal(appendSkipped(null, [], at), null);

  const muchos = Array.from({ length: SKIP_REPORT_CAP + 5 }, (_, i) => p(`x${i}`));
  const grande = appendSkipped(null, muchos, at);
  assert.equal(grande?.total, SKIP_REPORT_CAP + 5);
  assert.equal(grande?.products.length, SKIP_REPORT_CAP);
  assert.equal(grande?.truncated, true);
});

test("leer el reporte guardado: tolera basura", () => {
  assert.equal(readSkipReport(null), null);
  assert.equal(readSkipReport("x"), null);
  assert.equal(readSkipReport({ reason: "otra", products: [] }), null);
  assert.equal(readSkipReport({ reason: "manual-discount", total: 0, products: [] }), null);
  const ok = readSkipReport({
    reason: "manual-discount",
    total: 1,
    products: [{ id: "a", title: "A", price: "1", compareAtPrice: "2", variants: 1 }],
  });
  assert.equal(ok?.total, 1);
});
