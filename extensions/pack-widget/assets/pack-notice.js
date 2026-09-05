/* DiscountFlow — aviso del pack en el carrito.
 *
 * Decisión de producto del 2026-09-05: si el comprador borra una línea, el pack
 * NO se deshace y nada se bloquea. El carrito avisa de lo que perdió y de cómo
 * recuperarlo.
 *
 * Igual que el widget, este archivo NO calcula descuentos: usa `pack-calc.js`,
 * el mismo módulo que la Function del checkout.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 EL PROBLEMA DEL AJAX, Y POR QUÉ ESTA ES LA SOLUCIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Síntoma: el aviso solo aparecía tras refrescar la página.
 *
 * Causa: los temas actualizan el carrito con la Section Rendering API. Al
 * quitar una línea, el tema hace su petición y REEMPLAZA el HTML de la sección
 * del carrito. Eso rompe el aviso por dos lados a la vez:
 *
 *   a) si el bloque está DENTRO de la sección que se re-renderiza, su nodo del
 *      DOM se sustituye por uno nuevo, recién salido de Liquid — vacío y con
 *      `hidden`. El script ya corrió y no vuelve a correr.
 *   b) si está fuera, el nodo sobrevive pero nadie le dice que el carrito cambió.
 *
 * Lo que NO sirve:
 *   · `shopify:section:load` → solo se dispara en el EDITOR de temas.
 *   · `cart:updated` / `cart:refresh` → los inventa cada tema. Dawn no los
 *     emite: usa su propio pub/sub en un módulo de JS, inalcanzable desde acá.
 *     Escuchar solo esos eventos es apostar a qué tema tiene el merchant.
 *   · Un `MutationObserver` sobre el carrito → se dispara con cada cambio de
 *     cantidad, cada re-render y cada cosa que haga el tema. Ruido y riesgo de
 *     bucle.
 *
 * Lo que SÍ sirve, y es independiente del tema: **todas** las mutaciones Ajax
 * del carrito, en cualquier tema, pasan por `/cart/add`, `/cart/change`,
 * `/cart/update` o `/cart/clear`. Interceptando `fetch` y `XMLHttpRequest` se
 * detecta el cambio sin suponer nada del tema.
 *
 * Reglas que se respetan al interceptar, porque estamos en la casa de otro:
 *   · Siempre se deja pasar la petición y se devuelve su resultado tal cual.
 *   · Nunca se traga un error: el `catch` re-lanza.
 *   · Todo va dentro de try/catch, y si el parcheo fallara el aviso deja de
 *     actualizarse solo — el carrito del merchant sigue funcionando igual.
 *   · Se parchea UNA vez aunque el bloque esté puesto dos veces.
 *
 * Límite conocido y aceptado: un tema con un endpoint de carrito propio (muy
 * raro) no se detecta. En ese caso el aviso se comporta como antes: correcto al
 * cargar la página.
 */
