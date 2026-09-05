/**
 * Escribe en la tienda de desarrollo el metafield que lee el bloque de tema, y
 * lo vuelve a leer para probar que quedó.
 *
 * ─── Por qué existe ─────────────────────────────────────────────────────────
 *
 * El metafield lo escribe la app sola en cada guardado, activación, pausa y
 * borrado de una campaña de pack. Pero las campañas que ya existen se guardaron
 * ANTES de que eso existiera, así que su metafield no está escrito: el bloque
 * caería al app proxy y seguiría mostrando «Cargando tu pack…».
 *
 * Este script lo siembra sin tener que tocar el admin. Y hace algo que el admin
 * no hace: LO LEE DE VUELTA y lo imprime, que es la única forma de saber si
 * Shopify aceptó la escritura en el namespace reservado `$app:`.
 *
 * ⚠️ SOLO DEV. Aborta si la base tiene más de una tienda, que es la señal de que
 * apunta a producción.
 *
 * Uso:
 *   node --env-file=.env scripts/dev-sincronizar-metafield-pack.mjs
 */

import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";

const API = "2025-10";
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prisma = new PrismaClient();

async function gql(shop, token, query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  // `errors` no siempre es un array: con un token invalido o un scope que falta,
  // Shopify devuelve una cadena. Tragarse esa diferencia deja un error mudo.
  if (json.errors) {
    const detalle = Array.isArray(json.errors)
      ? json.errors.map((e) => e.message).join(", ")
      : JSON.stringify(json.errors);
    if (res.status === 401)
      throw new Error(
        "El token de la tienda de dev esta vencido (HTTP 401). " +
          "Corre `shopify app dev`, abri la app una vez, y volve a lanzar este " +
          "script. Alternativa sin script: guardar la campana de pack desde el " +
          "admin de la app escribe el metafield por el mismo camino."
      );
    throw new Error(`GraphQL (HTTP ${res.status}): ${detalle}`);
  }
  if (!json.data) throw new Error(`Respuesta sin datos (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 400)}`);
  return json.data;
}

/**
 * Compila los módulos de la app y los carga.
 *
 * 🔴 Es a propósito, y no una copia del código: si este script armara el
 * metafield por su cuenta, probaría algo distinto de lo que hace la app. Lo que
 * se quiere verificar es EL MISMO camino.
 */
