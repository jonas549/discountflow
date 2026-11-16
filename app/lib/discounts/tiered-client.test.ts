import test from "node:test";
import assert from "node:assert/strict";

import {
  TIERED_METAFIELD_MAX_BYTES,
  mensajeTieredDemasiadoGrande,
  tieredConfigBytes,
  type TieredCampaignConfig,
} from "./tiered-client.ts";

// Ids del mismo largo que los reales de Shopify (13 dígitos).
const ids = (n: number, desde = 0) =>
  Array.from({ length: n }, (_, i) => `gid://shopify/Product/${9000000000000 + desde + i}`);

const campana = (over: Partial<TieredCampaignConfig>): TieredCampaignConfig => ({
  mode: "UNIFORM",
  tiers: [{ minQty: 2, percent: 10 }],
  selectionMode: "products",
  productIds: [],
  collectionIds: [],
  rawItems: [],
  excludeProductIds: [],
  ...over,
});

const maximoDe = (mensaje: string) => Number(/admite hasta (\d+)/.exec(mensaje)?.[1]);

test("N1: una campaña chica entra y no hay mensaje", () => {
  assert.equal(mensajeTieredDemasiadoGrande(campana({ productIds: ids(3) })), null);
  assert.equal(mensajeTieredDemasiadoGrande(campana({ productIds: ids(200) })), null);
});

test("🔴 N1: los 343 productos que quedaban «Activa» sin descontar se rechazan", () => {
  const mensaje = mensajeTieredDemasiadoGrande(campana({ productIds: ids(343) }));
  assert.ok(mensaje);
  assert.match(mensaje, /abarca 343 productos/);
  assert.match(mensaje, /con el nivel que elegiste/);
  // Nada técnico de cara al comerciante.
  assert.doesNotMatch(mensaje, /byte|metafield|Function/i);
});

test("🔴 N1: el máximo que se promete ENTRA de verdad, y uno más ya no", () => {
  for (const tiers of [
    [{ minQty: 2, percent: 10 }],
    [
      { minQty: 2, percent: 10 },
      { minQty: 4, percent: 15 },
      { minQty: 6, percent: 20 },
      { minQty: 8, percent: 25 },
    ],
  ]) {
    const mensaje = mensajeTieredDemasiadoGrande(campana({ tiers, productIds: ids(400) }));
    assert.ok(mensaje);
    const maximo = maximoDe(mensaje);
    assert.ok(maximo > 0 && maximo < 400);
    assert.equal(mensajeTieredDemasiadoGrande(campana({ tiers, productIds: ids(maximo) })), null);
    assert.ok(mensajeTieredDemasiadoGrande(campana({ tiers, productIds: ids(maximo + 1) })));
  }
});

test("🔴 N1: el límite depende de los niveles, no es un número fijo de productos", () => {
  const unNivel = maximoDe(mensajeTieredDemasiadoGrande(campana({ productIds: ids(400) }))!);
  const cuatro = maximoDe(
    mensajeTieredDemasiadoGrande(
      campana({
        productIds: ids(400),
        tiers: [
          { minQty: 2, percent: 10 },
          { minQty: 4, percent: 15 },
          { minQty: 6, percent: 20 },
          { minQty: 8, percent: 25 },
        ],
      })
    )!
  );
  assert.ok(cuatro < unNivel, `${cuatro} < ${unNivel}`);
});

test("N1: las exclusiones ocupan lugar y el mensaje lo dice", () => {
  const mensaje = mensajeTieredDemasiadoGrande(
    campana({ productIds: ids(300), excludeProductIds: ids(20, 5000) })
  );
  assert.ok(mensaje);
  assert.match(mensaje, /Los 20 productos excluidos también ocupan lugar/);
  const maximo = maximoDe(mensaje);
  assert.equal(
    mensajeTieredDemasiadoGrande(
      campana({ productIds: ids(maximo), excludeProductIds: ids(20, 5000) })
    ),
    null
  );
});

test("N1: «toda la tienda» solo crece por las exclusiones", () => {
  assert.equal(mensajeTieredDemasiadoGrande(campana({ selectionMode: "all" })), null);
  const mensaje = mensajeTieredDemasiadoGrande(
    campana({ selectionMode: "all", excludeProductIds: ids(400) })
  );
  assert.ok(mensaje);
  assert.match(mensaje, /excluye 400 productos/);
  const maximo = maximoDe(mensaje);
  assert.equal(
    mensajeTieredDemasiadoGrande(campana({ selectionMode: "all", excludeProductIds: ids(maximo) })),
    null
  );
});

test("N1: el tamaño se mide en bytes reales (una ñ en el mensaje pesa 2)", () => {
  const base = campana({ productIds: ids(1), message: "aaaa" });
  assert.equal(tieredConfigBytes({ ...base, message: "ññññ" }) - tieredConfigBytes(base), 4);
  assert.ok(TIERED_METAFIELD_MAX_BYTES < 10_000);
});

test("N1: con ids de distinto largo el máximo no castiga a todos por los largos", () => {
  // 14 ids largos (como los productos nuevos) + 300 cortos.
  const largos = Array.from({ length: 14 }, (_, i) => `gid://shopify/Product/${15000000000000 + i}`);
  const todos = [...largos, ...ids(300)];
  const maximo = maximoDe(mensajeTieredDemasiadoGrande(campana({ productIds: todos }))!);
  // El peor subconjunto de ese tamaño (todos los largos adentro) entra…
  assert.equal(
    mensajeTieredDemasiadoGrande(campana({ productIds: [...largos, ...ids(maximo - 14)] })),
    null
  );
  // …y con uno más ya no.
  assert.ok(mensajeTieredDemasiadoGrande(campana({ productIds: [...largos, ...ids(maximo - 13)] })));
});
