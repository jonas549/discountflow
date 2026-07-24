# 📐 PLAN — Descuentos Escalonados (4º tipo de campaña)

> **Fase actual: SOLO ANÁLISIS.** Ningún archivo de la app fue modificado para escribir este documento.
> Fecha: 2026-07-24 · Rama de trabajo: `dev` · Producción (`main`) intocable.
> Fuentes: lectura del código real del repo + documentación oficial de Shopify (Discount Function API, `discountAutomaticAppCreate`).

---

## 0. Resumen ejecutivo

**Sí es viable, y es menos trabajo de lo que parecía en el análisis anterior** — porque el repo ya tiene el 70% de las piezas:

| Pieza necesaria | ¿Ya existe? |
|---|---|
| Patrón de descuento automático gestionado por Shopify (no editar precios) | ✅ **Sí** — BXGY ya usa `discountAutomaticBxgyCreate` |
| Mutaciones de pausar / reactivar / eliminar descuento automático | ✅ **Sí** — `deactivate/activate/delete` en `bxgy.ts` son **genéricas**, sirven igual para descuentos de Function |
| Resolver colección/tag/vendor/tipo → lista de product IDs | ✅ **Sí** — `resolveToProductIds()` en `bxgy.ts` |
| UI de selección de aplicabilidad (productos/colecciones/tienda) | ✅ **Sí** — `SelectionPanel` + `CampaignFormShared` |
| Layout formulario + preview lateral sticky | ✅ **Sí** — patrón idéntico en las 3 campañas |
| Workspace de extensiones | ✅ **Sí** — `package.json` ya declara `"workspaces": ["extensions/*"]` |
| Scopes necesarios | ✅ **Sí** — `write_discounts` ya está concedido |
| **Shopify Function (Wasm)** | ❌ **No** — es lo único genuinamente nuevo |

Lo verdaderamente nuevo es **una sola cosa**: escribir y desplegar una Function de descuento. Todo lo demás es replicar patrones que ya funcionan en producción.

**Estimación total: 5–8 sesiones de trabajo (~30–45 h)**, de las cuales ~40% es la curva de Functions.

---

## 1. Lo que confirmé en la documentación oficial

La **Discount Function API** se unificó en la versión `2025-10`. Los tres tipos viejos (`product_discounts`, `order_discounts`, `shipping_discounts`) se colapsaron en **un solo target**:

```
cart.lines.discounts.generate.run   →   export function cartLinesDiscountsGenerateRun(input)
```

Hechos verificados en `shopify.dev/docs/api/functions/latest/discount`:

1. **Configuración por metafield.** La Function lee su configuración de `input.discount.metafield.jsonValue`. Eso significa: **una sola Function desplegada sirve a todas las campañas escalonadas de todos los merchants**; lo que cambia es el metafield de cada descuento. No se despliega código por campaña.

2. **Targeting parcial de línea — confirmado.** El target acepta cantidad:
   ```js
   targets: [{ cartLine: { id: line.id, quantity: 1 } }]
   ```
   (visto en el ejemplo oficial de "10% off on Y when buying X"). Esto es lo que hace posible el Modo B.

3. **Dos formas de valor:** `percentage: { value: "15.0" }` y `fixedAmount: { amount, appliesToEachItem: bool }`.

4. **Clases de descuento:** la Function declara `PRODUCT` / `ORDER` / `DELIVERY`, y en runtime valida `input.discount.discountClasses`. Nosotros solo necesitamos `PRODUCT`.

5. **Scaffolding:** `shopify app generate extension --template discount`. El CLI del repo es `@shopify/cli 3.94.3` → soporta la plantilla.

6. **Coste de instrucciones:** los ejemplos oficiales en JavaScript rondan 200.000–500.000 instrucciones; el límite es 11 M. **JavaScript/TypeScript es suficiente, no hace falta Rust.** (Rust queda como optimización si algún día se acerca al techo.)

---

