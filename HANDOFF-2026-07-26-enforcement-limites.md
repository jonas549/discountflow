# 🚀 HANDOFF — Enforcement de límites de plan en producción (2026-07-26, cierre de jornada)

> **Este es el handoff vigente.**
> El anterior, [`HANDOFF-2026-07-25-atribucion-y-contador.md`](HANDOFF-2026-07-25-atribucion-y-contador.md), sigue siendo válido para todo lo de escalonados y atribución.
> La sección **🧨 DEUDA TÉCNICA Y TRAMPAS** de [`HANDOFF-2026-07-24-escalonados-produccion.md`](HANDOFF-2026-07-24-escalonados-produccion.md) continúa siendo la referencia a nivel de código.

---

## ═══ ESTADO DE PRODUCCIÓN ═══

| Pieza | Estado |
|---|---|
| Código en producción | **`8706569`** — `feat(billing): enforcement de límites de plan` |
| Anterior (rollback) | `9822f30` |
| Function de Shopify | `discountflow-6` ★ activa — **sin cambios hoy** |
| Migraciones | **ninguna nueva** |
| Scopes / webhooks / toml | **sin tocar** → ningún merchant reautorizó |
| `main` y `dev` | `main` = `8706569`; `dev` = igual + el endpoint sin trackear |

### Rollback
Vercel → Instant Rollback a **`9822f30`**. Limpio y sin pasos previos: no hay migración que revertir ni Function que degradar. La línea base de `typecheck` volvería a 100.

---

## ═══ ⏳ LO PRIMERO AL RETOMAR ═══

🔴 **Confirmar en el dashboard de Vercel que `8706569` figura como Ready / Production Current.**

No se pudo verificar desde fuera, y la razón importa: **todos los cambios de este deploy son de servidor** (`action`s y librerías `.server`), que React Router elimina del bundle de cliente. Los 42 assets del manifiesto de producción coinciden con el build local, pero eso no discrimina — el bundle de cliente es idéntico antes y después. No hay rutas nuevas que sondear, no hay CLI de Vercel instalado y las cabeceras no exponen el commit.

> Precedente: el 24/07 un push a `main` **no** disparó el deploy y se detectó por casualidad. Si no aparece, el arreglo conocido es un commit vacío de trigger, o revisar Vercel → Settings → Git.

---

## ═══ LO QUE SE HIZO HOY ═══

### 1. Auditoría completa de límites de plan

Se levantó el mapa de los **9 puntos de acción** (crear ×4, activar desde editar ×4, reactivar desde listado) contra los dos límites. Resultado del diagnóstico previo:

- Límite de **campañas**: ya estaba completo en los 8 puntos alcanzables.
- Límite de **variantes**: solo existía como adorno. `getVariantCount()` alimentaba la UI y **no bloqueaba nada**.

Ese hueco es como Vermú (FREE, límite 50) llegó a **578 variantes activas**.

### 2. Enforcement de variantes en PERCENTAGE / RANGE

**El problema técnico:** las variantes no se conocen hasta resolver la selección contra Shopify, que ocurre *después* de crear la campaña.

**La solución:** opción `maxVariants` en `applyPercentageDiscount` / `applyRangeDiscount`. La comprobación va **justo después de `resolveVariants` y ANTES del bucle** que hace los `upsert` y escribe precios en Shopify. Lanzar ahí no deja rastro: ni una fila, ni un precio tocado.

- Error tipado `PlanLimitError` (`app/lib/billing/plan-limit-error.ts`, archivo nuevo) → las rutas lo traducen a 422 + `limitExceeded` para que salga el banner amarillo con "Ver planes".
- Detecta por `name`, no con `instanceof`: si el bundler duplicara el módulo, `instanceof` fallaría en silencio y el error se reportaría como un 500 genérico, perdiendo el banner.
- Enganchado en: crear (percentage/range), activar desde editar (×2) y reactivar desde el listado.

**Dos sutilezas que hubo que resolver:**

1. **No contar dos veces al reeditar.** Si la campaña ya está ACTIVE, sus filas están dentro de `getVariantCount` y se van a **reemplazar**, no a sumar → se descuentan. Sin esto, reeditar una campaña de 500 variantes en ESSENTIAL la contaría como 1.000.
2. **Hay un camino que no pasa por `apply*`.** Al activar desde editar **sin cambiar la selección** se llama a `reactivate*Discount` con las filas guardadas. Ese camino tiene su propio chequeo en el bloque de plan; si no, sería un bypass.

