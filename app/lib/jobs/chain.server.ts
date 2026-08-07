// Cadena de auto-invocación: cómo un lote dispara el siguiente.
//
// ─────────────────────────────────────────────────────────────────────────────
//  🔴 POR QUÉ EL ORIGEN SE DERIVA DE LA PETICIÓN Y NUNCA DE UNA VARIABLE
// ─────────────────────────────────────────────────────────────────────────────
//
//  La fuente "obvia" para saber a qué URL llamarse a uno mismo sería
//  process.env.SHOPIFY_APP_URL. NO SE USA, y no es una cuestión de estilo:
//
//      .env (entorno de DESARROLLO) → SHOPIFY_APP_URL=https://discountflow-app.vercel.app
//
//  Es un valor de PRODUCCIÓN. `shopify app dev` reescribe la URL en el .toml pero
//  deja el .env intacto, así que la variable se queda apuntando al Vercel real. Un
//  motor que leyera esa variable haría que CADA LOTE DE CADA JOB DE PRUEBA EN LOCAL
//  golpease producción, con las campañas de clientes que pagan al otro lado. El
//  fallo no se ve venir: el código parece correcto y en producción funciona bien.
//
//  Por eso el origen sale SIEMPRE de la petición entrante:
//    - en local  → la URL del túnel de Cloudflare que levanta `shopify app dev`
//    - en Vercel → el dominio público real
//  Es autorreferencial por construcción: no se puede apuntar a otro sitio.
//
//  Y encima va el guardia de abajo, que es la red por si alguien reintroduce una
//  variable de entorno en esta ruta en el futuro.
// ─────────────────────────────────────────────────────────────────────────────

/** Host de producción. Solo se usa para PROHIBIRLO fuera de producción. */
const PRODUCTION_HOST = "discountflow-app.vercel.app";

export class ChainOriginError extends Error {
  readonly name = "ChainOriginError";
}

/**
 * Origen al que el worker se llama a sí mismo, derivado de la petición.
 *
 * Se prefieren las cabeceras x-forwarded-* porque tras el proxy de Vercel
 * request.url puede traer el host interno, mientras que esas cabeceras siempre
 * llevan el host público real.
 */
export function resolveWorkerOrigin(request: Request): string {
  const h = request.headers;
  const forwardedHost = h.get("x-forwarded-host") ?? h.get("host");
  const forwardedProto = h.get("x-forwarded-proto") ?? "https";

  const origin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : new URL(request.url).origin;

  const host = new URL(origin).host;

  // ── EL GUARDIA ──────────────────────────────────────────────────────────────
  // Si algo resolviera al host de producción sin estar en producción, es que
  // alguien volvió a colar una URL fija o una variable de entorno en esta ruta.
  // Se corta aquí: es preferible un job que falla con un mensaje explícito a un
  // job de desarrollo escribiendo en las tiendas de Greta y SkinUp.
  const isProductionRuntime = process.env.NODE_ENV === "production";
  if (!isProductionRuntime && host === PRODUCTION_HOST)
    throw new ChainOriginError(
      `Se ha impedido encadenar un lote contra el host de PRODUCCIÓN (${host}) ` +
        `desde un entorno que no es producción. El origen debe derivarse de la ` +
        `petición entrante, nunca de SHOPIFY_APP_URL ni de ninguna constante.`
    );

  // Un origen vacío o sin host no es utilizable: mejor fallar que construir una
  // URL relativa que acabe resolviendo en cualquier parte.
  if (!host)
    throw new ChainOriginError(
      "No se pudo determinar el origen de la petición para encadenar el siguiente lote."
    );

  return origin;
}

/**
 * Extiende la vida de la invocación hasta que la promesa termine.
 *
 * En Vercel hace falta waitUntil: un fetch disparado justo antes de responder se
 * cancelaría con la respuesta. En local no hace falta —el servidor de desarrollo es
 * un proceso largo y la promesa sobrevive sola—, y por eso el import es dinámico y
 * el fallo se traga: en local el paquete puede no comportarse igual y no debe
 * romper nada.
 */
export async function extendLifetime(promise: Promise<unknown>): Promise<void> {
  const swallowed = promise.catch((err) => {
    console.error("[jobs] fallo al encadenar el siguiente lote:", err);
  });
  try {
    const mod = await import("@vercel/functions");
    mod.waitUntil(swallowed);
  } catch {
    // Entorno local (o waitUntil no disponible): fire-and-forget normal.
  }
}

/**
 * Dispara el siguiente lote y devuelve el control de inmediato.
 *
 * La invocación receptora es NUEVA e independiente, con su propio presupuesto de
 * 300 s. Por eso la cadena puede recorrer un catálogo de cualquier tamaño sin que
 * ninguna invocación se acerque al tope.
 */
export async function dispatchNextBatch(
  request: Request,
  jobId: string
): Promise<void> {
  const origin = resolveWorkerOrigin(request);
  const secret = process.env.CRON_SECRET ?? "";

  const call = fetch(`${origin}/api/jobs/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-discountflow-job-secret": secret,
    },
    body: JSON.stringify({ jobId }),
  });

  await extendLifetime(call);
}

/** Compara el secreto en tiempo constante-ish y sin filtrar longitud por logs. */
export function isAuthorizedWorkerCall(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const got = request.headers.get("x-discountflow-job-secret");
  if (!got || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
