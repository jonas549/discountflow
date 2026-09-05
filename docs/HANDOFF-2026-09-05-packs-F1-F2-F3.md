# HANDOFF — Packs armables: F1 · F2 · F3 · ajustes · F4 (2026-09-05)

> Escrito para alguien que no vivió el día. No hace falta contexto previo.
> Todo lo que se afirma acá está verificado, salvo lo que diga explícitamente
> "sin verificar".

---

## 1. ESTADO

| Pieza | Estado |
|---|---|
| Rama | **`dev`** = **`1ee661a`**, 6 commits nuevos. `main` **sin tocar** |
| Producción (Vercel) | **`e7be44d`** — intacta. Ni un push, ni un deploy |
| `shopify.app.toml` (PROD) | **intacto**, verificado con `git diff` |
| Base de datos | Solo el branch **dev** de Neon. Guardia previa: `SELECT count(*) FROM "Shop"` = **1** |
| Migración | `20260905090000_add_pack_campaign_type` — aditiva, aplicada **solo a dev** |
| Function nueva | `pack-discount`, **construida y probada en local**. NO desplegada a ninguna app |
| Extensión de tema | `pack-widget`, nueva. NO desplegada |

**Los commits:**

```
1ee661a  feat(billing): F4 — limites por TIPO de campana segun plan
2987c4d  fix(packs): estilos heredados del tema, barra, desglose, aviso Ajax y atribucion
473f3b1  docs: handoff de las fases F1-F2-F3
e0999e8  feat(packs): F3 — bloque de tema, widget y app proxy
9cc9d65  feat(packs): F2 — crear, editar y operar campañas PACK desde el admin
1b2b41a  feat(packs): F1 — Function de packs armables y cálculo compartido
```

**Verificaciones al cierre:**

| | |
|---|---|
| `npm test` | **155/155** (121 previos + 27 de packs + 7 de planes) |
| Fixtures `pack-discount` contra el Wasm real | **13/13** |
| Fixtures `tiered-discount` contra el Wasm real | **16/16, sin tocar ninguna** ✅ |
| `npm run build` | verde |
| `npx tsc --noEmit` | **131** — ver abajo |

### Sobre el typecheck: 112 → 131

🔴 **Primero, un dato que corrige el handoff anterior:** la línea base documentada
era **111**, pero medida hoy en HEAD **sin ningún cambio mío** (con `git stash`)
da **112**. Derivó por su cuenta entre el 01/09 y hoy. La base real era 112.

Los **19 nuevos** son, uno por uno, de las **tres clases que el repo ya arrastra**:

| Clase | Nuevos | Dónde |
|---|---|---|
| `AdminApiContext` vs `AdminClient` | 12 | Una por cada llamada nueva que pasa `admin` a una función de descuentos |
| `Record<string, unknown>` vs `InputJsonValue` | 3 | Una por cada `prisma.campaign.update` con `config` |
| `string \| undefined` vs `string` | 3 | `session.accessToken` en `getOrCreateShop`, igual que en las otras 9 rutas |
| `Decimal` del candidate de la Function | 1 | Clon exacto del que ya tiene `tiered-discount` |

**Ninguno se enmascara con `as`**, porque el repo no lo hace en ningún sitio.
El del `Decimal` merece nota: el tipo generado declara `percentage.value` como
`string` y se emite un **número**. Se deja así a propósito — es lo que las
fixtures verifican contra el Wasm real y lo que la Function de escalonados lleva
emitiendo en producción desde julio. Divergir entre las dos Functions sería peor
que el error de tipos.

**Nueva línea base: 131.**

---

## 2. LAS CINCO DECISIONES, Y DÓNDE VIVEN EN EL CÓDIGO

Para que no haya que reconstruirlas leyendo:

| Decisión | Dónde está clavada |
|---|---|
| **Modo B cuenta productos DISTINTOS, no unidades** | `pack-calc.ts` (`new Set(...).size`) · test *"modo B cuenta PRODUCTOS DISTINTOS"* · fixture `modo-b-dos-unidades-un-producto-no-alcanza.json` |
| **Una unidad por producto, sin selector de cantidad** | `pack-builder.js` (toggle, `quantity: 1`) |
| **Borrar una línea avisa, no deshace ni bloquea** | Bloque `pack-notice` + `pack-notice.js` |
| **Un pack por carrito** | `PackWidget.clearPreviousPack()` |
| **Mínimo de 2 productos en modo A** | `MIN_PACK_PRODUCTS` en `pack-calc.ts` · fixture `modo-a-un-solo-producto-no-aplica.json` |