## 2. Arquitectura propuesta

### 2.1 Decisión central: la Function no sabe de colecciones

**El problema:** el input query de una Function es **estático** — se compila con la extensión. No se le pueden inyectar IDs de colección en runtime. Entonces, si el merchant elige "colección Skincare", la Function no puede preguntar "¿esta línea pertenece a la colección X?".

**Las 3 salidas posibles:**

| Opción | Cómo | Veredicto |
|---|---|---|
| **A. Resolver a IDs en el servidor** y guardarlos en el metafield del descuento | Reutiliza `resolveToProductIds()` que ya existe | ✅ **Elegida para v1** |
| B. Escribir un metafield en cada producto y que la Function lo lea | Escalable, sobrevive a cambios de colección | ❌ Revive el problema de los 541 productos de Greta (N escrituras) |
| C. `inAnyCollection` en el input query | Requiere IDs fijos en tiempo de compilación | ❌ Imposible para multi-tenant |

**Opción A** encaja perfecto porque el código de resolución **ya está escrito y probado** en `bxgy.ts` (BXGY tiene la misma limitación: `{ all: true }` no existe, hay que resolver a IDs).

> ⚠️ **Consecuencia honesta de la opción A:** si el merchant añade un producto a la colección *después* de activar la campaña, ese producto **no** entra al descuento hasta que edite y vuelva a guardar. Hay que decirlo en la UI ("se aplicará a los N productos actuales de la colección") y añadir un botón "Resincronizar productos" en fase 2.
>
> **Excepción feliz:** modo "toda la tienda" → lista vacía = aplica a todo. No hay que resolver nada y no hay staleness. Es el caso más barato.

### 2.2 Forma del `config` JSON (sin columnas nuevas)

El modelo `Campaign` ya guarda `config Json` con forma distinta por tipo. Se añade una cuarta forma — **cero columnas nuevas**:

```ts
// TIERED
{
  mode: "UNIFORM" | "INCREMENTAL",

  // Aplicabilidad — mismo vocabulario que BXGY
  selectionMode: "products" | "collections" | "tags" | "vendors" | "productTypes" | "all",
  productIds: string[],        // gid://shopify/Product/... (resueltos al activar)
  collectionIds: string[],     // solo para reconstruir el formulario al editar
  rawItems: string[],          // tags / vendors / types seleccionados
  excludeProductIds: string[],

  // La curva
  tiers: Array<{ minQty: number; percent: number }>,   // ordenado asc por minQty

  // Handles de Shopify (se llenan al activar)
  shopifyDiscountId?: string,  // gid://shopify/DiscountAutomaticNode/...
  functionId?: string,
  metafieldId?: string,        // para poder actualizar la config sin recrear
}
```

**Único cambio de esquema: un valor nuevo en el enum.**
```prisma
enum CampaignType {
  PERCENTAGE
  RANGE
  BXGY
  TIERED   // ← lo único que se añade
}
```

> Nota técnica de Postgres: `ALTER TYPE ... ADD VALUE` no puede usarse en la misma transacción que lo consume. Prisma lo maneja bien si la migración **solo añade el valor** y no hace backfill. Regla: esa migración no toca ni una fila.

### 2.3 Cómo se sincroniza con la Function

```
[Admin app]                              [Shopify]
campaña TIERED activada
   │
   ├─ 1. resolver selección → productIds
   ├─ 2. query shopifyFunctions(apiType:"discount") → functionId
   └─ 3. discountAutomaticAppCreate {
           functionId,
           title: "[DiscountFlow] <nombre>",
           startsAt, endsAt,
           discountClasses: [PRODUCT],
           combinesWith: { product:false, order:false, shipping:false },
           metafields: [{
             namespace: "$app:discountflow",
             key: "tiered-config",
             type: "json",
             value: JSON.stringify({ mode, tiers, productIds, excludeProductIds })
           }]
         }
                                              │
                                     el carrito cambia
                                              │
                                    Function corre en Shopify
                                    lee input.discount.metafield.jsonValue
                                    devuelve operations[]
```

