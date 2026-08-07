// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTES DEL MOTOR DE JOBS — ÚNICO SITIO DONDE SE TOCAN
// ─────────────────────────────────────────────────────────────────────────────
//
//  Client-safe a propósito: la UI necesita LEASE_STALE_MS para decidir si un job
//  está colgado, así que este archivo no puede importar nada de servidor.
//
//  Si cambias un número de aquí, lee antes el porqué. Están calculados contra dos
//  presupuestos ajenos que no controlamos:
//
//    1. Vercel Hobby  → 300 s de tope duro por invocación (con Fluid compute).
//    2. Shopify Admin → bucket de 1.000 puntos, recuperación 50 pts/s.
//                       Una mutación cuesta ~10 pts → ~5 mutaciones/segundo
//                       SOSTENIDAS. Ese es el techo real del sistema: ninguna
//                       arquitectura baja de ahí.
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⏱️ EL NÚMERO IMPORTANTE — presupuesto de reloj de UNA invocación.
 *
 * El worker comprueba este plazo ANTES de lanzar cada ola. Cuando se agota, cierra
 * el lote, guarda progreso y encadena el siguiente. Nunca corta a mitad de una ola.
 *
 * Por qué 45 s y no más:
 *   peor caso = 45 s + una ola entera en backoff máximo. Una mutación que agota los
 *   4 reintentos de admin-api.ts tarda ~11,5 s (5 intentos × ~800 ms + 500+1000+
 *   2000+4000 ms de espera). Total ~56,5 s contra el tope de 300 s → margen 5,3×.
 *
 * Por qué 45 s y no menos:
 *   el coste fijo por invocación (arranque, authenticate, upsert de shop, lease)
 *   es ~1,5 s. Con lotes de 4 s de trabajo útil —los "20 productos" que se barajaron
 *   al principio— se desperdicia el 27 % en ceremonia y la cadena pasa de 18 a 200
 *   eslabones, cada uno un punto de fallo. A 45 s el desperdicio baja al 3 %.
 *
 * ⚠️ Depende de que Fluid compute esté ACTIVO (confirmado 2026-08-07). Sin Fluid el
 *    tope de Hobby son 60 s y este número tendría que bajar a ~20 s.
 */
export const DEADLINE_MS = 45_000;

/**
 * Mutaciones simultáneas a Shopify dentro de una invocación.
 *
 * A ~500 ms por mutación, 4 en paralelo dan 8/s. Como el techo sostenido son 5/s,
 * el job arranca rápido quemando el bucket de 1.000 puntos (~33 s de trabajo a
 * máxima velocidad) y a partir de ahí el backoff que YA existe en
 * admin-api.ts:175-244 lo hace converger solo hacia los 5/s. Sin lógica nueva.
 *
 * 🔴 No subir a 8: no va más rápido (solo pasa más tiempo en backoff) y el bucket
 *    se COMPARTE con el propio admin del merchant. Un job agresivo le ralentiza la
 *    ficha de producto mientras trabaja, y eso llega como ticket de soporte que
 *    nadie relaciona con la app.
 */
export const CONCURRENCY = 4;

/** Redes de seguridad del lote, por si el reloj se comporta de forma inesperada. */
export const MAX_PRODUCTS_PER_BATCH = 300;
export const MAX_VARIANTS_PER_BATCH = 3_000;

/**
 * Cada cuántas unidades se vuelca el progreso a la BD.
 *
 * No se escribe por unidad: 20.000 unidades serían 20.000 escrituras, justo el
 * problema de round-trips que este sistema viene a evitar. Se agrupa.
 *
 * El progreso se ESCRIBE, no se incrementa (`processedProducts = valor calculado`),
 * de modo que repetir un volcado es idempotente. Y la verdad de qué unidades están
 * hechas no vive en este contador sino en CampaignProduct.processedByJobId, que es
 * un sello por fila y no puede contar de más.
 */
export const PROGRESS_FLUSH_UNITS = 25;

/**
 * Un job no terminal cuyo heartbeat supere esto se considera ZOMBI y otro worker
 * puede reclamarlo.
 *
 * 90 s son ~8× el peor caso de una sola unidad (11,5 s con backoff completo), así
 * que no hay falsos positivos: un worker vivo pero lento nunca es desalojado.
 */
export const LEASE_STALE_MS = 90_000;

/**
 * Freno de mano. Un job que revienta siempre en el mismo punto se re-patearía
 * eternamente entre la cadena, el vigilante del cliente y el cron: sin este tope
 * se comería la cuota de invocaciones de Hobby, y superar la cuota en Hobby no
 * degrada el servicio, lo APAGA hasta 30 días.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Cadencia de sondeo que el SERVIDOR le impone al cliente (campo `nextPollMs` de
 * la respuesta de estado). El cliente obedece, no elige.
 *
 * Así se puede ralentizar el sondeo desde el servidor sin desplegar cliente nuevo
 * si algún día la cuota de invocaciones aprieta.
 *
 * Coste de un job de 20.000 unidades (~14 min): 10 + 20 + ~158 ≈ 188 sondeos.
 * Hobby incluye 1.000.000 de invocaciones/mes → ~4.850 jobs así al mes.
 */
export const POLL_FAST_MS = 1_000;
export const POLL_NORMAL_MS = 2_000;
export const POLL_SLOW_MS = 5_000;
export const POLL_FAST_UNTIL_MS = 10_000;
export const POLL_NORMAL_UNTIL_MS = 50_000;

/** Estados desde los que un job ya no se mueve. */
export const TERMINAL_STATUSES = [
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
] as const;

/** Flag que gobierna la ENTRADA al sistema de jobs. Nunca al worker. */
export const JOBS_FEATURE_FLAG = "jobs:batched";