---

## 3. LA ARQUITECTURA, EN UNA PANTALLA

```
                    app/lib/discounts/pack-calc.ts
                    (módulo puro · ÚNICA fuente de verdad)
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
   import directo            import directo          scripts/build-pack-widget.mjs
        │                         │                         │
   Preview del admin      Function (Wasm)          assets/pack-calc.js
   PackCampaignForm       pack-discount            (widget del storefront)
        │                         │                         │
   lo que ve el           LO QUE SE COBRA          lo que ve el comprador
   merchant al crear      en el checkout           en la tienda
```

**El widget no lleva una copia del cálculo escrita a mano.** Se compila del mismo
archivo. Verificado: el asset generado devuelve `34480 / 3448 / 31032`, los
mismos números que el test unitario del wireframe.

### La frontera de seguridad

Una línea del carrito participa del pack **solo si cumple las dos**:

1. declara `_df_pack` con el **id de esta campaña**, y
2. su producto está en el **catálogo curado del metafield**.

La (2) no es redundante: la propiedad la controla el navegador del comprador, así
que cualquiera puede ponerle `_df_pack` a un producto que el merchant nunca
incluyó. Hay dos fixtures hostiles que lo cubren.

🔴 **El porcentaje NUNCA sale de la línea.** Sale siempre del metafield. Si
viajara en la propiedad, el comprador se fijaría su propio descuento.

---

## 4. 🔴 CÓMO PROBARLO — paso a paso

### 4.0 · Antes de arrancar

```bash
cd C:/Users/Jonas/Desktop/nuevaApp/discountflow
git branch --show-current          # debe decir: dev
npx shopify app config use dev     # 🔴 IMPRESCINDIBLE
```

⚠️ **`shopify app dev` con la config de producción activa reescribiría la
`application_url` de prod y rompería el OAuth de Greta, SkinUp y Nachin.**
El `config use dev` no es opcional.

### 4.1 · Levantar

```bash
npx shopify app dev
```

Esto sube **tres extensiones** a la app **DiscountFlow Dev**: las dos Functions
(`tiered-discount`, `pack-discount`) y la de tema (`pack-widget`). Es la primera
vez que la app lleva más de una.

**Tienda:** `calendario-envios-test-final.myshopify.com`

**Plan: ya está en PROFESSIONAL** y la degradación está frenada con
`PLAN_SYNC_OBSERVACION=1` en el `.env`. Las dos cosas se hicieron a propósito y
son necesarias: desde F4 los packs exigen ESSENTIAL, y la tienda de dev no tiene
suscripción real, así que sin el freno el sondeo la bajaría a FREE a los 15
minutos y la campaña no se podría activar. Ver §5-TER.

### 4.2 · Crear la campaña

1. Abrir la app → **Campañas**.
2. Tarjeta nueva: **«Armá tu pack»** → *Nueva campaña de pack*.
3. Rellenar:
   - **Nombre:** `Pack rutina facial` (solo lo ve él).
   - **Título que ve el comprador:** `Armá tu rutina`.
   - **Modo:** ya no hay que elegirlo. El selector desapareció porque solo se
     ofrece «Por tamaño del pack» (ver §5-BIS).
   - **Productos:** *Elegir productos* → **5 productos cualesquiera** de la
     tienda de prueba.
   - **Niveles:** vienen por defecto `2 → 10%`, `3 → 20%`, `4 → 30%`.
4. El panel derecho debe mostrar un **preview con subtotal, ahorro y total**
   mientras se edita. Ese número sale de la misma función que cobra el checkout.
5. **Activar campaña**.

✅ En el listado la campaña aparece **Activa**, con la etiqueta
*«3 niveles · hasta 30% (por tamaño)»* y el número de productos.

> Si aparece un aviso ámbar de solapamiento es correcto: significa que alguno de
> esos productos ya está en otra campaña activa. Con 0 campañas previas no debería salir.

### 4.3 · Colocar el bloque en el tema

