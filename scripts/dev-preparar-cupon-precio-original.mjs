/**
 * Deja la tienda de desarrollo lista para probar F1 del cupón sobre precio
 * original, y lo deshace cuando haga falta.
 *
 * ─── Por qué existe ─────────────────────────────────────────────────────────
 *
 * F1 entrega la Function, no las pantallas. Para probarla hacen falta dos cosas
 * que no existen en la tienda de dev:
 *
 *   1. Un producto REBAJADO con precio comparativo. Es el escenario entero: sin
 *      un `compareAtPrice` mayor que el precio, no hay precio original que
 *      recuperar y el cupón se comporta como uno normal. Se monta el caso del
 *      brief tal cual: $100 de lista, $85 hoy.
 *   2. El descuento de código que apunta a la Function.
 *
 * ⚠️ SOLO DEV. Aborta si la base tiene más de una tienda, que es la señal de que
 * apunta a producción.
 *
 * Uso:
 *   node --env-file=.env scripts/dev-preparar-cupon-precio-original.mjs
 *   node --env-file=.env scripts/dev-preparar-cupon-precio-original.mjs --borrar
 *
 * `--borrar` quita el descuento Y devuelve el producto a su precio anterior,
 * que queda guardado en `scripts/dev-estado-cupon.json` al preparar.
 */

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const API = "2025-10";
const CODIGO = "INFLU10";
const PORCENTAJE = 10;
const TITULO = "[DiscountFlow · PRUEBA F1] Cupón sobre precio original";

/** El caso del brief, exacto: $100 de lista, $85 hoy. */
const PRECIO_REBAJADO = "85.00";
const PRECIO_ORIGINAL = "100.00";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVO_ESTADO = join(raiz, "scripts/dev-estado-cupon.json");
const prisma = new PrismaClient();

async function gql(shop, token, query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();

  // 🔴 `errors` NO SIEMPRE ES UN ARRAY: con un token vencido Shopify devuelve
  // una cadena. El `.map` de la primera versión de este patrón reventaba y
  // tapaba el error de verdad detrás del fallo del manejador de errores.
  if (json.errors) {
    if (res.status === 401)
      throw new Error(
        "El token de la tienda de dev está vencido (HTTP 401). Corré " +
          "`shopify app dev` y abrí la app una vez para renovarlo."
      );
    const detalle = Array.isArray(json.errors)
      ? json.errors.map((e) => e.message).join(", ")
      : String(json.errors);
    throw new Error(`GraphQL (HTTP ${res.status}): ${detalle}`);
  }
  if (!json.data)
    throw new Error(
      `Respuesta sin datos (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`
    );
  return json.data;
}

