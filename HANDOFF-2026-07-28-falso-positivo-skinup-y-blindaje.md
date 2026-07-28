# 🔍 HANDOFF — El caso SkinUp era un falso positivo, y el blindaje que sí hacía falta (2026-07-28)

> **Handoff vigente.** El anterior, [`HANDOFF-2026-07-26-enforcement-limites.md`](HANDOFF-2026-07-26-enforcement-limites.md), sigue siendo válido para el enforcement de límites y el endpoint de pausa.
> La sección **🧨 DEUDA TÉCNICA Y TRAMPAS** de [`HANDOFF-2026-07-24-escalonados-produccion.md`](HANDOFF-2026-07-24-escalonados-produccion.md) continúa siendo la referencia a nivel de código.

---

## ═══ ESTADO DE PRODUCCIÓN ═══

| Pieza | Estado |
|---|---|
| Código en producción | **`8706569`** — sin cambios hoy |
| Function de Shopify | `discountflow-6` ★ activa — **sin cambios hoy** |
| Trabajo de hoy | **solo en `dev`, sin commitear.** Producción intacta |

**No se tocó producción en ningún momento.** Todo el acceso a datos reales fue de solo lectura.

---

## ═══ 🔴 LO PRIMERO: LA CAUSA RAÍZ QUE ARRASTRÁBAMOS ERA FALSA ═══

La sesión se retomó con este diagnóstico dado por confirmado:

> *La campaña guarda GID de PRODUCTO; la Function compara contra GID de VARIANTE → nunca coinciden → la lista de elegibles queda vacía → lista vacía = "toda la tienda" → descuenta TODO.*

**Nada de eso ocurre.** Comprobado en tres sitios independientes:

| Comprobación | Resultado |
|---|---|
| Fuente de la Function | `line.merchandise.product.id` vs `config.productIds` → **producto contra producto** |
| Compilado `dist/function.js:145-147` | idéntico al fuente |
| Historial git completo (4 commits sobre la Function) | **ningún** commit comparó nunca variantes |

Si la comparación hubiera sido producto-vs-variante, además, el síntoma habría sido el **contrario**: cero coincidencias con la lista NO vacía significa que no se descuenta **nada**. Nunca "se descuenta todo".

---

## ═══ 🔍 AUDITORÍA DE PRODUCCIÓN (solo lectura) ═══

### Alcance real: **1 sola campaña TIERED en toda la producción**

Ni Greta, ni NYZA, ni Vermú tienen escalonados. La única es "Mudrad 2" de SkinUp.

```
[OK] skinup-cl.myshopify.com (ESSENTIAL) | "Mudrad 2" | PAUSED
     selectionMode=collections | productIds=85 | collectionIds=1
     tiers=3/INCREMENTAL | tipo de GID guardado: Product
ACTIVAS descontando toda la tienda sin pedirlo: 0
Latentes con el mismo config: 0
```

### La campaña estaba correctamente configurada

Contrastado contra la Admin API de SkinUp, producto a producto:

| | |
|---|---|
| Colección "BRAND Murad" | **85 productos** |
| `productIds` del metafield | **85** |
| Guardados que NO están en la colección | **0** |
| En la colección pero NO guardados | **0** |
| Vendors entre los 85 | **85 × Murad** |

### El producto del reporte SÍ es Murad

```
Hydrating Toner - Tónico Hidratante  [vendor: Murad]  gid://shopify/Product/4363125948478
   ¿en la colección BRAND Murad? SÍ
   ¿en los productIds de la campaña? SÍ
```

**Recibió descuento porque es un producto Murad y pertenece a la colección.** La campaña hizo exactamente lo que se le pidió. **No hubo sangrado.**

### Dos pistas para la conversación con el cliente

1. **Hay OTRA app de descuentos activa en SkinUp.** `Pack 2 Flo` es un `DiscountAutomaticApp` **ACTIVE** con `functionId 65d94a32-0917-4729-868d-b8f9f34ba62a`, distinto del nuestro (`019f9628-8775-7f75-9e6f-7d8579e30de4`). Si el cliente vio un descuento inesperado sobre algo que no es Murad, ese es el candidato probable. SkinUp tiene además ~20 códigos activos y un BxGy ("Environ + regalo").
2. **La colección se llama "BRAND Murad" pero su handle es `brand-multimarca-copia`** — creada duplicando una colección multimarca. Si el merchant cree que contiene menos productos de los que contiene, la discusión es sobre el contenido de su colección, no sobre la app.