async function cargarModulos() {
  // Dentro del repo y no en el temp del sistema: el bundle deja `@prisma/client`
  // como externo, y desde fuera del proyecto Node no sabe resolverlo.
  const entrada = join(raiz, `.df-tmp-entrada-${process.pid}.ts`);
  const salida = join(raiz, `.df-tmp-metafield-${process.pid}.mjs`);
  fs.writeFileSync(
    entrada,
    'export { packsActivosDeLaTienda } from "' +
      join(raiz, "app/lib/discounts/pack-widget-payload.server").replace(/\\/g, "/") +
      '";\n' +
      'export { construirMetafieldDeWidget } from "' +
      join(raiz, "app/lib/discounts/pack-widget-metafield").replace(/\\/g, "/") +
      '";\n'
  );
  await build({
    entryPoints: [entrada],
    bundle: true,
    outfile: salida,
    format: "esm",
    platform: "node",
    target: ["node20"],
    packages: "external",
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(salida).href);
  fs.unlinkSync(entrada);
  fs.unlinkSync(salida);
  return mod;
}

async function main() {
  // ── Guardia dev-vs-prod, la misma que usa el resto del proyecto ──
  const tiendas = await prisma.shop.count();
  if (tiendas !== 1) {
    console.error(
      `\n🔴 ABORTADO: la base tiene ${tiendas} tiendas. Dev tiene 1 y producción 6.\n` +
        "   Este script solo puede correr contra la base de desarrollo.\n"
    );
    process.exit(1);
  }

  const shop = await prisma.shop.findFirst({
    select: { id: true, domain: true, accessToken: true, currency: true },
  });
  if (!shop) throw new Error("No hay ninguna tienda en la base de dev.");

  // 🔴 El token bueno esta en `Session`, no en `Shop`.
  //
  // `Shop.accessToken` de dev quedo con el token de una instalacion anterior y
  // devuelve 401. El que renueva el framework en cada `shopify app dev` es el de
  // la tabla `Session`. Se prefiere ese y `Shop` queda como respaldo.
  const sesion = await prisma.session.findFirst({
    where: { shop: shop.domain },
    orderBy: { expires: "desc" },
    select: { accessToken: true },
  });
  const token = sesion?.accessToken || shop.accessToken;
  if (!token) throw new Error("La tienda de dev no tiene ningun accessToken guardado.");

  const { packsActivosDeLaTienda, construirMetafieldDeWidget } = await cargarModulos();
  const payloads = await packsActivosDeLaTienda(shop.id, shop.currency);
  const valor = construirMetafieldDeWidget(payloads);

  console.log(`\nTienda: ${shop.domain}`);
  console.log(`Packs activos: ${Object.keys(valor.packs).length}`);
  for (const [id, p] of Object.entries(valor.packs))
    console.log(`  · ${id} — "${p.heading}" — ${p.items.length} productos`);
  if (!Object.keys(valor.packs).length)
    console.log("  (ninguno: el bloque va a caer al app proxy)");

  // ── 1. La definición, con acceso público de storefront ──
  const def = await gql(
    shop.domain,
    token,
    `mutation ($definition: MetafieldDefinitionInput!) {
       metafieldDefinitionCreate(definition: $definition) {
         createdDefinition { id namespace key }
         userErrors { code field message }
       }
     }`,
    {
      definition: {
        name: "DiscountFlow · configuración del widget de packs",
        namespace: "$app:discountflow",
        key: "pack_widget",
        ownerType: "SHOP",
        type: "json",
        access: { storefront: "PUBLIC_READ" },
      },
    }
  );
  const errDef = def.metafieldDefinitionCreate.userErrors.filter((e) => e.code !== "TAKEN");
  if (errDef.length) throw new Error("Definición: " + JSON.stringify(errDef));
  console.log(
    def.metafieldDefinitionCreate.createdDefinition
      ? "\n✓ definición creada"
      : "\n✓ la definición ya existía"
  );

  // ── 2. El valor ──
  const { shop: tienda } = await gql(shop.domain, token, "{ shop { id } }");
  const set = await gql(
    shop.domain,
    token,
    `mutation ($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) {
         metafields { id namespace key }
         userErrors { field message }
       }
     }`,
    {
      metafields: [
        {
          ownerId: tienda.id,
          namespace: "$app:discountflow",
          key: "pack_widget",
          type: "json",
          value: JSON.stringify(valor),
        },
      ],
    }
  );
  if (set.metafieldsSet.userErrors.length)
    throw new Error("metafieldsSet: " + JSON.stringify(set.metafieldsSet.userErrors));
  console.log("✓ metafield escrito");

  // ── 3. 🔴 Leerlo de vuelta. Sin esto no se sabe si Shopify lo aceptó ──
  const leido = await gql(
    shop.domain,
    token,
    `{ shop { metafield(namespace: "$app:discountflow", key: "pack_widget") {
         id type value
       } } }`
  );
  const mf = leido.shop.metafield;
  if (!mf) {
    console.error("\n🔴 El metafield NO se puede leer de vuelta. Algo lo rechazó.");
    process.exit(1);
  }
  const vuelta = JSON.parse(mf.value);
  const igual = JSON.stringify(vuelta) === JSON.stringify(valor);
  console.log(`✓ leído de vuelta · ${mf.type} · ${mf.value.length} bytes`);
  console.log(igual ? "✓ el contenido coincide" : "🔴 el contenido NO coincide");

  // 🔴 El build se LEE del bloque, no se escribe a mano acá: un número copiado
  // se queda viejo al primer cambio y manda a buscar algo que ya no existe.
  const bloque = fs.readFileSync(
    join(raiz, "extensions/pack-widget/blocks/pack-builder.liquid"),
    "utf8"
  );
  const build = (bloque.match(/data-df-build="(\d+)"/) || [])[1] ?? "?";

  console.log(
    "\nAhora, en la tienda de dev, Ctrl+U sobre la página del pack y buscá\n" +
      `«DiscountFlow». Tiene que decir BUILD ${build} y metafield = app.metafields\n` +
      "(o shop.metafields). Si dice «ninguna», Liquid no lo está viendo.\n"
  );
}

main()
  .catch((err) => {
    console.error("\n🔴", err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
