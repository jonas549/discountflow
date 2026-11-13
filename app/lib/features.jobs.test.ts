import test from "node:test";
import assert from "node:assert/strict";
import { hasFeature, jobsEnabled } from "./features.server.ts";

test("barra de fábrica: una tienda recién instalada (features vacío) va por el motor", () => {
  assert.equal(jobsEnabled({ features: {} }), true);
  assert.equal(jobsEnabled({}), true);
  assert.equal(jobsEnabled({ features: null }), true);
});

test("barra de fábrica: las tiendas que ya tenían el flag en true no cambian", () => {
  assert.equal(jobsEnabled({ features: { "jobs:batched": true } }), true);
});

test("barra de fábrica: se apaga SOLO con false explícito (interruptor de emergencia)", () => {
  assert.equal(jobsEnabled({ features: { "jobs:batched": false } }), false);
  assert.equal(jobsEnabled({ features: { "jobs:batched": false, "cupones:viaje": true } }), false);
});

test("barra de fábrica: valores raros no apagan el motor", () => {
  assert.equal(jobsEnabled({ features: { "jobs:batched": "false" } }), true);
  assert.equal(jobsEnabled({ features: { "jobs:batched": 0 } }), true);
  assert.equal(jobsEnabled({ features: [] }), true);
  assert.equal(jobsEnabled({ features: "roto" }), true);
  assert.equal(jobsEnabled(null), true);
});

test("los demás flags siguen fallando cerrado", () => {
  assert.equal(hasFeature({ features: {} }, "cupones:viaje"), false);
  assert.equal(hasFeature(null, "cupones:viaje"), false);
});