1. Admin de Shopify → **Tienda online → Temas → Personalizar**.
2. Elegir dónde: **Inicio** es lo más simple.
3. **Agregar sección → Aplicaciones → «Armá tu pack»**.
   - Si no aparece, la sección elegida no admite bloques de app. Probar otra, o
     usar *Agregar sección* en el nivel superior de la plantilla.
4. En los ajustes del bloque, dejar **ID de la campaña vacío** (usa el pack
   activo más reciente). Si se quiere fijar, el id está en la URL de la pantalla
   de edición de la campaña.
5. **Guardar** y abrir la tienda.

**Ahora NO es opcional** — el aviso del carrito, que es lo que se arregló en
esta ronda: Personalizar → plantilla **Carrito** → *Agregar bloque →
Aplicaciones → «Aviso de pack (carrito)»*.

### 4.4 · Lo que tiene que pasar en la tienda

| Acción | Qué se ve |
|---|---|
| Abrir la página con el bloque | El título, los 4 productos con foto y precio, y **«Sumá 2 productos y ahorrás 10%»** con la barra vacía |
| Agregar **1** producto | El botón queda deshabilitado. *«Agregá 1 producto más para activar el descuento.»* |
| Agregar **2** | Aparece **Subtotal / Ahorro (10%) / Total**. Arriba: *«Sumá 1 producto y ahorrás 20%»* |
| Agregar **3** | El ahorro pasa a **20%** |
| Agregar **4** | **30%**, y arriba *«Máximo descuento aplicado: 30%»* |
| **Agregar pack al carrito** | Redirige a `/cart` |

### 4.5 · 🔴 Lo que hay que verificar en el carrito y el checkout

**En el carrito:**
- Las 4 líneas del pack, **una unidad cada una**.
- El descuento aplicado con el texto **«Descuento por pack»**.
- **El total con descuento tiene que ser EXACTAMENTE el que mostraba el widget.**
  Esta es la prueba que importa: es lo único que demuestra que el widget, el
  admin y el Wasm calculan lo mismo.
- La propiedad `_df_pack` **NO debe verse** (empieza con `_`, Shopify la oculta).

**Quitar una línea del carrito** (la prueba de la decisión 3):
- El descuento baja de 30% a 20% solo.
- Si se colocó el bloque de aviso: *«Sumá 1 producto y tu descuento pasa a 30%.»*
- Bajando a 1 producto: el descuento desaparece y el aviso dice
  *«Agregá 1 producto y recuperás el 10%.»*
- **Nada se bloquea y el pack no se deshace.** Es lo decidido.

**En el checkout:**
- El descuento **sigue aplicado**, con el mismo importe que en el carrito.

**La prueba del modo A** (más corta): editar la campaña, cambiar a **«Por
producto»**, poner porcentajes distintos (10 / 15 / 20 / 12), guardar. En la
tienda cada tarjeta muestra su **«N% OFF»** y el ahorro es la suma de los
descuentos de los elegidos.

**La prueba de un pack por carrito:** armar un pack, agregarlo, volver al bloque,
armar otro distinto y agregarlo. En el carrito tiene que quedar **solo el
segundo**.

### 4.5-BIS · 🔴 LO QUE HAY QUE MIRAR DE NUEVO EN ESTA RONDA

| Qué | Qué se espera |
|---|---|
| **Tipografía y tamaño** | El texto tiene el tamaño y la fuente del tema, legible. Nada de letra minúscula |
| **Botones** | «Agregar al pack» y el CTA se ven como los botones de la tienda. El elegido usa el botón primario del tema; el no elegido, el secundario |
| **Colores** | No hay ningún verde ni gris nuestro. Bordes y fondos suaves salen del color del texto |
| **La barra de progreso** | Con 3 de 5 avanza a ~75%. Si volviera a fallar: inspeccionar el elemento y mirar `data-df-progress` en `.df-pack__bar` — si dice 75 el cálculo está bien y el problema es de CSS del tema |
| **Desglose por producto** | El panel lista cada producto con su ahorro y su % |
| **Aviso del carrito SIN refrescar** | Quitar una línea → el aviso cambia solo, en ~1 segundo, sin recargar |
| **Atribución** | Completar una compra → Analytics debe mostrar el pedido y el ROI del pack. Si sigue en 0, `npx shopify app logs` y buscar `[pack-attribution]`: el log dice cuántas líneas con marca vio y cuánto atribuyó |
| **Puerta por plan (F4)** | Bajar el plan de dev a `LITE` con un UPDATE e intentar activar el pack → debe decir que los packs no están incluidos en Lite. Volver a `PROFESSIONAL` después |

