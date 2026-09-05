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

  /** Tope para que el spinner nunca sea eterno. Ver el vigilante en `load`. */
  var TIEMPO_MAXIMO_MS = 10000;

  /** Alto de la barra de progreso, en píxeles. Se escribe EN LÍNEA. Ver abajo. */
  var ALTO_BARRA = 6;

  /** Los widgets vivos de la página, para poder resincronizarlos. */
  var widgets = [];

  /**
   * Diagnóstico de un comando: `dfPack()` en la consola.
   *
   * Existe porque el 2026-09-05 el widget no arrancó dos veces seguidas y no
   * había forma de saber, sin abrir la pestaña de red y comparar archivos, si
   * el asset no había llegado, había llegado viejo, o había llegado y fallado.
   *
   * ⚠️ Si `dfPack` no existe en la consola, ESO YA ES LA RESPUESTA: este archivo
   * no se está ejecutando. La causa más probable es el fallo de Shopify con
   * varios bloques de una misma theme app extension — ver el comentario de
   * `blocks/pack-builder.liquid`.
   */
  window.dfPack = function () {
    var caja = document.querySelector("[data-df-pack]");
    var aviso = document.querySelector("[data-df-pack-notice]");
    var cssBuild = "";
    try {
      if (caja)
        cssBuild = (window.getComputedStyle(caja).getPropertyValue("--df-build") || "").trim();
    } catch (e) {
      /* ignorado */
    }

    var info = {
      buildDelLiquid: caja ? caja.getAttribute("data-df-build") : "(sin bloque de armador en esta página)",
      buildDelLiquidAviso: aviso ? aviso.getAttribute("data-df-build") : "(sin bloque de aviso en esta página)",
      buildDelJS: String(window.DF_PACK_BUILD),
      buildDelCSS: cssBuild || "🔴 el CSS no llegó",
      archivosJSCargados: (window.DF_PACK_CARGADOS || []).join(", ") || "🔴 ninguno",
      calculoDisponible: !!window.DiscountFlowPackCalc,
      widgetsIniciados: widgets.length,
      packCargado: widgets.length ? !!widgets[0].pack : false,
      seleccionados: widgets.length ? widgets[0].selected.length : 0,
      enCarrito: widgets.length ? widgets[0].enCarrito.length : 0,
      proxy: caja ? caja.getAttribute("data-proxy") : null,
    };

    var mismos =
      String(info.buildDelLiquid) === String(info.buildDelJS) &&
      String(info.buildDelCSS) === String(info.buildDelJS);

    try {
      console.log(
        mismos
          ? "✅ Liquid, JS y CSS están en la MISMA versión (build " + info.buildDelJS + ")"
          : "🔴 VERSIONES DISTINTAS — el CDN está sirviendo algo viejo. Ver el procedimiento del handoff."
      );
      console.table ? console.table(info) : console.log(info);
    } catch (e) {
      /* ignorado */
    }
    return info;
  };

  /**
   * Las clases con las que el TEMA pinta un botón.
   *
   * Dawn y los temas Online Store 2.0 usan `.button` (+ `.button--secondary`);
   * los vintage usan `.btn` (+ `.btn--secondary`). Se ponen las dos familias a
   * la vez: la que el tema tenga definida gana y la otra no existe, así que no
   * hay conflicto. Es la única forma de que el botón salga con el color, la
   * forma y el hover de la tienda en vez de con los nuestros.
   *
   * Y es lo que pinta el estado "elegido / no elegido": primaria contra
   * secundaria DEL TEMA, no un verde inventado por nosotros.
   */
  function themeBtn(primaria) {
    return primaria
      ? "button btn"
      : "button button--secondary btn btn--secondary";
  }

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
    /**
     * Los productos de este pack que YA están en el carrito.
     *
     * Se usa para dos cosas: precargar la selección al abrir la página, y
     * cambiar el texto del botón — «agregar» y «actualizar» no son lo mismo
     * para quien ya armó su pack.
     */
    this.enCarrito = [];
    this.pack = null;
    this.busy = false;
  }

  PackWidget.prototype.load = function () {
    var self = this;
    var url = this.proxy + (this.campaignId ? "?campaign=" + encodeURIComponent(this.campaignId) : "");

    // 🔴 Vigilante: pase lo que pase, el bloque llega a un estado definitivo.
    //
    // El 2026-09-05 el widget se quedó eternamente en «Cargando tu pack…».
    // La causa fue un parcheo de `window.fetch` que hacía que la llamada
    // lanzara de forma SÍNCRONA: la excepción salía de `load()` antes de que
    // hubiera cadena a la que enganchar el `.catch`, así que ni se pintaba ni
    // se ocultaba. Un spinner eterno es la peor respuesta posible — no dice
    // nada y no se puede diagnosticar.
    //
    // Esto lo cubre por construcción, sea cual sea la causa del cuelgue:
    // un proxy que no responde, una red caída o un fallo que no previmos.
    var vigilante = setTimeout(function () {
      if (!self.pack) {
        self.fallar("El pack tardó demasiado en cargar.", null);
      }
    }, TIEMPO_MAXIMO_MS);
    var listo = function () {
      clearTimeout(vigilante);
    };

    // `Promise.resolve().then(...)` convierte un throw SÍNCRONO de `fetch` en
    // un rechazo normal, para que el `.catch` de abajo lo vea siempre.
    return Promise.resolve()
      .then(function () {
        return fetch(url, { headers: { Accept: "application/json" } });
      })
      .then(function (r) {
        if (!r.ok) throw new Error("proxy " + r.status);
        return r.json();
      })
      .then(function (data) {
        listo();
        if (!data || !data.pack) {
          // Sin campaña activa el bloque desaparece en vez de mostrar un cascarón
          // vacío. El merchant lo ve en el editor de temas; el comprador, no.
          self.ocultar();
          return;
        }
        self.pack = data.pack;
        return self.leerCarrito().then(function () {
          self.render();
          self.refreshPrices();
        });
      })
      .catch(function (err) {
        listo();
        self.fallar(
          "No se pudo cargar el pack. Revisá que el App proxy apunte a la URL " +
            "correcta (Partner Dashboard → App setup → App proxy).",
          err
        );
      });
  };

  /**
   * Precarga la selección con el pack que el comprador YA tiene en el carrito.
   *
   * Sin esto, alguien que armó su pack, fue al carrito y volvió se encontraba el
   * widget en cero —«0 productos», botón deshabilitado— mientras el carrito, en
   * la misma pantalla, mostraba su pack con el descuento aplicado. Dos verdades
   * distintas sobre lo mismo en la misma página.
   *
   * Se leen solo las líneas marcadas con ESTA campaña y cuyo producto siga en el
   * catálogo curado: si el merchant sacó un producto del pack, no se precarga
   * algo que ya no forma parte de él.
   *
   * ⚠️ En la Ajax Cart API `properties` es un OBJETO. En el payload REST del
   * pedido (el webhook de atribución) es un ARRAY de {name, value}. Es el mismo
   * dato con dos formas según por dónde se lea.
   */
  PackWidget.prototype.leerCarrito = function () {
    var self = this;
    return Promise.resolve()
      .then(function () {
        return fetch("/cart.js", { headers: { Accept: "application/json" } });
      })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cart) {
        if (!cart || !cart.items || !cart.items.length) return;

        var enCatalogo = {};
        (self.pack.items || []).forEach(function (it) {
          enCatalogo[it.productId] = true;
        });

        var attr = self.pack.attribute;
        var yaEstan = [];
        cart.items.forEach(function (l) {
          if (!l.properties || l.properties[attr] !== self.pack.campaignId) return;
          var gid = "gid://shopify/Product/" + l.product_id;
          if (!enCatalogo[gid]) return;
          if (yaEstan.indexOf(gid) === -1) yaEstan.push(gid);
        });

        if (!yaEstan.length) return;
        self.enCarrito = yaEstan;
        self.selected = yaEstan.slice();
      })
      .catch(function () {
        // Si el carrito no se puede leer, se empieza vacío. Es peor experiencia,
        // no un error: el comprador puede armar su pack igual.
      });
  };

  /** Deja el bloque sin rastro: ni contenido ni caja. */
  PackWidget.prototype.ocultar = function () {
    this.root.innerHTML = "";
    this.root.hidden = true;
  };

  /**
   * Falla en silencio para el comprador y en voz alta para quien depure.
   *
   * Un comprador no debe ver un error técnico; quien abra la consola tiene que
   * encontrar la causa en un segundo.
   */
  PackWidget.prototype.fallar = function (mensaje, err) {
    this.ocultar();
    console.error("[DiscountFlow] " + mensaje, err || "");
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
      var fraccion = Math.max(0, Math.min(1, p.distinctProducts / tope));

      var porcentaje = Math.round(fraccion * 100);

      // 🔴 TODA la geometría va EN LÍNEA, no en la hoja de estilos.
      //
      // Es la tercera versión de esta barra. La primera usaba `width` en % con
      // `height: 100%`; la segunda, `transform: scaleX()`. Las dos se veían
      // vacías en la tienda, con los números correctos. Cuando dos técnicas
      // distintas fallan igual, el problema deja de ser la técnica: algo del
      // tema las estaba anulando. Un estilo en línea gana a cualquier hoja del
      // tema sin `!important`, así que esto ya no depende de qué CSS tenga el
      // merchant.
      var pista = el("div", "df-pack__bar");
      pista.style.position = "relative";
      pista.style.display = "block";
      pista.style.width = "100%";
      pista.style.height = ALTO_BARRA + "px";
      pista.style.minHeight = ALTO_BARRA + "px";
      pista.style.overflow = "hidden";
      pista.style.borderRadius = "999px";

      var relleno = el("div", "df-pack__bar-fill");
      relleno.style.display = "block";
      relleno.style.height = ALTO_BARRA + "px";
      relleno.style.minHeight = ALTO_BARRA + "px";
      relleno.style.width = porcentaje + "%";
      relleno.style.background = "currentColor";
      relleno.style.borderRadius = "999px";
      // Sin `position: absolute`: así no depende de que el carril sea un bloque
      // contenedor, que es una condición más que un tema puede alterar.

      // Expuesto en el DOM para poder depurarlo sin reproducir el estado.
      pista.setAttribute("data-df-progress", String(porcentaje));
      pista.setAttribute("role", "progressbar");
      pista.setAttribute("aria-valuemin", "0");
      pista.setAttribute("aria-valuemax", String(tope));
      pista.setAttribute("aria-valuenow", String(p.distinctProducts));
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

      var btn = el("button", "df-pack__toggle " + themeBtn(elegido));
      btn.type = "button";
      btn.setAttribute("aria-pressed", elegido ? "true" : "false");
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
      // Desglose por producto. En el wireframe cada línea mostraba lo suyo, y
      // con precios distintos el mismo porcentaje da ahorros distintos: el
      // total solo no explica de dónde sale.
      var titulos = {};
      (pack.items || []).forEach(function (it) {
        titulos[it.productId] = it.title;
      });
      var ahorroPorProducto = {};
      var pctPorProducto = {};
      (p.rows || []).forEach(function (r) {
        ahorroPorProducto[r.productId] = r.savings;
        pctPorProducto[r.productId] = r.percent;
      });

      var lista = el("ul", "df-pack__items");
      // Se recorre lo ELEGIDO, no las filas con descuento: un producto al 0%
      // está en el pack y tiene que aparecer, diciendo que no rebaja.
      self.selected.forEach(function (id) {
        var li = el("li", "df-pack__item");
        li.appendChild(el("span", "df-pack__item-name", titulos[id] || "—"));
        if (ahorroPorProducto[id] > 0) {
          li.appendChild(
            el(
              "span",
              "df-pack__item-save",
              "−" + money(ahorroPorProducto[id], pack.currency) +
                " (" + pctPorProducto[id] + "%)"
            )
          );
        } else {
          li.appendChild(el("span", "df-pack__item-none", "sin descuento"));
        }
        lista.appendChild(li);
      });
      panel.appendChild(lista);

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

    var yaHayPack = this.enCarrito.length > 0;
    if (yaHayPack) {
      panel.appendChild(
        el(
          "p",
          "df-pack__hint",
          "Ya tenés " +
            this.enCarrito.length +
            (this.enCarrito.length === 1 ? " producto" : " productos") +
            " de este pack en el carrito."
        )
      );
    }

    // El botón va dentro de un envoltorio que en escritorio no hace nada y en
    // móvil ES la barra fija del pie. Un solo botón, no una copia: dos botones
    // serían dos manejadores y dos estados que mantener en sintonía.
    var ctaWrap = el("div", "df-pack__cta-wrap");

    // Total compacto, exclusivo de la barra del pie (oculto en escritorio).
    var barTotal = el("div", "df-pack__bar-total");
    barTotal.appendChild(el("span", "df-pack__bar-total-label", "Total"));
    barTotal.appendChild(
      el(
        "span",
        "df-pack__bar-total-value",
        p.applies ? money(p.total, pack.currency) : money(p.subtotal, pack.currency)
      )
    );
    ctaWrap.appendChild(barTotal);

    var cta = el("button", "df-pack__cta " + themeBtn(true));
    cta.type = "button";
    cta.textContent = this.busy
      ? "Agregando…"
      : yaHayPack
      ? "Actualizar mi pack"
      : this.ctaLabel;
    cta.disabled = !p.applies || this.busy;
    cta.addEventListener("click", function () {
      self.addToCart();
    });
    ctaWrap.appendChild(cta);
    panel.appendChild(ctaWrap);

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
    var roots = document.querySelectorAll("[data-df-pack]");

    if (!Calc) {
      // Antes esto solo se registraba en consola y el bloque se quedaba con el
      // «Cargando…» para siempre. Ahora también se retira: un estado indefinido
      // es peor que ninguno.
      console.error("[DiscountFlow] pack-calc.js no cargó: el widget no puede calcular.");
      for (var j = 0; j < roots.length; j++) {
        roots[j].innerHTML = "";
        roots[j].hidden = true;
      }
      return;
    }

    for (var i = 0; i < roots.length; i++) {
      if (roots[i].dataset.dfPackReady) continue;
      roots[i].dataset.dfPackReady = "1";
      var w = new PackWidget(roots[i]);
      widgets.push(w);
      w.load();
    }
  }

  /** Vuelve a leer el carrito y repinta, sin rehacer la carga entera. */
  function resincronizar() {
    for (var i = 0; i < widgets.length; i++) {
      (function (w) {
        if (!w.pack) return;
        w.enCarrito = [];
        w.selected = [];
        w.leerCarrito().then(function () {
          w.render();
        });
      })(widgets[i]);
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();

  // El editor de temas re-renderiza las secciones sin recargar la página.
  document.addEventListener("shopify:section:load", init);

  // Lo emite el bloque de aviso cuando detecta una mutación del carrito. Cubre
  // el caso de quitar una línea desde el cajón del carrito, en la misma página.
  document.addEventListener("df:pack-cart-changed", resincronizar);

  // Volver con el botón atrás desde /cart restaura la página desde la caché sin
  // ejecutar nada: sin esto, el widget mostraría la selección de antes de que el
  // comprador editara su carrito.
  window.addEventListener("pageshow", function (e) {
    if (e && e.persisted) resincronizar();
  });
})();
