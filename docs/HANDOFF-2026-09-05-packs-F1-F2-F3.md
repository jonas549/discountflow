# HANDOFF — Packs armables, fases F1 · F2 · F3 (2026-09-05)

> Escrito para alguien que no vivió el día. No hace falta contexto previo.
> Todo lo que se afirma acá está verificado, salvo lo que diga explícitamente
> "sin verificar".

---

## 1. ESTADO

| Pieza | Estado |
|---|---|
| Rama | **`dev`**, 3 commits nuevos. `main` **sin tocar** |
| Producción (Vercel) | **`e7be44d`** — intacta. Ni un push, ni un deploy |
| `shopify.app.toml` (PROD) | **intacto**, verificado con `git diff` |
| Base de datos | Solo el branch **dev** de Neon. Guardia previa: `SELECT count(*) FROM "Shop"` = **1** |
| Migración | `20260905090000_add_pack_campaign_type` — aditiva, aplicada **solo a dev** |
| Function nueva | `pack-discount`, **construida y probada en local**. NO desplegada a ninguna app |
| Extensión de tema | `pack-widget`, nueva. NO desplegada |

**Los tres commits:**

```
e0999e8  feat(packs): F3 — bloque de tema, widget y app proxy
9cc9d65  feat(packs): F2 — crear, editar y operar campañas PACK desde el admin
1b2b41a  feat(packs): F1 — Function de packs armables y cálculo compartido
```

**Verificaciones al cierre:**

| | |
|---|---|
| `npm test` | **148/148** (121 previos + 27 nuevos) |
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
**Plan:** FREE → tope de **2 campañas activas**. Hay **0** campañas ahora mismo,
así que sobra. Si en algún momento estorba: `UPDATE "Shop" SET plan='PROFESSIONAL';`
contra la base de **dev**.

### 4.2 · Crear la campaña

1. Abrir la app → **Campañas**.
2. Tarjeta nueva: **«Armá tu pack»** → *Nueva campaña de pack*.
3. Rellenar:
   - **Nombre:** `Pack rutina facial` (solo lo ve él).
   - **Título que ve el comprador:** `Armá tu rutina`.
   - **Modo:** empezar por **«Por tamaño del pack»** (es el que tiene barra de
     progreso y niveles, y por tanto el que más superficie prueba).
   - **Productos:** *Elegir productos* → **4 productos cualesquiera** de la
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

**Opcional pero recomendado** — el aviso del carrito:
Personalizar → plantilla **Carrito** → *Agregar bloque → Aplicaciones →
«Aviso de pack (carrito)»*.

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

## 6. LO QUE FALTA

### F4 — límites por plan (lo siguiente, tras la validación de Jonas)

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
