/*
 * DiscountFlow · Cupones de viaje — widget de la ficha de producto.
 *
 * Se sirve por el app proxy: /apps/discountflow/cupones-viaje.js
 * Se instala UNA vez pegando en el tema (bloque «Liquid personalizado»):
 *
 *   <div data-df-cupones-viaje data-product-id="{{ product.id }}"
 *        data-money-format="{{ shop.money_format | escape }}"></div>
 *   <script src="/apps/discountflow/cupones-viaje.js" defer></script>
 *
 * ─── Qué hace ────────────────────────────────────────────────────────────────
 *
 * Pinta los cupones como botones con estilo propio (en línea, heredando la
 * tipografía y los colores del tema). El comprador pincha uno y se aplica;
 * no escribe nada.
 *
 *   · Con «Pago total» elegido → aplica el código al carrito (/cart/update.js,
 *     parámetro `discount`) y el descuento aparece en el carrito.
 *   · Con «Reserva» elegida → NO aplica el código (la reserva se paga completa)
 *     y deja el cupón en los atributos del carrito, que Shopify copia al pedido
 *     para que la agencia lo descuente del saldo.
 *
 * Al cambiar de variante se vuelve a evaluar: si el comprador pasa de Pago total
 * a Reserva, el código se quita del carrito y queda solo la anotación.
 *
 * ─── Reglas de convivencia (estamos en casa de otro) ─────────────────────────
 *
 *   · No se parchea NADA del tema: ni `fetch`, ni eventos, ni el formulario.
 *     (El 2026-09-05 un parcheo de `fetch` del widget de packs rompió el fetch
 *     de la página entera.) Las llamadas van a `window.fetch` explícito.
 *   · Los cupones son `<button type="button">`: no se envían con ningún
 *     formulario ni los confunde con los suyos el selector de variantes.
 *   · Todo va en try/catch. Si algo falla, el bloque se oculta y el tema sigue
 *     igual. Un vigilante de 10 s garantiza que nunca queda a medio pintar.
 *   · Si el tema re-renderiza la sección (algunos lo hacen al cambiar de
 *     variante), el bloque nuevo se inicializa solo.
 */