> `[DiscountFlow] Mudrad 2` figura como **EXPIRED** en Shopify: es el efecto normal de pausarla (`discountAutomaticDeactivate` fija `endsAt`). La pausa de Jonas funcionó.

---

## ═══ ✅ LO QUE SÍ SE ARREGLÓ (en `dev`) ═══

El agujero real no era el reportado, sino el que ya estaba anotado como deuda: **"un escalonado sobre una colección vacía descuenta todo el catálogo"**. Seguía abierto y es el único camino por el que el sangrado temido podía ocurrir de verdad.

**Raíz del problema:** `productIds: []` significaba dos cosas incompatibles e indistinguibles — *"el merchant eligió toda la tienda"* y *"la resolución falló o la colección está vacía"*. La segunda convertía un fallo silencioso en un descuento a todo el catálogo.

### Capa 1 — La Function ya no adivina el alcance

Campo **`scope`** explícito en el metafield: `"all"` | `"selected"`. Solo `"all"` autoriza descontar todo el catálogo. Cualquier otro caso con lista vacía → `NO_DISCOUNT`.

**Metafields legados (sin `scope`) → fail-closed.** Una campaña vieja de "toda la tienda" deja de aplicar hasta que la app reescriba su metafield. Es deliberado: dejar de descontar es un fallo que el merchant ve y reporta; descontar el catálogo entero cuesta dinero en silencio.

### Capa 2 — La app declara el alcance

`toFunctionConfig()` emite `scope` derivado de `selectionMode`. `tieredAppliesToProduct()` (atribución en Analytics) replica la regla nueva: si las dos divergen, la atribución miente.

### Capa 3 — La resolución deja de mentir

`admin-api.ts` tenía el patrón `json.data?.algo?.nodes ?? []`, que convierte **cualquier** fallo de API (consulta rechazada, throttling, token caducado) en "no hay productos". Nuevo helper `readQueryData()` que lanza. Aplicado a `getCollectionProductVariants`, `getAllProductVariants` y `getProductsByFilter`. Una colección borrada o inaccesible lanza en vez de pasar por vacía.

> Mismo fallo tragado que ya se corrigió en `bulkUpdateVariantPrices` y `runDiscountMutation`. Este era el tercero.

### Capa 4 — Una campaña no se guarda si no abarca nada

`resolveTieredProductIds()` lanza con mensaje accionable cuando la selección resuelve a cero productos (colección vacía, filtro que no casa, selección ausente). `countTieredProducts()` queda tolerante (devuelve 0) porque es solo un contador de UI y no puede tumbar una pantalla.

### Capa 5 — La reactivación refresca la configuración

Reactivar un TIERED desde el listado llamaba solo a `activateTieredDiscount`, que **no** reescribe el metafield. Con el fail-closed eso habría dejado a "Mudrad 2" reactivada y sin descontar nada. Ahora la reactivación llama antes a `updateTieredDiscount`: migra el metafield legado y re-resuelve los productos, de modo que una campaña por colección refleje la colección de HOY.

---

## ═══ VERIFICACIÓN ═══

| Suite | Resultado |
|---|---|
| Fixtures de la Function (contra el Wasm real) | **10/10** ✅ (eran 7) |
| `npm test` (calculadora) | **24/24** ✅ |
| `npm run build` | verde ✅ |
| `npm run typecheck` | **103** — ver nota abajo |

### Fixtures nuevas (3)

- **`seleccion-vacia-no-descuenta-nada.json`** — `scope: "selected"` + lista vacía → no descuenta. Es *el* test del bug latente.
- **`metafield-legado-sin-scope-no-descuenta.json`** — metafield viejo sin `scope` → fail-closed.
- **`coleccion-carrito-mixto-solo-los-de-dentro.json`** — réplica del caso SkinUp: carrito con productos dentro y fuera de la colección; solo los de dentro reciben descuento, y las líneas ajenas **no** corren los tramos.

Las 6 fixtures previas se migraron al contrato explícito (`scope`).

> ⚠️ **Nota sobre el typecheck: 103, no 102.** El error nuevo es `app.campaigns._index.tsx:168` — `updateTieredDiscount(admin, …)`, exactamente el mismo desajuste `AdminApiContext` vs `AdminClient` que ya arrastran **todas** las llamadas de ese archivo. Es la deuda de tipos conocida del repo, no un tipo mal escrito. No se enmascaró con un `as` porque ningún otro sitio del repo lo hace. **Nueva línea base de `dev` = 103.**

