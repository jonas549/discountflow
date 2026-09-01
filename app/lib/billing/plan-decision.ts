/**
 * Decisión de plan a partir de lo que responde Shopify. Módulo PURO: sin base de
 * datos, sin red, sin relojes. Todo lo que decide si una tienda sube, baja o se
 * queda como está vive aquí, para que se pueda probar sin levantar nada.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * LA RESTRICCIÓN QUE GOBIERNA ESTE ARCHIVO
 *
 * Un cliente que paga NO puede ver FREE por error. Ni una vez, ni por un momento.
 * Por eso la ambigüedad NUNCA degrada: ante cualquier duda se conserva el plan que
 * la tienda ya tenía. Bajar de plan exige evidencia POSITIVA de que no queda
 * ninguna suscripción viva, no la mera ausencia de evidencia.
 *
 * Se escribe FREE solo si se cumplen las CUATRO condiciones:
 *
 *   1. La lectura es válida — HTTP correcto, sin `errors`, y con
 *      `currentAppInstallation` presente. (Lo comprueba quien lee; aquí llega ya
 *      como `valida: false` si falló.)
 *   2. `activeSubscriptions` está vacío.
 *   3. En `allSubscriptions` no hay NINGUNA ACTIVE, PENDING ni FROZEN.
 *   4. Una segunda lectura, segundos después, dice exactamente lo mismo.
 *
 * Este módulo cubre 1-3 en `evaluarLectura()`. La 4 la orquesta quien llama:
 * cuando `evaluarLectura` devuelve `degradar-si-se-confirma`, hay que releer y
 * volver a preguntar; solo si las dos coinciden se escribe FREE.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * POR QUÉ CADA CONDICIÓN
 *
 * · La 1 existe porque `json.data?.…?.activeSubscriptions ?? []` confundía tres
 *   cosas distintas —lista vacía de verdad, `currentAppInstallation` nulo, y
 *   respuesta sin `data`— en el mismo valor. Mientras nadie degradaba daba igual;
 *   en cuanto se puede bajar a FREE, esa confusión es dinero.
 *
 * · La 3 existe porque CANCELLED es AMBIGUO. Shopify lo documenta así: una
 *   suscripción pasa a CANCELLED cuando se desinstala la app, cuando se cancela
 *   de verdad, Y TAMBIÉN «when a new app subscription is activated» — es decir,
 *   en cada CAMBIO DE PLAN. Mirar solo la última suscripción y ver CANCELLED
 *   degradaría a alguien que acaba de SUBIR de plan. La pregunta correcta no es
 *   «¿la última está cancelada?» sino «¿queda alguna viva?».
 *
 * · FROZEN es impago en curso y Shopify la reactiva sola al cobrar: cuenta como
 *   viva. Un merchant con una tarjeta rechazada no pierde su plan.
 *
 * · La 4 cubre la ventana transaccional de un cambio de plan, en la que la vieja
 *   ya está CANCELLED y la nueva todavía no existe. No se puede datar desde la
 *   API (`AppSubscription` expone `createdAt`, pero ni `cancelledAt` ni
 *   `updatedAt`), así que no hay forma de reconocerla mirando los datos: se cubre
 *   exigiendo que dos lecturas separadas en el tiempo coincidan.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * 🔴 NO FILTRAR POR `test`
 *
 * `AppSubscription.test` marca las suscripciones sin cargo. Los revisores de
 * Shopify se suscriben con planes sin cargo, y desde julio de 2026 pueden elegir
 * cualquier plan existente. Filtrar por `test: false` degradaría al revisor a FREE
 * en mitad de la revisión. Aquí se tratan igual que las de pago, a propósito.
 *
 * 🔴 AVISO PARA EL DÍA QUE SE MIGRE A SHOPIFY APP PRICING
 *
 * Shopify documenta que, tras migrar, la Active Subscription API devuelve solo los
 * contratos de App Pricing, y que «if it returns null, don't treat the app user as
 * unpaid until currentAppInstallation also confirms». Hoy leemos justamente
 * `currentAppInstallation`, así que estamos del lado correcto. Tras la migración,
 * este módulo degradaría a TODO EL MUNDO si no se consulta además la Partner API.
 */

// Extensión `.ts` explícita: el resolvedor ESM de Node la exige y este módulo se
// carga desde `npm test`. Vite la resuelve igual. Misma razón que en app/lib/jobs.
import { planFromHandle, type Plan } from "./plan-limits.ts";

/** Estados vivos: mientras exista alguno, la tienda NO baja de plan. */
const ESTADOS_VIVOS = ["ACTIVE", "PENDING", "FROZEN"] as const;

/** Estados que dan derecho a un plan de pago aquí y ahora. */
const ESTADOS_DE_PAGO = ["ACTIVE", "PENDING"] as const;

export type SubLeida = {
  status: string;
  /** `planHandle` de AppRecurringPricing, o null si no se pudo leer. */
  planHandle: string | null;
};

/**
 * Lo que se pudo averiguar en UNA consulta a Shopify.
 * `valida: false` significa «no pude preguntar», que es muy distinto de
 * «pregunté y no hay nada».
 */
export type LecturaPlan =
  | { valida: false; motivo: string }
  | {
      valida: true;
      activas: SubLeida[];
      todas: SubLeida[];
      /**
       * `false` si `allSubscriptions` tenía más páginas de las que se leyeron.
       * Sin el historial completo no se puede AFIRMAR que no queda ninguna viva,
       * que es justo lo que exige la condición 3 → se trata como ambigüedad.
       */
      historialCompleto: boolean;
    };