Y una prueba de **no regresión** que conviene hacer una vez, porque F4 tocó los
límites de los cuatro tipos anteriores: crear y activar una campaña de
Porcentaje y una Escalonada, y comprobar que siguen funcionando igual.

### 4.6 · Si algo no aparece

| Síntoma | Causa más probable |
|---|---|
| El bloque no está en «Agregar sección → Aplicaciones» | La sección no admite bloques `@app`, o el tema no es OS 2.0 |
| El bloque aparece pero vacío | El app proxy. Ver abajo |
| El widget no carga y la consola dice `proxy 502` | 🔴 **El app proxy apunta a un túnel muerto.** Partner Dashboard → DiscountFlow Dev → App setup → **App proxy** → la URL tiene que ser el túnel actual + `/apps/discountflow` |
| El descuento no aplica en el carrito | `npx shopify app logs` y buscar `[pack] sin-descuento`: el motivo va en el propio log |
| «No se encontró la Function "pack-discount"» al activar | `shopify app dev` no estaba corriendo, o la extensión no se subió |

---

## 5. DECISIONES DE IMPLEMENTACIÓN QUE CONVIENE CONOCER

### Por qué una Function nueva y no un target más en la existente
Una extensión Function exporta **un handler por target**, y
`cart.lines.discounts.generate.run` ya lo ocupa `tiered-discount`.

🔴 **Consecuencia operativa que cambia el procedimiento de despliegue:**
`shopify app deploy` versiona la configuración y **todas** las extensiones
juntas — no se puede desplegar solo una. Desde ahora, cada despliegue publica
también el Wasm de escalonados, y **un rollback de packs devuelve la Function de
escalonados a su versión anterior**. Antes de desplegar hay que correr las
fixtures de las dos.

### `getDiscountFunctionId` (`function-id.ts`)
El emparejamiento salió de `tiered.ts` a un módulo propio. Con dos Functions
instaladas, los descartes «es la única de descuento» / «es la única» dejan de
identificar a nadie, y acertar por descarte podría enganchar packs al Wasm de
escalonados: una campaña que la app muestra activa y que en el checkout no
descuenta nada.

- **Escalonados conserva su fallback** (`allowSingleFunctionFallback: true`) para
  no cambiar el comportamiento que hoy corre en producción.
- **Packs nunca adivina** (`false`).

### `runDiscountMutation` → `discount-mutation.ts`
Se movió sin cambiar el cuerpo. Dos copias de "cómo se detecta que Shopify falló"
es como se vuelven a tragar errores: este repo ya arregló ese patrón **cuatro
veces** (`bulkUpdateVariantPrices`, `runDiscountMutation`, `readQueryData`,
`currentAppInstallation`).

### `DecimalInput` → `CampaignFormShared.tsx`
El campo de porcentaje por producto usa buffer de texto desde el día uno, no
`<input type="number">`. Se movió el componente en vez de copiarlo.
🟡 **Sigue pendiente** (decidido el 08/08, no hecho) usarlo también en el campo
de porcentaje de escalonados, que arrastra el mismo bug.

### El motor de jobs
🔴 El flag `jobs:batched` está **ENCENDIDO en dev**, así que activar/pausar/
eliminar un pack pasa por `campaign-ops.ts`. Sin ramas para PACK ahí, esas
operaciones no habrían hecho **nada**. Están puestas.

### El solapamiento con otras campañas
`findPackOverlaps` avisa (no bloquea) cuando un producto del pack ya está en otra
campaña activa. `combinesWith.productDiscounts` sigue en **`false`**, como el
resto de la app.

Razonamiento: en escalonados el solapamiento no es un problema real —nadie pone
dos campañas sobre el mismo producto a propósito—, pero en packs el merchant cura
una lista de productos sueltos y es fácil que alguno esté cubierto sin haberlo
buscado. Se le cuenta, en vez de cambiar reglas de combinación que no se han
probado en una tienda real.