**El `functionId` NO se hardcodea.** Se consulta en tiempo de activación:
```graphql
{ shopifyFunctions(first: 25, apiType: "discount") { nodes { id title } } }
```
Así funciona igual en la app dev y en la de producción, que tienen IDs distintos.

**Al editar** una campaña activa: `metafieldsSet` sobre el nodo del descuento (o `discountAutomaticAppUpdate`). No hace falta borrar y recrear.

### 2.4 El algoritmo — Modo A vs Modo B

Entrada: líneas del carrito que están en `productIds` (o todas, si la lista está vacía) y no en `excludeProductIds`.
`Q` = suma de cantidades de esas líneas.
Tier vigente = el tier de mayor `minQty` que cumple `minQty <= Q`. Si `Q` no llega al primer tier → sin descuento.

**MODO A — UNIFORME** (directo):
```
percent = tierVigente.percent
para cada línea aplicable:
   candidate { targets: [{ cartLine: { id } }],           // línea completa
               value: { percentage: { value: percent } } }
```
Ejemplo del brief: 3 × $100 → Q=3 → tier 20% → los 3 al 20% → $240. ✅

**MODO B — INCREMENTAL** (aquí está el truco arquitectónico):

El impulso natural sería emitir un candidate por unidad (`quantity: 1` con 10%, otro con 15%…). **No lo recomiendo:** varios candidates apuntando a la *misma* línea con cantidades distintas dependen de cómo Shopify resuelva solapamientos vía `selectionStrategy`, y ese comportamiento no está garantizado en la documentación.

**En su lugar: calcular el dinero y emitir UN candidate por línea.**
```
unidades = expandir líneas aplicables a unidades individuales, con su precio unitario
ordenar unidades  (ver decisión abajo)
descuentoTotal[línea] = Σ  precioUnitario × percentDeLaUnidad / 100

para cada línea:
   candidate { targets: [{ cartLine: { id } }],
               value: { fixedAmount: { amount: descuentoTotal[línea],
                                       appliesToEachItem: false } } }
```
Ejemplo del brief: 3 × $100 → unidad 1 = 10% ($10) + unidad 2 = 15% ($15) + unidad 3 = 20% ($20) = $45 de descuento sobre una línea de $300 → paga **$255**. ✅ Exacto.

Ventajas: cero ambigüedad de solapamiento, un solo candidate por línea, y el importe se deriva de `line.cost.amountPerQuantity` — que ya viene **en la moneda de presentación del carrito**, así que el multi-moneda sale correcto gratis.

> 🔸 **Decisión de producto pendiente (necesito tu criterio):** cuando hay varias unidades a distinto precio, ¿qué unidad recibe el % más alto?
> - **Recomendado:** ordenar de mayor a menor precio y dar los % más altos a las **unidades más baratas** → el descuento le sale más barato al merchant y el cliente igual ve el precio prometido.
> - La alternativa (% más alto a la unidad más cara) es más generosa y más cara.
> Sea cual sea, hay que enseñarlo en el preview con números, no dejarlo implícito.
>
> 🔸 **Unidades más allá del último tier:** se quedan con el % del último tier (comportamiento estándar del mercado). A documentar en la UI.

---

## 3. Plan de implementación paso a paso

### Paso 1 — Calculadora pura de tiers *(sin Shopify, sin DB)* — 3–4 h
`app/lib/discounts/tiered-calc.ts`
```ts
export type TierMode = "UNIFORM" | "INCREMENTAL";
export type Tier = { minQty: number; percent: number };
export type Unit = { lineId: string; price: number };

export function resolveTier(tiers: Tier[], totalQty: number): Tier | null
export function computeUniform(tiers, units): Map<lineId, percent>
export function computeIncremental(tiers, units): Map<lineId, montoDescuento>
export function validateTiers(tiers): string[]   // errores de validación
```
**Sin una sola dependencia**, para poder importarla *tanto* desde la Function (se compila a Wasm) *como* desde el preview del admin. Un solo cerebro, dos consumidores → el preview nunca puede mentir respecto a lo que hará el checkout.