function sinErrores(resultado, raiz) {
  const errs = resultado[raiz]?.userErrors ?? [];
  if (errs.length) throw new Error(`${raiz}: ${JSON.stringify(errs)}`);
  return resultado[raiz];
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

  const tienda = await prisma.shop.findFirst({
    select: { domain: true, accessToken: true },
  });
  const sesion = await prisma.session.findFirst({
    where: { shop: tienda.domain },
    orderBy: { expires: "desc" },
  });
  const shop = tienda.domain;
  const token = sesion?.accessToken || tienda.accessToken;
  if (!token) throw new Error("No hay sesión: instalá la app en la dev store.");
  console.log("Tienda:", shop);

  const borrar = process.argv.includes("--borrar");

  // ── Quitar el descuento de prueba anterior, si lo hay ──
  const existentes = await gql(
    shop,
    token,
    `query { discountNodes(first: 50) { nodes { id discount { ... on DiscountCodeApp { title } } } } }`
  );
  for (const n of existentes.discountNodes?.nodes ?? []) {
    if (n.discount?.title === TITULO) {
      await gql(
        shop,
        token,
        `mutation D($id: ID!) { discountCodeDelete(id: $id) { userErrors { message } } }`,
        { id: n.id }
      );
      console.log("Descuento de prueba anterior borrado:", n.id);
    }
  }

  // ── Restaurar el precio del producto ──
  if (borrar) {
    if (!fs.existsSync(ARCHIVO_ESTADO)) {
      console.log(
        "\nNo hay estado guardado: el producto no se toca.\n" +
          "✅ Listo: solo se borró el descuento.\n"
      );
      return;
    }
    const previo = JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, "utf8"));
    await gql(
      shop,
      token,
      `mutation R($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
         productVariantsBulkUpdate(productId: $productId, variants: $variants) {
           userErrors { field message }
         }
       }`,
      {
        productId: previo.productId,
        variants: [
          {
            id: previo.variantId,
            price: previo.price,
            compareAtPrice: previo.compareAtPrice,
          },
        ],
      }
    );
    fs.unlinkSync(ARCHIVO_ESTADO);
    console.log(
      `Producto restaurado: "${previo.title}" vuelve a ${previo.price} ` +
        `(comparativo ${previo.compareAtPrice ?? "ninguno"}).`
    );
    console.log("\n✅ Listo: todo deshecho.\n");
    return;
  }

  // ── 1. El producto rebajado ──
  //
  // Se elige el PRIMERO por título para que la elección sea determinista y el
  // script sea idempotente: correrlo dos veces toca el mismo producto.
  const prods = await gql(
    shop,
    token,
    `query { products(first: 1, sortKey: TITLE) {
       nodes { id title handle onlineStoreUrl
               variants(first: 1) { nodes { id price compareAtPrice } } } } }`
  );
  const producto = prods.products.nodes[0];
  const variante = producto?.variants?.nodes?.[0];
  if (!variante) throw new Error("La tienda de dev no tiene ningún producto con variantes.");

  // El estado previo se guarda ANTES de tocar nada, para que `--borrar` no
  // tenga que adivinar a qué precio volver.
  if (!fs.existsSync(ARCHIVO_ESTADO)) {
    fs.writeFileSync(
      ARCHIVO_ESTADO,
      JSON.stringify(
        {
          productId: producto.id,
          variantId: variante.id,
          title: producto.title,
          price: variante.price,
          compareAtPrice: variante.compareAtPrice,
        },
        null,
        2
      )
    );
  }

  await gql(
    shop,
    token,
    `mutation P($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         userErrors { field message }
       }
     }`,
    {
      productId: producto.id,
      variants: [
        {
          id: variante.id,
          price: PRECIO_REBAJADO,
          compareAtPrice: PRECIO_ORIGINAL,
        },
      ],
    }
  );
  console.log(
    `Producto preparado: "${producto.title}" → $${PRECIO_REBAJADO} ` +
      `(antes $${PRECIO_ORIGINAL})`
  );

  // ── 2. La Function ──
  const fns = await gql(
    shop,
    token,
    `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
  );
  const nodos = fns.shopifyFunctions?.nodes ?? [];
  const fn = nodos.find(
    (n) => (n.title ?? "").toLowerCase().replace(/[\s_]+/g, "-") === "code-original-price"
  );
  if (!fn) {
    console.error(
      "\n🔴 No se encontró la Function 'code-original-price' en la tienda.\n" +
        "   Es una extensión NUEVA: `shopify app dev` tiene que estar corriendo\n" +
        "   para registrarla. Functions vistas: " +
        nodos.map((n) => `"${n.title}"`).join(", ") +
        "\n"
    );
    process.exit(1);
  }
  console.log("Function:", fn.id);

  // ── 3. El descuento de código ──
  const creado = await gql(
    shop,
    token,
    `mutation Crear($codeAppDiscount: DiscountCodeAppInput!) {
       discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
         codeAppDiscount { discountId }
         userErrors { field message }
       }
     }`,
    {
      codeAppDiscount: {
        title: TITULO,
        functionId: fn.id,
        code: CODIGO,
        startsAt: new Date().toISOString(),
        // 🔴 PRODUCT: el cupón descuenta líneas, no el subtotal. La Function lo
        // comprueba y se niega si no coincide.
        discountClasses: ["PRODUCT"],
        // Que Shopify no descarte nada por su cuenta. Quién gana lo decide el
        // merchant con la exclusión entre campañas, que se evalúa dentro de la
        // Function y deja el motivo en el log. Es la lección del carrito mixto.
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: false,
        },
        metafields: [
          {
            namespace: "discountflow",
            key: "original-price-config",
            type: "json",
            value: JSON.stringify({
              percent: PORCENTAJE,
              message: "Descuento sobre el precio original",
              excludeIfPackIds: [],
            }),
          },
        ],
      },
    }
  );
  const id = sinErrores(creado, "discountCodeAppCreate").codeAppDiscount?.discountId;
  console.log("Descuento creado:", id);

  const url = producto.onlineStoreUrl || `(tienda)/products/${producto.handle}`;

  console.log(`
✅ Listo para probar.

   Producto : ${producto.title}
              ${url}
              $${PRECIO_REBAJADO} hoy · $${PRECIO_ORIGINAL} de lista

   Cupón    : ${CODIGO}  (${PORCENTAJE}% sobre el precio original)

   En el carrito, con ese producto y el cupón aplicado:
     · Un cupón normal de Shopify daría $8,50 y dejaría la línea en $76,50.
     · Éste tiene que dar $10 y dejarla en $75.

   Para deshacerlo todo:
     node --env-file=.env scripts/dev-preparar-cupon-precio-original.mjs --borrar
`);
}

main()
  .catch((err) => {
    console.error("\n🔴", err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
