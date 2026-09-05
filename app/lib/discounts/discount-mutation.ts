// Ejecutor común de mutaciones de descuento.
//
// Vivía dentro de `tiered.ts`. Se movió acá SIN cambiar una línea de su cuerpo
// el 2026-09-05, cuando `pack.ts` necesitó exactamente la misma disciplina.
// Tener dos copias de "cómo se detecta que Shopify falló" es cómo se empieza a
// tragar errores otra vez: este repo ya arregló ese patrón cuatro veces
// (`bulkUpdateVariantPrices`, `runDiscountMutation`, `readQueryData` y
// `currentAppInstallation`), y las cuatro eran el mismo `?? []` convirtiendo un
// fallo en "no hay nada".

export type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

/**
 * Ejecuta una mutación y NO deja pasar ningún fallo en silencio.
 *
 * Hay tres formas distintas de fallar y hay que mirar las tres:
 *   1. `json.errors`  → la consulta ni se ejecutó (campo o mutación que no
 *      existe en esta versión de la API). Shopify devuelve `data: null`.
 *   2. `json.data[root]` ausente → respuesta inesperada.
 *   3. `userErrors`   → la consulta corrió pero Shopify rechazó los datos.
 *
 * Mirar solo (3) hace que un fallo de tipo (1) se trague sin excepción: la app
 * redirige como si todo hubiera ido bien mientras en Shopify no ha cambiado
 * nada.
 */
export async function runDiscountMutation(
  admin: AdminClient,
  query: string,
  variables: unknown,
  root: string
): Promise<Record<string, unknown>> {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();

  if (json.errors?.length)
    throw new Error(
      `Shopify rechazó la consulta (${root}): ${json.errors
        .map((e: { message: string }) => e.message)
        .join(", ")}`
    );

  const result = json.data?.[root];
  if (!result)
    throw new Error(`Shopify no devolvió datos para ${root}.`);

  const userErrors = result.userErrors as Array<{ message: string }> | undefined;
  if (userErrors?.length)
    throw new Error(userErrors.map((e) => e.message).join(", "));

  return result;
}