Tests con los casos del brief (los tres ejemplos Murad) + carrito vacío + Q bajo el primer tier + tiers desordenados + tiers duplicados.

### Paso 2 — Extensión Function — 6–10 h *(la parte con curva de aprendizaje)*
```
npx shopify app generate extension --template discount --name tiered-discount
```
Genera `extensions/tiered-discount/` con `shopify.extension.toml`, el input query y `src/`.
- Ajustar el input query: `cart.lines { id quantity cost { amountPerQuantity { amount } } merchandise { ... on ProductVariant { id product { id } } } }` + `discount { metafield(namespace:"$app:discountflow", key:"tiered-config") { jsonValue } discountClasses }`.
- Importar la calculadora del Paso 1 y mapear a `operations`.
- Probar con `shopify app function run` y fixtures JSON antes de tocar una tienda real.

### Paso 3 — Migración Prisma — 30 min
`npx prisma migrate dev --name add_tiered_campaign_type` → solo añade `TIERED` al enum. Aditiva, reversible, no toca datos.

### Paso 4 — Capa de servicio — 4–5 h
`app/lib/discounts/tiered.ts`, calcado de `bxgy.ts`:
- `createTieredDiscount()` → resolver IDs + buscar functionId + `discountAutomaticAppCreate` + persistir `shopifyDiscountId`/`metafieldId` en config.
- `updateTieredDiscount()` → `metafieldsSet` + reresolver IDs.
- Pausar/reactivar/eliminar → **reutilizar las funciones de `bxgy.ts`** (`discountAutomaticDeactivate/Activate/Delete` son genéricas para cualquier descuento automático).
  - *Refactor recomendado en este paso:* mover esas 3 funciones a `app/lib/discounts/automatic.ts` y que `bxgy.ts` las reexporte. Cambio quirúrgico, sin tocar comportamiento.
- `app/lib/discounts/tiered-client.ts` con los tipos y `tieredDiscountLabel(config)` para la tabla del listado (espejo de `bxgy-client.ts`).

### Paso 5 — Ruta de creación — 6–8 h
`app/routes/app.campaigns.new.tiered.tsx`, clonando la estructura de `new.bxgy.tsx`:
- loader: `getCollections` + `getProductMetadata` (idéntico).
- Reutilizar `SelectionPanel` (se puede extraer de `new.bxgy.tsx` a `CampaignFormShared.tsx` — hoy está duplicado ahí dentro).
- Editor de tiers + selector de modo (§4).
- action: validaciones → `getOrCreateShop` → límite de plan → `prisma.campaign.create({ type: "TIERED" })` → si activa, `createTieredDiscount()` con el mismo rollback que BXGY (borrar la campaña si Shopify falla).

### Paso 6 — Ruta de edición — 3–4 h
`app/routes/app.campaigns.$id.edit_.tiered.tsx`, espejo de `edit_.bxgy.tsx`.

### Paso 7 — Integración en el listado — 1–2 h
En `app.campaigns._index.tsx`:
- 4ª `CampaignCard` con mockup + `href="/app/campaigns/new/tiered"`.
- `editHref`: añadir rama `TIERED → /app/campaigns/${id}/edit/tiered`.
- Columna "Descuento": `tieredDiscountLabel(config)` → p.ej. *"3 niveles · hasta 20%"*.
- Las 3 ramas de acciones (pause/activate/delete): añadir `|| campaign.type === "TIERED"` reutilizando el `shopifyDiscountId` del config.
- Textos en `app/i18n.ts` (namespace `es.nuevaTiered` + `es.campanas.escalonado`).

### Paso 8 — Preview visual — 3–4 h
Componente `TieredPreview` en el panel sticky (§4).

