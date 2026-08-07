// Registro de operaciones. El runner no sabe qué hace cada una: solo pide
// unidades pendientes, las manda ejecutar y pregunta cuántas quedan.
//
// Ese contrato es el mismo para NOOP (que no toca nada) y para las operaciones
// reales de D2 (que mutan precios en Shopify). Un único camino de código para los
// cuatro tipos de campaña: los caminos especiales "para los rápidos" son justo
// donde se acumulan los bugs que nadie prueba.

import type { JobOperation } from "../job-state.ts";
import type { JobRecord } from "../jobs.server.ts";
import { noopHandler } from "./noop.ts";

/** Una unidad de trabajo = un producto (una mutación de Shopify en D2). */
export type JobUnit = {
  /** GID del producto. En NOOP es un GID sintético. */
  productId: string;
  /** Cuántas variantes cuelgan de él (para el texto de la barra y los topes). */
  variantCount: number;
};

export type ResolveStep = {
  /** true = la resolución terminó y se puede pasar a la fase de trabajo. */
  done: boolean;
  totalProducts: number;
  totalVariants: number;
  resolveCursor: string | null;
};

export type RunUnitsResult = {
  succeeded: JobUnit[];
  /** Fallos por unidad. NO abortan el lote: el job acaba COMPLETED_WITH_ERRORS. */
  failures: Array<{ unit: string; message: string }>;
};

export type JobHandler = {
  /** Un tramo de la fase 0. Se llama repetidamente hasta `done`. */
  resolveStep(job: JobRecord, nonce: string): Promise<ResolveStep>;
  /** Unidades que este job todavía no ha sellado. */
  pendingUnits(job: JobRecord, limit: number): Promise<JobUnit[]>;
  /** Hace el trabajo y SELLA processedByJobId. Sellar es lo que hace idempotente todo. */
  runUnits(job: JobRecord, units: JobUnit[]): Promise<RunUnitsResult>;
  totalDone(job: JobRecord): Promise<{ products: number; variants: number }>;
  remaining(job: JobRecord): Promise<number>;
};

const HANDLERS: Partial<Record<JobOperation, JobHandler>> = {
  NOOP: noopHandler,
  // APPLY / REACTIVATE / REVERT / DELETE llegan en D2.
};

export function getHandler(operation: JobOperation): JobHandler | null {
  return HANDLERS[operation] ?? null;
}
