/**
 * Crea un descuento de VALOR DE CARRITO en la tienda de desarrollo, sin pasar
 * por el admin de la app.
 *
 * ─── Por qué existe ─────────────────────────────────────────────────────────
 *
 * F1 entrega la Function, no las pantallas. Con packs esperamos hasta tener el
 * widget para que Jonas pudiera probar algo, y eso significó construir el admin
 * entero sobre una Function sin verificar. Acá no hace falta: un descuento de
 * valor de carrito se ve en el carrito, sin interfaz. Este script es lo que
 * permite adelantar la verificación a F1.
 *
 * ⚠️ SOLO DEV. Tiene una guardia que lo aborta si la base tiene más de una
 * tienda, que es la señal de que apunta a producción.
 *
 * Uso:
 *   node --env-file=.env scripts/dev-crear-descuento-valor-carrito.mjs
 *   node --env-file=.env scripts/dev-crear-descuento-valor-carrito.mjs --borrar
 */

import { PrismaClient } from "@prisma/client";

const NIVELES = [
  { minSubtotal: 50, amount: 10 },
  { minSubtotal: 100, amount: 25 },
  { minSubtotal: 200, amount: 70 },
];

const CONFIG = {
  valueType: "AMOUNT",
  tiers: NIVELES,
  message: "Descuento por monto de compra",
};

const TITULO = "[DiscountFlow · PRUEBA F1] Valor de carrito";
const API = "2025-10";

const prisma = new PrismaClient();

async function gql(shop, token, query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length)
    throw new Error("GraphQL: " + json.errors.map((e) => e.message).join(", "));
  return json.data;
}

async function main() {
  // ── Guardia dev-vs-prod, la misma que usa el resto del proyecto ──
  const tiendas = await prisma.shop.count();
  if (tiendas !== 1) {
    console.error(
      `\n🔴 ABORTADO: la base tiene ${tiendas} tiendas. Dev tiene 1 y producción 6.\n` +
        "   Este script NO se ejecuta contra producción.\n"
    );
    process.exit(1);
  }

  const sesion = await prisma.session.findFirst();
  if (!sesion) throw new Error("No hay sesión: instalá la app en la dev store.");
  const { shop, accessToken } = sesion;
  console.log("Tienda:", shop);

  // ── Localizar la Function ──
  const fns = await gql(
    shop,
    accessToken,
    `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
  );
  const nodos = fns.shopifyFunctions?.nodes ?? [];
  const fn = nodos.find(
    (n) => (n.title ?? "").toLowerCase().replace(/[\s_]+/g, "-") === "order-discount"
  );
  if (!fn) {
    console.error(
      "\n🔴 No se encontró la Function 'order-discount' en la tienda.\n" +
        "   ¿Está corriendo `shopify app dev`?\n" +
        "   Functions vistas: " +
        nodos.map((n) => `"${n.title}"`).join(", ") +
        "\n"
    );
    process.exit(1);
  }
  console.log("Function:", fn.id);

  // ── Borrar el descuento de prueba anterior, si lo hay ──
  const existentes = await gql(
    shop,
    accessToken,
    `query { discountNodes(first: 50) { nodes { id discount { ... on DiscountAutomaticApp { title } } } } }`
  );
  for (const n of existentes.discountNodes?.nodes ?? []) {
    if (n.discount?.title === TITULO) {
      await gql(
        shop,
        accessToken,
        `mutation D($id: ID!) { discountAutomaticDelete(id: $id) { userErrors { message } } }`,
        { id: n.id }
      );
      console.log("Descuento de prueba anterior borrado:", n.id);
    }
  }

  if (process.argv.includes("--borrar")) {
    console.log("\n✅ Listo: solo se borró. No se creó ninguno nuevo.\n");
    return;
  }

  // ── Crear ──
  const creado = await gql(
    shop,
    accessToken,
    `mutation Crear($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      discount: {
        title: TITULO,
        functionId: fn.id,
        startsAt: new Date().toISOString(),
        // 🔴 ORDER, no PRODUCT. Es la diferencia con las otras dos Functions de
        // la app, y si estuviera mal el descuento no aplicaría nada en silencio.
        discountClasses: ["ORDER"],
        combinesWith: {
          orderDiscounts: false,
          // 🔴 EN TRUE A PROPÓSITO PARA ESTA PRUEBA.
          // La pregunta de F1 es si un descuento de ORDEN convive con uno de
          // PRODUCTO (un pack o un escalonado) en el mismo carrito. Con esto en
          // `false` la respuesta estaría decidida de antemano y la prueba no
          // mediría nada.
          productDiscounts: true,
          shippingDiscounts: false,
        },
        metafields: [
          {
            namespace: "discountflow",
            key: "cart-value-config",
            type: "json",
            value: JSON.stringify(CONFIG),
          },
        ],
      },
    }
  );

  const errores = creado.discountAutomaticAppCreate?.userErrors ?? [];
  if (errores.length) {
    console.error("\n🔴 Shopify rechazó la creación:");
    for (const e of errores) console.error("   ·", e.field, e.message);
    process.exit(1);
  }

  console.log(
    "\n✅ Descuento creado:",
    creado.discountAutomaticAppCreate.automaticAppDiscount.discountId
  );
  console.log("\nNiveles configurados:");
  for (const n of NIVELES) console.log(`   · desde $${n.minSubtotal} → $${n.amount} off`);
  console.log("\nProbalo en el carrito de la tienda. Para quitarlo:");
  console.log("   node --env-file=.env scripts/dev-crear-descuento-valor-carrito.mjs --borrar\n");
}

main()
  .catch((e) => {
    console.error("\n🔴", e.message, "\n");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