### Paso 9 — Atribución en analytics — 2–3 h
`webhooks.orders.create.tsx`: añadir bloque TIERED que cruce `discount_applications[].title` con las campañas.

> 🐛 **Hallazgo colateral (bug preexistente, NO parte de esta feature).** El bloque BXGY del webhook compara `campaign.name` con `discount_applications[].title`, pero `createBxgyDiscount()` crea el descuento con el título **`[DiscountFlow] ${campaignName}`**. Los strings no coinciden → **es muy probable que la atribución de pedidos BXGY nunca haya registrado nada en producción.** No lo toqué. Es verificable en 5 minutos con un pedido de prueba en la dev store, y conviene arreglarlo antes de construir TIERED encima del mismo mecanismo (o TIERED nacerá con el mismo bug). Lo suyo: guardar `shopifyDiscountId` y comparar por título con prefijo, no por nombre pelado.

### Paso 10 — Prueba end-to-end en dev store — 3–4 h
Crear productos de prueba, campaña de 3 tiers en cada modo, verificar carrito y checkout con números reales.

---

## 4. UX propuesta

### Wireframe del formulario (mismo layout 1fr/320px de las otras campañas)

```
┌─────────────────────────────────────────────┬──────────────────────────┐
│ 1 · INFORMACIÓN GENERAL                   ▾ │  VISTA PREVIA            │
│   Nombre de la campaña  [_______________]   │  ┌────────────────────┐  │
│                                             │  │ Cant.  Desc. Precio│  │
│ 2 · ¿A QUÉ PRODUCTOS APLICA?              ▾ │  │  1     10%    $90  │  │
│   Modo [Colecciones ▾]  [Seleccionar…]      │  │  2     15%   $170  │  │
│   (chips de lo seleccionado)                │  │  3     20%   $240  │  │
│                                             │  │  4+    20%   $320  │  │
│ 3 · MODO DE APLICACIÓN                    ▾ │  └────────────────────┘  │
│   ◉ Uniforme    ○ Incremental               │   Ejemplo con producto   │
│   ┌───────────────────────────────────────┐ │   de $100                │
│   │ Al llegar a 3 unidades, las 3 quedan  │ │                          │
│   │ al 20%.  3 × $100 → paga $240         │ │  ┌────────────────────┐  │
│   └───────────────────────────────────────┘ │  │ RESUMEN            │  │
│                                             │  │ Tipo   Escalonado  │  │
│ 4 · NIVELES DE DESCUENTO                  ▾ │  │ Modo   Uniforme    │  │
│   Desde  Descuento                          │  │ Aplica 12 productos│  │
│   [ 1 ] u.  [ 10 ] %              [🗑]      │  │ Niveles 3          │  │
│   [ 2 ] u.  [ 15 ] %              [🗑]      │  │ Máximo 20%         │  │
│   [ 3 ] u.  [ 20 ] %              [🗑]      │  │ Inicio Inmediato   │  │
│   [ + Agregar nivel ]                       │  └────────────────────┘  │
│                                             │                          │
│ 5 · PROGRAMAR CAMPAÑA                     ▸ │                          │
└─────────────────────────────────────────────┴──────────────────────────┘
[Cancelar]                    [Guardar borrador]  [Activar campaña]
```

**Selector de modo:** dos radios con una caja explicativa que **cambia en vivo con los tiers reales del merchant** — no texto genérico. Si tiene 1/10%, 2/15%, 3/20%:
- Uniforme → *"Al llegar a 3 unidades, las 3 quedan al 20%. 3 × $100 → paga $240."*
- Incremental → *"Cada unidad tiene su propio descuento: 10%, 15% y 20%. 3 × $100 → paga $255."*

Es la forma más rápida de que entienda la diferencia: mismos tiers, dos totales distintos, lado a lado.

