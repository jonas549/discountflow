// Barra de progreso de un job.
//
// Sondea /api/jobs/:id/status a la cadencia que le dicta el SERVIDOR (nextPollMs).
// El cliente no elige el ritmo: así se puede ralentizar el sondeo desde el servidor
// si algún día aprieta la cuota de invocaciones de Hobby, sin desplegar cliente.
//
// El cliente tampoco procesa trabajo nunca. Solo mira, y si ve un job colgado pide
// que lo despierten. Cerrar esta pestaña no detiene nada.

import { useCallback, useEffect, useRef, useState } from "react";

export type JobStatusPayload = {
  jobId: string;
  campaignName: string | null;
  operation: string;
  status:
    | "QUEUED"
    | "RESOLVING"
    | "RUNNING"
    | "CANCELLING"
    | "COMPLETED"
    | "COMPLETED_WITH_ERRORS"
    | "FAILED"
    | "CANCELLED";
  phase: string;
  percent: number | null;
  processedProducts: number;
  totalProducts: number;
  processedVariants: number;
  totalVariants: number;
  message: string;
  etaSeconds: number | null;
  stalled: boolean;
  errorCount: number;
  /** Unidades salteadas por no existir ya en la tienda. NO son incidencias. */
  skippedCount: number;
  skippedProducts: Array<{ id: string; reason: string; variants: number }>;
  lastError: string | null;
  attempts: number;
  canCancel: boolean;
  nextPollMs: number | null;
};

const TERMINAL = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);

/**
 * Aviso de lo que se salteó por no existir ya en la tienda.
 *
 * 🔴 Se distingue el producto BORRADO de la variante borrada de un producto que
 * sigue vivo, porque no son lo mismo para el merchant: en el segundo caso su
 * producto está ahí y sus demás tallas SÍ recuperaron el precio. Decirle
 * "producto no encontrado" cuando lo tiene delante en su catálogo lo mandaría a
 * buscar un problema que no existe.
 *
 * En gris y no en ámbar a propósito: no es una incidencia que deba resolver.
 */
function SalteadosAviso({ data }: { data: JobStatusPayload }) {
  const lista = data.skippedProducts ?? [];
  const productos = lista.filter((p) => p.reason === "product-missing");
  const conVariantes = lista.filter((p) => p.reason === "variants-missing");
  const noListados = data.skippedCount - lista.length;

  return (
    <div
      style={{
        marginTop: 8,
        fontSize: 12,
        color: "#6d7175",
        background: "#f6f6f7",
        border: "1px solid #e1e3e5",
        borderRadius: 6,
        padding: "8px 10px",
      }}
    >
      <div style={{ fontWeight: 600, color: "#42474c" }}>
        Se saltearon {data.skippedCount}{" "}
        {data.skippedCount === 1 ? "producto" : "productos"} que ya no están en la
        tienda.
      </div>
      <div style={{ marginTop: 4 }}>
        No tenían ningún precio que restaurar, así que la campaña terminó igual.
        El resto se procesó con normalidad.
      </div>

      {productos.length > 0 && (
        <div style={{ marginTop: 6, wordBreak: "break-all" }}>
          <strong>Eliminados de la tienda</strong> ({productos.length}):{" "}
          {productos.map((p) => p.id).join(" · ")}
        </div>
      )}

      {conVariantes.length > 0 && (
        <div style={{ marginTop: 6, wordBreak: "break-all" }}>
          <strong>Con variantes eliminadas</strong> ({conVariantes.length}): el
          producto sigue existiendo y sus demás variantes sí recuperaron el
          precio —{" "}
          {conVariantes
            .map((p) => `${p.id} (${p.variants})`)
            .join(" · ")}
        </div>
      )}

      {noListados > 0 && (
        <div style={{ marginTop: 6 }}>…y {noListados} más.</div>
      )}
    </div>
  );
}

/**
 * Cuántos fallos de red seguidos se toleran antes de rendirse (~25 s a 5 s cada uno).
 *
 * Antes no había tope: cualquier error dejaba un setTimeout reintentando para
 * siempre, así que una pestaña olvidada sondeaba indefinidamente y la barra se
 * quedaba congelada en la última foto que hubiera alcanzado a leer.
 */
const MAX_ERROR_RETRIES = 5;

