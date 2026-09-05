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

  /**
   * El `money_format` del tema, tal como lo publica Liquid. Ej: `${{amount}}`.
   *
   * 🔴 Existe porque el widget formateaba el dinero con `Intl` mientras el resto
   * de la tienda lo formatea con el formato del merchant. En una tienda chilena
   * eso daba «$18,990.00» al lado de «$18.990» en la misma pantalla. Ahora el
   * bloque lo pasa en `data-money-format` y acá se aplica igual que en el tema.
   * Si no llegara, se cae a `Intl`, que es lo que había.
   */
  var formatoDelTema = "";

  function separar(valor, decimales, miles, decimal) {
    var texto = Math.abs(valor).toFixed(decimales);
    var partes = texto.split(".");
    partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, miles);
    return (valor < 0 ? "-" : "") + (partes.length > 1 ? partes[0] + decimal + partes[1] : partes[0]);
  }

  /** Los marcadores que documenta Shopify para `money_format`. */
  function aplicarFormatoDelTema(valor, formato) {
    return formato.replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, clave) {
      switch (clave) {
        case "amount":
          return separar(valor, 2, ",", ".");
        case "amount_no_decimals":
          return separar(valor, 0, ",", ".");
        case "amount_with_comma_separator":
          return separar(valor, 2, ".", ",");
        case "amount_no_decimals_with_comma_separator":
          return separar(valor, 0, ".", ",");
        case "amount_with_apostrophe_separator":
          return separar(valor, 2, "'", ".");
        case "amount_no_decimals_with_space_separator":
          return separar(valor, 0, " ", ".");
        case "amount_with_space_separator":
          return separar(valor, 2, " ", ",");
        default:
          return "";
      }
    });
  }

  /** `valor` va en UNIDADES de la moneda, no en centavos. */
  function money(valor, currency) {
    if (formatoDelTema && formatoDelTema.indexOf("{{") > -1) {
      try {
        return aplicarFormatoDelTema(valor, formatoDelTema);
      } catch (e) {
        /* se cae a Intl */
      }
    }
    try {
      return new Intl.NumberFormat(document.documentElement.lang || "es", {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: 2,
      }).format(valor);
    } catch (e) {
      return String(Math.round(valor));
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
    // El formato de dinero del tema, para que el widget no escriba los números
    // de otra forma que el resto de la tienda. Es global porque `money()` no
    // pertenece a ningún widget, y en una página con dos bloques el formato es
    // el mismo: sale de la tienda, no del bloque.
    if (root.dataset.moneyFormat) formatoDelTema = root.dataset.moneyFormat;
    this.selected = [];
    /** ¿Se pudo leer /cart.js en el último intento? Lo usa la revalidación. */
    this.carritoLeido = false;
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

  /**
   * Los datos que el bloque Liquid dejó escritos en la página.
   *
   * 🔴 ES EL CAMINO NORMAL. El bloque se pinta entero en el servidor y deja acá
   * la configuración del pack con los precios YA RESUELTOS por Liquid. No hay
   * petición, no hay estado de carga, y el widget no depende de que nuestro
   * servidor conteste para que el comprador vea algo.
   *
   * Devuelve null si no está —tienda sin el metafield escrito, o campaña que no
   * figura en él—, y entonces se usa el app proxy, que es el camino viejo con su
   * «Cargando tu pack…».
   */
  PackWidget.prototype.leerIncrustado = function () {
    try {
      if (!this.root.querySelector) return null;
      var nodo = this.root.querySelector("[data-df-pack-data]");
      if (!nodo) return null;
      var datos = JSON.parse(nodo.textContent);
      if (!datos || !datos.items || !datos.items.length) return null;
      return datos;
    } catch (e) {
      console.error("[DiscountFlow] los datos incrustados del pack no se pudieron leer.", e);
      return null;
    }
  };

  PackWidget.prototype.load = function () {
    var datos = this.leerIncrustado();
    if (datos) {
      this.pack = {
        campaignId: datos.campaignId,
        heading: datos.heading,
        mode: datos.mode,
        tiers: datos.tiers || [],
        minProducts: datos.minProducts,
        attribute: datos.attribute,
        currency: datos.currency,
        items: datos.items,
      };
      // La selección también viene del servidor: Liquid la sacó de `cart.items`.
      this.enCarrito = (datos.seleccionados || []).slice();
      this.selected = this.enCarrito.slice();
      this.render();
      this.revalidar();
      return Promise.resolve();
    }
    return this.cargarDesdeProxy();
  };

  /**
   * Comprueba en SEGUNDO PLANO que lo pintado siga siendo verdad. Sin spinner:
   * ya hay un widget usable en pantalla y esto solo lo corrige si algo difiere.
   *
   * Dos cosas se revisan, por dos motivos distintos:
   *
   *   · El CARRITO, contra /cart.js. El tema puede haber servido esta página
   *     desde una caché con un carrito viejo, y entonces la preselección que
   *     escribió Liquid no sería la del comprador.
   *   · El CATÁLOGO, contra el app proxy. El metafield que lee Liquid puede
   *     quedarse cacheado horas del lado de Shopify; el proxy sale de Postgres
   *     y siempre está al día.
   */
  PackWidget.prototype.revalidar = function () {
    var self = this;
    var antes = this.huella();
    var previaEnCarrito = this.enCarrito.slice();
    var previaSeleccion = this.selected.slice();

    this.carritoLeido = false;
    this.enCarrito = [];
    this.selected = [];

    return this.leerCarrito()
      .then(function () {
        if (!self.carritoLeido) {
          // /cart.js no contesto. Lo que pinto Liquid vale mas que nada.
          self.enCarrito = previaEnCarrito;
          self.selected = previaSeleccion;
        }
        return self.pedirAlProxy().catch(function () {
          // Si el proxy no contesta no pasa nada: lo pintado sigue siendo
          // válido. Es una comprobación, no una dependencia.
          return null;
        });
      })
      .then(function (fresco) {
        if (fresco) self.adoptar(fresco);
        if (self.huella() !== antes) self.render();
      })
      .catch(function (err) {
        console.error("[DiscountFlow] la revalidación del pack falló.", err);
      });
  };

  /** Un resumen de lo que se está mostrando, para saber si cambió algo. */
  PackWidget.prototype.huella = function () {
    var items = (this.pack && this.pack.items) || [];
    return JSON.stringify([
      this.pack ? this.pack.heading : null,
      this.pack ? this.pack.minProducts : null,
      this.pack ? this.pack.tiers : null,
      items.map(function (i) {
        return [i.productId, i.percent || 0, i.price];
      }),
      this.selected.slice().sort(),
    ]);
  };

  /**
   * Adopta el catálogo del proxy CONSERVANDO los precios de Liquid.
   *
   * El proxy sirve la foto que guardó el admin, que puede tener el precio viejo;
   * Liquid resolvió el precio en vivo. Así que el proxy manda en QUÉ productos
   * hay y con qué porcentaje, y Liquid manda en CUÁNTO valen.
   */
  PackWidget.prototype.adoptar = function (fresco) {
    var viejos = {};
    ((this.pack && this.pack.items) || []).forEach(function (i) {
      viejos[i.productId] = i;
    });

    this.pack.heading = this.headingOverride || fresco.heading;
    this.pack.mode = fresco.mode;
    this.pack.tiers = fresco.tiers || [];
    this.pack.minProducts = fresco.minProducts;
    this.pack.items = (fresco.items || []).map(function (nuevo) {
      var viejo = viejos[nuevo.productId];
      if (!viejo) return nuevo;
      // El porcentaje es configuración: manda el proxy. El precio y la variante
      // son del storefront: manda lo que resolvió Liquid.
      return {
        productId: viejo.productId,
        handle: viejo.handle,
        title: viejo.title,
        variantId: viejo.variantId,
        liveVariantId: viejo.liveVariantId,
        available: viejo.available,
        price: viejo.price,
        image: viejo.image,
        percent: nuevo.percent,
      };
    });

    // Lo que ya no esté en el catálogo deja de estar elegido.
    var enCatalogo = {};
    this.pack.items.forEach(function (i) {
      enCatalogo[i.productId] = true;
    });
    this.selected = this.selected.filter(function (id) {
      return enCatalogo[id];
    });
    this.enCarrito = this.enCarrito.filter(function (id) {
      return enCatalogo[id];
    });
  };

  /** Pide la configuración al app proxy. Devuelve el pack o null. */
  PackWidget.prototype.pedirAlProxy = function () {
    var url =
      this.proxy + (this.campaignId ? "?campaign=" + encodeURIComponent(this.campaignId) : "");
    return Promise.resolve()
      .then(function () {
        return fetch(url, { headers: { Accept: "application/json" } });
      })
      .then(function (r) {
        if (!r.ok) throw new Error("proxy " + r.status);
        return r.json();
      })
      .then(function (data) {
        return data && data.pack ? data.pack : null;
      });
  };

  PackWidget.prototype.cargarDesdeProxy = function () {
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
        if (!cart) return;
        // Se marca ANTES de mirar el contenido: un carrito vacio tambien es una
        // lectura buena, y la revalidacion necesita distinguir "esta vacio" de
        // "no se pudo leer". Sin esto, un /cart.js caido borraria la seleccion
        // que Liquid ya habia pintado bien.
        self.carritoLeido = true;
        if (!cart.items || !cart.items.length) return;

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

      card.appendChild(body);

      // 🔴 El botón es HERMANO del cuerpo, no hijo suyo.
      //
      // La tarjeta es una rejilla con áreas, y eso es lo que deja que la MISMA
      // marca se vea de dos formas: en escritorio el botón cae debajo del texto
      // (área "action" en la segunda fila) y en móvil pasa a ser una tercera
      // columna a la derecha, cuadrada. Si el botón viviera dentro del cuerpo,
      // en móvil no habría forma de sacarlo de esa columna sin tocar el DOM.
      //
      // El texto va en dos hijos y NO en el botón: el ícono se ve en móvil, la
      // etiqueta en escritorio, y `aria-label` lleva siempre la frase completa
      // para que un lector de pantalla nunca escuche solo «más».
      var etiqueta = elegido ? "Quitar del pack" : "Agregar al pack";
      var btn = el("button", "df-pack__toggle " + themeBtn(elegido));
      btn.type = "button";
      btn.setAttribute("aria-pressed", elegido ? "true" : "false");
      btn.setAttribute("aria-label", etiqueta + ": " + item.title);
      btn.appendChild(el("span", "df-pack__toggle-icon", elegido ? "−" : "+"));
      btn.appendChild(el("span", "df-pack__toggle-label", etiqueta));
      btn.addEventListener("click", function () {
        self.toggle(item.productId);
      });
      card.appendChild(btn);

      grid.appendChild(card);
    });
    root.appendChild(grid);

    // ── Resumen y CTA ──
    // ── El panel «Tu pack» ──
    //
    // Sigue al wireframe: un encabezado con el nombre del panel y el contador,
    // y debajo o bien la caja de «está vacío» o bien una línea por producto
    // elegido con su foto, su ahorro, su precio y su «Quitar».
    var panel = el("div", "df-pack__summary");

    var cabecera = el("div", "df-pack__panel-head");
    cabecera.appendChild(el("span", "df-pack__panel-title", "Tu pack"));
    cabecera.appendChild(
      el(
        "span",
        "df-pack__count",
        p.distinctProducts === 1 ? "1 producto" : p.distinctProducts + " productos"
      )
    );
    panel.appendChild(cabecera);

    /** Cuántos faltan para que el descuento se active, en palabras. */
    var faltan = Math.max(0, pack.minProducts - p.distinctProducts);
    var textoFaltan =
      "Agregá " +
      faltan +
      (faltan === 1 ? " producto más" : " productos más") +
      " para activar el descuento.";

    if (!self.selected.length) {
      // Caja de vacío, no un renglón suelto: en el wireframe ocupa su sitio y
      // dice qué hacer. Antes acá solo había «0 PRODUCTOS» y una frase, que en
      // móvil se leía como si el widget no hubiera cargado.
      var vacio = el("div", "df-pack__empty-box");
      vacio.appendChild(el("span", "df-pack__empty-title", "Tu pack está vacío"));
      vacio.appendChild(el("p", "df-pack__hint", textoFaltan));
      panel.appendChild(vacio);
    } else {
      // Desglose por producto. En el wireframe cada línea mostraba lo suyo, y
      // con precios distintos el mismo porcentaje da ahorros distintos: el
      // total solo no explica de dónde sale.
      var porId = {};
      (pack.items || []).forEach(function (it) {
        porId[it.productId] = it;
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
        var it = porId[id];
        var li = el("li", "df-pack__item");

        var thumb = el("div", "df-pack__item-media");
        if (it && it.image) {
          var mini = document.createElement("img");
          mini.src = it.image;
          mini.alt = "";
          mini.loading = "lazy";
          thumb.appendChild(mini);
        }
        li.appendChild(thumb);

        var cuerpo = el("div", "df-pack__item-body");
        cuerpo.appendChild(el("span", "df-pack__item-name", it ? it.title : "—"));
        if (ahorroPorProducto[id] > 0) {
          cuerpo.appendChild(
            el(
              "span",
              "df-pack__item-save",
              "Ahorrás " +
                money(ahorroPorProducto[id], pack.currency) +
                " (" + pctPorProducto[id] + "%)"
            )
          );
        } else {
          cuerpo.appendChild(
            el(
              "span",
              "df-pack__item-none",
              p.applies ? "sin descuento" : "sin descuento todavía"
            )
          );
        }
        li.appendChild(cuerpo);

        var lado = el("div", "df-pack__item-side");
        if (it) lado.appendChild(el("span", "df-pack__item-price", money(it.price, pack.currency)));
        // «Quitar» por línea: en el wireframe está, y sin él la única forma de
        // sacar algo del pack es encontrarlo otra vez en la lista de abajo.
        var quitar = el("button", "df-pack__item-remove", "Quitar");
        quitar.type = "button";
        quitar.setAttribute("aria-label", "Quitar del pack: " + (it ? it.title : ""));
        quitar.addEventListener("click", function () {
          self.toggle(id);
        });
        lado.appendChild(quitar);
        li.appendChild(lado);

        lista.appendChild(li);
      });
      panel.appendChild(lista);
    }

    if (self.selected.length && !p.applies) {
      panel.appendChild(el("p", "df-pack__hint", textoFaltan));
    }

    if (p.applies) {
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

    // El botón va dentro de un envoltorio propio. Un solo botón, no una copia:
    // dos botones serían dos manejadores y dos estados que mantener en
    // sintonía. En móvil ese envoltorio ES la barra del pie (`position: sticky`,
    // ver el CSS).
    var ctaWrap = el("div", "df-pack__cta-wrap");

    // Los números de la barra del pie: ahorro, precio tachado y total. Solo se
    // ven en móvil; en escritorio los da la tabla del panel, que está a la vista
    // todo el tiempo. Se pintan siempre para que la barra no cambie de alto al
    // pasar del carrito vacío al carrito con pack.
    var barTotal = el("div", "df-pack__bar-total");
    var barIzq = el("div", "df-pack__bar-left");
    if (p.applies && p.savings > 0) {
      barIzq.appendChild(
        el("span", "df-pack__bar-save", "Ahorrás " + money(p.savings, pack.currency))
      );
      barIzq.appendChild(
        el("span", "df-pack__bar-strike", money(p.subtotal, pack.currency))
      );
    } else {
      barIzq.appendChild(
        el(
          "span",
          "df-pack__bar-label",
          faltan > 0
            ? textoFaltan
            : p.distinctProducts === 1
            ? "1 producto"
            : p.distinctProducts + " productos"
        )
      );
    }
    barTotal.appendChild(barIzq);
    barTotal.appendChild(
      el(
        "span",
        "df-pack__bar-value",
        money(p.applies ? p.total : p.subtotal, pack.currency)
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

    // 🔴 EL BOTÓN NO CUELGA DEL PANEL: cuelga del `aside`, hermano suyo.
    //
    // Es lo que hace posible la barra pegajosa del móvil. `position: sticky`
    // solo puede desplazarse DENTRO de su bloque contenedor: si el botón viviera
    // dentro del panel —que en móvil está arriba del todo— su recorrido sería el
    // alto del panel y la barra se despegaría a los dos dedos de scroll.
    //
    // En escritorio el `aside` es la columna derecha pegada arriba, igual que
    // antes. En móvil se anula con `display: contents`, el panel y la barra
    // pasan a ser hijos directos del widget, y el recorrido de la barra es el
    // widget entero: se ve mientras el comprador mira el pack y se va con él.
    var aside = el("div", "df-pack__aside");
    aside.appendChild(panel);
    aside.appendChild(ctaWrap);
    root.appendChild(aside);
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