**Editor de tiers:** filas con `Desde [n] unidades → [%] descuento` + papelera. "Agregar nivel" precarga la siguiente cantidad y +5%. Validaciones en vivo: mínimo 1 tier, `minQty` estrictamente creciente y sin repetir, `percent` entre 1 y 99, y aviso suave si un tier posterior tiene menos % que el anterior (permitido pero casi siempre es un error de dedo).

**Preview:** tabla de tiers calculada con la **misma función pura** del Paso 1, sobre un producto de referencia de $100 (o el precio real del primer producto seleccionado, que es mejor). Fila extra "4+" mostrando que el último tier se mantiene. Al cambiar de modo, la columna "Precio" se recalcula sola.

---

## 5. Riesgos

| # | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| 1 | **Curva de Shopify Functions** | 🟡 Media | Es el primer contacto del equipo. Mitigado por: plantilla oficial del CLI, `shopify app function run` con fixtures locales (se prueba sin tienda), y toda la lógica difícil vive en la calculadora pura testeable en Node. Estimo 6–10 h para la primera Function funcionando. |
| 2 | **`shopify app deploy` publica a TODOS los clientes** | 🔴 **Alta** | Es un tipo de deploy distinto al de Vercel: las extensiones van en la *versión de la app*, no en el código del servidor. **Atenuante fuerte:** una Function desplegada es **inerte** — solo corre si existe un nodo de descuento que la invoque. Sin campañas TIERED, Greta/NYZA/Vermú no notan nada. Regla: desplegar la extensión primero (inerte), la UI detrás de flag después. Y **nunca** `shopify app deploy` con el toml de dev activo. |
| 3 | **Scopes nuevos** | 🟢 Ninguno | `write_discounts` ya está concedido y es el único que pide `discountAutomaticAppCreate`. Los metafields del descuento van dentro de esa misma mutación. **No hay re-consentimiento de los merchants.** |
| 4 | **El descuento NO se ve en la página de producto** | 🟠 **Alta (de producto, no técnica)** | Con Functions el descuento aparece en **carrito y checkout**, no en el PDP. Es un cambio de expectativa fuerte frente a PERCENTAGE, que sí baja el precio visible. La competencia lo resuelve con una *theme app extension* que pinta la tabla de tiers en el PDP → **es Fase 2 y hay que decírselo al cliente potencial antes de vender la feature.** |
| 5 | **Doble descuento con campañas PERCENTAGE** | 🟡 Media | Si un producto está en una campaña PERCENTAGE (precio de variante ya bajado) *y* en una TIERED, el % escalonado se aplica sobre el precio ya rebajado. Mitigación v1: `combinesWith: {product:false, order:false, shipping:false}` como en BXGY, + validar al guardar si hay solape de productos con otra campaña activa y avisar. |
| 6 | **Staleness de colecciones** | 🟡 Media | Consecuencia de la opción A (§2.1). Mitigación: copy explícito en la UI + botón "Resincronizar" en fase 2. |
| 7 | **Tamaño del metafield** | 🟢 Baja | `productIds` como JSON: ~50 bytes por producto. Greta con ~200 productos ≈ 10 KB, muy por debajo del límite. Solo sería problema con miles de productos → ahí conviene "toda la tienda" (lista vacía). |
| 8 | **Límite de descuentos automáticos por tienda** | 🟡 Media | Shopify limita los descuentos automáticos activos por tienda. Hay que **verificarlo en la dev store** antes de prometer "campañas ilimitadas" en planes altos (PROFESSIONAL permite 100 campañas). |
| 9 | **Edge cases** | 🟡 Media | Carrito vacío → `{operations: []}`. Sin líneas aplicables → idem. `Q` bajo el primer tier → idem. Falta el metafield o viene corrupto → salir sin descuento (**nunca lanzar**: una Function que falla puede romper el checkout). Selling plans / suscripciones y tarjetas de regalo → excluir explícitamente. Borradores de pedido y POS no ejecutan la misma ruta. |
| 10 | **Atribución rota** | 🟡 Media | El bug del prefijo `[DiscountFlow]` descrito en el Paso 9. Arreglarlo antes, o TIERED hereda el mismo defecto. |