### 3. Límite de campañas ACTIVAS por tipo (BxGy / Escalonado)

Se descartó contar variantes para estos dos tipos por tres motivos: desajuste productos-vs-variantes, `selectionMode: "all"` guarda `productIds` vacío a propósito (contaría 0 justo en el caso más grande), y el riesgo de medir a SkinUp por primera vez y bloquearla.

**En su lugar: tope por cantidad de campañas activas simultáneas de ese tipo.**

| Plan | General | BxGy | Escalonados |
|---|---|---|---|
| FREE | 2 | — *(usa el general)* | — |
| LITE | 5 | 4 | 2 |
| ESSENTIAL | 50 | 10 | 10 |
| PROFESSIONAL | 100 | sin tope | sin tope |

- **Solo cuentan las ACTIVE.** Pausadas y borradores no ocupan cuota → **pausar una para activar otra es válido y deseado**, no una trampa.
- En LITE los sublímites no son alcanzables a la vez (4+2=6 > 5). No es un bug: el general se agota antes.
- Ninguna campaña activa se re-evalúa nunca → **nadie queda bloqueado de golpe**. Es estructural, no una promesa.

### 4. Endurecimiento de `bulkUpdateVariantPrices` — **ya está en producción**

Hacía `json.data?.… ?? []`, tragándose en silencio los errores de GraphQL y los `userErrors`: el llamador sumaba variantes como aplicadas/revertidas aunque Shopify no hubiera cambiado nada. Mismo patrón de error tragado que ocultó el bug del modo INCREMENTAL.

Ahora lanza ante las tres formas de fallar (igual que `runDiscountMutation` en `tiered.ts`) y reintenta con backoff exponencial ante `THROTTLED` (4 reintentos, 500 ms base).

> ⚠️ **Entró con `8706569`, así que lleva vivo desde hoy afectando a Greta, NYZA y SkinUp.** El camino feliz es idéntico (misma mutación, mismo mapeo, y ningún llamador lee el retorno). **Revisar los logs de Vercel:** si aparecen excepciones nuevas desde `bulkUpdateVariantPrices`, son fallos reales que antes se tragaban — información valiosa, no una regresión.

### 5. Archivos del deploy (15)

```
app/i18n.ts                                   + limiteCampanasTipo()
app/lib/billing/plan-limit-error.ts           NUEVO
app/lib/billing/plan-limits.ts                + maxBxgy/maxTiered + getTypeCampaignLimit()
app/lib/billing/plan-limits.server.ts         + getCampaignVariantCount, getActiveCampaignCountByType
app/lib/discounts/percentage.ts               + maxVariants
app/lib/discounts/range.ts                    + maxVariants
app/lib/shopify/admin-api.ts                  endurecido + backoff
app/routes/app.campaigns.new.percentage.tsx   cuota + traducción de PlanLimitError
app/routes/app.campaigns.new.range.tsx        ídem
app/routes/app.campaigns.$id.edit.tsx         ídem + descuento de filas propias
app/routes/app.campaigns.$id.edit_.range.tsx  ídem
app/routes/app.campaigns.new.bxgy.tsx         sublímite por tipo
app/routes/app.campaigns.new.tiered.tsx       sublímite por tipo
app/routes/app.campaigns.$id.edit_.bxgy.tsx   sublímite por tipo
app/routes/app.campaigns._index.tsx           variantes (P/R) + cantidad (BxGy/TIERED)
```

**Verificación pre-deploy:** typecheck **100** (línea base original, cero errores nuevos), 24/24 tests, build verde. 15 sondeos HTTP durante ~7 min → **200 siempre, cero downtime**.

---

## ═══ 🔒 EL ENDPOINT DE PAUSA — CONSTRUIDO, PROBADO, **NO DESPLEGADO** ═══

`app/routes/api.internal.pause-over-limit.tsx` — **existe solo en `dev`, sin trackear.** Quedó deliberadamente fuera del deploy.

**Qué hace:** panel HTML interno que lista las campañas que exceden el límite de variantes de su plan, con un botón rojo por campaña. Al pulsarlo (con `confirm` previo) revierte los precios en Shopify y marca PAUSED.

