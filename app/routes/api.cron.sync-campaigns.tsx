// Cron de la programación de campañas.
//
//   GET /api/cron/sync-campaigns      (Vercel Cron, cada 5 minutos — ver vercel.json)
//
// Activa las campañas cuya hora de inicio llegó y pausa las que llegaron a su fin.
// Solo ENCOLA jobs en el motor; no toca precios en esta petición.
//
// Autenticación: Vercel Cron envía `Authorization: Bearer <CRON_SECRET>` cuando
// la variable existe en el proyecto. Sin secreto configurado la ruta no hace
// nada (responde 401): es preferible un cron mudo a una ruta pública que mueva
// precios.
//
// `vercel.json` declaraba este cron desde hace meses, pero la ruta no existía.

import type { LoaderFunctionArgs } from "react-router";
import { ChainOriginError, dispatchNextBatch } from "../lib/jobs/chain.server";
import { finishJob } from "../lib/jobs/jobs.server";
import { runScheduleTick } from "../lib/schedule/scheduler.server";

function autorizado(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const got = request.headers.get("authorization") ?? "";
  const want = `Bearer ${expected}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!autorizado(request)) return Response.json({ error: "No autorizado" }, { status: 401 });

  try {
    const result = await runScheduleTick({
      dispatch: async (jobId) => {
        try {
          await dispatchNextBatch(request, jobId);
        } catch (err) {
          // Mismo criterio que el worker: un fallo del guardia de origen es de
          // configuración, no transitorio. El job muere con el motivo a la vista.
          if (err instanceof ChainOriginError) {
            await finishJob(jobId, null, "FAILED", { lastError: err.message, force: true });
            return;
          }
          throw err;
        }
      },
    });
    if (result.iniciadas.length || result.terminadas.length || result.avisos.length)
      console.log("[schedule] tick:", JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[schedule] el tick falló:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
};
