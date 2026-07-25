# 🚀 HANDOFF — Atribución de escalonados y contador de productos (2026-07-25, cierre de jornada)

> **Este es el handoff vigente.**
> El anterior, [`HANDOFF-2026-07-24-escalonados-produccion.md`](HANDOFF-2026-07-24-escalonados-produccion.md), **sigue siendo lectura obligada**: su sección **🧨 DEUDA TÉCNICA Y TRAMPAS** conserva el detalle a nivel de código de las trampas que siguen vivas. No está obsoleto, está subordinado a este.
> Registro de la sesión del 24: [`docs/sesiones/2026-07-24-escalonados-y-deploy-produccion.md`](docs/sesiones/2026-07-24-escalonados-y-deploy-produccion.md)

---

## ═══ ESTADO DE PRODUCCIÓN ═══

| Pieza | Estado |
|---|---|
| Código en producción | **`9822f30`** |
| Function de Shopify | `discountflow-6` ★ activa — **sin cambios hoy** |
| Vercel | `dpl_D8SwUkhkUXJUsvUW9UU2ynz1fYF4` · Ready · Production Current |
| `main` y `dev` | idénticos en `9822f30` (más el commit de este handoff, solo en `dev`) |
| Migraciones | ninguna nueva hoy |

**Feature Descuentos Escalonados: COMPLETA y validada de punta a punta** — aplica el descuento, atribuye correctamente en Analytics y no afecta a los otros tres tipos de campaña.

### Rollback
| Nivel | Acción |
|---|---|
| 1 | Vercel → Instant Rollback a **`discountflow-chfpx4ehw`** (`94b19a6`, contador ya arreglado pero atribución vieja) |
| 2 | Vercel → Instant Rollback a `discountflow-1adb4euya` (`0d138a2`, estado del 24/07) |
| — | Ninguno de los dos deploys de hoy tocó la Function, el esquema ni los scopes → **rollback limpio, sin pasos previos** |

---

## ═══ LO QUE SE HIZO HOY ═══

### 1. Verificación del "0 productos" — no era un bug

Confirmado en la dev store que el contador en 0 para TIERED **era de siempre** y puramente cosmético: el escalonado funcionaba correctamente igual. Se descartó como fallo funcional antes de tocar nada.

### 2. Fix del contador → producción (`94b19a6`)

El listado de Campañas ya muestra el número real de productos para TIERED.

- **2 archivos:** `app/lib/discounts/tiered-client.ts` (helper `tieredProductsLabel()`) y `app/routes/app.campaigns._index.tsx` (la celda).
- **Causa:** la columna usa `_count.products` (filas de `CampaignProduct`) y **TIERED no crea ninguna, igual que BXGY** — no edita precios de variantes, el descuento lo calcula la Function en el carrito. Verificado contando referencias: `percentage.ts` y `range.ts` sí las crean; `bxgy.ts` y `tiered.ts`, cero.
- **Casos:** modo "all" → **"Toda la tienda"** (`productIds` vacío es intencionado) · borrador por colección/tag/vendor/tipo → **"—"** (los productos se resuelven al ACTIVAR) · resto → número real.
- Aditivo puro. PERCENTAGE, RANGE y BXGY intactos. Deploy solo código.
- ⚠️ **Cubrió solo el listado.** El dashboard de Inicio sigue con el conteo viejo — ver pendientes.

### 3. Fix de la atribución de escalonados → producción (`9822f30`) — lo grande del día

**El problema, descubierto por los logs:** el título que llega en `discount_applications[].title` es **`"Descuento por cantidad"`** —el `message` de la Function— y **no** `[DiscountFlow] <nombre>`. Es idéntico en todas las campañas escalonadas, así que **no sirve para identificar campaña**. Encima, el código viejo cogía solo la primera application (`find`) cuando la Function emite **una por línea**, de modo que un pedido de N líneas atribuía **1/N del importe**.

**La solución implementada** (bloque 3 de `webhooks.orders.create.tsx` + helpers en `tiered-client.ts`):

1. **El título solo DESCARTA, nunca elige.** Se consideran únicamente las applications `automatic` cuyo título coincida con el `message` de alguna campaña TIERED activa → deja fuera los descuentos del merchant o de otras apps, que si no inflarían el revenue.
2. **Quien ASIGNA es el cruce por productos:** `product_id` del pedido contra `config.productIds` de cada TIERED activa, vía `tieredAppliesToProduct()`.
3. **"Toda la tienda" / lista vacía = candidata universal**, exactamente la misma regla que aplica la Function en el checkout.
4. **Normalización de IDs**: el webhook manda `product_id` numérico y el config guarda GIDs → se convierte a `gid://shopify/Product/N`. Sin esto no cruza nada.
5. **Se suman TODAS las allocations** (`find` → recorrido completo), con un `Set` de líneas para no contar dos veces el `orderAmount`.
6. **Ante ambigüedad no se atribuye** y queda registrado en el log: mejor un hueco visible que dinero en la campaña equivocada.

