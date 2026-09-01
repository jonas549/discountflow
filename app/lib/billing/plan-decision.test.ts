// Tests puros de la decisión de plan. Sin BD, sin red — corren con `npm test`.
//
// Esta batería es además la EVIDENCIA para el caso 116943 de Shopify: la fila
// «activeSubscriptions vacío + historial terminal → FREE» es la incidencia que
// reportaron, y el resto de filas demuestran que la corrección no degrada a
// ninguna tienda que siga pagando.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decidirPlan,
  evaluarLectura,
  type LecturaPlan,
  type SubLeida,
} from "./plan-decision.ts";

const sub = (status: string, planHandle: string | null = null): SubLeida => ({
  status,
  planHandle,
});

const ok = (
  activas: SubLeida[],
  todas: SubLeida[] = activas,
  historialCompleto = true
): LecturaPlan => ({ valida: true, activas, todas, historialCompleto });

const fallo = (motivo = "http 500"): LecturaPlan => ({ valida: false, motivo });

/** Lectura que cumple las condiciones 1-3: nada activo, todo el historial terminal. */
const CONFIRMA_BAJA = ok([], [sub("CANCELLED", "essential")]);

// ─── Sube o mantiene con suscripción viva ─────────────────────────────────────

test("ACTIVE con handle conocido escribe ese plan", () => {
  const r = decidirPlan({
    planActual: "FREE",
    primera: ok([sub("ACTIVE", "essential")]),
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("PENDING cuenta como viva y conserva el plan de pago", () => {
  const r = decidirPlan({
    planActual: "LITE",
    primera: ok([sub("PENDING", "professional")]),
  });
  assert.equal(r.plan, "PROFESSIONAL");
});

test("ACTIVE con handle desconocido NO degrada: conserva el plan", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: ok([sub("ACTIVE", "handle-que-no-existe")]),
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("ACTIVE sin planHandle legible NO degrada", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: ok([sub("ACTIVE", null)]),
  });
  assert.equal(r.plan, "ESSENTIAL");
});

test("FROZEN (impago en curso) conserva el plan: el merchant no pierde servicio", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: ok([sub("FROZEN", "essential")]),
    segunda: CONFIRMA_BAJA,
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

// ─── La ambigüedad nunca degrada (condición 1) ────────────────────────────────

test("lectura inválida (HTTP/errors/currentAppInstallation nulo) conserva el plan", () => {
  const r = decidirPlan({ planActual: "ESSENTIAL", primera: fallo(), segunda: CONFIRMA_BAJA });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("una lectura inválida NO se puede confundir con lista vacía", () => {
  assert.equal(evaluarLectura(fallo()).accion, "mantener");
  assert.equal(evaluarLectura(ok([], [])).accion, "degradar-si-se-confirma");
});

// ─── Evidencia positiva (condición 3): CANCELLED es ambiguo ───────────────────

test("🔴 cambio de plan: vieja CANCELLED + nueva PENDING NO degrada", () => {
  // Shopify marca CANCELLED la suscripción anterior al activar una nueva. Mirar
  // solo la última y ver CANCELLED degradaría a quien acaba de SUBIR de plan.
  const r = decidirPlan({
    planActual: "LITE",
    primera: ok(
      [sub("PENDING", "essential")],
      [sub("CANCELLED", "lite"), sub("PENDING", "essential")]
    ),
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("🔴 activeSubscriptions vacío pero el historial tiene una ACTIVE: NO degrada", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: ok([], [sub("CANCELLED", "lite"), sub("ACTIVE", "essential")]),
    segunda: ok([], [sub("CANCELLED", "lite"), sub("ACTIVE", "essential")]),
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("activeSubscriptions vacío pero el historial tiene una FROZEN: NO degrada", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: ok([], [sub("FROZEN", "essential")]),
    segunda: ok([], [sub("FROZEN", "essential")]),
  });
  assert.equal(r.plan, "ESSENTIAL");
});

// ─── Doble confirmación (condición 4) ─────────────────────────────────────────

test("sin segunda lectura NO se degrada, aunque la primera lo pida", () => {
  const r = decidirPlan({ planActual: "ESSENTIAL", primera: CONFIRMA_BAJA });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("segunda lectura inválida NO confirma: conserva el plan", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: CONFIRMA_BAJA,
    segunda: fallo("timeout"),
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

test("🔴 ventana transaccional: la segunda lectura ya ve la nueva suscripción → no degrada", () => {
  const r = decidirPlan({
    planActual: "ESSENTIAL",
    primera: ok([], [sub("CANCELLED", "essential")]),
    segunda: ok([sub("ACTIVE", "professional")], [
      sub("CANCELLED", "essential"),
      sub("ACTIVE", "professional"),
    ]),
  });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

// ─── La degradación legítima: lo que reportó Shopify ──────────────────────────

test("⭐ caso 116943: cancelación confirmada por dos lecturas → FREE", () => {
  const lectura = ok([], [sub("CANCELLED", "essential")]);
  const r = decidirPlan({ planActual: "ESSENTIAL", primera: lectura, segunda: lectura });
  assert.equal(r.plan, "FREE");
  assert.equal(r.degradado, true);
});

test("historial solo con EXPIRED/DECLINED → FREE", () => {
  const lectura = ok([], [sub("EXPIRED", "lite"), sub("DECLINED", "essential")]);
  const r = decidirPlan({ planActual: "LITE", primera: lectura, segunda: lectura });
  assert.equal(r.plan, "FREE");
  assert.equal(r.degradado, true);
});

test("instalación nueva sin historial → FREE, y no cuenta como degradación", () => {
  const lectura = ok([], []);
  const r = decidirPlan({ planActual: "FREE", primera: lectura, segunda: lectura });
  assert.equal(r.plan, "FREE");
  assert.equal(r.degradado, false);
});

test("🔴 historial paginado sin ver ninguna viva: NO degrada (no lo vimos entero)", () => {
  const truncada = ok([], [sub("CANCELLED", "lite")], false);
  const r = decidirPlan({ planActual: "ESSENTIAL", primera: truncada, segunda: truncada });
  assert.equal(r.plan, "ESSENTIAL");
  assert.equal(r.degradado, false);
});

// ─── Suscripciones de prueba ──────────────────────────────────────────────────

test("🔴 una suscripción sin cargo se trata como cualquier otra (revisores de Shopify)", () => {
  // Si en algún momento se filtrara por `test: false`, el revisor de Shopify
  // —que se suscribe con un plan sin cargo— acabaría degradado a FREE en mitad
  // de la revisión. `SubLeida` no expone `test` justamente para que no se pueda.
  const r = decidirPlan({
    planActual: "FREE",
    primera: ok([sub("ACTIVE", "professional")]),
  });
  assert.equal(r.plan, "PROFESSIONAL");
});
