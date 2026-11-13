import test from "node:test";
import assert from "node:assert/strict";
import { formatShopDateTime, safeTimeZone, shopLocalToUtc, utcToShopLocal } from "./shop-time.ts";

const iso = (d: Date | null) => d?.toISOString() ?? null;

test("hora de la tienda → UTC: Chile en verano (UTC-3) y en invierno (UTC-4)", () => {
  assert.equal(iso(shopLocalToUtc("2026-12-01T09:00", "America/Santiago")), "2026-12-01T12:00:00.000Z");
  assert.equal(iso(shopLocalToUtc("2026-07-01T09:00", "America/Santiago")), "2026-07-01T13:00:00.000Z");
});

test("hora de la tienda → UTC: Nueva York con y sin horario de verano", () => {
  assert.equal(iso(shopLocalToUtc("2026-11-20T09:00", "America/New_York")), "2026-11-20T14:00:00.000Z");
  assert.equal(iso(shopLocalToUtc("2026-07-04T09:00", "America/New_York")), "2026-07-04T13:00:00.000Z");
});

test("hora de la tienda → UTC: España y una zona sin cambio de hora", () => {
  assert.equal(iso(shopLocalToUtc("2026-01-15T00:00", "Europe/Madrid")), "2026-01-14T23:00:00.000Z");
  assert.equal(iso(shopLocalToUtc("2026-08-15T00:00", "Europe/Madrid")), "2026-08-14T22:00:00.000Z");
  assert.equal(iso(shopLocalToUtc("2026-03-10T18:30", "America/Caracas")), "2026-03-10T22:30:00.000Z");
});

test("ida y vuelta: lo que el merchant escribe es lo que vuelve a ver", () => {
  for (const tz of ["America/Santiago", "America/New_York", "Europe/Madrid", "Asia/Tokyo", "UTC"])
    for (const local of ["2026-01-01T00:00", "2026-06-15T13:45", "2026-11-20T23:59"])
      assert.equal(utcToShopLocal(shopLocalToUtc(local, tz), tz), local, `${tz} ${local}`);
});

test("cambio de hora: la hora que no existe cae en una hora válida contigua, sin romper", () => {
  // Nueva York salta de 02:00 a 03:00 el 8 de marzo de 2026: las 02:30 no existen.
  const d = shopLocalToUtc("2026-03-08T02:30", "America/New_York");
  assert.ok(d);
  assert.ok(["2026-03-08T01:30", "2026-03-08T03:30"].includes(utcToShopLocal(d, "America/New_York")));
});

test("vacío, basura o zona desconocida no lanzan", () => {
  assert.equal(shopLocalToUtc("", "America/Santiago"), null);
  assert.equal(shopLocalToUtc(null, "America/Santiago"), null);
  assert.equal(shopLocalToUtc("mañana", "America/Santiago"), null);
  assert.equal(utcToShopLocal(null, "America/Santiago"), "");
  // Zona inválida o ausente = UTC, que es lo que hacía el código anterior.
  assert.equal(safeTimeZone("No/Existe"), "UTC");
  assert.equal(iso(shopLocalToUtc("2026-11-20T09:00", null)), "2026-11-20T09:00:00.000Z");
  assert.equal(iso(shopLocalToUtc("2026-11-20T09:00", "No/Existe")), "2026-11-20T09:00:00.000Z");
});

test("formato para el listado", () => {
  assert.equal(formatShopDateTime(new Date("2026-11-20T14:00:00Z"), "America/New_York"), "20/11/2026 09:00");
  assert.equal(formatShopDateTime("2026-12-01T12:00:00.000Z", "America/Santiago"), "01/12/2026 09:00");
  assert.equal(formatShopDateTime(null, "UTC"), "");
});