### Regla de negocio confirmada de paso

En modo INCREMENTAL las unidades se agrupan entre **todas** las líneas elegibles del carrito, se ordenan de más cara a más barata y los tramos se reparten por posición (el % más alto a la unidad más barata; decidido el 24/07). Un carrito de 3×$100 + 2×$50 da `[10,15,20,20,20]` → $45.00 y $20.00. La primera versión de la fixture asumía cálculo por línea y estaba mal; el código tenía razón.

---

## ═══ 📋 PLAN DE DEPLOY A PRODUCCIÓN (pendiente de aprobación) ═══

**Este deploy toca la Function → requiere `shopify app deploy` + release.** Es más delicado que los tres últimos.

### Antes

1. **Probar en la dev store** con `shopify app dev` (interactivo, lo corre Jonas): escalonado por colección con carrito mixto; regresión de "productos específicos" y "toda la tienda". Las fixtures ya cubren la lógica contra el Wasm, pero el circuito completo con metafield real no se ha ejercitado.
2. **Decidir si se sigue adelante**, dado que el bug que motivó la sesión no existía. El blindaje sigue mereciendo la pena por sí solo, pero ya no es una urgencia: **no hay ninguna campaña sangrando en producción.**

### Orden

1. `shopify app deploy` → nueva versión de la Function → **release**.
2. Deploy del código de la app (Vercel).
3. La Function nueva y el código viejo conviven bien: el código viejo no emite `scope`, la Function nueva lo trata como legado → fail-closed. **Como la única campaña TIERED está PAUSED, ese hueco temporal no afecta a nadie.** Aun así, desplegar la Function y la app seguidas.

### Después — migración de "Mudrad 2"

Su metafield es legado (sin `scope`). **No hace falta script**: al reactivarla desde el listado, la capa 5 reescribe el metafield y re-resuelve la colección. Verificar tras reactivar que el metafield tiene `scope: "selected"` y 85 productIds.

### Rollback

Vercel → Instant Rollback a `8706569`. La Function se revierte por separado desde el Partner Dashboard (release de la versión anterior). Sin migraciones ni scopes de por medio.

---

## ═══ ARCHIVOS TOCADOS (todo en `dev`, sin commitear) ═══

```
extensions/tiered-discount/src/cart_lines_discounts_generate_run.ts   puerta de seguridad + scope
app/lib/discounts/tiered-client.ts                                    tipo TieredScope, toFunctionConfig, tieredAppliesToProduct
app/lib/discounts/tiered.ts                                           resolveTieredProductIds lanza; countTieredProducts tolerante
app/lib/shopify/admin-api.ts                                          readQueryData() + 3 helpers endurecidos
app/routes/app.campaigns._index.tsx                                   reactivación refresca el metafield
extensions/tiered-discount/tests/fixtures/*.json                      3 nuevas + 6 migradas
```

---

## ═══ PENDIENTES HEREDADOS (sin cambios) ═══

- 🔴 Seguridad: repo GitHub **público**, backup `.env` de prod sin borrar, secretos sin rotar. **Van 4 días.**
- 🔴 Cron `/api/cron/sync-campaigns` declarado en `vercel.json` y **la ruta no existe** → campañas programadas nunca se activan.
- 🟡 Endpoint de pausa (`api.internal.pause-over-limit.tsx`) sin desplegar; caso Vermú sin cerrar.
- 🟡 Quitar los logs `[tiered-debug]` y `[tiered-attribution]`.
- 🟡 `"Descuento por cantidad"` duplicado en 3 sitios.
- 🟡 Decisión pendiente: `combinesWith.productDiscounts` sigue en `false`.

> Sobre el último punto, dato nuevo de hoy: SkinUp tiene **otro descuento automático de app activo** (`Pack 2 Flo`). Con `productDiscounts: false`, nuestro escalonado y el de la otra app compiten y **uno de los dos se pierde en silencio** en cualquier carrito donde ambos apliquen. Es el escenario exacto que motivó la duda, ahora con un caso real detrás.

---

*Sesión 2026-07-28. Cero cambios en producción. Un falso positivo cerrado con evidencia y un bug latente real, blindado en dev.*