---

## 6. Estimación

| Paso | Trabajo | Estimado |
|---|---|---|
| 1 | Calculadora pura + tests | 3–4 h |
| 2 | Extensión Function | **6–10 h** |
| 3 | Migración Prisma (enum) | 0.5 h |
| 4 | Capa de servicio `tiered.ts` | 4–5 h |
| 5 | Ruta de creación | 6–8 h |
| 6 | Ruta de edición | 3–4 h |
| 7 | Integración en el listado | 1–2 h |
| 8 | Preview visual | 3–4 h |
| 9 | Atribución en analytics | 2–3 h |
| 10 | E2E en dev store | 3–4 h |
| | **Total** | **32–45 h** *(5–8 sesiones)* |

**Orden de ataque recomendado:** 1 → 2 → 3 → 4 → 5 → 8 → 7 → 6 → 9 → 10.
Los pasos 1 y 2 primero **a propósito**: concentran todo el riesgo desconocido. Si Functions resulta más áspero de lo previsto, se descubre en el día 1 y no en el día 5 con la UI ya construida.

---

## 7. 🎯 El primer commit

```
feat(tiered): calculadora pura de descuentos escalonados + tests
```

**Un solo archivo nuevo:** `app/lib/discounts/tiered-calc.ts` (~150 líneas) y sus tests.

**Por qué este y no otro:**

- **Riesgo cero para producción.** No importa a nadie, no toca el esquema, no toca la API de Shopify, no toca ninguna ruta. Si se mergea a `main` por accidente, el bundle crece unos KB y no pasa absolutamente nada más.
- **Es la pieza compartida.** Esa misma función pura la consumen **la Function (Wasm) y el preview del admin**. Escrita una vez, el preview no puede mentir sobre lo que hará el checkout — que es exactamente el fallo típico de este tipo de feature.
- **Fuerza a cerrar las decisiones de producto** antes de escribir UI: qué unidad recibe el % mayor en modo B, qué pasa más allá del último tier, cómo se ordenan los tiers. Se resuelven en tests, en horas, no en refactors después.
- **Se puede probar en Node puro**, sin túnel, sin dev store, sin desplegar nada.

**Commits siguientes, en orden:**
2. `feat(tiered): extensión Function de descuento (inerte, sin registrar)`
3. `feat(tiered): añadir TIERED al enum CampaignType` ← primera migración
4. `refactor(discounts): extraer activate/deactivate/delete a automatic.ts`
5. `feat(tiered): capa de servicio createTieredDiscount`
6. … rutas y UI

---

## 8. Antes de empezar necesito de ti

