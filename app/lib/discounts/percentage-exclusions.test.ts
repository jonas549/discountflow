import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  unirExclusiones,
  parseExcludedCollectionIds,
  resolverExclusiones,
} from "./percentage-exclusions.ts";

test("producto suelto: excluye solo las variantes elegidas en el picker", () => {
  const ids = unirExclusiones([{ id: "P1", variants: [{ id: "V1" }] }], []);
  assert.deepEqual([...ids], ["V1"]);
});

test("colección: excluye TODAS las variantes de sus productos", () => {
  const ids = unirExclusiones([], [
    { productId: "P2", variants: [{ id: "V2a" }, { id: "V2b" }] },
    { productId: "P3", variants: [{ id: "V3" }] },
  ]);
  assert.equal(ids.size, 3);
  for (const v of ["V2a", "V2b", "V3"]) assert.ok(ids.has(v));
});

test("las dos listas se SUMAN y un producto repetido cuenta una vez", () => {
  const ids = unirExclusiones(
    [{ id: "P1", variants: [{ id: "V1" }] }, { id: "P2", variants: [{ id: "V2a" }] }],
    [{ productId: "P2", variants: [{ id: "V2a" }, { id: "V2b" }] }]
  );
  assert.equal(ids.size, 3);
  for (const v of ["V1", "V2a", "V2b"]) assert.ok(ids.has(v));
});

test("sin exclusiones = conjunto vacío", () => {
  assert.equal(unirExclusiones([], []).size, 0);
});

// 🔴 NO-REGRESIÓN para las campañas que ya existen (SkinUp, Nachin, Greta): sin
// colecciones excluidas, el conjunto tiene que ser EXACTAMENTE el que armaba el
// código anterior. Ésta es la fórmula vieja, copiada literal de las dos rutas
// antes del cambio, con la misma condición de entrada.
function armadoViejo(enableExclusions: boolean, excluded: Array<{ id: string; variants?: Array<{ id: string }> }>) {
  return enableExclusions && excluded.length > 0
    ? new Set(excluded.flatMap((p) => (p.variants ?? []).map((v) => v.id)))
    : undefined;
}
// Y la nueva, con la misma condición que pusieron las rutas, sin colecciones.
function armadoNuevoSinColecciones(enableExclusions: boolean, excluded: Array<{ id: string; variants?: Array<{ id: string }> }>) {
  const colecciones = parseExcludedCollectionIds(undefined);
  return enableExclusions && (excluded.length > 0 || colecciones.length > 0)
    ? unirExclusiones(excluded, [])
    : undefined;
}

const casos: Array<[string, boolean, Array<{ id: string; variants?: Array<{ id: string }> }>]> = [
  ["exclusiones apagadas", false, [{ id: "P1", variants: [{ id: "V1" }] }]],
  ["encendidas sin productos", true, []],
  ["apagadas y vacías", false, []],
  ["un producto con dos variantes", true, [{ id: "P1", variants: [{ id: "V1" }, { id: "V2" }] }]],
  ["producto sin variantes en el picker", true, [{ id: "P1", variants: [] }]],
  ["producto con variants ausente", true, [{ id: "P1" }]],
  ["variantes repetidas entre productos", true, [
    { id: "P1", variants: [{ id: "V1" }] },
    { id: "P2", variants: [{ id: "V1" }, { id: "V3" }] },
  ]],
];

for (const [nombre, on, excl] of casos) {
  test(`sin colecciones = MISMO conjunto que antes: ${nombre}`, () => {
    const viejo = armadoViejo(on, excl);
    const nuevo = armadoNuevoSinColecciones(on, excl);
    if (viejo === undefined) return assert.equal(nuevo, undefined);
    assert.ok(nuevo instanceof Set);
    assert.deepEqual([...nuevo].sort(), [...viejo].sort());
  });
}

test("parseExcludedCollectionIds tolera ausencia y basura", () => {
  assert.deepEqual(parseExcludedCollectionIds(undefined), []);
  assert.deepEqual(parseExcludedCollectionIds("no-json"), []);
  assert.deepEqual(parseExcludedCollectionIds('{"a":1}'), []);
  assert.deepEqual(parseExcludedCollectionIds('["C1", 3, "", "C2"]'), ["C1", "C2"]);
});

// Las dos pantallas tienen que pasar por el MISMO helper; si una arma el conjunto
// por su cuenta, crear y editar dejan de excluir lo mismo.
const sinComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

