// Registro de operaciones. El runner no sabe qué hace cada una: solo pide
// unidades pendientes, las manda ejecutar y pregunta cuántas quedan.
//
// Ese contrato es el mismo para NOOP (que no toca nada) y para las operaciones
// reales que mutan precios en Shopify. Un único camino de código: los caminos
// especiales "para los rápidos" son justo donde se acumulan los bugs que nadie
// prueba.
//
// ⭐ El cliente de Shopify llega por el CONTEXTO, no por import. Es la costura que
//    permite correr toda la batería contra el cliente falso (fake-admin.ts) con
//    catálogos de 20.000 variantes, sin tienda y sin rate limits.

import type { JobOperation } from "../job-state.ts";
import type { JobRecord } from "../jobs.server.ts";
import { noopHandler } from "./noop.ts";
import {
  applyHandler,
  reactivateHandler,
  revertHandler,
  deleteHandler,
} from "./campaign-ops.ts";

export type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

export type OpCampaign = {
  id: string;
  /** La tienda dueña. La necesita la sincronización del metafield del widget. */
  shopId: string;
  name: string;
  type: string;
  status: string;
  config: unknown;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type OpContext = {
  job: JobRecord;
  admin: AdminClient;
  campaign: OpCampaign;
};

/** Una unidad de trabajo = un producto = una mutación de Shopify. */
export type JobUnit = {
  productId: string;
  /** Variantes que cuelgan de él: alimenta el texto de la barra y los topes. */
  variantCount: number;
};

export type ResolveStep = {
  /** true = la resolución terminó y se puede pasar a la fase de trabajo. */
  done: boolean;
  totalProducts: number;
  totalVariants: number;
  resolveCursor: string | null;
};

/** Por qué una unidad se salteó. Ninguno de los dos es un error del merchant. */
export type SkipReason = "product-missing" | "variants-missing";

export type SkippedUnit = {
  unit: string;
  reason: SkipReason;
  /** Cuántas variantes de esa unidad no se encontraron. Alimenta el aviso. */
  variants: number;
};

export type RunUnitsResult = {
  succeeded: JobUnit[];
  /** Fallos por unidad. NO abortan el lote: el job acaba COMPLETED_WITH_ERRORS. */
  failures: Array<{ unit: string; message: string }>;
  /**
   * Unidades salteadas porque ya no existen en Shopify.
   *
   * 🔴 NO son fallos y no cambian el estado final del job: un producto borrado no
   * tiene precio que revertir, así que saltearlo ES el resultado correcto. Se
   * cuentan aparte para poder decírselo al merchant, y se SELLAN igual que las
   * que salieron bien — si no se sellaran, `remaining` nunca llegaría a cero y la
   * campaña no se podría pausar, que es exactamente el bloqueo que esto arregla.
   */
  skipped?: SkippedUnit[];
};

export type JobHandler = {
  /** Un tramo de la fase 0. Se llama repetidamente hasta `done`. */
  resolveStep(ctx: OpContext): Promise<ResolveStep>;
  /** Unidades que este job todavía no ha sellado. */
  pendingUnits(ctx: OpContext, limit: number): Promise<JobUnit[]>;
  /** Hace el trabajo y SELLA. Sellar es lo que hace idempotente la reanudación. */
  runUnits(ctx: OpContext, units: JobUnit[]): Promise<RunUnitsResult>;
  totalDone(ctx: OpContext): Promise<{ products: number; variants: number }>;
  remaining(ctx: OpContext): Promise<number>;
  /**
   * Se ejecuta UNA vez, cuando ya no queda trabajo y antes de marcar el job como
   * terminado. Es donde DELETE borra la campaña: si se hiciera antes, el borrado
   * en cascada se llevaría por delante el propio job a mitad de ejecución.
   */
  finalize?(ctx: OpContext): Promise<void>;
};

const HANDLERS: Partial<Record<JobOperation, JobHandler>> = {
  NOOP: noopHandler,
  APPLY: applyHandler,
  REACTIVATE: reactivateHandler,
  REVERT: revertHandler,
  DELETE: deleteHandler,
};

export function getHandler(operation: JobOperation): JobHandler | null {
  return HANDLERS[operation] ?? null;
}