### El app proxy
Se eligió frente al metafield de tienda porque **no necesita ningún scope nuevo**
—ningún merchant reautoriza— y no se queda viejo. No llama a la Admin API: sirve
la foto que guardó el admin, y el widget refresca precios contra
`/products/{handle}.js`, que es del storefront y va por CDN.

Filtra por `startsAt`/`endsAt` **a propósito**: el cron que debería cerrar
campañas **no existe** (deuda conocida). Sin ese filtro, un pack vencido se
seguiría ofreciendo en la tienda y el comprador armaría un pack que no descuenta.

---

## 5-BIS. SEGUNDA RONDA — lo que salió de la prueba de Jonas

F3 pasó las 14 pruebas del modo por tamaño. Verificado con 5 productos y niveles
2→10 / 3→20 / 4→30: widget, carrito y checkout dieron **$270,20** idéntico, la
compra se completó con las 5 líneas marcadas, y quitar líneas recalculó bien a
cada paso. Después de eso, seis cambios.

### ⛔ El modo «Por producto» se OCULTA

Decisión de producto de Jonas, no técnica: si cada producto lleva su propio
descuento fijo, el comprador elige los dos de mayor porcentaje y arma el pack con
esos. No incentiva combinar nada, y ese caso ya lo cubre una campaña de
Porcentaje.

**El código NO se borró.** `PACK_MODOS_OFRECIDOS` en `pack-client.ts` gobierna
qué modos ofrece la interfaz. Cálculo, Function, widget y fixtures siguen
intactos, y las campañas ya guardadas en `PER_PRODUCT` se abren y editan igual:
el formulario detecta el modo retirado y **les devuelve el selector solo a
ellas**, con un aviso. Reactivarlo = añadir `"PER_PRODUCT"` a ese array.

Con un solo modo el selector desaparece —una sección entera para no dejar elegir
nada es ruido— y los números de sección pasan a **calcularse**, porque si no
quedaba «1 · 3 · 4 · 5».

### 1 · Estilos: ahora los hereda del tema

🔴 **La letra ilegible era `rem`.** Un `rem` se mide contra la raíz del
documento, y es habitual que un tema declare `html { font-size: 62.5% }` para
hacer las cuentas en décimas. En ese tema, `0.9rem` son **nueve píxeles**. Todo
pasó a `em`, que se mide contra el texto del tema y escala con él. De paso todos
los tamaños subieron.

Lo demás:

- `font: inherit` en el contenedor, los botones y el aviso.
- **Los botones llevan las clases del TEMA** (`button`/`btn` + `--secondary`, las
  dos familias a la vez para cubrir OS 2.0 y vintage). El color, la forma y el
  hover salen de la tienda. El estado elegido / no elegido se pinta cambiando
  entre la variante primaria y la secundaria **del tema**, no con un verde
  nuestro.
- Bordes y fondos suaves derivados de `currentColor` con `color-mix` y `rgba` de
  reserva delante. Gratis: se adapta a temas oscuros sin una sola media query.
- Cero CSS estructural moderno (sin anidamiento, sin `:has()`, sin container
  queries) para que funcione en temas viejos.
- Queda **un** color fijo: el blanco de reserva de la barra fija del móvil, que
  no puede ser translúcida porque flota sobre el contenido. Está comentado.

### 2 · La barra de progreso

No era el cálculo: los números eran correctos. Era el layout. El carril tenía
`height: 4px` y el relleno `height: 100%` con un `width` en porcentaje, y una
altura porcentual depende de que el padre tenga altura definida **en ese
momento**; un reset del tema basta para que resuelva a cero.

Ahora carril y relleno tienen su **propia altura en píxeles** y el relleno se
recorta con `scaleX()`, que no depende del layout del padre. El porcentaje queda
en `data-df-progress` y en atributos ARIA, para poder depurarlo sin reproducir el
estado.

### 3 · Desglose por producto

El panel lista cada producto elegido con su ahorro y su porcentaje. Se recorre lo
**elegido** y no las filas con descuento: un producto al 0% está en el pack y
tiene que aparecer diciendo que no rebaja.

### 4 · El aviso del carrito — el análisis que pidió Jonas