for (const ruta of [
  "app/routes/app.campaigns.new.percentage.tsx",
  "app/routes/app.campaigns.$id.edit.tsx",
]) {
  test(`${ruta} arma las exclusiones con resolverVariantesExcluidas`, () => {
    const src = sinComentarios(readFileSync(ruta, "utf8").replace(/\r\n/g, "\n"));
    assert.match(src, /resolverVariantesExcluidas\(/);
    // La condición de entrada es la que copia el test de no-regresión de arriba.
    assert.match(
      src,
      /enableExclusions &&\s*\(excluded\.length > 0 \|\| excludedCollectionIds\.length > 0\)/
    );
    assert.match(src, /name="excludedCollectionIdsJson"/);
    assert.match(src, /excludedCollectionIds:/);
    // El armado viejo, solo con productos, no puede seguir vivo en paralelo.
    assert.doesNotMatch(src, /excluded\.flatMap\(/);
  });
}

// ─── Producto excluido SIN variantes = producto ENTERO (2026-11-13) ───────────
//
// En producción, 7 de 17 productos marcados como excluidos llegaron del
// formulario sin variantes y se rebajaron igual, sin un aviso. La regla ahora:
// sin variantes elegidas se excluye el producto entero, y si no se puede leer,
// se aborta antes de tocar precios.

const lectores = (
  catalogo: Record<string, string[]>,
  colecciones: Record<string, string[]> = {}
) => {
  const leidos: string[] = [];
  return {
    leidos,
    leerProducto: async (id: string) => {
      leidos.push(id);
      if (!(id in catalogo)) throw new Error(`no existe ${id}`);
      return catalogo[id].map((v) => ({ id: v }));
    },
    leerColeccion: async (id: string) => {
      if (!(id in colecciones)) throw new Error(`no existe ${id}`);
      return colecciones[id].map((p) => ({
        productId: p,
        variants: (catalogo[p] ?? []).map((v) => ({ id: v })),
      }));
    },
  };
};

test("producto SIN variantes (vacío o ausente) se excluye ENTERO", async () => {
  const l = lectores({ P1: ["V1", "V2", "V3"], P2: ["V4"] });
  const ids = await resolverExclusiones({
    productos: [{ id: "P1", variants: [] }, { id: "P2" }],
    collectionIds: [],
    leerProducto: l.leerProducto,
    leerColeccion: l.leerColeccion,
  });
  assert.deepEqual([...ids].sort(), ["V1", "V2", "V3", "V4"]);
});

test("producto CON variantes elegidas: solo ésas, y no se lee de Shopify", async () => {
  const l = lectores({ P1: ["V1", "V2", "V3"] });
  const ids = await resolverExclusiones({
    productos: [{ id: "P1", variants: [{ id: "V2" }] }],
    collectionIds: [],
    leerProducto: l.leerProducto,
    leerColeccion: l.leerColeccion,
  });
  assert.deepEqual([...ids], ["V2"]);
  assert.deepEqual(l.leidos, []);
});

test("el caso real: productos con y sin variantes + colección", async () => {
  const l = lectores({ P1: ["V1", "V2"], P2: ["V3", "V4"], P3: ["V5"] }, { C1: ["P3"] });
  const ids = await resolverExclusiones({
    productos: [
      { id: "P1", variants: [{ id: "V1" }, { id: "V2" }] },
      { id: "P2", variants: [] },
    ],
    collectionIds: ["C1"],
    leerProducto: l.leerProducto,
    leerColeccion: l.leerColeccion,
  });
  assert.deepEqual([...ids].sort(), ["V1", "V2", "V3", "V4", "V5"]);
});

test("producto sin variantes que NO se puede leer: lanza (falla cerrado)", async () => {
  const l = lectores({});
  await assert.rejects(
    resolverExclusiones({
      productos: [{ id: "PX", variants: [] }],
      collectionIds: [],
      leerProducto: l.leerProducto,
      leerColeccion: l.leerColeccion,
    }),
    /no existe PX/
  );
});

test("producto sin variantes que vuelve VACÍO de Shopify: lanza, no excluye nada en silencio", async () => {
  const l = lectores({ P1: [] });
  await assert.rejects(
    resolverExclusiones({
      productos: [{ id: "P1" }],
      collectionIds: [],
      leerProducto: l.leerProducto,
      leerColeccion: l.leerColeccion,
    }),
    /no devolvió ninguna variante/
  );
});

test("colección ilegible sigue lanzando", async () => {
  const l = lectores({});
  await assert.rejects(
    resolverExclusiones({
      productos: [],
      collectionIds: ["CX"],
      leerProducto: l.leerProducto,
      leerColeccion: l.leerColeccion,
    }),
    /no existe CX/
  );
});

test("el lector de producto del servidor es estricto y pasa por resolverExclusiones", () => {
  const src = sinComentarios(
    readFileSync("app/lib/discounts/percentage-exclusions.server.ts", "utf8").replace(/\r\n/g, "\n")
  );
  assert.match(src, /readQueryData</);
  assert.match(src, /resolverExclusiones\(/);
  assert.doesNotMatch(src, /getProductVariants\(/);
});
