// Lo que la pantalla de planes PROMETE tiene que ser lo que `PLAN_LIMITS` HACE.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ EXISTE
//
// Durante semanas los cuatro planes dijeron "Porcentaje, Rango de precio,
// BxGy". Cuando F4 cerró el agujero de los límites por tipo, el plan GRATIS
// dejó de incluir BxGy — y el texto no se enteró. La pantalla que un merchant
// lee ANTES DE PAGAR estuvo prometiendo un tipo de campaña que no iba a poder
// crear.
//
// Nadie lo vio porque no había nada que lo mirara: la tabla vive en
// `plan-limits.ts` y el texto en `app.plans.tsx`, y no se hablaban. Esto los
// hace hablarse.
//
// Lo que NO puede comprobar: que el texto esté bien escrito, ni que las
// promesas de analítica y soporte signifiquen algo (hoy no: no hay gating por
// plan en ninguna de las dos). Lo que sí: que ningún plan nombre un tipo que no
// incluye, y que los números de la pantalla sean los de la tabla.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  PLAN_LIMITS,
  PLANS,
  reglaDeTipo,
  type Plan,
  type TypeLimitedCampaign,
} from "./plan-limits.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");

/** El texto de la pantalla, normalizado: un `git checkout` puede dejarlo CRLF. */
const fuente = fs
  .readFileSync(path.join(RAIZ, "app/routes/app.plans.tsx"), "utf8")
  .split(String.fromCharCode(13) + String.fromCharCode(10))
  .join(String.fromCharCode(10));

/** Las líneas que se le muestran a un plan, sacadas del literal `FEATURES`. */
function lineasDe(plan: Plan): string[] {
  const bloque = fuente.slice(fuente.indexOf("const FEATURES"));
  const desde = bloque.indexOf(`${plan}: [`);
  assert.ok(desde > 0, `no se halló el bloque de ${plan} en FEATURES`);
  const hasta = bloque.indexOf("],", desde);
  return [...bloque.slice(desde, hasta).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Cómo se nombra cada tipo en la pantalla. Si un plan NO lo incluye, no puede
 *  aparecer ninguna de estas palabras en su tarjeta. */
const NOMBRES: Record<TypeLimitedCampaign, RegExp> = {
  BXGY: /BxGy/i,
  TIERED: /Escalonad/i,
  PACK: /Pack/i,
  CART_VALUE: /Monto de compra/i,
  CODE_ORIGINAL_PRICE: /Cup[oó]n/i,
};

/** Las claves, con su tipo real: `Object.keys` las devuelve como `string`. */
const TIPOS = Object.keys(NOMBRES) as TypeLimitedCampaign[];

test("🔴 ningún plan puede nombrar un tipo de campaña que NO incluye", () => {
  // Es el bug exacto que se coló: GRATIS anunciando BxGy después de F4.
  for (const plan of PLANS as readonly Plan[]) {
    const texto = lineasDe(plan).join(" · ");
    for (const tipo of TIPOS) {
      // `reglaDeTipo` es el accesor oficial: se usa el mismo que la app, no una
      // lectura paralela de la tabla que pueda desincronizarse.
      if (reglaDeTipo(plan, tipo).incluido) continue;
      assert.doesNotMatch(
        texto,
        NOMBRES[tipo],
        `${plan} NO incluye ${tipo} y su tarjeta lo nombra: "${texto}"`
      );
    }
  }
});

test("los números de la tarjeta son los de PLAN_LIMITS", () => {
  for (const plan of PLANS as readonly Plan[]) {
    const texto = lineasDe(plan).join(" · ");
    const limites = PLAN_LIMITS[plan];

    // Las campañas van sin separador de miles (2, 5, 50, 100).
    assert.match(
      texto,
      new RegExp(`\\b${limites.campaigns} campañas`),
      `${plan}: la tarjeta no dice sus ${limites.campaigns} campañas`
    );

    // Las variantes pueden llevar punto de millar: 50, 750, 6.000, 10.000.
    const conPunto = limites.variants.toLocaleString("es-CL");
    const variantesOk =
      texto.includes(`${limites.variants} variantes`) ||
      texto.includes(`${conPunto} variantes`);
    assert.ok(
      variantesOk,
      `${plan}: la tarjeta no dice sus ${limites.variants} variantes`
    );
  }
});

test("si un tipo tiene tope propio, la tarjeta lo dice", () => {
  // Un merchant que paga LITE leyendo "BxGy" concluye que puede crear los que
  // le entren en sus 5 campañas. Puede crear 4. El número tiene que estar.
  for (const plan of PLANS as readonly Plan[]) {
    const texto = lineasDe(plan).join(" · ");
    for (const tipo of TIPOS) {
      const regla = reglaDeTipo(plan, tipo);
      // El `if` estrecha el tipo: `max` solo existe cuando está incluido.
      if (!regla.incluido) continue;
      if (regla.max === null) continue;
      const max = regla.max;
      assert.ok(
        texto.includes(String(max)),
        `${plan}: ${tipo} topa en ${max} y la tarjeta no lo menciona: "${texto}"`
      );
    }
  }
});

test("GRATIS ofrece exactamente los dos tipos que no dependen del plan", () => {
  // Porcentaje y Rango no pasan por la puerta por tipo (`esTipoLimitadoPorPlan`
  // los deja fuera): existen en todos los planes, acotados solo por el tope
  // general de campañas. Son los únicos que GRATIS puede ofrecer.
  const texto = lineasDe("FREE").join(" · ");
  assert.match(texto, /Porcentaje/i);
  assert.match(texto, /Rango/i);
});