Su diagnóstico era correcto. Los temas actualizan el carrito con la Section
Rendering API y **reemplazan el HTML de la sección**: si el bloque está dentro,
su nodo del DOM se sustituye por uno nuevo y vacío; si está fuera, nadie le dice
que el carrito cambió.

**Lo que no sirve, y por qué:**

| Señal | Por qué no |
|---|---|
| `shopify:section:load` | Solo se dispara en el **editor** de temas |
| `cart:updated` / `cart:refresh` | Los inventa cada tema. **Dawn no los emite**: usa su propio pub/sub en un módulo de JS, inalcanzable desde un asset |
| `MutationObserver` sobre el carrito | Se dispara con cada cambio de cantidad y cada re-render. Ruido y riesgo de bucle |

**Lo que sí sirve y es independiente del tema:** todas las mutaciones Ajax del
carrito, en cualquier tema, pasan por `/cart/add`, `/cart/change`,
`/cart/update` o `/cart/clear`. Se interceptan `fetch` y `XMLHttpRequest`.

Reglas que se respetan, porque estamos en casa de otro: la petición siempre pasa
y se devuelve tal cual · el `catch` re-lanza · todo va en `try/catch` y si el
parcheo fallara el aviso deja de actualizarse solo, el carrito del merchant sigue
igual · se parchea una vez aunque el bloque esté puesto dos veces.

Tres pasadas escalonadas (60 ms / 350 ms / 1200 ms) porque el tema re-renderiza
**después** de que su fetch resuelva, y el nodo se vuelve a buscar en cada
pasada.

🟡 **Límite aceptado:** un tema con un endpoint de carrito propio (muy raro) no
se detecta; ahí el aviso se comporta como antes, correcto al cargar la página.

### 5 · Atribución de pedidos

Bloque 4 nuevo en `webhooks.orders.create.tsx`. Es **la atribución más exacta de
las cuatro**: la línea lleva escrito el id de la campaña en `_df_pack`, así que
no hay que deducir nada. (PERCENTAGE/RANGE cruzan variantes; TIERED cruza
productos, descarta por título y no atribuye si hay ambigüedad.)

🔴 **El detalle que habría dado cero en silencio:** en el payload REST del
pedido, `properties` es un **ARRAY de `{name, value}`**, no el objeto
`{clave: valor}` que devuelve la Ajax Cart API. Se verificó en la documentación
**antes** de escribir el código. `leerPropiedad` tolera las dos formas.

El importe sale de las `discount_allocations` filtradas por el título de NUESTRO
descuento —una línea puede llevar encima descuentos de otras apps— y la campaña
se busca por id **sin filtrar por estado**: el pedido ocurrió cuando estaba
activa, y pausarla después no debe borrar su historial de ventas.

Además `tipoLabel` no conocía `PACK` y mostraba «PACK» crudo en analytics y en el
dashboard.

---

## 5-TER. F4 — LÍMITES POR TIPO SEGÚN PLAN

### 🔴 El agujero que cierra, además del eje nuevo

`PLAN_LIMITS` solo sabía de CANTIDADES (`maxBxgy`/`maxTiered`), y `null`
significaba «sin sublímite» — que las rutas leían como **saltarse la comprobación
entera**. FREE tenía los dos en `null`, así que **una tienda del plan gratuito
podía crear y activar campañas BxGy y Escalonadas**, acotada solo por el tope
general de 2. La tabla de planes decía lo contrario desde hacía meses.

Y era peor de lo que parece: son los dos tipos que **no** se topan por variantes,
así que un FREE podía poner un escalonado sobre toda la tienda sin tocar su cuota
de 50 variantes.

### El modelo

`TypeRule` hace que **«no incluido» e «incluido sin tope» sean estados
distintos** en vez de compartir el valor `null` — que era exactamente lo que el
modelo viejo no podía expresar.

| Tipo | FREE | LITE | ESSENTIAL | PRO |
|---|---|---|---|---|
| BxGy | ✗ | máx. 4 | máx. 10 | sin tope |
| Escalonado | ✗ | máx. 2 | máx. 10 | sin tope |
| Pack | ✗ | ✗ | sin tope | sin tope |