Se eliminó `matchesTieredDiscountTitle()` (código muerto: su único consumidor era este webhook) y se corrigió el comentario de `TIERED_TITLE_PREFIX`, que afirmaba lo contrario y fue el origen del error.

> El payload REST de `orders/create` **no trae el ID del descuento**, así que no existe una vía exacta de identificación. Por eso se convive con la ambigüedad en vez de fingir precisión.

#### ✅ VALIDADO EN PRODUCCIÓN — pedido real #1008

| Métrica | Resultado |
|---|---|
| Líneas del pedido | 3 |
| Importe atribuido | **$45.10 — el total, no un tercio** |
| Ingresos atribuidos | $304 |
| Pedidos atribuidos | 1 |
| ROI | 674% |

La atribución funciona de punta a punta y Analytics lo refleja.

### 4. Duda resuelta — la regla del "4º producto"

**Pregunta:** ¿el 4º producto no debería quedarse sin descuento?

**Respuesta: no es un bug, el comportamiento es correcto.** Contrastado con la documentación de otras apps del mercado: el estándar de la industria es que **las unidades por encima del último nivel mantienen el descuento del último tramo** (el clásico "50 o más"). El modo Incremental de la app sigue el estándar DTC. No hay nada que cambiar.

---

## ═══ PENDIENTES ABIERTOS ═══

### 🔴 Seguridad (lo más urgente)

- [ ] **El repo de GitHub sigue PÚBLICO** → volver a privado. Es un clic. *(Recordatorio: Vercel despliega repos privados sin problema; ponerlo público nunca fue necesario.)*
- [ ] **Rotar secretos:** `SHOPIFY_API_SECRET` de producción, contraseña de Neon y el secreto de la app Dev.
- [ ] **Borrar** `C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` tras moverlo al gestor de contraseñas.

### 🧹 Limpieza (ya se puede hacer)

- [ ] **Quitar los logs `[tiered-debug]` y `[tiered-attribution]`.** Ya cumplieron su función: la atribución está validada. Deploy pequeño, solo código. Ubicaciones exactas en la sección "Limpieza pendiente" del handoff del 24.
- [ ] **`connect_timeout=20`** en las URLs de Neon (el `P1001` vuelve tras cada suspensión del branch; el default de Prisma son 5 s y el arranque en frío tarda ~11 s).

### 🧨 Deuda técnica — detalle completo en el handoff del 24

- **`"Descuento por cantidad"` duplicado en 3 sitios** (`tiered-form.ts:74`, la Function `:109`, `TIERED_DEFAULT_MESSAGE` en `tiered-client.ts`). **Romper uno solo deja la atribución en $0, en silencio y sin error.** Unificar el día que se toque la Function por otro motivo (exige redeploy + release).
- **Bug latente:** un escalonado sobre una **colección vacía** descuenta **todo el catálogo** (lista vacía = universal para la Function). Sin arreglar.
- **Dashboard de Inicio** (`app/routes/app._index.tsx`) con el contador viejo: la tabla de recientes necesita que el loader devuelva `config`; el KPI "Productos en descuento" **necesita decisión aparte** porque mezcla variantes (`CampaignProduct`) con productos (`config.productIds`).

### Decisiones de negocio aún sin tomar (heredadas)

- **`combinesWith.productDiscounts`**: sigue en `false`. Un escalonado se pierde en silencio si hay otro descuento automático compitiendo en el mismo carrito. Cambiarlo es 1 línea, con riesgo de acumulación.
- **Un borrador escalonado no se puede activar** desde la pantalla de edición (se implementó y se revirtió en `64b8d23`).
- **Atribución de BXGY rota** desde su primer commit. Decisión tomada: no se arregla.

---

## ═══ NOTAS PARA RETOMAR ═══

- **`dev` va un commit por delante de `main`**: el de este handoff. Es solo documentación, no toca código. Tenlo en cuenta al preparar el próximo deploy, para que no aparezca como sorpresa en `git log main..dev`.
- **`npm run build` modifica `.vercel/react-router-build-result.json`, que está TRACKEADO en git.** Revertirlo antes de commitear o se cuela un artefacto en el deploy.
- **En dev NO se puede probar la atribución:** `orders/create` está comentado en `shopify.app.dev.toml` por falta de aprobación de Protected Customer Data en la app Dev. Toda validación de atribución tiene que ser en producción.
- **Nunca `shopify app dev` con la config de producción activa** (`automatically_update_urls_on_dev = true` reescribiría la `application_url` de prod y rompería el OAuth de todos los clientes).
- **Suites de regresión:** `npm test` (24 tests de la calculadora) y `cd extensions/tiered-discount && npx vitest run` (7 fixtures contra el Wasm).
- **`npm run typecheck` ya venía rojo** en 14 archivos por versiones duplicadas de `@shopify/shopify-api`. La referencia actual son **100 errores**: si tras un cambio siguen siendo 100, no hay regresión.

---

*Cierre de jornada 2026-07-25. Dos deploys a producción, feature de escalonados completa y validada con pedido real. Sin incidencias.*