(function () {
  "use strict";

  var Calc = window.DiscountFlowPackCalc;

  /** Rutas que mutan el carrito en cualquier tema. */
  var RUTAS_CARRITO = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;

  function esMutacionDeCarrito(url) {
    try {
      return RUTAS_CARRITO.test(String(url || ""));
    } catch (e) {
      return false;
    }
  }

  function render(root, texto, tono) {
    if (!texto) {
      root.hidden = true;
      root.textContent = "";
      return;
    }
    root.hidden = false;
    root.className = "df-pack-notice df-pack-notice--" + (tono || "info");
    root.textContent = texto;
  }

  function run() {
    // Se vuelve a buscar el nodo en CADA pasada, no se guarda una referencia:
    // el re-render de la sección lo sustituye por otro.
    var root = document.querySelector("[data-df-pack-notice]");
    if (!root || !Calc) return;
    var proxy = root.dataset.proxy || "/apps/discountflow/pack";

    fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cart) {
        if (!cart || !cart.items || !cart.items.length) return render(root, null);

        // ¿Hay líneas de algún pack? La clave la decide el servidor, así que se
        // busca cualquier propiedad que empiece por el prefijo conocido.
        var campaignId = null;
        var lineas = [];
        cart.items.forEach(function (l) {
          if (!l.properties) return;
          Object.keys(l.properties).forEach(function (k) {
            if (k.indexOf("_df_pack") === 0 && l.properties[k]) {
              campaignId = l.properties[k];
              lineas.push(l);
            }
          });
        });

        if (!campaignId) return render(root, null);

        return fetch(proxy + "?campaign=" + encodeURIComponent(campaignId), {
          headers: { Accept: "application/json" },
        })
          .then(function (r) {
            return r.ok ? r.json() : null;
          })
          .then(function (data) {
            if (!data || !data.pack) return render(root, null);
            var pack = data.pack;

            var enCatalogo = {};
            (pack.items || []).forEach(function (it) {
              enCatalogo[it.productId] = it;
            });

            var aplicables = lineas
              .map(function (l) {
                var gid = "gid://shopify/Product/" + l.product_id;
                if (!enCatalogo[gid]) return null;
                return {
                  lineId: String(l.key),
                  productId: gid,
                  unitPrice: l.price / 100,
                  quantity: l.quantity,
                };
              })
              .filter(Boolean);

            var catalog = (pack.items || []).map(function (it) {
              return { productId: it.productId, percent: it.percent };
            });

            var p = Calc.buildPackPreview(pack.mode, catalog, pack.tiers || [], aplicables);

            if (!p.applies) {
              var faltan = Math.max(1, pack.minProducts - p.distinctProducts);
              var recupera =
                p.nextTier && p.nextTier.percent
                  ? " y recuperás el " + p.nextTier.percent + "%"
                  : " y recuperás el descuento del pack";
              return render(
                root,
                "Agregá " +
                  faltan +
                  (faltan === 1 ? " producto" : " productos") +
                  recupera +
                  ".",
                "warn"
              );
            }

            if (p.nextTier) {
              return render(
                root,
                "Sumá " +
                  p.nextTier.productsNeeded +
                  (p.nextTier.productsNeeded === 1 ? " producto" : " productos") +
                  " y tu descuento pasa a " +
                  p.nextTier.percent +
                  "%.",
                "info"
              );
            }

            return render(root, null);
          });
      })
      .catch(function () {
        render(root, null);
      });
  }

  /**
   * Reintentos escalonados tras una mutación del carrito.
   *
   * El tema reemplaza el HTML de la sección DESPUÉS de que su petición
   * resuelva, así que correr una sola vez al terminar el fetch puede pintar
   * sobre un nodo que está a punto de ser sustituido. Tres pasadas cubren los
   * temas lentos sin convertirse en un sondeo: son tres lecturas de
   * `/cart.js`, cacheadas por el navegador.
   */
  var pendiente = null;
  function programar() {
    if (pendiente) clearTimeout(pendiente);
    pendiente = setTimeout(function () {
      pendiente = null;
      run();
      setTimeout(run, 350);
      setTimeout(run, 1200);
    }, 60);
  }

  /** Intercepta las mutaciones de carrito sin alterar su comportamiento. */
  function observarCarrito() {
    if (window.__dfPackCartHook) return;
    window.__dfPackCartHook = true;

    try {
      var fetchOriginal = window.fetch;
      if (typeof fetchOriginal === "function") {
        window.fetch = function (entrada, opciones) {
          var url =
            typeof entrada === "string"
              ? entrada
              : entrada && entrada.url
              ? entrada.url
              : "";
          var promesa = fetchOriginal.apply(this, arguments);
          if (esMutacionDeCarrito(url)) {
            // `then` con los DOS caminos y re-lanzando: interceptar no puede
            // convertir un fallo del tema en un éxito silencioso.
            promesa.then(
              function (res) {
                programar();
                return res;
              },
              function (err) {
                throw err;
              }
            );
          }
          return promesa;
        };
      }
    } catch (e) {
      /* si no se puede parchear, el aviso solo se actualiza al cargar */
    }

    try {
      var openOriginal = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (metodo, url) {
        try {
          if (esMutacionDeCarrito(url)) {
            this.addEventListener("loadend", programar);
          }
        } catch (e) {
          /* ignorado a propósito */
        }
        return openOriginal.apply(this, arguments);
      };
    } catch (e) {
      /* ídem */
    }
  }

  function arrancar() {
    observarCarrito();
    run();
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", arrancar);
  else arrancar();

  // Señales adicionales. No se confía en ellas —cada tema inventa las suyas y
  // Dawn no emite ninguna—, pero si están, mejor: el aviso reacciona antes.
  document.addEventListener("shopify:section:load", programar);
  document.addEventListener("cart:updated", programar);
  document.addEventListener("cart:refresh", programar);
  document.addEventListener("cart:change", programar);
})();
