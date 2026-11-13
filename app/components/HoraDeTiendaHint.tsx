// Aclaración junto a las fechas de campaña: se interpretan en la hora de la tienda.
import { useRouteLoaderData } from "react-router";

export function HoraDeTiendaHint() {
  const data = useRouteLoaderData("routes/app") as { shopTimeZone?: string | null } | undefined;
  const tz = data?.shopTimeZone;
  return (
    <div data-testid="hora-de-tienda" style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
      Hora de la tienda{tz ? ` (${tz.replace(/_/g, " ")})` : ""}
    </div>
  );
}
