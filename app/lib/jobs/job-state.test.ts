// Tests puros del motor de jobs: máquina de estados y guardia de origen.
// Sin BD, sin red — corren con el resto en `npm test`.
//
// Las garantías que dependen de PostgreSQL (cerrojo de campaña, lease entre dos
// workers, zombis) NO se prueban aquí: falsear Prisma haría que pasaran siempre sin
// demostrar nada. Están en engine.dbtest.ts, contra Postgres de verdad.

import test from "node:test";
import assert from "node:assert/strict";

import {
  canTransition,
  isClaimable,
  isStalled,
  isTerminal,
  percentOf,
  type JobStatus,
} from "./job-state.ts";
import { ChainOriginError, resolveWorkerOrigin } from "./chain.server.ts";

const STALE = 90_000;
const NOW = new Date("2026-08-07T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ─── Estados terminales ───────────────────────────────────────────────────────

test("los cuatro estados finales son terminales y el resto no", () => {
  for (const s of ["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELLED"])
    assert.equal(isTerminal(s as JobStatus), true, s);
  for (const s of ["QUEUED", "RESOLVING", "RUNNING", "CANCELLING"])
    assert.equal(isTerminal(s as JobStatus), false, s);
});

test("desde un estado terminal no se sale a ningún sitio", () => {
  const todos: JobStatus[] = [
    "QUEUED", "RESOLVING", "RUNNING", "CANCELLING",
    "COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELLED",
  ];
  for (const to of todos) {
    assert.equal(canTransition("COMPLETED", to), false);
    assert.equal(canTransition("CANCELLED", to), false);
    assert.equal(canTransition("FAILED", to), false);
    assert.equal(canTransition("COMPLETED_WITH_ERRORS", to), false);
  }
});

test("RUNNING -> QUEUED es válida: es el vigilante devolviendo un zombi al ruedo", () => {
  assert.equal(canTransition("RUNNING", "QUEUED"), true);
});

test("CANCELLING solo puede acabar en CANCELLED o FAILED", () => {
  assert.equal(canTransition("CANCELLING", "CANCELLED"), true);
  assert.equal(canTransition("CANCELLING", "FAILED"), true);
  assert.equal(canTransition("CANCELLING", "RUNNING"), false);
  assert.equal(canTransition("CANCELLING", "COMPLETED"), false);
});

test("no se puede saltar de QUEUED a COMPLETED sin pasar por el trabajo", () => {
  assert.equal(canTransition("QUEUED", "COMPLETED"), false);
});

// ─── Lease / zombis ───────────────────────────────────────────────────────────

test("un job QUEUED siempre es reclamable", () => {
  assert.equal(isClaimable("QUEUED", null, NOW, STALE), true);
});

test("un RUNNING con latido reciente NO es reclamable", () => {
  assert.equal(isClaimable("RUNNING", ago(10_000), NOW, STALE), false);
});

test("un RUNNING con latido rancio SÍ es reclamable — esa es la definición de zombi", () => {
  assert.equal(isClaimable("RUNNING", ago(120_000), NOW, STALE), true);
});

test("el umbral de zombi es 8x el peor caso de una unidad, así que 60 s no basta", () => {
  assert.equal(isClaimable("RUNNING", ago(60_000), NOW, STALE), false);
  assert.equal(isClaimable("RUNNING", ago(90_001), NOW, STALE), true);
});

test("un job terminal nunca es reclamable ni está colgado", () => {
  assert.equal(isClaimable("COMPLETED", ago(999_999), NOW, STALE), false);
  assert.equal(isStalled("COMPLETED", ago(999_999), NOW, STALE), false);
});

test("isStalled solo marca jobs vivos que dejaron de latir", () => {
  assert.equal(isStalled("RUNNING", ago(120_000), NOW, STALE), true);
  assert.equal(isStalled("RUNNING", ago(10_000), NOW, STALE), false);
  assert.equal(isStalled("QUEUED", null, NOW, STALE), false);
});

// ─── Porcentaje ───────────────────────────────────────────────────────────────

test("sin denominador el porcentaje es null, no 0 (barra indeterminada)", () => {
  assert.equal(percentOf(0, 0, "RESOLVING"), null);
});

test("un 0 % legítimo sí se muestra como 0 cuando ya hay total", () => {
  assert.equal(percentOf(0, 4000, "RUNNING"), 0);
});

test("el porcentaje se trunca hacia abajo y nunca pasa de 100", () => {
  assert.equal(percentOf(1720, 4000, "RUNNING"), 43);
  assert.equal(percentOf(4000, 4000, "RUNNING"), 100);
  assert.equal(percentOf(5000, 4000, "RUNNING"), 100);
});

test("un job completado marca 100 aunque los contadores no cuadren", () => {
  assert.equal(percentOf(0, 0, "COMPLETED"), 100);
  assert.equal(percentOf(0, 0, "COMPLETED_WITH_ERRORS"), 100);
});

// ─── 🔴 Guardia de origen ─────────────────────────────────────────────────────

const req = (headers: Record<string, string>, url = "https://ejemplo.test/api/jobs/run") =>
  new Request(url, { headers });

test("el origen sale de x-forwarded-*, no de la URL interna", () => {
  const origin = resolveWorkerOrigin(
    req({ "x-forwarded-host": "abc.trycloudflare.com", "x-forwarded-proto": "https" },
      "http://127.0.0.1:3000/api/jobs/run")
  );
  assert.equal(origin, "https://abc.trycloudflare.com");
});

test("sin cabeceras de proxy cae al origen de la propia URL", () => {
  const origin = resolveWorkerOrigin(req({}, "https://tunel.trycloudflare.com/api/jobs/run"));
  assert.equal(origin, "https://tunel.trycloudflare.com");
});

test("🔴 fuera de producción, encadenar contra el host de PRODUCCIÓN se bloquea", () => {
  // Este es el fallo que el .env de desarrollo provocaría: SHOPIFY_APP_URL apunta
  // a discountflow-app.vercel.app, así que un motor que leyera esa variable haría
  // que cada lote de prueba golpease las tiendas de clientes reales.
  const previo = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    assert.throws(
      () => resolveWorkerOrigin(req({ "x-forwarded-host": "discountflow-app.vercel.app" })),
      (err: unknown) => err instanceof ChainOriginError
    );
  } finally {
    process.env.NODE_ENV = previo;
  }
});

test("en producción, el host de producción sí es válido", () => {
  const previo = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(
      resolveWorkerOrigin(req({ "x-forwarded-host": "discountflow-app.vercel.app" })),
      "https://discountflow-app.vercel.app"
    );
  } finally {
    process.env.NODE_ENV = previo;
  }
});

test("un host de túnel cualquiera pasa el guardia en desarrollo", () => {
  const previo = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    assert.equal(
      resolveWorkerOrigin(req({ "x-forwarded-host": "loud-pines-42.trycloudflare.com" })),
      "https://loud-pines-42.trycloudflare.com"
    );
  } finally {
    process.env.NODE_ENV = previo;
  }
});