const COLORS: Record<string, { bar: string; bg: string; text: string }> = {
  RUNNING: { bar: "#008060", bg: "#f1f8f5", text: "#007a5a" },
  COMPLETED: { bar: "#008060", bg: "#d3f5e2", text: "#007a5a" },
  COMPLETED_WITH_ERRORS: { bar: "#b98900", bg: "#fff3cd", text: "#8b5e00" },
  FAILED: { bar: "#c0392b", bg: "#fde8e8", text: "#c0392b" },
  CANCELLED: { bar: "#8c9196", bg: "#e4e5e7", text: "#505050" },
};

function formatEta(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return "menos de un minuto";
  const min = Math.round(seconds / 60);
  return `${min} minuto${min === 1 ? "" : "s"}`;
}

export function JobProgress({
  jobId,
  onFinished,
  compact = false,
}: {
  jobId: string;
  onFinished?: (status: string) => void;
  /** Franja de una línea para el shell: se sigue el progreso navegando. */
  compact?: boolean;
}) {
  const [data, setData] = useState<JobStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** El job ya no existe (404): la barra se retira en vez de quedarse colgada. */
  const [gone, setGone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedNotified = useRef(false);
  const errorRetries = useRef(0);

  // onFinished se guarda en un ref y NO va en las dependencias del efecto: los
  // padres lo definen inline, así que cambia de identidad en cada render y el
  // sondeo se reiniciaría solo —justo después de revalidar, que es cuando el
  // padre re-renderiza—, duplicando peticiones sobre el mismo job.
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const post = useCallback(
    async (intent: "cancel" | "kick") => {
      const body = new FormData();
      body.append("intent", intent);
      await fetch(`/api/jobs/${jobId}/status`, { method: "POST", body });
    },
    [jobId]
  );

  useEffect(() => {
    let cancelled = false;

    // Un solo sitio por el que se sale del sondeo: así no hay forma de terminar
    // sin avisar al padre, que es lo que dejaba la lista sin refrescar.
    const finish = (reason: string) => {
      if (finishedNotified.current) return;
      finishedNotified.current = true;
      onFinishedRef.current?.(reason);
    };

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/status`);

        // 🔴 404 = el job ya no está. Eso es un FINAL, no un error de red.
        //
        // Tratarlo como error era el bug que hacía parecer rota la app: el
        // componente se quedaba pintando el último payload que hubiera leído
        // —100 % en jobs largos, 0 % en jobs cortos, de ahí que pareciera
        // intermitente— y reintentaba cada 5 s para siempre sin avisar a nadie.
        //
        // Con el job sobreviviendo a su campaña esto ya casi no debería ocurrir;
        // queda como red de seguridad para el resto de casos (id inválido, base
        // limpiada, job purgado).
        if (res.status === 404) {
          if (cancelled) return;
          setGone(true);
          setError(null);
          finish("GONE");
          return; // no se vuelve a sondear
        }

        if (!res.ok) throw new Error(`estado ${res.status}`);
        const payload = (await res.json()) as JobStatusPayload;
        if (cancelled) return;

        setData(payload);
        setError(null);
        errorRetries.current = 0;

        if (TERMINAL.has(payload.status)) {
          finish(payload.status);
          return; // no se vuelve a sondear
        }

        // Vigilante: el job dejó de dar señales -> pedir que lo despierten.
        // No procesamos nada aquí; solo avisamos al servidor.
        if (payload.stalled) await post("kick");

        timer.current = setTimeout(tick, payload.nextPollMs ?? 2000);
      } catch (err) {
        if (cancelled) return;
        errorRetries.current += 1;
        setError(err instanceof Error ? err.message : String(err));

        // Se acabaron los reintentos: se avisa al padre igualmente para que
        // revalide y la lista deje de mostrar un estado que ya no es cierto.
        if (errorRetries.current >= MAX_ERROR_RETRIES) {
          finish("UNREACHABLE");
          return;
        }

        timer.current = setTimeout(tick, 5000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, post]);

  // El job ya no existe. La barra se retira en silencio: al padre ya se le avisó
  // y habrá revalidado, así que la lista de al lado muestra el estado real.
  if (gone) return null;

  if (error && !data)
    return (
      <div style={box("#fde8e8")}>
        <strong style={{ color: "#c0392b" }}>
          No se pudo consultar el progreso
        </strong>
        <div style={{ fontSize: 13, color: "#6d7175", marginTop: 4 }}>{error}</div>
      </div>
    );

  if (!data)
    return (
      <div style={box("#f6f6f7")}>
        <div style={{ fontSize: 14, color: "#6d7175" }}>Cargando progreso…</div>
      </div>
    );

  const palette = COLORS[data.status] ?? COLORS.RUNNING;
  const indeterminate = data.percent === null && !TERMINAL.has(data.status);
  const eta = formatEta(data.etaSeconds);

  // Modo compacto: una franja fina para el shell. Deja de pintarse en cuanto el
  // job termina — en el listado ya está la tarjeta completa con el resultado.
  if (compact) {
    if (TERMINAL.has(data.status)) return null;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 16px",
          background: palette.bg,
          borderBottom: "1px solid #e1e3e5",
          fontSize: 13,
          color: "#42474c",
        }}
      >
        <div
          style={{
            flex: "0 0 120px",
            height: 6,
            borderRadius: 999,
            background: "#fff",
            border: "1px solid #e1e3e5",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: indeterminate ? "35%" : `${data.percent ?? 0}%`,
              height: "100%",
              background: palette.bar,
              transition: "width 400ms ease",
            }}
          />
        </div>
        <span>
          <strong>{data.campaignName ?? "Campaña"}</strong>
          {data.percent !== null ? ` — ${data.percent}%` : " — preparando…"}
        </span>
      </div>
    );
  }

  return (
    <div style={box(palette.bg)}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <strong style={{ fontSize: 14, color: "#202223" }}>
          {data.campaignName ?? "Campaña"}
        </strong>
        <span style={{ fontSize: 20, fontWeight: 700, color: palette.text }}>
          {data.percent === null ? "" : `${data.percent}%`}
        </span>
      </div>

      {/* Carril */}
      <div
        style={{
          height: 10,
          borderRadius: 999,
          background: "#ffffff",
          border: "1px solid #e1e3e5",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {indeterminate ? (
          // Sin denominador todavía. Un 0 % inmóvil durante 30 s se lee como un
          // cuelgue; una barra que se mueve dice "estoy trabajando".
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `repeating-linear-gradient(90deg, ${palette.bar} 0 18px, transparent 18px 36px)`,
              opacity: 0.5,
              animation: "discountflow-job-slide 1.1s linear infinite",
            }}
          />
        ) : (
          <div
            style={{
              width: `${data.percent ?? 0}%`,
              height: "100%",
              background: palette.bar,
              transition: "width 400ms ease",
            }}
          />
        )}
      </div>

      <div style={{ marginTop: 10, fontSize: 13, color: "#42474c" }}>
        {data.message}
      </div>

      {data.totalProducts > 0 && (
        <div style={{ marginTop: 2, fontSize: 12, color: "#6d7175" }}>
          {data.processedProducts.toLocaleString("es-CL")} de{" "}
          {data.totalProducts.toLocaleString("es-CL")} productos
          {eta && !TERMINAL.has(data.status) ? ` · quedan ${eta}` : ""}
        </div>
      )}

      {!TERMINAL.has(data.status) && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#6d7175" }}>
          Puedes cerrar esta ventana o seguir navegando: el proceso continúa en
          segundo plano.
        </div>
      )}

      {data.stalled && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#8b5e00" }}>
          Sin respuesta hace un rato — reintentando automáticamente (intento{" "}
          {data.attempts}).
        </div>
      )}

      {data.errorCount > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#8b5e00" }}>
          {data.errorCount} unidad{data.errorCount === 1 ? "" : "es"} con
          incidencias.
        </div>
      )}

      {/*
        Lo salteado se cuenta y se explica APARTE de las incidencias, en gris y
        no en ámbar: no es un problema que el merchant tenga que resolver. Un
        producto que borró de su tienda no tiene precio que devolver, y decirle
        "incidencia" lo dejaría dudando de si sus precios volvieron o no.
      */}
      {(data.skippedCount ?? 0) > 0 && <SalteadosAviso data={data} />}

      {data.lastError && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#c0392b" }}>
          {data.lastError}
        </div>
      )}

      {data.canCancel && (
        <button
          type="button"
          onClick={() => void post("cancel")}
          style={{
            marginTop: 12,
            background: "transparent",
            border: "1px solid #c9cccf",
            borderRadius: 6,
            padding: "6px 14px",
            fontSize: 13,
            cursor: "pointer",
            color: "#42474c",
          }}
        >
          Cancelar
        </button>
      )}

      <style>{`@keyframes discountflow-job-slide{from{background-position:0 0}to{background-position:36px 0}}`}</style>
    </div>
  );
}

function box(bg: string): React.CSSProperties {
  return {
    background: bg,
    border: "1px solid #e1e3e5",
    borderRadius: 12,
    padding: "16px 20px",
  };
}