- `GET` → página con la lista. **No toca nada**: solo `findMany`/`count`/`groupBy`, cero llamadas a Shopify.
- `POST` → ejecuta. Que la ejecución viva en POST es deliberado: ningún GET accidental dispara cambios.
- Protegido con `CRON_SECRET` (cabecera, query o campo del formulario). Sin él → 401.
- **No enlazado desde ninguna parte de la UI.** Nadie lo importa.

**🔴 ORDEN NO NEGOCIABLE dentro del endpoint:** revertir precios primero, marcar PAUSED **solo si el revert vuelve sin errores**. Al revés, un corte a mitad dejaría la campaña "pausada" con los descuentos vivos y nadie volvería a revertirlos, porque el flujo de pausa de la UI ya se habría consumido.

**Probado en dev:** 401 sin secreto · dry-run detecta "Test vermu" (139 variantes / 65 productos, límite 50) · la página renderiza tienda, campaña, contadores y botón.
**Sin ejercitar:** el `POST` real. Sería el **primer uso de `unauthenticated.admin` en todo el repo**.

### ⛔ NO cambiar a `Shop.accessToken`

`Shop.accessToken` es una copia que escribe `getOrCreateShop` en cada carga (`shop.server.ts:17-18`) y **nunca se refresca**. Con `expiringOfflineAccessTokens: true` (`shopify.server.ts:20`) caduca y la columna se queda muerta. `unauthenticated.admin` sí dispara el refresh vía el `refreshToken` de la fila `Session`. Cambiarlo convertiría un fallo recuperable en uno permanente y silencioso.

---

## ═══ CASO VERMÚ ═══

FREE, **578 variantes activas** con límite 50 (11×). Token **vivo** (confirmado por Jonas).

**Lo que cambió hoy:** con el enforcement en producción, **ya no puede rehacer la campaña grande**. La puerta de entrada está cerrada; el sangrado, cortado. Lo que queda pendiente es apagar la campaña **actual**, y eso necesita el endpoint desplegado.

**Antes de ejecutar sobre ella:**

1. 🟡 **Confirmar si Fluid compute está activo** (Vercel → Settings → Functions). Con Fluid, techo 300 s → sobra. Sin él, 60 s contra un revert de ~40 s → va justo, y el backoff de throttle puede alargarlo.
2. 🟡 **Mandar el correo comercial ANTES.** El día que se ejecute, 578 variantes vuelven a precio completo sin aviso. Con correo previo es una conversación de venta; sin él, un incidente.
3. Dato útil para ese correo: **578 variantes entran en LITE (750) — $9.99/mes**, no necesita ESSENTIAL. Es un "sí" mucho más fácil.
4. Verificar una vez la URL de Managed Pricing en una tienda real: es la que dio 404 en el rechazo de App Store del 29/05 y no se ha comprobado post-fix.

**Aislamiento al ejecutar:** el `?shop=` filtra lo que muestra la página, no el `action` (que recalcula sobre todas las tiendas y pausa la campaña del `campaignId` enviado). Lo que garantiza no tocar a otros son cuatro capas: un clic = una campaña · con el filtro solo se dibujan los botones de esa tienda · el servidor rechaza con 409 si esa campaña ya no excede · y hoy Greta/NYZA/SkinUp no exceden nada, así que ni aparecen en la lista.

---

## ═══ 🕳️ HUECOS QUE SIGUEN ABIERTOS ═══

| | Hueco | Detalle |
|---|---|---|
| 🔴 | **BxGy / Escalonado "toda la tienda"** | Se topan por *cantidad* de campañas, no por tamaño de catálogo. Un FREE puede descontar todo su catálogo con un escalonado. **Contrapartida aceptada conscientemente** a cambio de no romper a SkinUp |
| 🔴 | **Campañas programadas no se activan nunca** | `vercel.json` declara el cron `/api/cron/sync-campaigns` y **la ruta no existe** → 404 cada medianoche desde siempre. Bug de producto vigente. Y futuro bypass: quien construya ese cron activará campañas **sin merchant presente**, así que debe llevar los dos checks dentro |
| 🟡 | **`edit_.tiered.tsx` sin ningún check** | Hoy no es un hueco porque esa pantalla no cambia el estado (se implementó y revirtió en `64b8d23`). Lo será el día que se permita activar borradores desde ahí — meter **los dos** límites a la vez |
| 🟡 | **RANGE: el conteo es cota superior** | Cuenta variantes resueltas menos excluidas; en modo rango algunas se descartan luego porque el precio no supondría descuento. Bloquea un pelín antes de lo estricto, **nunca de más**. Se prefirió a duplicar la lógica de precios, que acabaría divergiendo |
| 🟢 | **`HEAD` devuelve 500** | `GET` devuelve 200 siempre. Consistente y ajeno a este cambio (nada aquí toca el manejo de métodos HTTP). Observado, no contrastado contra el deployment anterior |