(function () {
  "use strict";

  var PROXY = "/apps/discountflow/cupones-viaje";
  // Los nombres de los atributos del carrito. El servidor los escribe acá al
  // servir el script; si no están (el código leído en crudo), se piden al proxy.
  var ATRIBUTOS = /*__DF_ATRIBUTOS__*/null;
  /** Prefijo de los códigos que crea la app: así se distinguen de los del comprador. */
  var PREFIJO_NUESTRO = /^DFV/i;

  if (window.__dfCuponesViaje) return;
  window.__dfCuponesViaje = true;

  // ─── Utilidades ─────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function separar(valor, decimales, miles, decimal) {
    var partes = Math.abs(valor).toFixed(decimales).split(".");
    partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, miles);
    return (valor < 0 ? "-" : "") + (partes.length > 1 ? partes[0] + decimal + partes[1] : partes[0]);
  }

  /**
   * El monto con el separador de miles de la tienda y SIN decimales.
   *
   * Se respeta el `money_format` de la tienda (el que el tema publica en
   * `data-money-format`) para que el cupón use el mismo separador que el precio
   * de arriba: GeoTerra muestra «$5,890,000». Pero los decimales se quitan
   * SIEMPRE: los cupones son montos enteros y «$500,000.00» sobra — decisión
   * del 2026-09-25. Una tienda en USD mostraría «$500,000».
   */
  function money(valor, formato) {
    if (formato && formato.indexOf("{{") > -1) {
      try {
        return formato.replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, clave) {
          switch (clave) {
            case "amount":
            case "amount_no_decimals":
              return separar(valor, 0, ",", ".");
            case "amount_with_comma_separator":
            case "amount_no_decimals_with_comma_separator":
              return separar(valor, 0, ".", ",");
            case "amount_with_apostrophe_separator":
              return separar(valor, 0, "'", ".");
            case "amount_with_space_separator":
            case "amount_no_decimals_with_space_separator":
              return separar(valor, 0, " ", ",");
            default:
              return "";
          }
        });
      } catch (e) {
        /* se cae al formato genérico */
      }
    }
    return "$" + separar(valor, 0, ".", ",");
  }

  /** {monto} por pasajero, {total} = monto × pasajeros, {cupon} = el nombre. */
  function rellenar(mensaje, monto, cupon, total) {
    return String(mensaje || "").replace(/\{(monto|cupon|total)\}/g, function (_, k) {
      return k === "monto" ? monto : k === "total" ? total || monto : cupon;
    });
  }

  /**
   * Pasajeros que ya están EN EL CARRITO para esas variantes del viaje.
   *
   * 🔴 Es la fuente de verdad. El 2026-09-25 (pedido #1022) el widget anotó un
   * solo pasajero en un pedido de dos: leía la cantidad de la FICHA en el momento
   * de pinchar el cupón, y las 2 reservas se habían sumado en el carrito (el tema
   * de dev ni siquiera tiene selector de cantidad). Lo que se cobra es lo que
   * hay en el carrito, así que los pasajeros se cuentan ahí.
   */
  function pasajerosEnCarrito(carrito, ids) {
    var n = 0;
    ((carrito && carrito.items) || []).forEach(function (it) {
      if (it && ids.indexOf(String(it.variant_id)) > -1) n += Number(it.quantity) || 0;
    });
    return n;
  }

  /**
   * El nombre del cupón dentro del valor de «Cupón de viaje»
   * («Test 1 · $1,000 por pasajero» → «test 1», normalizado para comparar).
   */
  function nombreDelCupon(valor) {
    var s = String(valor || "");
    var i = s.lastIndexOf(" · ");
    return normalizarNombre(i > -1 ? s.slice(0, i) : s);
  }
  /** Un nombre de cupón, listo para comparar (igual que `normalizarNombre` del servidor). */
  function normalizarNombre(nombre) {
    return String(nombre || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  /**
   * Lo que el guardián de la página del carrito necesita para recalcular sin
   * ir al servidor: el monto por pasajero y cuáles variantes son reservas. Vive
   * en el NAVEGADOR (antes era un atributo oculto del carrito, y la agencia lo
   * veía en el pedido). Si el navegador no lo guarda, el guardián lo pide.
   */
  var RECUERDO = "df-cupon-viaje";

  /** Campañas cuyo cupón el comprador quitó en esta visita (pestaña). */
  var SOLTADOS = "df-cupon-viaje-soltado";
  function recordarSoltado(campaignId) {
    try {
      var l = JSON.parse(window.sessionStorage.getItem(SOLTADOS) || "[]");
      if (l.indexOf(campaignId) < 0) l.push(campaignId);
      window.sessionStorage.setItem(SOLTADOS, JSON.stringify(l));
    } catch (e) {
      /* sin almacenamiento: se vuelve a marcar al recargar, nada más */
    }
  }
  function fueSoltado(campaignId) {
    try {
      return JSON.parse(window.sessionStorage.getItem(SOLTADOS) || "[]").indexOf(campaignId) > -1;
    } catch (e) {
      return false;
    }
  }
  function recordar(nombre, monto, reservas) {
    try {
      if (nombre) window.localStorage.setItem(RECUERDO, JSON.stringify({ nombre: nombre, monto: monto, reservas: reservas }));
      else window.localStorage.removeItem(RECUERDO);
    } catch (e) {
      /* sin almacenamiento: el guardián lo pide al servidor */
    }
  }
  function recordado(nombre) {
    try {
      var x = JSON.parse(window.localStorage.getItem(RECUERDO) || "null");
      return x && x.nombre === nombre && typeof x.monto === "number" && x.reservas ? x : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Pago total, con las personas del selector de cantidad de la ficha:
   * «2 personas × $1,000 = $2,000». Con una sola: «$1,000 por persona».
   * Es lo que Shopify descuenta en el checkout (el código es por unidad).
   */
  function textoPagoTotal(monto, personas, formato) {
    return personas > 1
      ? personas + " personas × " + money(monto, formato) + " = " + money(monto * personas, formato)
      : money(monto, formato) + " por persona";
  }

  /** El total a descontar del saldo, legible: «$2,000 (2 pasajeros × $1,000)». */
  function textoSaldo(monto, pasajeros, formato) {
    return (
      money(monto * pasajeros, formato) +
      (pasajeros > 1 ? " (" + pasajeros + " pasajeros × " + money(monto, formato) + ")" : "")
    );
  }

  /**
   * Los pasajeros: la cantidad elegida en la ficha. Solo se usa mientras el
   * viaje todavía no está en el carrito (ver `pasajerosEnCarrito`).
   *
   * En GeoTerra el comprador elige cuántas personas viajan con el selector de
   * más y menos, y la cantidad de la línea ES la cantidad de pasajeros. Dawn
   * pone ese input FUERA del formulario de compra, ligado con `form="…"`, así que
   * se busca por las dos vías. No se confunde con el carrito: ahí los inputs se
   * llaman `updates[]`.
   */
  function pasajerosActuales() {
    try {
      var campo =
        document.querySelector('form[data-type="add-to-cart-form"] [name="quantity"]') ||
        document.querySelector('input[name="quantity"][form]') ||
        document.querySelector('input[name="quantity"]');
      var n = campo ? parseInt(campo.value, 10) : 1;
      return n > 0 ? n : 1;
    } catch (e) {
      return 1;
    }
  }

  /**
   * 🔴 TODA lectura-y-escritura del carrito pasa por esta cola, una detrás de
   * otra. Sin ella, una corrección que leyó el carrito con 2 pasajeros podía
   * escribir DESPUÉS de otra que ya había leído 3, y dejar anotado el total
   * viejo.
   */
  var cola = Promise.resolve();
  function enCola(fn) {
    var p = cola.then(function () {
      return fn();
    });
    cola = p.catch(function () {
      /* un fallo no traba la cola */
    });
    return p;
  }

  function pedirJSON(url, opciones) {
    return window.fetch(url, opciones).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " en " + url);
      return r.json();
    });
  }

  /**
   * La variante elegida en la ficha, como id numérico.
   *
   * Se LEE, no se escucha: cada tema avisa el cambio de variante a su manera
   * (Dawn ni siquiera dispara `change` al cambiar el input oculto), así que un
   * sondeo corto es lo único que funciona en todos.
   */
  function varianteActual() {
    try {
      // Primero el formulario de COMPRA. En temas basados en Dawn (GeoTerra lo
      // es) el primer formulario de producto de la página suele ser el de
      // cuotas (`product-form-installment`), que también lleva `name="id"`.
      // Dawn actualiza los dos, pero leer el de compra no depende de eso.
      var campo =
        document.querySelector('form[data-type="add-to-cart-form"] [name="id"]') ||
        document.querySelector('form[action*="/cart/add"] [name="id"]');
      if (campo && campo.value) return String(campo.value);
      var enUrl = new URLSearchParams(window.location.search).get("variant");
      if (enUrl) return enUrl;
    } catch (e) {
      /* sin variante */
    }
    return "";
  }

  /**
   * El aspecto de los cupones es PROPIO, no copiado del tema.
   *
   * Hasta el 2026-09-25 el widget copiaba las clases del selector de variantes
   * del tema. Dos problemas medidos: arrastraba clases de ESTADO (`disabled`
   * tachaba un cupón disponible), y en temas cuyo selector es un desplegable
   * —el de GeoTerra— no había de dónde copiar un botón, así que el cupón sin
   * elegir se veía suelto, sin borde. Ahora el estilo va EN LÍNEA: gana a
   * cualquier hoja del tema sin `!important`, y hereda de él solo la
   * tipografía y los colores.
   *
   * La hoja inyectada queda solo para lo que no se puede poner en línea: el
   * hover y el foco de teclado.
   */
  var ESTILO_ESTADOS =
    ".df-cv__btn:not(:disabled):hover{opacity:.8}" +
    ".df-cv__btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}";

  function inyectarEstilo() {
    if (document.getElementById("df-cv-estilo")) return;
    var s = el("style");
    s.id = "df-cv-estilo";
    s.textContent = ESTILO_ESTADOS;
    document.head.appendChild(s);
  }

  /** El primer fondo no transparente hacia arriba: el «texto claro» del botón elegido. */
  function fondoDeLaPagina(nodo) {
    try {
      for (var n = nodo; n && n.nodeType === 1; n = n.parentElement) {
        var bg = window.getComputedStyle(n).backgroundColor;
        if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
      }
    } catch (e) {
      /* sin estilos computados */
    }
    return "#ffffff";
  }

  function colorDelTexto(nodo) {
    try {
      return window.getComputedStyle(nodo).color || "#121212";
    } catch (e) {
      return "#121212";
    }
  }

  /** El estilo de un cupón según su estado. */
  function estiloDelCupon(elegido, agotado, texto, fondo) {
    return [
      "display:inline-flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:.2em",
      "min-width:8.5em",
      "padding:.75em 1.25em",
      "margin:0",
      "border-radius:8px",
      "font:inherit",
      "line-height:1.25",
      "text-align:center",
      "box-sizing:border-box",
      "transition:background-color .15s,color .15s",
      "border:1.5px " + (agotado ? "dashed" : "solid") + " " + texto,
      "background:" + (elegido ? texto : "transparent"),
      "color:" + (elegido ? fondo : texto),
      "opacity:" + (agotado ? ".45" : "1"),
      "cursor:" + (agotado ? "not-allowed" : "pointer"),
    ].join(";");
  }

  // ─── El widget ──────────────────────────────────────────────────────────────

  var contador = 0;

  function Widget(root) {
    this.root = root;
    this.formato = root.getAttribute("data-money-format") || "";
    this.productId = String(root.getAttribute("data-product-id") || "");
    this.datos = null;
    this.elegido = null; // código del cupón elegido
    this.modalidad = null; // "FULL_PAYMENT" | "RESERVATION" | null
    this.variante = "";
    this.pasajeros = 1;
    this.cantidadFicha = 1;
    this.nombreGrupo = "df-cv-" + ++contador;
  }

  Widget.prototype.ocultar = function () {
    this.root.hidden = true;
  };

  Widget.prototype.arrancar = function () {
    var self = this;
    // Vigilante: pase lo que pase, en 10 s el bloque queda pintado u oculto.
    var vigilante = setTimeout(function () {
      if (!self.root.getAttribute("data-df-estado")) self.ocultar();
    }, 10000);

    if (!/^\d+$/.test(this.productId)) {
      this.ocultar();
      return;
    }

    Promise.resolve()
      .then(function () {
        return Promise.all([
          pedirJSON(PROXY + "?product=" + encodeURIComponent(self.productId), {
            credentials: "same-origin",
          }),
          pedirJSON("/cart.js", { credentials: "same-origin" }).catch(function () {
            return null;
          }),
        ]);
      })
      .then(function (r) {
        clearTimeout(vigilante);
        var datos = r[0] && r[0].campana;
        if (!datos || !datos.coupons || datos.coupons.length === 0) {
          self.root.setAttribute("data-df-estado", "sin-campana");
          self.ocultar();
          return;
        }
        self.datos = datos;
        // Si el carrito ya trae un cupón nuestro que sigue publicado, se
        // muestra elegido: el comprador volvió a la ficha y no tiene que
        // volver a pincharlo.
        var enCarrito = nombreDelCupon(r[1] && r[1].attributes ? r[1].attributes[datos.atributos.cupon] : "");
        if (enCarrito)
          datos.coupons.forEach(function (c) {
            if (c.code && normalizarNombre(c.label) === enCarrito) self.elegido = c.code;
          });
        self.variante = varianteActual();
        self.modalidad = self.modalidadDe(self.variante);
        self.pasajeros = self.contarPasajeros(r[1], self.modalidad);
        self.cantidadFicha = pasajerosActuales();
        self.pintar();
        self.root.setAttribute("data-df-estado", "listo");
        elGuardian(self.formato).sembrar(datos);
        self.vigilarCompraRapida();
        self.marcarSolo();
        setInterval(function () {
          self.revisarVariante();
        }, 400);
        // Con un cupón elegido, el carrito se relee cada pocos segundos: si el
        // comprador agrega otra vez o cambia la cantidad en el carrito lateral,
        // el total anotado se corrige solo. Es la API del carrito de la tienda,
        // no nuestro servidor: no cuesta invocaciones.
        setInterval(function () {
          self.revisarCarrito();
        }, 2500);
      })
      .catch(function (e) {
        clearTimeout(vigilante);
        self.root.setAttribute("data-df-estado", "error");
        self.ocultar();
        if (window.console) console.warn("[DiscountFlow] cupones de viaje:", e);
      });
  };

  /** Las variantes del viaje de una modalidad (o de las dos si no hay). */
  Widget.prototype.idsDe = function (modalidad) {
    var d = this.datos;
    if (modalidad === "FULL_PAYMENT") return d.fullPaymentVariantIds;
    if (modalidad === "RESERVATION") return d.reservationVariantIds;
    return d.fullPaymentVariantIds.concat(d.reservationVariantIds);
  };

  /** Pasajeros: los del carrito si el viaje ya está ahí; si no, los de la ficha. */
  Widget.prototype.contarPasajeros = function (carrito, modalidad) {
    var enCarrito = pasajerosEnCarrito(carrito, this.idsDe(modalidad));
    return enCarrito > 0 ? enCarrito : pasajerosActuales();
  };

  Widget.prototype.revisarCarrito = function () {
    var self = this;
    try {
      if (!this.elegido || this.ocupado || document.hidden) return;
      pedirJSON("/cart.js", { credentials: "same-origin" })
        .then(function (carrito) {
          var p = self.contarPasajeros(carrito, self.modalidad);
          if (p !== self.pasajeros && self.elegido && !self.ocupado) self.aplicar(self.elegido);
        })
        .catch(function () {
          /* se reintenta en la próxima vuelta */
        });
    } catch (e) {
      /* el sondeo nunca rompe la página */
    }
  };

  /**
   * Opción de la campaña «Cupón marcado al entrar» (`autoApply`): al cargar la
   * ficha se aplica solo el primer cupón disponible, igual que si el comprador
   * lo hubiera pinchado. No se marca si:
   *   · el carrito ya trae un cupón (el elegido manda);
   *   · el comprador ya lo quitó en esta visita (se respeta su decisión).
   */
  Widget.prototype.marcarSolo = function () {
    var d = this.datos;
    if (!d.autoApply || this.elegido || fueSoltado(d.campaignId)) return;
    for (var i = 0; i < d.coupons.length; i++)
      if (!d.coupons[i].agotado && d.coupons[i].code) {
        this.aplicar(d.coupons[i].code);
        return;
      }
  };

  Widget.prototype.cupon = function (code) {
    var cs = (this.datos && this.datos.coupons) || [];
    for (var i = 0; i < cs.length; i++) if (cs[i].code && cs[i].code === code) return cs[i];
    return null;
  };

  Widget.prototype.modalidadDe = function (variante) {
    var d = this.datos;
    if (!d || !variante) return null;
    if (d.fullPaymentVariantIds.indexOf(variante) > -1) return "FULL_PAYMENT";
    if (d.reservationVariantIds.indexOf(variante) > -1) return "RESERVATION";
    return null;
  };

  Widget.prototype.revisarVariante = function () {
    try {
      var v = varianteActual();
      // La cantidad de la FICHA se sigue por separado de `this.pasajeros`, que
      // sale del carrito. Si esta función escribiera `this.pasajeros`, pisaría
      // lo que corrige `revisarCarrito` y los dos se corregirían en cada vuelta.
      var cantidad = pasajerosActuales();
      if (v === this.variante && cantidad === this.cantidadFicha) return;
      this.variante = v;
      var m = this.modalidadDe(v);
      var cambioModalidad = m !== this.modalidad;
      var cambioCantidad = cantidad !== this.cantidadFicha;
      this.modalidad = m;
      this.cantidadFicha = cantidad;
      if (!cambioModalidad && !cambioCantidad) return;
      this.pintarMensaje();
      // El cupón elegido se re-aplica: pasar de Pago total a Reserva tiene que
      // QUITAR el código del carrito, y cambiar la cantidad de pasajeros tiene
      // que cambiar el total anotado (o soltar el cupón si ya no alcanza).
      if (this.elegido) this.aplicar(this.elegido);
    } catch (e) {
      /* el sondeo nunca rompe la página */
    }
  };

  Widget.prototype.pintar = function () {
    var self = this;
    var d = this.datos;
    inyectarEstilo();
    this.root.textContent = "";
    this.root.className = (this.root.className + " df-cv").trim();
    // Separación del contenido de arriba y de abajo.
    this.root.style.cssText = "display:block;margin:1.5em 0;font:inherit";
    this.texto = colorDelTexto(this.root);
    this.fondo = fondoDeLaPagina(this.root);

    var titulo = el("p", "df-cv__titulo", d.heading);
    titulo.style.cssText = "margin:0 0 .7em;font-weight:600";
    this.root.appendChild(titulo);

    var opciones = el("div", "df-cv__opciones");
    opciones.setAttribute("role", "group");
    opciones.setAttribute("aria-label", d.heading);
    opciones.style.cssText = "display:flex;flex-wrap:wrap;gap:.6em";
    this.root.appendChild(opciones);

    // Botones y no radios: un <button type="button"> no se envía con ningún
    // formulario ni lo toma por suyo el selector de variantes del tema.
    this.botones = d.coupons.map(function (c) {
      var b = el("button", "df-cv__btn");
      b.type = "button";
      b.disabled = !!c.agotado;
      var nombre = el("span", "df-cv__nombre", c.label);
      nombre.style.cssText = "font-weight:600" + (c.agotado ? ";text-decoration:line-through" : "");
      var sub = el(
        "span",
        "df-cv__sub",
        c.agotado ? "Agotado" : money(c.amount, self.formato) + " · quedan " + c.restantes
      );
      sub.style.cssText = "font-size:.8em;opacity:.85";
      b.appendChild(nombre);
      b.appendChild(sub);
      // Pinchar el cupón elegido lo quita.
      b.addEventListener("click", function () {
        if (c.agotado || !c.code) return;
        var soltar = self.elegido === c.code;
        // Si el comprador QUITA el cupón, no se le vuelve a marcar solo en lo
        // que queda de la visita (ver `marcarSolo`).
        if (soltar) recordarSoltado(d.campaignId);
        self.aplicar(soltar ? null : c.code);
      });
      opciones.appendChild(b);
      return { boton: b, cupon: c };
    });
    this.pintarBotones();

    this.mensaje = el("p", "df-cv__msg");
    this.estado = el("p", "df-cv__estado");
    this.mensaje.style.cssText = "margin:1em 0 0;line-height:1.5";
    this.estado.style.cssText = "margin:.5em 0 0;font-weight:600";
    this.root.appendChild(this.mensaje);
    this.root.appendChild(this.estado);
    this.pintarMensaje();
  };

  /** Repinta el estado de cada botón: elegido o no, disponible o agotado. */
  Widget.prototype.pintarBotones = function () {
    var self = this;
    (this.botones || []).forEach(function (x) {
      var elegido = !!x.cupon.code && x.cupon.code === self.elegido;
      x.boton.setAttribute("aria-pressed", elegido ? "true" : "false");
      x.boton.style.cssText = estiloDelCupon(elegido, !!x.cupon.agotado, self.texto, self.fondo);
    });
  };

  /** El mensaje que corresponde a la modalidad elegida, con el monto del cupón. */
  Widget.prototype.pintarMensaje = function () {
    if (!this.mensaje) return;
    var d = this.datos;
    var c = this.cupon(this.elegido);
    if (!c)
      for (var i = 0; i < d.coupons.length; i++)
        if (!d.coupons[i].agotado) {
          c = d.coupons[i];
          break;
        }
    var texto =
      this.modalidad === "FULL_PAYMENT"
        ? d.messageFullPayment
        : this.modalidad === "RESERVATION"
          ? d.messageReservation
          : "";
    this.mensaje.textContent = c
      ? rellenar(
          texto,
          money(c.amount, this.formato),
          c.label,
          money(c.amount * this.pasajeros, this.formato)
        )
      : "";
    this.mensaje.hidden = !this.mensaje.textContent;
  };

  /**
   * Deja el carrito como corresponde al cupón elegido (o a ninguno).
   *
   * 🔴 `discount` en /cart/update.js REEMPLAZA la lista entera de códigos. Por
   * eso se leen los que ya tiene el carrito y se conservan los que no son
   * nuestros: un comprador con otro código no lo pierde por pinchar un cupón.
   */
  Widget.prototype.aplicar = function (code) {
    var self = this;
    var d = this.datos;
    var modalidad = this.modalidad;
    var pedido = this.cupon(code);
    this.ocupado = true;
    this.elegido = pedido ? code : null;
    this.pintarBotones();
    this.estado.textContent = "";

    var resultado = { cupon: null, aviso: "", pasajeros: 1 };
    return enCola(function () {
      return pedirJSON("/cart.js", { credentials: "same-origin" }).then(function (carrito) {
        // Los pasajeros salen del CARRITO (ver `pasajerosEnCarrito`), leídos
        // justo antes de escribir: lo anotado es lo que se va a cobrar.
        var pasajeros = self.contarPasajeros(carrito, modalidad);
        self.pasajeros = pasajeros;
        resultado.pasajeros = pasajeros;

        // 🔴 El stock cuenta pasajeros: si no quedan cupos para todos, el cupón
        // no se aplica y se dice por qué.
        var c = pedido;
        if (c && pasajeros > c.restantes) {
          resultado.aviso =
            c.label + " tiene " + c.restantes + (c.restantes === 1 ? " cupo" : " cupos") +
            ": no alcanza para " + pasajeros + " pasajeros.";
          c = null;
          self.elegido = null;
          self.pintarBotones();
        }
        resultado.cupon = c;
        self.pintarMensaje();

        var otros = (carrito.discount_codes || [])
          .map(function (x) {
            return x && x.code;
          })
          .filter(function (x) {
            return x && !PREFIJO_NUESTRO.test(x);
          });

        var atributos = {};
        // Los técnicos de antes se BORRAN si el carrito los trae: la agencia
        // solo tiene que ver «Cupón de viaje» y «Descontar del saldo».
        (d.atributos.obsoletos || []).forEach(function (k) {
          if (carrito.attributes && carrito.attributes[k] != null) atributos[k] = "";
        });
        atributos[d.atributos.cupon] = c
          ? c.label + " · " + money(c.amount, self.formato) + " por pasajero"
          : "";
        // El monto a descontar del saldo se anota SOLO en Reserva: en Pago total
        // el descuento ya ocurre en el checkout, y anotarlo también confundiría
        // a la agencia con un doble descuento. Es el TOTAL de los pasajeros: lo
        // que la agencia tiene que restar, sin hacer la cuenta.
        atributos[d.atributos.saldo] =
          c && modalidad === "RESERVATION" ? textoSaldo(c.amount, pasajeros, self.formato) : "";
        recordar(c ? normalizarNombre(c.label) : "", c ? c.amount : 0, d.reservationVariantIds);

        var codigos = c && modalidad === "FULL_PAYMENT" ? otros.concat(c.code) : otros;
        return pedirJSON("/cart/update.js", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ attributes: atributos, discount: codigos.join(",") }),
        });
      });
    })
      .then(function () {
        var c = resultado.cupon;
        var pasajeros = resultado.pasajeros;
        if (resultado.aviso) {
          self.estado.textContent = resultado.aviso;
          return;
        }
        if (!c) return;
        self.estado.textContent =
          modalidad === "RESERVATION"
            ? "✓ " + c.label + " anotado en tu reserva: " + money(c.amount * pasajeros, self.formato) +
              (pasajeros > 1 ? " (" + pasajeros + " pasajeros)" : "")
            : modalidad === "FULL_PAYMENT"
              ? "✓ " + c.label + " aplicado: " + textoPagoTotal(c.amount, pasajerosActuales(), self.formato)
              : "✓ " + c.label + " elegido";
      })
      .catch(function (e) {
        self.estado.textContent = "No se pudo aplicar el cupón. Probá de nuevo.";
        if (window.console) console.warn("[DiscountFlow] cupones de viaje:", e);
      })
      .then(function () {
        self.ocupado = false;
      });
  };

  /**
   * «Comprar ahora» (el botón de compra rápida del tema) va directo al checkout
   * con un carrito NUEVO: sin los atributos ni el código del cupón. Con un cupón
   * elegido, el cupón se perdía entero. Así que, con un cupón elegido, el botón
   * agrega el viaje al carrito, deja el cupón anotado y sigue al checkout.
   *
   * Límite: los botones de pago acelerado que el tema pinta dentro de un iframe
   * (Shop Pay, PayPal…) no se pueden interceptar desde la página.
   */
  Widget.prototype.vigilarCompraRapida = function () {
    var self = this;
    document.addEventListener(
      "click",
      function (ev) {
        try {
          var b =
            ev.target && ev.target.closest
              ? ev.target.closest(".shopify-payment-button__button--unbranded, .shopify-payment-button button")
              : null;
          if (!b || !self.elegido || !self.datos) return;
          var variante = varianteActual();
          if (!self.modalidadDe(variante)) return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          pedirJSON("/cart/add.js", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ items: [{ id: Number(variante), quantity: pasajerosActuales() }] }),
          })
            .then(function () {
              self.modalidad = self.modalidadDe(variante);
              return self.aplicar(self.elegido);
            })
            .then(function () {
              return elGuardian(self.formato).revisar();
            })
            .catch(function (e) {
              if (window.console) console.warn("[DiscountFlow] cupones de viaje (compra rápida):", e);
            })
            .then(function () {
              window.location.href = "/checkout";
            });
        } catch (e) {
          /* nunca rompe la página */
        }
      },
      true
    );
  };

  // ─── El guardián del carrito ────────────────────────────────────────────────
  //
  // 🔴 Pedido #1023 (2026-09-25): el total anotado quedó con los pasajeros de
  // antes. Medido en un navegador real sobre la tienda de dev:
  //   · cambiando la cantidad en el CAJÓN del carrito, la corrección llegaba
  //     entre 3 y 6 s después (el sondeo era de 2,5 s): pinchar «Pagar» antes
  //     dejaba el total viejo;
  //   · cambiando la cantidad en la PÁGINA /cart no se corregía nunca, porque
  //     ahí no corría nada nuestro.
  //
  // El guardián es UNO por página, en la ficha (lo arranca el widget) y en la
  // página del carrito (con la línea de la plantilla del carrito):
  //   1. se entera de cada cambio del carrito que hace el tema (/cart/add,
  //      /cart/change, /cart/update) y corrige en el acto, sin esperar al sondeo;
  //   2. RETIENE el paso al checkout hasta que el carrito dejó de cambiar y el
  //      total está escrito (como mucho 5 s: nunca le traba la compra);
  //   3. y sigue sondeando cada 2,5 s por si el tema cambia el carrito de una
  //      forma que no se ve.
  //
  // Para instalarlo en la página del carrito:
  //
  //   <div data-df-cupones-viaje-carrito hidden
  //        data-money-format="{{ shop.money_format | escape }}"></div>
  //   <script src="/apps/discountflow/cupones-viaje.js" defer></script>

  var guardian = null;
  function elGuardian(formato) {
    if (!guardian) {
      guardian = new Guardian(formato);
      guardian.vigilar();
    }
    return guardian;
  }

  function Guardian(formato) {
    this.formato = formato || "";
    this.atributos = null;
    this.campanas = {}; // id de producto → campaña (o null si no tiene)
    this.activo = false; // el último carrito leído traía un cupón nuestro
    this.pendiente = null;
    this.cambios = 0; // respuestas del carrito vistas (del tema o nuestras)
    this.leido = false; // ya se leyó el carrito al menos una vez
    var self = this;
    // Se cumple cuando se saben los nombres de los atributos (o cuando se sabe
    // que no se van a saber). Hasta entonces el guardián no puede decir si el
    // carrito trae un cupón nuestro.
    this.listo = new Promise(function (cumplir) {
      self.marcarListo = cumplir;
    });
  }

  /** La ficha ya tiene la campaña: se la pasa para no pedirla de nuevo. */
  Guardian.prototype.sembrar = function (campana) {
    var self = this;
    this.atributos = campana.atributos;
    this.sembrada = campana;
    this.marcarListo();
    this.revisar();
  };

  /**
   * Deja el total anotado igual a los pasajeros del carrito. Devuelve una
   * promesa que se cumple cuando el carrito quedó en regla. Varias llamadas
   * seguidas, antes de que arranque, se funden en una sola.
   */
  Guardian.prototype.revisar = function () {
    var self = this;
    if (this.pendiente) return this.pendiente;
    if (!this.atributos) return Promise.resolve();
    var a = this.atributos;
    this.pendiente = enCola(function () {
      self.pendiente = null;
      return pedirJSON("/cart.js", { credentials: "same-origin" }).then(function (carrito) {
        var valor = (carrito.attributes && carrito.attributes[a.cupon]) || "";
        self.activo = !!valor;
        self.leido = true;
        // Los técnicos de antes, si el carrito todavía los trae, se borran.
        var limpiar = {};
        (a.obsoletos || []).forEach(function (k) {
          if (carrito.attributes && carrito.attributes[k] != null) limpiar[k] = "";
        });
        if (!valor) return escribir(carrito, null, limpiar);
        var nombre = nombreDelCupon(valor);
        return self.datosDelCupon(nombre, carrito).then(function (dato) {
          return escribir(carrito, dato, limpiar);
        });
      });
      function escribir(carrito, dato, atributos) {
        if (dato) {
          var pasajeros = pasajerosEnCarrito(carrito, dato.reservas);
          // Sin reservas del viaje en el carrito no hay saldo que anotar.
          var saldo = pasajeros > 0 ? textoSaldo(dato.monto, pasajeros, self.formato) : "";
          var actual = (carrito.attributes && carrito.attributes[a.saldo]) || "";
          if (saldo !== actual) atributos[a.saldo] = saldo;
        }
        if (Object.keys(atributos).length === 0) return null;
        return pedirJSON("/cart/update.js", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ attributes: atributos }),
        });
      }
    }).catch(function (e) {
      if (window.console) console.warn("[DiscountFlow] cupones de viaje (carrito):", e);
    });
    return this.pendiente;
  };

  /**
   * Corrige y espera a que el carrito deje de cambiar. Hace falta al pasar al
   * checkout: medido en /cart, pinchar «Pagar» 150 ms después del «+» llegaba
   * con el cambio del tema TODAVÍA EN VUELO — la corrección leía el carrito
   * viejo y el checkout se llevaba el total viejo. Se corrige, se espera un
   * rato, y si en ese rato respondió otro cambio del carrito, se vuelve a
   * corregir.
   */
  Guardian.prototype.asentar = function (hasta) {
    var self = this;
    function vuelta() {
      var antes = self.cambios;
      return self
        .revisar()
        .then(function () {
          // Sin cupón nuestro en el carrito no hay nada que esperar.
          if (!self.activo) return;
          return new Promise(function (listo) {
            setTimeout(listo, 900);
          });
        })
        .then(function () {
          if (self.cambios !== antes && Date.now() < hasta) return vuelta();
        });
    }
    return vuelta();
  };

  /**
   * El monto y las reservas del cupón llamado `nombre`: de la campaña de la
   * ficha, del recuerdo del navegador o, si no, de las campañas de los viajes
   * que hay en el carrito (una consulta por producto, guardada).
   */
  Guardian.prototype.datosDelCupon = function (nombre, carrito) {
    var self = this;
    function buscar(campana) {
      var hallado = null;
      ((campana && campana.coupons) || []).forEach(function (c) {
        if (!hallado && normalizarNombre(c.label) === nombre)
          hallado = { monto: c.amount, reservas: campana.reservationVariantIds };
      });
      return hallado;
    }
    var dato = buscar(this.sembrada) || recordado(nombre);
    if (dato) return Promise.resolve(dato);
    var productos = [];
    ((carrito && carrito.items) || []).forEach(function (it) {
      var id = String(it.product_id || "");
      if (id && productos.indexOf(id) < 0) productos.push(id);
    });
    return Promise.all(
      productos.map(function (id) {
        if (id in self.campanas) return Promise.resolve(self.campanas[id]);
        return pedirJSON(PROXY + "?product=" + encodeURIComponent(id), { credentials: "same-origin" })
          .then(function (r) {
            self.campanas[id] = (r && r.campana) || null;
            return self.campanas[id];
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (campanas) {
      for (var k = 0; k < campanas.length; k++) {
        var x = buscar(campanas[k]);
        if (x) return x;
      }
      return null;
    });
  };

  Guardian.prototype.vigilar = function () {
    var self = this;

    // 1 · Cada cambio del carrito que hace el tema, apenas vuelve la respuesta.
    try {
      new PerformanceObserver(function (lista) {
        var entradas = lista.getEntries();
        for (var i = 0; i < entradas.length; i++)
          if (/\/cart\/(add|change|update|clear)/.test(entradas[i].name)) {
            self.cambios++;
            self.revisar();
            return;
          }
      }).observe({ type: "resource" });
    } catch (e) {
      /* sin PerformanceObserver queda el sondeo */
    }

    // 2 · El paso al checkout espera a que el total esté escrito.
    //
    // 🔴 El formulario de la página del carrito REENVÍA las cantidades que
    // muestra (`updates[]`) al pinchar «Pagar». Medido: si la página se pintó
    // con un cambio del cajón todavía en vuelo, el formulario volvía a poner la
    // cantidad vieja DESPUÉS de que el total estaba escrito (llegó al checkout
    // con 2 reservas y «3 pasajeros» anotados). Por eso, antes de calcular, se
    // aplican al carrito esas mismas cantidades del formulario: el total sale
    // de lo que de verdad se va a cobrar. Es lo mismo que haría el envío.
    function retener(ev, seguir, form) {
      // Se deja pasar SOLO cuando se sabe que el carrito no trae un cupón
      // nuestro. Medido: en la página del carrito, pinchar «Pagar» antes de
      // que el guardián terminara de arrancar (en dev, ~2 s) pasaba sin
      // retener y el checkout se llevaba el total viejo.
      if (self.leido && !self.activo && !self.pendiente) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      var hecho = false;
      function continuar() {
        if (hecho) return;
        hecho = true;
        seguir();
      }
      setTimeout(continuar, 5000);
      var cantidades = self.listo.then(function () {
        if (!self.atributos || !(form && form.querySelector && form.querySelector('[name^="updates"]'))) return;
        return enCola(function () {
          return pedirJSON("/cart/update.js", {
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
            body: new FormData(form),
          });
        });
      });
      cantidades
        .catch(function () {
          /* si falla, el envío del formulario las aplica igual */
        })
        .then(function () {
          return self.asentar(Date.now() + 4000);
        })
        .then(continuar, continuar);
    }
    document.addEventListener(
      "submit",
      function (ev) {
        try {
          var form = ev.target;
          var boton = ev.submitter || null;
          var alCheckout =
            (boton && boton.name === "checkout") || /\/checkout/.test(form.getAttribute("action") || "");
          if (!alCheckout || form.__dfListo) return;
          retener(ev, function () {
            form.__dfListo = true;
            setTimeout(function () {
              form.__dfListo = false;
            }, 5000);
            if (form.requestSubmit) form.requestSubmit(boton && boton.form === form ? boton : undefined);
            else form.submit();
          }, form);
        } catch (e) {
          /* nunca traba la compra */
        }
      },
      true
    );
    document.addEventListener(
      "click",
      function (ev) {
        try {
          var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
          if (!a || !/\/checkout(\?|$|\/)/.test(a.getAttribute("href") || "")) return;
          retener(ev, function () {
            window.location.href = a.href;
          });
        } catch (e) {
          /* nunca traba la compra */
        }
      },
      true
    );

    // 3 · El sondeo, por si el tema cambia el carrito de una forma que no se ve.
    setInterval(function () {
      if (!document.hidden) self.revisar();
    }, 2500);
  };

  /** Modo carrito: la página del carrito, sin widget visible. */
  function arrancarModoCarrito(root) {
    root.hidden = true;
    var g = elGuardian(root.getAttribute("data-money-format") || "");
    if (g.atributos) return;
    if (ATRIBUTOS) {
      g.atributos = ATRIBUTOS;
      g.marcarListo();
      g.revisar();
      return;
    }
    pedirJSON(PROXY + "?modo=carrito", { credentials: "same-origin" })
      .then(function (r) {
        if (!r || !r.atributos || g.atributos) return;
        g.atributos = r.atributos;
        g.revisar();
      })
      .catch(function () {
        /* sin flag o sin proxy: no hace nada */
      })
      .then(function () {
        // Sin atributos (sin flag, sin proxy) no hay nada que cuidar: el
        // checkout pasa sin esperar.
        if (!g.atributos) g.leido = true;
        g.marcarListo();
      });
  }

  // ─── Arranque ───────────────────────────────────────────────────────────────

  function iniciarPendientes() {
    try {
      var roots = document.querySelectorAll("[data-df-cupones-viaje]:not([data-df-iniciado])");
      for (var i = 0; i < roots.length; i++) {
        roots[i].setAttribute("data-df-iniciado", "1");
        new Widget(roots[i]).arrancar();
      }
      var carritos = document.querySelectorAll("[data-df-cupones-viaje-carrito]:not([data-df-iniciado])");
      for (var k = 0; k < carritos.length; k++) {
        carritos[k].setAttribute("data-df-iniciado", "1");
        arrancarModoCarrito(carritos[k]);
      }
    } catch (e) {
      /* nunca rompe la página */
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciarPendientes);
  else iniciarPendientes();

  // Temas que re-renderizan la sección del producto al cambiar de variante: el
  // bloque nuevo llega sin inicializar y se engancha acá.
  try {
    var pendiente = false;
    new MutationObserver(function () {
      if (pendiente) return;
      pendiente = true;
      setTimeout(function () {
        pendiente = false;
        iniciarPendientes();
      }, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    /* sin observador: el bloque inicial igual funciona */
  }
})();