`PLAN_LIMITS.types` es la única autoridad. Se **quitaron** `maxBxgy`/`maxTiered`
(los mismos números escritos en un segundo sitio) y `getTypeCampaignLimit`
(respondía la misma pregunta con peor semántica).

### Un solo punto de decisión

`comprobarTipoDeCampana` en `plan-limits.server.ts`. La comprobación estaba
copiada en **cinco** sitios y con los tipos nuevos habrían sido **nueve**. Misma
lección que el flag `jobs:batched` leído en tres lugares el 09/08: la
inconsistencia se evita por construcción, no por disciplina.

No construye la Response: cada ruta tiene su forma de JSON y eso es
presentación. Lo que no puede estar duplicado es la **decisión**.

Dos motivos de bloqueo, distintos a propósito:

- **el plan no incluye el tipo** → hay que subir de plan. Decirle «pausá una
  campaña» lo mandaría a intentar algo que no puede funcionar.
- **incluido con tope** → pausar otra del tipo sí ayuda.

La puerta va en la **activación**, nunca en el guardado: un borrador siempre se
puede guardar, así el límite es argumento de venta y no un muro.

### El punto que más importaba

El **listado**. Desde el 01/09 activa borradores de BxGy, Escalonado y Pack
creando el descuento en Shopify; sin la puerta ahí, un plan que no incluye el
tipo lo activaría igual desde la lista.

### Tests

`plan-limits.test.ts`, 7 tests. La tabla decidida se escribe **aparte** del
código y se compara contra él: si alguien cambia la matriz sin cambiar la tabla,
falla. Incluye un test que exige que **todo plan defina regla para todos los
tipos** — un tipo nuevo olvidado en un plan haría que `reglaDeTipo` devolviera
`undefined` y la puerta dejara pasar todo.

### Qué NO cambia

Las campañas ACTIVE **nunca se re-evalúan**. Una tienda que baje de plan conserva
su pack corriendo. Es lo seguro y es coherente con la restricción del caso
116943; queda escrito para que sea una decisión y no un descuido.

### 🔴 Consecuencia para volver a probar en dev

La tienda de dev estaba en **FREE**, y con F4 los packs exigen ESSENTIAL. Sin
tocar nada, la campaña no se podría activar. Se hicieron dos cambios **solo en el
ambiente de desarrollo**:

1. `UPDATE` del plan de la tienda de dev a **PROFESSIONAL** (guardia previa:
   `count(*) FROM "Shop"` = 1 → es dev).
2. **`PLAN_SYNC_OBSERVACION=1` en el `.env` local.** Hace falta porque la tienda
   de dev no tiene ninguna suscripción real: el sondeo la bajaría a FREE en la
   siguiente carga de `/app` y la campaña quedaría sin poder activarse a los 15
   minutos. Es el mismo interruptor que se usó en producción durante el caso
   116943, y está comentado en el `.env`.

⚠️ El `.env` está en `.gitignore`: es local y no viaja al repo. Para volver a
ejercitar la degradación en dev, borrar esa línea.

---

## 6. LO QUE FALTA

### ✅ F4 — HECHO (ver §5-TER). Lo que sigue vivo de esta sección:

🔴 **El eje de "este plan no puede usar este tipo" NO EXISTE hoy.**
`PLAN_LIMITS` solo sabe de **cantidades**: `campaigns`, `variants`, `maxBxgy`,
`maxTiered`. Y `getTypeCampaignLimit` devuelve `null` para "sin sublímite", que
las rutas interpretan como **saltarse la comprobación entera**.

**Consecuencia que hay que decir en voz alta:** la tabla de planes decidida dice
"BxGy: No en FREE" y "Escalonado: No en FREE". **Hoy el código no lo impide.**
Una tienda FREE puede crear y activar las dos, acotada solo por el tope general
de 2. La fase 4 no es solo para los tipos nuevos: **cierra un hueco que ya
existe**.

Lo que hay que construir:
- La matriz completa en `PLAN_LIMITS` y **una sola** función `puedeUsarTipo()`.
  Hoy la comprobación está duplicada en **5 sitios**; con 4 tipos nuevos serían
  ~9 × 2. Es el mismo patrón que ya mordió con el flag `jobs:batched` leído en
  tres lugares.
