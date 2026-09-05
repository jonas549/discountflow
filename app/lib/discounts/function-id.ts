// Descubrimiento del ID de nuestras Shopify Functions en una tienda.
//
// No se hardcodea porque la app de dev y la de producción tienen IDs distintos,
// y porque el id cambia entre instalaciones.
//
// ─── Por qué este archivo existe ─────────────────────────────────────────────
//
// Hasta 2026-09 la app tenía UNA sola Function (`tiered-discount`) y el
// emparejamiento vivía dentro de `tiered.ts` con dos redes de seguridad:
//
//     byTitle  →  "la única Function de descuento"  →  "la única Function"
//
// Con la llegada de `pack-discount` esas dos redes dejan de servir: hay dos
// Functions de descuento instaladas, así que ninguna de las dos condiciones se
// cumple nunca. Peor: si se dejaran activas y alguna vez casaran, podrían
// enganchar una campaña de packs al Wasm de escalonados. El síntoma sería una
// campaña que la app muestra ACTIVA y que en el checkout no descuenta nada —
// exactamente el fallo silencioso que este proyecto ya pagó en julio.
//
// La regla que se aplica acá: **fallar fuerte y temprano vale más que acertar
// por casualidad.** Un error al crear la campaña lo ve el merchant y lo reporta;
// una campaña muda cuesta dinero sin que nadie se entere.

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

/** Handles de las extensiones, tal como figuran en sus `shopify.extension.toml`. */
export const TIERED_FUNCTION_HANDLE = "tiered-discount";
export const PACK_FUNCTION_HANDLE = "pack-discount";

type ShopifyFunctionNode = { id: string; title: string; apiType: string };

/**
 * El título que Shopify guarda sale del `name` de `locales/en.default.json` de
 * la extensión. Lo normalizamos igual que antes (minúsculas, espacios y guiones
 * bajos a guiones) para que "Tiered Discount" y "tiered_discount" casen con el
 * handle.
 */
function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "").toLowerCase().trim().replace(/[\s_]+/g, "-");
}

export async function getDiscountFunctionId(
  admin: AdminClient,
  handle: string,
  options: {
    /**
     * Acepta "la única Function de descuento instalada" cuando el título no
     * casa.
     *
     * 🔴 Solo para `tiered-discount`, y solo para no cambiar el comportamiento
     * que hoy corre en producción: una tienda que tenga instalada únicamente la
     * Function de escalonados sigue funcionando aunque su título no coincida
     * exactamente. Para `pack-discount` va en `false` — una Function nueva
     * nunca debe adivinar, porque adivinar mal significa enganchar la campaña al
     * Wasm equivocado.
     */
    allowSingleFunctionFallback: boolean;
  }
): Promise<string> {
  const res = await admin.graphql(
    `#graphql
    query DiscountFunctionId {
      shopifyFunctions(first: 50) {
        nodes { id title apiType }
      }
    }`
  );
  const json = await res.json();

  if (json.errors?.length)
    throw new Error(
      `No se pudieron listar las Functions: ${json.errors
        .map((e: { message: string }) => e.message)
        .join(", ")}`
    );

  const nodes: ShopifyFunctionNode[] = json.data?.shopifyFunctions?.nodes ?? [];
  const objetivo = normalizeTitle(handle);

  const porTitulo = nodes.filter((n) => normalizeTitle(n.title) === objetivo);

  if (porTitulo.length === 1) return porTitulo[0].id;

  // Dos Functions con el mismo título es un estado imposible de resolver bien:
  // elegir una al azar enganchará la mitad de las campañas al Wasm equivocado.
  if (porTitulo.length > 1)
    throw new Error(
      `Hay ${porTitulo.length} Functions instaladas con el título "${handle}". ` +
        "No se puede saber cuál corresponde. Revisá las versiones de la app en el Partner Dashboard."
    );

  const deDescuento = nodes.filter((n) =>
    (n.apiType ?? "").toLowerCase().includes("discount")
  );

  if (options.allowSingleFunctionFallback && deDescuento.length === 1) {
    console.warn(
      `[function-id] "${handle}" no casó por título; se usa la única Function de descuento ` +
        `instalada ("${deDescuento[0].title}"). Si la app tiene más de una Function, ` +
        "esto dejará de funcionar: revisá el name de locales/en.default.json."
    );
    return deDescuento[0].id;
  }

  const encontradas = nodes.length
    ? ` Functions encontradas: ${nodes
        .map((n) => `"${n.title}" (${n.apiType})`)
        .join(", ")}.`
    : " No hay ninguna Function instalada en la tienda.";

  throw new Error(
    `No se encontró la Function "${handle}" en esta tienda. ` +
      "¿Está corriendo `shopify app dev` (o se desplegó con `shopify app deploy`)?" +
      encontradas
  );
}
