// Fechas de campaña en la ZONA HORARIA DE LA TIENDA.
//
// El formulario usa <input type="datetime-local">, que entrega "2026-11-20T09:00"
// SIN zona. Antes el servidor hacía `new Date(valor)`, y en Vercel (UTC) eso lo
// leía como hora UTC: para una tienda de Chile todo arrancaba 3 o 4 horas antes.
//
// Aquí ese texto se interpreta como hora de pared de la tienda (su `ianaTimezone`,
// que da Shopify) y se convierte a un instante UTC, y al revés para mostrarlo.
// Sin librerías: Intl ya trae la base de zonas horarias y sus cambios de hora.
//
// Archivo puro (sin BD ni red) para poder probarlo.

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zona a usar: la de la tienda si es válida; si no, UTC (el comportamiento de antes). */
export function safeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? tz : "UTC";
}

/** Desfase (ms) de la zona respecto de UTC en un instante dado. Chile en verano: -3 h. */
function offsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * "2026-11-20T09:00" (hora de la tienda) → instante UTC. Vacío o inválido → null.
 *
 * En el cambio de hora hay horas que no existen (salto adelante) o que ocurren dos
 * veces (salto atrás). No se rechaza: la hora inexistente cae en la hora válida
 * contigua (a lo sumo una hora de diferencia, una vez al año) y nunca lanza.
 */
export function shopLocalToUtc(
  local: string | null | undefined,
  tz: string | null | undefined
): Date | null {
  const m = LOCAL_RE.exec((local ?? "").trim());
  if (!m) return null;
  const zone = safeTimeZone(tz);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  if (Number.isNaN(wall)) return null;
  // Dos pasadas: el desfase depende del instante, y el instante del desfase.
  let guess = wall - offsetMs(new Date(wall), zone);
  guess = wall - offsetMs(new Date(guess), zone);
  return new Date(guess);
}

/** Instante → "YYYY-MM-DDTHH:mm" en hora de la tienda, para el campo del formulario. */
export function utcToShopLocal(
  instant: Date | null | undefined,
  tz: string | null | undefined
): string {
  if (!instant || Number.isNaN(instant.getTime())) return "";
  const zone = safeTimeZone(tz);
  const shifted = new Date(instant.getTime() + offsetMs(instant, zone));
  return shifted.toISOString().slice(0, 16);
}

/** Instante → "20/11/2026 09:00" en hora de la tienda, para mostrar en el listado. */
export function formatShopDateTime(
  instant: Date | string | null | undefined,
  tz: string | null | undefined
): string {
  if (!instant) return "";
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const local = utcToShopLocal(d, tz);
  if (!local) return "";
  const [fecha, hora] = local.split("T");
  const [y, mo, da] = fecha.split("-");
  return `${da}/${mo}/${y} ${hora}`;
}