1. **Modo B — ¿el % más alto va a la unidad más barata o a la más cara?** (§2.4). Recomiendo la más barata; cambia el coste real para el merchant.
2. **¿Los dos modos en v1, o arrancamos con Uniforme?** El Uniforme es el estándar del mercado y ~30% menos trabajo. El Incremental es el diferenciador que pidió el prospecto. Mi recomendación: **los dos**, porque la calculadora los cubre casi al mismo coste y el trabajo pesado (Function, rutas, preview) es compartido.
3. **¿La feature se limita por plan?** P. ej. escalonado solo desde LITE. Se decide ahora o se pospone.
4. **¿Arreglamos primero el bug de atribución BXGY** (§ Paso 9) antes de construir encima?
5. **Confirmar con el cliente potencial** que entiende que el descuento se ve en el carrito, no en la página de producto (riesgo #4).

---

## 9. Registro de avance

### Decisiones confirmadas por Jonas (2026-07-24)
1. **Solo carrito/checkout** en v1 — sin theme app extension. El riesgo #4 queda aceptado conscientemente.
2. **Los dos modos en v1**: Uniforme (A) + Incremental (B).
3. **Modo B: el % más alto va a la unidad MÁS BARATA.**
4. ~~Arreglar el bug de atribución BxGy primero~~ → **descartado**. Jonas confirma que BxGy aplica los descuentos correctamente a clientes reales; el bug afecta solo a la tabla interna `OrderAttribution` (Analytics), no a la experiencia del comprador. **BxGy no se toca.** El diagnóstico queda documentado en el Paso 9 por si se retoma.

### FASE 1 — Calculadora pura ✅ COMPLETADA
- `app/lib/discounts/tiered-calc.ts` — sin dependencias, ambos modos, regla "% mayor al más barato", aritmética en centavos enteros.
- `app/lib/discounts/tiered-calc.test.ts` — 24 tests, **24 en verde**.
- `package.json` — script `test` con el runner nativo de Node (`--experimental-strip-types`). **Cero dependencias nuevas.**
- `tsconfig.json` — `allowImportingTsExtensions: true` (necesario para que el runner de Node resuelva el import `./tiered-calc.ts`; inerte para el build de Vite).
- Verificado: ESLint limpio, y `typecheck` sin ningún error en los archivos nuevos.
- Ninguna ruta, modelo ni archivo existente fue tocado. El módulo todavía no lo importa nadie.

> Nota de entorno descubierta en esta fase: `npm run typecheck` **ya venía en rojo** en el repo (14 archivos, por conflicto de versiones duplicadas de `@shopify/shopify-api` entre `@shopify/shopify-app-react-router` y la raíz). No es consecuencia de este trabajo, pero conviene arreglarlo algún día porque tapa errores reales.

### FASE 2 — Extensión Shopify Function ✅ COMPLETADA
Generada con `shopify app generate extension --template discount --flavor typescript` (el CLI **sí** aceptó los flags de forma no interactiva, a diferencia de `config link`).

- `extensions/tiered-discount/src/cart_lines_discounts_generate_run.graphql` — input query propio: `quantity`, `cost.amountPerQuantity`, `merchandise.product.id` y `discount.metafield(namespace:"$app:discountflow", key:"tiered-config")`.
- `extensions/tiered-discount/src/cart_lines_discounts_generate_run.ts` — **no contiene lógica de cálculo**: importa `computeTiered` desde `app/lib/discounts/tiered-calc.ts` (import cruzado que el bundler de `shopify app function build` resuelve sin problema — verificado). Solo filtra líneas aplicables y traduce el resultado a `productDiscountsAdd`.
- **Se eliminó el target de envío** (`cart.delivery-options.discounts.generate.run`) y su código de ejemplo. Menos superficie que pueda afectar al checkout de un merchant.
- Regla de oro implementada: la Function **nunca lanza**. Config ausente, corrupta o modo desconocido → `{operations: []}`.

**Verificación con el Wasm real** — 6 fixtures, todas en verde vía `npx vitest run` dentro de la extensión. El harness compila a Wasm, valida el input query contra el schema y ejecuta la función de verdad:

| Fixture | Comprueba |
|---|---|
| `uniform-3-units` | 3×$100 → `percentage 20` sobre la línea |
| `incremental-3-units` | 3×$100 → `fixedAmount 45` (paga $255) |
| `incremental-cheapest-gets-highest` | $200/$100/$50 → 20/15/10 → la barata se lleva el 20% |
| `product-not-in-campaign` | 5 unidades de un producto ajeno **no** cuentan para el nivel |
| `below-first-tier` | sin operaciones |
| `no-config-metafield` | metafield nulo → sin operaciones |

> ⚠️ Pendiente de verificar **solo** en tienda real: que el namespace `$app:discountflow` del metafield resuelva igual desde el lado del Admin API. Si no resolviera, el síntoma sería "no aplica descuento" (nunca un error), y se arregla cambiando el namespace en los dos lados.

### Siguiente: FASE 3 — migración Prisma (enum TIERED)

---

*Análisis del 2026-07-24. Producción intacta durante todo el proceso.*