export type Evaluacion =
  /** Hay plan de pago reconocido: se escribe. */
  | { accion: "usar-plan"; plan: Plan; motivo: string }
  /** Ambigüedad o suscripción viva: no se toca el plan. */
  | { accion: "mantener"; motivo: string }
  /** Todo apunta a que no queda nada vivo. Falta la SEGUNDA lectura. */
  | { accion: "degradar-si-se-confirma"; motivo: string };

const estaViva = (s: SubLeida) =>
  (ESTADOS_VIVOS as readonly string[]).includes(s.status);

/** Evalúa UNA lectura contra las condiciones 1-3. Nunca decide FREE por sí sola. */
export function evaluarLectura(lectura: LecturaPlan): Evaluacion {
  // Condición 1 — si no se pudo preguntar, no se toca nada.
  if (!lectura.valida)
    return { accion: "mantener", motivo: `lectura inválida: ${lectura.motivo}` };

  // Una suscripción de pago vigente manda sobre todo lo demás.
  const vigente = lectura.activas.find((s) =>
    (ESTADOS_DE_PAGO as readonly string[]).includes(s.status)
  );
  if (vigente) {
    // 🔴 `planFromHandle` distingue «reconocido» de «desconocido»; `handleToPlan`
    // no, porque devuelve FREE para los dos. Esa confusión hacía que una bajada
    // legítima al plan gratuito —que Shopify entrega como una suscripción ACTIVE
    // con handle "free"— se tratara como handle ilegible y la tienda se quedara
    // en su plan de pago para siempre. Era el caso REAL de bajar de plan; el
    // camino de «no queda ninguna suscripción» solo ocurre al desinstalar.
    const plan = planFromHandle(vigente.planHandle);
    if (plan)
      return {
        accion: "usar-plan",
        plan,
        motivo: `suscripción ${vigente.status} con handle ${vigente.planHandle}`,
      };
    // Handle que no está en la lista: ambigüedad, no degradación encubierta.
    return {
      accion: "mantener",
      motivo: `suscripción ${vigente.status} con handle no reconocido (${vigente.planHandle ?? "ninguno"})`,
    };
  }

  // FROZEN = impago en curso. Sigue siendo cliente: se conserva el plan.
  const congelada = lectura.activas.find((s) => s.status === "FROZEN");
  if (congelada) return { accion: "mantener", motivo: "suscripción FROZEN (impago en curso)" };

  // Condición 2 — cualquier cosa restante en `activas` que no sepamos interpretar
  // es ambigüedad, no ausencia.
  if (lectura.activas.length > 0)
    return {
      accion: "mantener",
      motivo: `activeSubscriptions no vacío con estados no interpretables: ${lectura.activas
        .map((s) => s.status)
        .join(",")}`,
    };

  // Condición 3 — evidencia positiva: que no quede NINGUNA viva en el historial.
  const vivasEnHistorial = lectura.todas.filter(estaViva);
  if (vivasEnHistorial.length > 0)
    return {
      accion: "mantener",
      motivo: `allSubscriptions contradice a activeSubscriptions: ${vivasEnHistorial
        .map((s) => s.status)
        .join(",")}`,
    };

  // Historial truncado: no vimos ninguna viva, pero tampoco lo vimos entero. Eso
  // es «no lo sé», no «no hay». La condición 3 pide evidencia positiva.
  if (!lectura.historialCompleto)
    return {
      accion: "mantener",
      motivo: "historial de suscripciones incompleto (allSubscriptions paginado)",
    };

  return {
    accion: "degradar-si-se-confirma",
    motivo:
      lectura.todas.length === 0
        ? "sin suscripciones en el historial (instalación nueva o nunca pagó)"
        : `todas terminales: ${lectura.todas.map((s) => s.status).join(",")}`,
  };
}

/**
 * Decisión final con las DOS lecturas. `segunda` es la tomada unos segundos
 * después; solo hace falta cuando la primera pide confirmación.
 */
export function decidirPlan({
  planActual,
  primera,
  segunda,
}: {
  planActual: string;
  primera: LecturaPlan;
  segunda?: LecturaPlan;
}): { plan: string; degradado: boolean; motivo: string } {
  // «Degradado» = la tienda pasa de un plan de PAGO a FREE, venga por donde venga.
  // No se define como «llegó por el camino de las cuatro condiciones»: al bajar de
  // plan desde Shopify, la tienda llega por `usar-plan` con handle "free", y ese
  // caso tiene que quedar igual de vigilado —y frenado por el modo observación—
  // que una cancelación. Lo que le importa a un merchant es que su plan bajó, no
  // por qué rama del código pasó.
  const esDegradacion = (planNuevo: string) => planActual !== "FREE" && planNuevo === "FREE";

  const uno = evaluarLectura(primera);

  if (uno.accion === "usar-plan")
    return { plan: uno.plan, degradado: esDegradacion(uno.plan), motivo: uno.motivo };

  if (uno.accion === "mantener")
    return { plan: planActual, degradado: false, motivo: uno.motivo };

  // Condición 4 — la primera lectura pide bajar; hace falta que la segunda lo
  // confirme. Sin segunda lectura NO se degrada: quien llama tiene que pedirla.
  if (!segunda)
    return {
      plan: planActual,
      degradado: false,
      motivo: `pendiente de confirmación (${uno.motivo}) y no se hizo la segunda lectura`,
    };

  const dos = evaluarLectura(segunda);
  if (dos.accion !== "degradar-si-se-confirma")
    return {
      plan: planActual,
      degradado: false,
      motivo: `la segunda lectura no confirmó: ${dos.motivo}`,
    };

  // Si ya está en FREE no es una degradación, es el estado correcto.
  return {
    plan: "FREE",
    degradado: esDegradacion("FREE"),
    motivo: `confirmado por dos lecturas: ${uno.motivo}`,
  };
}
