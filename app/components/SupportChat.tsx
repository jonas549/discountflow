// Chat de soporte (Tawk.to) — PRUEBA EN DEV.
//
// 🔴 ESTE COMPONENTE VIVE EN EL SHELL (`app/routes/app.tsx`), que envuelve TODA la
//    app. Un fallo aquí se lleva por delante las cinco pantallas de un cliente que
//    paga. Por eso:
//
//    1. Todo el cuerpo del efecto va dentro de un try/catch. Un `throw` dentro de
//       un `useEffect` SÍ propaga y tumba el árbol de React: no alcanza con que el
//       script de Tawk sea asíncrono.
//    2. No pinta nada propio (`return null`). El widget lo inyecta Tawk en el
//       `<body>`; si el script no carga, no queda ni un hueco en la pantalla.
//    3. Quien decide si esto se monta es el SERVIDOR, con el flag `chat:tawk` de
//       `Shop.features`, que falla cerrado. Ver `app/routes/app.tsx`.
//
// El merchant no ve ningún dato nuestro: lo que se manda son atributos para el
// panel de Tawk, para saber con quién se está hablando.

import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * 🔴 EL ID DE LA CUENTA DE TAWK VIVE SOLO AQUÍ.
 *
 * Duplicarlo en otro archivo es como nacen los bugs silenciosos de este repo
 * (el `message` de escalonados en tres sitios, el título de BxGy en dos).
 * `support-chat.test.ts` falla si aparece en cualquier otro fichero.
 *
 * No es un secreto: viaja en el HTML que recibe el navegador, como cualquier
 * widget de chat.
 */
const TAWK_SRC = "https://embed.tawk.to/6aae966baaf7f5343d673729/1k2svn5ee";

type Props = {
  /** Dominio de la tienda. Es el nombre con el que el visitante sale en el panel. */
  shopDomain: string;
  /** Plan leído en el shell. Puede tener hasta 15 min de desfase (ver app.tsx). */
  plan: string;
};

/** Nombre legible de la pantalla, para no leer rutas crudas en el panel. */
function nombreDePantalla(pathname: string): string {
  const mapa: Record<string, string> = {
    "/app": "Inicio",
    "/app/campaigns": "Campañas",
    "/app/analytics": "Analíticas",
    "/app/plans": "Planes",
    "/app/support": "Soporte",
    "/app/campaigns/new/percentage": "Nueva campaña · Porcentaje",
    "/app/campaigns/new/range": "Nueva campaña · Rango de precio",
    "/app/campaigns/new/bxgy": "Nueva campaña · BxGy",
    "/app/campaigns/new/tiered": "Nueva campaña · Escalonado",
    "/app/campaigns/new/pack": "Nueva campaña · Pack",
    "/app/campaigns/new/cart-value": "Nueva campaña · Monto de compra",
    "/app/campaigns/new/original-price": "Nueva campaña · Cupón",
  };
  // Si la ruta no está en el mapa se devuelve la ruta REAL, nunca un texto
  // inventado: un "Otra pantalla" sería el mismo fallback mudo que ya escondió
  // dos veces un tipo de campaña sin traducir.
  return mapa[pathname] ?? pathname;
}

export function SupportChat({ shopDomain, plan }: Props) {
  const { pathname } = useLocation();
  const cargado = useRef(false);
  // Última foto de los atributos. El efecto de navegación la reescribe y `onLoad`
  // la lee: así la primera pantalla también llega, aunque Tawk tarde en cargar.
  const atributos = useRef({ shopDomain, plan, pantalla: nombreDePantalla(pathname) });

  atributos.current = { shopDomain, plan, pantalla: nombreDePantalla(pathname) };

  // 1 · Cargar el script una sola vez.
  useEffect(() => {
    try {
      if (cargado.current) return;
      if (typeof document === "undefined") return;
      if (document.querySelector('script[data-df-chat="tawk"]')) return;
      cargado.current = true;

      const w = window as unknown as Record<string, unknown>;
      const api = (w.Tawk_API ?? {}) as Record<string, unknown>;
      w.Tawk_API = api;
      w.Tawk_LoadStart = new Date();

      // Se aplican en cuanto el widget está vivo. Antes de esto, `setAttributes`
      // todavía no existe y llamarlo no haría nada.
      api.onLoad = function onLoad() {
        aplicarAtributos(atributos.current);
      };

      const s = document.createElement("script");
      s.async = true;
      s.src = TAWK_SRC;
      s.charset = "UTF-8";
      s.setAttribute("crossorigin", "*");
      s.setAttribute("data-df-chat", "tawk");
      document.head.appendChild(s);
    } catch {
      // Silencio a propósito: el chat es accesorio y la app tiene que seguir.
    }
  }, []);

  // 2 · Reenviar los atributos en cada cambio de pantalla.
  //
  // 🔴 Hace falta hacerlo en el cliente: `app/routes/app.tsx` es el layout padre y
  //    su loader NO se vuelve a ejecutar cuando el merchant navega a una ruta hija.
  //    Es el mismo motivo por el que el distintivo de plan del menú se quedaba con
  //    un valor viejo. Si esto dependiera del loader, el panel diría siempre
  //    "Inicio".
  useEffect(() => {
    aplicarAtributos({ shopDomain, plan, pantalla: nombreDePantalla(pathname) });
  }, [shopDomain, plan, pathname]);

  return null;
}

function aplicarAtributos(datos: { shopDomain: string; plan: string; pantalla: string }) {
  try {
    const api = (window as unknown as Record<string, unknown>).Tawk_API as
      | Record<string, unknown>
      | undefined;
    const set = api?.setAttributes;
    if (typeof set !== "function") return;

    (set as (a: Record<string, string>, cb: (e?: unknown) => void) => void).call(
      api,
      {
        // `name` es lo que se ve en la lista de visitantes del panel.
        name: datos.shopDomain,
        tienda: datos.shopDomain,
        plan: datos.plan,
        pantalla: datos.pantalla,
      },
      () => {
        // Callback obligatorio de Tawk. Un fallo aquí no se reporta al merchant:
        // que el panel no sepa la pantalla no es motivo para molestarlo.
      },
    );
  } catch {
    // Ídem: el chat nunca puede tumbar la app.
  }
}
