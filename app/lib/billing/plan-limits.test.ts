// Tests del eje de TIPO de campaña por plan.
//
// Este eje no existía antes del 2026-09-05 y decide dinero: si una tienda puede
// o no tener activa una campaña de un tipo de pago. Los tests están para que la
// tabla de planes decidida y el código no puedan divergir en silencio.
//
// `comprobarTipoDeCampana` (que además cuenta activas en la base) vive en
// `plan-limits.server.ts` y no se cubre acá: necesita Postgres. Lo que sí se
// cubre es la REGLA, que es donde estaba el agujero.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PLANS,
  PLAN_LIMITS,
  reglaDeTipo,
  esTipoLimitadoPorPlan,
  type Plan,
  type TypeLimitedCampaign,
} from "./plan-limits.ts";

/**
 * La tabla que decidió Jonas, escrita aparte del código a propósito.
 *
 *   false      → el plan NO incluye el tipo
 *   número     → incluido, con ese máximo de activas simultáneas
 *   null       → incluido, sin sublímite propio
 */
const TABLA: Record<Plan, Record<TypeLimitedCampaign, false | number | null>> = {
  FREE: { BXGY: false, TIERED: false, PACK: false },
  LITE: { BXGY: 4, TIERED: 2, PACK: false },
  ESSENTIAL: { BXGY: 10, TIERED: 10, PACK: null },
  PROFESSIONAL: { BXGY: null, TIERED: null, PACK: null },
};

const TIPOS: TypeLimitedCampaign[] = ["BXGY", "TIERED", "PACK"];

test("la regla de cada plan coincide con la tabla de planes decidida", () => {
  for (const plan of PLANS) {
    for (const tipo of TIPOS) {
      const esperado = TABLA[plan][tipo];
      const regla = reglaDeTipo(plan, tipo);

      if (esperado === false) {
        assert.equal(
          regla.incluido,
          false,
          `${plan} NO debería incluir ${tipo}`
        );
      } else {
        assert.equal(regla.incluido, true, `${plan} debería incluir ${tipo}`);
        if (regla.incluido)
          assert.equal(
            regla.max,
            esperado,
            `${plan}/${tipo}: máximo esperado ${esperado}`
          );
      }
    }
  }
});

test("🔴 FREE no incluye ningún tipo de pago (era el agujero)", () => {
  // Antes del 2026-09-05, FREE tenía `maxBxgy: null` y las rutas leían ese
  // `null` como "sin límite" → se saltaban la comprobación entera. Una tienda
  // del plan gratuito podía crear y activar BxGy y Escalonados.
  for (const tipo of TIPOS) {
    assert.equal(reglaDeTipo("FREE", tipo).incluido, false, tipo);
  }
});

test("los packs empiezan en ESSENTIAL", () => {
  assert.equal(reglaDeTipo("FREE", "PACK").incluido, false);
  assert.equal(reglaDeTipo("LITE", "PACK").incluido, false);
  assert.equal(reglaDeTipo("ESSENTIAL", "PACK").incluido, true);
  assert.equal(reglaDeTipo("PROFESSIONAL", "PACK").incluido, true);
});

test('"no incluido" y "incluido sin tope" son estados DISTINTOS', () => {
  // Es la distinción que el modelo viejo no podía expresar: los dos eran `null`.
  const noIncluido = reglaDeTipo("LITE", "PACK");
  const sinTope = reglaDeTipo("PROFESSIONAL", "PACK");

  assert.equal(noIncluido.incluido, false);
  assert.equal(sinTope.incluido, true);
  if (sinTope.incluido) assert.equal(sinTope.max, null);
});

test("PERCENTAGE y RANGE no pasan por el eje de tipo", () => {
  // Están en todos los planes y se topan por variantes, que es otro eje.
  assert.equal(esTipoLimitadoPorPlan("PERCENTAGE"), false);
  assert.equal(esTipoLimitadoPorPlan("RANGE"), false);
  assert.equal(esTipoLimitadoPorPlan("BXGY"), true);
  assert.equal(esTipoLimitadoPorPlan("TIERED"), true);
  assert.equal(esTipoLimitadoPorPlan("PACK"), true);
  assert.equal(esTipoLimitadoPorPlan("INVENTADO"), false);
});

test("todo plan define regla para TODOS los tipos limitados", () => {
  // Un tipo nuevo que se olvide en un plan haría que `reglaDeTipo` devolviera
  // undefined y la puerta dejara pasar todo. Esto lo caza en el acto.
  for (const plan of PLANS) {
    for (const tipo of TIPOS) {
      assert.ok(
        PLAN_LIMITS[plan].types[tipo] !== undefined,
        `${plan} no define regla para ${tipo}`
      );
    }
  }
});

test("los sublímites de LITE no son alcanzables a la vez, y no es un bug", () => {
  // 4 BxGy + 2 escalonadas = 6 > 5 campañas generales. El tope general se agota
  // antes. Está documentado desde el 2026-07-26 y el test lo fija para que
  // nadie lo "arregle" subiendo el general sin querer.
  const lite = reglaDeTipo("LITE", "BXGY");
  const liteT = reglaDeTipo("LITE", "TIERED");
  assert.ok(lite.incluido && liteT.incluido);
  if (lite.incluido && liteT.incluido)
    assert.ok(lite.max! + liteT.max! > PLAN_LIMITS.LITE.campaigns);
});
