/* DiscountFlow — aviso del pack en el carrito.
 *
 * Decisión de producto del 2026-09-05: si el comprador borra una línea, el pack
 * NO se deshace y nada se bloquea. El carrito avisa de lo que perdió y de cómo
 * recuperarlo.
 *
 * Igual que el widget, este archivo NO calcula descuentos: usa `pack-calc.js`,
 * el mismo módulo que la Function del checkout.
 */
(function () {
  "use strict";

  var Calc = window.DiscountFlowPackCalc;

  function render(root, texto, tono) {
    if (!texto) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    root.hidden = false;
    root.className = "df-pack-notice df-pack-notice--" + (tono || "info");
    root.textContent = texto;
  }

  function run() {
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();

  document.addEventListener("shopify:section:load", run);
  // Los temas disparan esto al cambiar cantidades sin recargar.
  document.addEventListener("cart:updated", run);
  document.addEventListener("cart:refresh", run);
})();
