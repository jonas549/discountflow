// Worker de lotes. Lo llama la cadena (el lote anterior), el vigilante del cliente
// o el barrido. Nunca un merchant directamente: exige el secreto compartido.
//
// ⭐ RESPONDE 202 DE INMEDIATO y hace el trabajo en waitUntil.
//
//    El orden importa y es contraintuitivo. Si esta ruta procesara el lote ANTES de
//    responder, el `fetch` del lote anterior seguiría abierto los 45 s, y como ese
//    fetch va dentro de su propio waitUntil, la invocación anterior se mantendría
//    viva esperándolo. Encadenando así, la invocación #1 seguiría viva hasta que
//    terminara la #18: una sola invocación de 14 minutos, muy por encima del tope
//    de 300 s de Hobby, y todo el troceado no habría servido de nada.
//
//    Respondiendo primero, el fetch del llamador se resuelve en milisegundos, su
//    invocación termina, y esta invocación se queda trabajando por su cuenta con
//    su propio presupuesto de 300 s. Cada eslabón es de verdad independiente.

import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import {
  ChainOriginError,
  dispatchNextBatch,
  extendLifetime,
  isAuthorizedWorkerCall,
} from "../lib/jobs/chain.server";
import { finishJob } from "../lib/jobs/jobs.server";
import { runJobBatch } from "../lib/jobs/runner.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST")
    return Response.json({ error: "Método no permitido" }, { status: 405 });

  if (!isAuthorizedWorkerCall(request))
    return Response.json({ error: "No autorizado" }, { status: 401 });

  let jobId = "";
  try {
    const body = (await request.json()) as { jobId?: string };
    jobId = String(body.jobId ?? "");
  } catch {
    return Response.json({ error: "Cuerpo inválido" }, { status: 400 });
  }
  if (!jobId) return Response.json({ error: "Falta jobId" }, { status: 400 });

  const work = runJobBatch(jobId, {
    /**
     * ⚠️ Aquí NO hay merchant ni sesión: el worker lo invoca la cadena, no un
     * navegador. `unauthenticated.admin` saca el token offline que la app guardó
     * al instalarse y devuelve un cliente Admin para esa tienda.
     *
     * 🔴 NO sustituir por `Shop.accessToken`: esa columna es una copia que nunca
     *    se refresca y, con `expiringOfflineAccessTokens` activo, queda muerta.
     *    El token bueno vive en la sesión que gestiona el SDK.
     */
    getAdmin: async (shopDomain) => {
      const { admin } = await unauthenticated.admin(shopDomain);
      return admin;
    },
    dispatchNext: async (id) => {
      try {
        await dispatchNextBatch(request, id);
      } catch (err) {
        // El guardia de origen saltó: hay una URL fija o una variable de entorno
        // en la ruta de encadenado. Es un fallo de configuración, no transitorio,
        // así que el job muere con el motivo a la vista en vez de reintentar.
        if (err instanceof ChainOriginError) {
          await finishJob(id, null, "FAILED", {
            lastError: err.message,
            force: true,
          });
          return;
        }
        throw err;
      }
    },
  }).catch((err) => {
    console.error(`[jobs] lote ${jobId} terminó con excepción:`, err);
  });

  await extendLifetime(work);

  return Response.json({ accepted: true, jobId }, { status: 202 });
};

/** GET no hace nada: este endpoint solo acepta POST autenticado. */
export const loader = () =>
  Response.json({ error: "No autorizado" }, { status: 401 });