- La puerta va en la **activación**, no en la creación.
- 🔴 `edit_.tiered.tsx` **sigue sin ningún check**. Era inocuo cuando esa
  pantalla no cambiaba estado; desde el 01/09 sí lo hace. Con un eje de permiso,
  ese hueco pasa a ser un **bypass de una feature de pago**.
- Decidir qué pasa al bajar de plan. La regla estructural de hoy es "ninguna
  campaña activa se re-evalúa nunca". Dejarlo así es lo seguro y lo coherente
  con el caso 116943, pero conviene que quede escrito.

### Antes de que packs salga a producción

- 🔴 **Añadir `[app_proxy]` a `shopify.app.toml`.** Se dejó fuera a propósito:
  producción no se toca en estas fases. Sin ese bloque, el widget no tiene de
  dónde leer.
- 🔴 Correr las fixtures de **las dos** Functions (el deploy publica ambas).
- 🟡 Confirmar que el título de las Functions casa con su handle en la tienda
  real, ahora que hay dos.

### Aplazado a propósito

- **Atribución de pedidos para PACK.** El webhook `orders/create` no la
  contempla; una venta con pack no aparecerá en Analytics. `packAppliesToProduct`
  ya existe para cuando se aborde. (No se puede probar en dev: `orders/create`
  está comentado en el toml de dev por falta de PCD.)
- **El dashboard de Inicio** (`app._index.tsx`) no muestra packs en su tabla de
  recientes. Mismo hueco que ya tenían BxGy y TIERED.
- **Crear un pack con barra de progreso (D3).** Como BxGy y TIERED, crear va por
  el camino síncrono. No es bloqueante: crear un pack son ~24 productos, no 6.000
  variantes.

### Heredados, sin tocar hoy

Cron de campañas programadas · seguridad de julio (repo público, backup del
`.env`, secretos sin rotar) · Vercel Pro · `shopify.app.toml:13` sigue diciendo
que BxGy usa Shopify Functions, que es falso · el campo de porcentaje de
escalonados con el bug del decimal · `ERROR.jpeg` sin trackear en la raíz.

---

## 7. ARCHIVOS

**Nuevos:**
```
app/lib/discounts/pack-calc.ts          ⚠️ se compila DENTRO del Wasm
app/lib/discounts/pack-calc.test.ts     27 tests
app/lib/discounts/pack-client.ts
app/lib/discounts/pack-form.ts
app/lib/discounts/pack.ts
app/lib/discounts/function-id.ts
app/lib/discounts/discount-mutation.ts
app/components/PackCampaignForm.tsx
app/routes/app.campaigns.new.pack.tsx
app/routes/app.campaigns.$id.edit_.pack.tsx
app/routes/apps.discountflow.pack.tsx   app proxy
extensions/pack-discount/               Function + 13 fixtures
extensions/pack-widget/                 bloque de tema + widget
scripts/build-pack-widget.mjs
prisma/migrations/20260905090000_add_pack_campaign_type/
```

**Tocados:** `tiered.ts` · `campaign-ops.ts` · `app.campaigns._index.tsx` ·
`CampaignFormShared.tsx` · `TieredCampaignForm.tsx` · `i18n.ts` ·
`schema.prisma` · `package.json` · `shopify.app.dev.toml`

**Trampas del repo, todas vigentes:**
- 🔴 `pack-calc.ts` y `tiered-calc.ts` viven en `app/` y **se compilan dentro del
  Wasm**. Tocar cualquiera de los dos obliga a desplegar su Function.
- El resolvedor ESM de Node **rechaza imports sin extensión**.
- `npm run build` modifica `.vercel/react-router-build-result.json`, que está
  **trackeado**. Revertirlo antes de commitear.
- Nunca `shopify app dev` con la config de producción activa.
- No correr `npm run build` y `vitest` a la vez en la misma extensión: los dos
  escriben en `dist/` y chocan (pasó hoy y parecía un fallo de las fixtures).

**Rollback:** las tres fases están en `dev` y nada se desplegó. Deshacerlo es
`git reset --hard e7be44d` más, si se quiere, revertir la migración de dev (no
hace falta: añadir un valor a un enum es inofensivo).

---

*Cierre 2026-09-05. F1, F2 y F3 completas en `dev`. Producción intacta.
Falta que Jonas valide el recorrido completo antes de F4.*
