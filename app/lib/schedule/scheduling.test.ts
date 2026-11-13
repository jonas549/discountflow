import test from "node:test";
import assert from "node:assert/strict";
import { dueAction, scheduleFlags, scheduleLabel } from "./scheduling.ts";

const now = new Date("2026-11-20T12:00:00Z");
const antes = new Date("2026-11-20T11:00:00Z");
const despues = new Date("2026-11-20T13:00:00Z");
const base = {
  status: "DRAFT",
  startsAt: null as Date | null,
  endsAt: null as Date | null,
  autoStart: false,
  autoEnd: false,
  activeJobId: null as string | null,
};

test("marcas: activar con inicio futuro programa el inicio; como borrador no", () => {
  assert.deepEqual(scheduleFlags({ intent: "activate", startsAt: despues, endsAt: null, now }), {
    isScheduled: true,
    autoStart: true,
    autoEnd: false,
  });
  assert.deepEqual(scheduleFlags({ intent: "draft", startsAt: despues, endsAt: null, now }), {
    isScheduled: true,
    autoStart: false,
    autoEnd: false,
  });
});

test("marcas: inicio pasado o vacío activa ya; el fin futuro se programa", () => {
  assert.deepEqual(scheduleFlags({ intent: "activate", startsAt: antes, endsAt: despues, now }), {
    isScheduled: false,
    autoStart: false,
    autoEnd: true,
  });
  assert.deepEqual(scheduleFlags({ intent: "activate", startsAt: null, endsAt: null, now }), {
    isScheduled: false,
    autoStart: false,
    autoEnd: false,
  });
});

test("marcas: un fin que ya pasó al guardar no se programa", () => {
  assert.equal(scheduleFlags({ intent: "activate", startsAt: null, endsAt: antes, now }).autoEnd, false);
});

test("🔒 campañas viejas con fechas vencidas y sin marca: NO se disparan", () => {
  assert.equal(dueAction({ ...base, status: "PAUSED", startsAt: antes, endsAt: antes }, now), null);
  assert.equal(dueAction({ ...base, status: "ACTIVE", endsAt: antes }, now), null);
  assert.equal(dueAction({ ...base, status: "DRAFT", startsAt: antes }, now), null);
});

test("inicio: arranca al llegar la hora, no antes", () => {
  assert.equal(dueAction({ ...base, autoStart: true, startsAt: despues }, now), null);
  assert.equal(dueAction({ ...base, autoStart: true, startsAt: antes }, now), "start");
  assert.equal(dueAction({ ...base, autoStart: true, startsAt: now }, now), "start");
  assert.equal(dueAction({ ...base, status: "PAUSED", autoStart: true, startsAt: antes }, now), "start");
});

test("fin: pausa al llegar la hora si está activa", () => {
  assert.equal(dueAction({ ...base, status: "ACTIVE", autoEnd: true, endsAt: despues }, now), null);
  assert.equal(dueAction({ ...base, status: "ACTIVE", autoEnd: true, endsAt: antes }, now), "end");
});

test("con una operación en curso no se toca: se reintenta en el próximo tick", () => {
  assert.equal(dueAction({ ...base, autoStart: true, startsAt: antes, activeJobId: "job" }, now), null);
  assert.equal(
    dueAction({ ...base, status: "ACTIVE", autoEnd: true, endsAt: antes, activeJobId: "job" }, now),
    null
  );
});

test("marcas sin efecto se limpian en vez de disparar algo raro", () => {
  // La activaron a mano antes de la hora: el inicio programado ya no aplica.
  assert.equal(dueAction({ ...base, status: "ACTIVE", autoStart: true, startsAt: antes }, now), "clear-start");
  // La pausaron a mano antes del fin: no hay nada que terminar.
  assert.equal(dueAction({ ...base, status: "PAUSED", autoEnd: true, endsAt: antes }, now), "clear-end");
  // Inicio y fin vencidos a la vez (el cron estuvo caído): no arranca para apagarse enseguida.
  assert.equal(
    dueAction({ ...base, autoStart: true, autoEnd: true, startsAt: antes, endsAt: antes }, now),
    "expired"
  );
});

test("etiqueta del listado", () => {
  const fmt = (d: Date) => d.toISOString().slice(0, 16);
  assert.equal(
    scheduleLabel({ ...base, autoStart: true, startsAt: despues }, now, fmt),
    "Programada: empieza el 2026-11-20T13:00"
  );
  assert.match(
    scheduleLabel({ ...base, autoStart: true, autoEnd: true, startsAt: despues, endsAt: despues }, now, fmt)!,
    /termina el/
  );
  assert.equal(
    scheduleLabel({ ...base, status: "ACTIVE", autoEnd: true, endsAt: despues }, now, fmt),
    "Termina el 2026-11-20T13:00"
  );
  assert.match(scheduleLabel({ ...base, status: "ACTIVE", startsAt: despues }, now, fmt)!, /^Programada/);
  assert.equal(scheduleLabel({ ...base, status: "PAUSED", startsAt: antes, endsAt: antes }, now, fmt), null);
});