---

## ═══ 🔴 SEGURIDAD — SIGUE TODO PENDIENTE ═══

Sin novedades desde el 24/07, y ya son tres días:

- [ ] **El repo de GitHub sigue PÚBLICO** → volver a privado. Es un clic. *(Vercel despliega repos privados sin problema; ponerlo público nunca fue necesario.)*
- [ ] **`C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` todavía existe** con las 7 claves de producción dentro. Moverlo al gestor y borrarlo.
- [ ] **Rotar:** `SHOPIFY_API_SECRET` de producción, contraseña de Neon y el secreto de la app Dev.

---

## ═══ PENDIENTES TÉCNICOS HEREDADOS ═══

- [ ] Quitar los logs `[tiered-debug]` y `[tiered-attribution]` — la atribución ya está validada.
- [ ] `connect_timeout=20` en las URLs de Neon (el `P1001` vuelve tras cada suspensión del branch dev).
- [ ] `"Descuento por cantidad"` duplicado en 3 sitios que deben coincidir o la atribución se rompe en silencio.
- [ ] Bug latente: un escalonado sobre una **colección vacía** descuenta **todo el catálogo**.
- [ ] Dashboard de Inicio (`app._index.tsx`) con el contador viejo para TIERED.
- [ ] Decisión pendiente: `combinesWith.productDiscounts` sigue en `false`.

---

## ═══ PROGRESS BAR — DIAGNOSTICADO, NO IMPLEMENTADO ═══

Se analizó meter una barra de progreso en crear/pausar/eliminar. **Conclusión: no es quirúrgico, no mezclarlo con nada.**

- Las tres operaciones son **un único POST bloqueante**: no hay canal para el progreso sin reestructurar a job + estado en BD + polling. Un `%` real no es un componente, es un cambio de arquitectura (**L**, con migración).
- **Polaris React no se importa en ningún archivo** del proyecto (la dependencia está sin usar). La barra sería HTML+CSS a mano, coherente con el resto.
- Una barra **no** resuelve el timeout de Vercel: solo lo hace visible. El troceado en varias invocaciones sí, y es el trabajo caro.
- **Asimetría clave:** el cuello al *crear* es la BD (un `upsert` por variante, secuencial) → `createMany` por lotes lo arreglaría (**S**). Pero al *pausar/eliminar* **no hay upserts**: el tiempo es de Shopify (1 mutación por producto), así que `createMany` no ayuda nada ahí.

**Orden recomendado:** mirar Fluid compute → copy honesto ("puede tardar un minuto", **XS**, riesgo cero) → `createMany` (**S**, deploy propio) → **medir de nuevo** → solo entonces decidir si la barra sigue haciendo falta.

---

## ═══ NOTAS PARA RETOMAR ═══

- **Líneas base de `typecheck`:** `main` = **100**. En `dev` con el endpoint presente = **102** (sus 2 errores son de la clase `AdminApiContext` vs `AdminClient`, la convención actual del repo).
- **`npm run build` modifica `.vercel/react-router-build-result.json`, que está TRACKEADO.** Revertirlo antes de commitear.
- 🔴 **Nunca `shopify app dev` con la config de producción activa** — reescribiría la `application_url` de prod y rompería el OAuth de los tres clientes.
- **El puerto del servidor de dev cambia en cada arranque.** Para localizarlo: el que responde **200** en `/auth/login` es la app; el proxy del CLI devuelve **404** para todo.
- **Un script Node suelto no puede importar módulos de `app/`**: usan imports sin extensión (`./db.server`) y el resolver ESM de Node los rechaza (`ERR_MODULE_NOT_FOUND`). Por eso el pausado se hizo como ruta HTTP y no como script — así reutiliza `revert*` sin duplicarlo.
- **Suites:** `npm test` (24 tests) y `cd extensions/tiered-discount && npx vitest run` (7 fixtures).

---

*Cierre de jornada 2026-07-26. Un deploy a producción, sin incidencias. Enforcement de límites vivo; endpoint de pausa listo y en espera.*
