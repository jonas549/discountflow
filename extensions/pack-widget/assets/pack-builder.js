/* DiscountFlow — widget «Armá tu pack».
 *
 * 🔴 ESTE ARCHIVO NO CALCULA DESCUENTOS.
 *
 * Todo el cálculo sale de `pack-calc.js`, que es el MISMO módulo
 * (app/lib/discounts/pack-calc.ts) que usa la Shopify Function del checkout,
 * compilado por scripts/build-pack-widget.mjs. Si algún día alguien escribe acá
 * una regla de descuento, el comprador verá un precio en la tienda y pagará
 * otro en el checkout.
 *
 * Lo que este archivo sí hace: pedir la configuración, pintar, y agregar al
 * carrito marcando las líneas con la propiedad que la Function busca.
 */
(function () {
  "use strict";

  var Calc = window.DiscountFlowPackCalc;

  function money(cents, currency) {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || "es", {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: 2,
      }).format(cents);
    } catch (e) {
      return String(Math.round(cents));
    }
  }

  /** El id numérico que necesita la Ajax Cart API, sacado del GID del admin. */
  function numericId(gid) {
    return String(gid || "").split("/").pop();
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function PackWidget(root) {
    this.root = root;
    this.campaignId = root.dataset.campaign || "";
    this.proxy = root.dataset.proxy || "/apps/discountflow/pack";
    this.ctaLabel = root.dataset.cta || "Agregar pack al carrito";
    this.headingOverride = root.dataset.heading || "";
    this.columns = parseInt(root.dataset.columns, 10) || 2;
    this.selected = [];
    this.pack = null;
    this.busy = false;
  }

  PackWidget.prototype.load = function () {
    var self = this;
    var url = this.proxy + (this.campaignId ? "?campaign=" + encodeURIComponent(this.campaignId) : "");

    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("proxy " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.pack) {
          // Sin campaña activa el bloque desaparece en vez de mostrar un cascarón
          // vacío. El merchant lo ve en el editor de temas; el comprador, no.
          self.root.innerHTML = "";
          self.root.hidden = true;
          return;
        }
        self.pack = data.pack;
        self.render();
        self.refreshPrices();
      })
      .catch(function (err) {
        self.root.innerHTML = "";
        self.root.hidden = true;
        // Visible solo para quien abra la consola. Un comprador no debe ver un
        // error técnico, pero quien depure tiene que encontrar la causa rápido.
        console.error(
          "[DiscountFlow] No se pudo cargar el pack. Revisá que el App proxy " +
            "apunte a la URL correcta (Partner Dashboard → App setup → App proxy).",
          err
        );
      });
  };

  /**
   * Refresca precios y variantes contra el propio storefront.
   *
   * La foto que guarda el admin puede quedar vieja si el merchant cambia un
   * precio. `/products/{handle}.js` es del mismo dominio, va por CDN y no cuesta
   * ninguna invocación nuestra. Si falla, se conserva la foto: un precio algo
   * viejo es mejor que un widget roto — y el que decide el dinero es la Function,
   * no esto.
   */
  PackWidget.prototype.refreshPrices = function () {
    var self = this;
    var items = this.pack.items || [];

    return Promise.all(
      items.map(function (item) {
        if (!item.handle) return null;
        return fetch("/products/" + item.handle + ".js", { headers: { Accept: "application/json" } })
          .then(function (r) {
            return r.ok ? r.json() : null;
          })
          .then(function (p) {
            if (!p || !p.variants || !p.variants.length) return;
            var v =
              p.variants.filter(function (x) {
                return x.available;
              })[0] || p.variants[0];
            // La Ajax API devuelve CENTAVOS; la foto del admin, unidades.
            item.price = v.price / 100;
            item.liveVariantId = v.id;
            item.available = !!v.available;
            if (p.featured_image) item.image = p.featured_image;
          })
          .catch(function () {
            /* se conserva la foto */
          });
      })
    ).then(function () {
      self.render();
    });
  };

  PackWidget.prototype.toggle = function (productId) {
    var i = this.selected.indexOf(productId);
    if (i > -1) this.selected.splice(i, 1);
    else this.selected.push(productId);
    this.render();
  };

  /** Traduce lo elegido a lo que entiende el cálculo compartido. */
  PackWidget.prototype.lines = function () {
    var items = this.pack.items || [];
    var out = [];
    for (var i = 0; i < this.selected.length; i++) {
      var id = this.selected[i];
      for (var j = 0; j < items.length; j++) {
        if (items[j].productId === id) {
          out.push({
            lineId: "w-" + id,
            productId: id,
            unitPrice: items[j].price,
            quantity: 1,
          });
          break;
        }
      }
    }
    return out;
  };

  PackWidget.prototype.preview = function () {
    var items = this.pack.items || [];
    var catalog = items.map(function (it) {
      return { productId: it.productId, percent: it.percent };
    });
    return Calc.buildPackPreview(this.pack.mode, catalog, this.pack.tiers || [], this.lines());
  };

  PackWidget.prototype.render = function () {
    var self = this;
    var pack = this.pack;
    var p = this.preview();
    var root = this.root;

    root.innerHTML = "";
    root.hidden = false;

    // ── Encabezado ──
    var head = el("div", "df-pack__head");
    head.appendChild(el("h2", "df-pack__title", this.headingOverride || pack.heading));

    if (pack.mode === "PACK_SIZE" && (pack.tiers || []).length) {
      var resumen = pack.tiers
        .map(function (t) {
          return t.minProducts + " → " + t.percent + "%";
        })
        .join(" · ");
      head.appendChild(el("p", "df-pack__subtitle", resumen));
    } else {
      head.appendChild(el("p", "df-pack__subtitle", "Cada producto tiene su propio descuento."));
    }
    root.appendChild(head);

    // ── Progreso al siguiente nivel (solo modo por tamaño) ──
    if (pack.mode === "PACK_SIZE") {
      var barra = el("div", "df-pack__progress");
      var texto = p.nextTier
        ? "Sumá " +
          p.nextTier.productsNeeded +
          (p.nextTier.productsNeeded === 1 ? " producto" : " productos") +
          " y ahorrás " +
          p.nextTier.percent +
          "%"
        : p.applies
        ? "Máximo descuento aplicado: " + p.appliedPercent + "%"
        : "";
      if (texto) barra.appendChild(el("span", "df-pack__progress-text", texto));

      var tope = (pack.tiers || []).reduce(function (m, t) {
        return Math.max(m, t.minProducts);
      }, 1);
      var pista = el("div", "df-pack__bar");
      var relleno = el("div", "df-pack__bar-fill");
      relleno.style.width = Math.min(100, (p.distinctProducts / tope) * 100) + "%";
      pista.appendChild(relleno);
      barra.appendChild(pista);
      root.appendChild(barra);
    }

    // ── Catálogo ──
    var grid = el("div", "df-pack__grid");
    grid.style.setProperty("--df-pack-cols", String(this.columns));

    (pack.items || []).forEach(function (item) {
      var elegido = self.selected.indexOf(item.productId) > -1;
      var card = el("div", "df-pack__card" + (elegido ? " is-selected" : ""));

      var media = el("div", "df-pack__media");
      if (item.image) {
        var img = document.createElement("img");
        img.src = item.image;
        img.alt = item.title;
        img.loading = "lazy";
        media.appendChild(img);
      }
      card.appendChild(media);

      var body = el("div", "df-pack__body");
      body.appendChild(el("span", "df-pack__name", item.title));

      var fila = el("div", "df-pack__pricerow");
      fila.appendChild(el("span", "df-pack__price", money(item.price, pack.currency)));
      if (pack.mode === "PER_PRODUCT" && item.percent > 0)
        fila.appendChild(el("span", "df-pack__off", item.percent + "% OFF"));
      body.appendChild(fila);

      var btn = el("button", "df-pack__toggle" + (elegido ? " is-selected" : ""));
      btn.type = "button";
      btn.textContent = elegido ? "Quitar del pack" : "Agregar al pack";
      btn.addEventListener("click", function () {
        self.toggle(item.productId);
      });
      body.appendChild(btn);

      card.appendChild(body);
      grid.appendChild(card);
    });
    root.appendChild(grid);

    // ── Resumen y CTA ──
    var panel = el("div", "df-pack__summary");
    panel.appendChild(
      el(
        "div",
        "df-pack__count",
        p.distinctProducts === 1 ? "1 producto" : p.distinctProducts + " productos"
      )
    );

    if (!p.applies) {
      var faltan = Math.max(1, pack.minProducts - p.distinctProducts);
      panel.appendChild(
        el(
          "p",
          "df-pack__hint",
          "Agregá " +
            faltan +
            (faltan === 1 ? " producto más" : " productos más") +
            " para activar el descuento."
        )
      );
    } else {
      var t = el("table", "df-pack__totals");
      [
        ["Subtotal", money(p.subtotal, pack.currency), ""],
        ["Ahorro" + (p.appliedPercent ? " (" + p.appliedPercent + "%)" : ""), "−" + money(p.savings, pack.currency), "df-pack__save"],
        ["Total", money(p.total, pack.currency), "df-pack__total"],
      ].forEach(function (row) {
        var tr = el("tr", row[2]);
        tr.appendChild(el("td", null, row[0]));
        tr.appendChild(el("td", null, row[1]));
        t.appendChild(tr);
      });
      panel.appendChild(t);
    }

    var cta = el("button", "df-pack__cta");
    cta.type = "button";
    cta.textContent = this.busy ? "Agregando…" : this.ctaLabel;
    cta.disabled = !p.applies || this.busy;
    cta.addEventListener("click", function () {
      self.addToCart();
    });
    panel.appendChild(cta);

    root.appendChild(panel);
  };

  /**
   * Agrega el pack al carrito.
   *
   * 🔴 La propiedad `_df_pack` lleva SOLO la identidad de la campaña. Nunca un
   * precio ni un porcentaje: la propiedad viaja en el navegador del comprador y
   * cualquiera puede editarla. La Function recalcula desde su metafield.
   *
   * El guion bajo inicial oculta la propiedad al comprador en el carrito y el
   * checkout, pero la conserva visible en el pedido dentro del admin, que es
   * donde hace falta para soporte.
   */
  PackWidget.prototype.addToCart = function () {
    var self = this;
    if (this.busy) return;
    var p = this.preview();
    if (!p.applies) return;

    this.busy = true;
    this.render();

    var items = this.pack.items || [];
    var elegidos = this.selected
      .map(function (id) {
        for (var i = 0; i < items.length; i++) if (items[i].productId === id) return items[i];
        return null;
      })
      .filter(Boolean);

    var props = {};
    props[this.pack.attribute] = this.pack.campaignId;

    // Un pack por carrito (decisión de producto del 2026-09-05): antes de
    // agregar, se quitan las líneas de un pack anterior. Sin esto, armar un pack
    // dos veces dejaría dos packs superpuestos y el total dejaría de coincidir
    // con lo que el comprador vio.
    this.clearPreviousPack()
      .then(function () {
        return fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            items: elegidos.map(function (it) {
              return {
                id: it.liveVariantId || numericId(it.variantId),
                quantity: 1,
                properties: props,
              };
            }),
          }),
        });
      })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.description || r.status); });
        window.location.href = "/cart";
      })
      .catch(function (err) {
        self.busy = false;
        self.render();
        console.error("[DiscountFlow] No se pudo agregar el pack al carrito.", err);
        window.alert("No pudimos agregar el pack al carrito. Volvé a intentarlo.");
      });
  };

  PackWidget.prototype.clearPreviousPack = function () {
    var attr = this.pack.attribute;
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cart) {
        if (!cart || !cart.items) return;
        var previas = cart.items.filter(function (l) {
          return l.properties && l.properties[attr];
        });
        // En serie y por `key`: los índices se mueven al quitar líneas, la clave
        // no.
        return previas.reduce(function (cadena, linea) {
          return cadena.then(function () {
            return fetch("/cart/change.js", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: linea.key, quantity: 0 }),
            });
          });
        }, Promise.resolve());
      })
      .catch(function () {
        /* si el carrito no se puede leer, se sigue: agregar es lo importante */
      });
  };

  function init() {
    if (!Calc) {
      console.error("[DiscountFlow] pack-calc.js no cargó: el widget no puede calcular.");
      return;
    }
    var roots = document.querySelectorAll("[data-df-pack]");
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].dataset.dfPackReady) continue;
      roots[i].dataset.dfPackReady = "1";
      new PackWidget(roots[i]).load();
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();

  // El editor de temas re-renderiza las secciones sin recargar la página.
  document.addEventListener("shopify:section:load", init);
})();
