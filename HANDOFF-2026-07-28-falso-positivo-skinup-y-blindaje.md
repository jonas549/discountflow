# 🚀 HANDOFF — Falso positivo de SkinUp, blindaje del alcance y niveles al 0% (2026-07-28, cierre de jornada)

> **Este es el handoff vigente.**
> El anterior, [`HANDOFF-2026-07-26-enforcement-limites.md`](HANDOFF-2026-07-26-enforcement-limites.md), sigue siendo válido para el enforcement de límites y el endpoint de pausa.
> La sección **🧨 DEUDA TÉCNICA Y TRAMPAS** de [`HANDOFF-2026-07-24-escalonados-produccion.md`](HANDOFF-2026-07-24-escalonados-produccion.md) continúa siendo la referencia a nivel de código.

---

## ═══ ESTADO DE PRODUCCIÓN ═══

| Pieza | Estado |
|---|---|
| Código en producción | **`5bcddba`** (funcional: `d54d0da`) |
| Anterior | `8706569` |
| Function de Shopify | **`discountflow-7` ★ activa** — creada y liberada hoy 18:37:56 |
| Function anterior | `discountflow-6` (inactiva, 24/07) |
| Migraciones | **ninguna** |
| Scopes / webhooks / toml | **sin tocar** → ningún merchant reautorizó |
| `main` / `dev` / `origin/main` | los tres en `5bcddba`, sin divergencia |

### Rollback — 🔴 EL ORDEN IMPORTA

```
1. Vercel → Instant Rollback a 8706569
2. Partner Dashboard → release de discountflow-6
```

**Vercel primero, Function después.** La combinación "app vieja + Function nueva" es segura (los escalonados simplemente no descuentan). La inversa —"app nueva + Function vieja"— deja guardar niveles al 0% que el Wasm viejo descarta, y entonces **cobra de más en silencio**. Sin migraciones ni scopes de por medio: rollback limpio, sin pasos previos.

---

## ═══ 1. EL "BUG CRÍTICO" DE SKINUP ERA UN FALSO POSITIVO ═══

La jornada empezó con este diagnóstico dado por confirmado:

> *La campaña guarda GID de PRODUCTO; la Function compara contra GID de VARIANTE → la lista de elegibles queda vacía → lista vacía = "toda la tienda" → descuenta TODO.*

**Nada de eso ocurría.** Comprobado en tres sitios independientes:

| Comprobación | Resultado |
|---|---|
| Fuente de la Function | `line.merchandise.product.id` vs `config.productIds` → **producto contra producto** |
| Compilado `dist/function.js:145-147` | idéntico al fuente |
| Historial git completo (4 commits sobre la Function) | **ningún** commit comparó nunca variantes |

El razonamiento tampoco se sostenía: con lista NO vacía y cero coincidencias el síntoma sería "no descuenta **nada**", jamás "descuenta todo". Solo una lista **vacía** podía descontar todo.

### Auditoría de producción (solo lectura)

**Alcance real: 1 sola campaña TIERED en toda la producción.** Ni Greta, ni NYZA, ni Vermú tienen escalonados.

```
[OK] skinup-cl.myshopify.com (ESSENTIAL) | "Mudrad 2" | PAUSED
     selectionMode=collections | productIds=85 | collectionIds=1
     tiers=3/INCREMENTAL | tipo de GID guardado: Product
ACTIVAS descontando toda la tienda sin pedirlo: 0
Latentes con el mismo config: 0
```

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

> `[DiscountFlow] Mudrad 2` figura como **EXPIRED** en Shopify: es el efecto normal de pausarla (`discountAutomaticDeactivate` fija `endsAt`). La pausa funcionó.

---

## ═══ 2. BLINDAJE DEL ALCANCE (el agujero que sí existía) ═══

El agujero real era el ya anotado como deuda: **"un escalonado sobre una colección vacía descuenta todo el catálogo"**. Era el único camino por el que el sangrado temido podía ocurrir de verdad.

**Raíz:** `productIds: []` significaba dos cosas incompatibles e indistinguibles — *"el merchant eligió toda la tienda"* y *"la resolución falló o la colección está vacía"*. La segunda convertía un fallo silencioso en un descuento a todo el catálogo.

### Capa 1 — La Function ya no adivina el alcance
Campo **`scope`** explícito en el metafield: `"all"` | `"selected"`. Solo `"all"` autoriza descontar todo el catálogo. Cualquier otro caso con lista vacía → `NO_DISCOUNT`.

**Metafields legados (sin `scope`) → fail-closed.** Una campaña vieja de "toda la tienda" deja de aplicar hasta que la app reescriba su metafield. Deliberado: dejar de descontar es un fallo que el merchant ve y reporta; descontar el catálogo entero cuesta dinero en silencio.

### Capa 2 — La app declara el alcance
`toFunctionConfig()` emite `scope` derivado de `selectionMode`. `tieredAppliesToProduct()` (atribución en Analytics) replica la regla nueva: **si las dos divergen, la atribución miente.**

### Capa 3 — La resolución deja de mentir
`admin-api.ts` tenía el patrón `json.data?.algo?.nodes ?? []`, que convierte **cualquier** fallo de API (consulta rechazada, throttling, token caducado) en "no hay productos". Nuevo helper `readQueryData()` que lanza. Aplicado a `getCollectionProductVariants`, `getAllProductVariants` y `getProductsByFilter`. Una colección borrada o inaccesible lanza en vez de pasar por vacía.

> Mismo fallo tragado que ya se corrigió en `bulkUpdateVariantPrices` y `runDiscountMutation`. **Este era el tercero.**

### Capa 4 — Una campaña no se guarda si no abarca nada
`resolveTieredProductIds()` lanza con mensaje accionable cuando la selección resuelve a cero productos. `countTieredProducts()` queda tolerante (devuelve 0): es un contador de UI y no puede tumbar una pantalla.

### Capa 5 — La reactivación refresca la configuración
Reactivar un TIERED desde el listado llamaba solo a `activateTieredDiscount`, que **no** reescribe el metafield. Con el fail-closed eso habría dejado a "Mudrad 2" reactivada y sin descontar. Ahora la reactivación llama antes a `updateTieredDiscount`: migra el metafield legado y re-resuelve los productos, de modo que una campaña por colección refleje la colección de HOY.

---

## ═══ 3. NIVELES AL 0% ═══

**Necesidad de negocio (SkinUp):** que la 1ª unidad quede a precio normal y el descuento empiece desde la 2ª. `1ª=0%, 2ª=10%, 3ª=15%, 4ª=20%`.

### ⚠️ La premisa "no toca la Function" era falsa — no volver a darla por buena

El 0% se descartaba en `normalizeTiers` (`tiered-calc.ts`), y **ese módulo se compila dentro del Wasm de la Function**. Solo el 0% del *primer* nivel funcionaba sin tocar nada, y porque era redundante con omitir el nivel. En un escalón intermedio o final, al desaparecer el nivel **sus unidades HEREDABAN el porcentaje del anterior**:

| tiers | Wasm viejo | Wasm nuevo |
|---|---|---|
| `[{1,10%},{2,0%},{3,20%}]`, 3 uds × $100 | **$40** (la 2ª hereda el 10%) | **$30** ✅ |

No había atajo: ninguna configuración de tiers hacía que el Wasm viejo produjera un 0% intermedio.

### Cambios

- `MIN_TIER_PERCENT` 1 → **0**.
- `normalizeTiers` **conserva** los 0; solo descarta negativos y no finitos.
- `computeUniform` corta si el nivel vigente es 0%: sin eso emitiría un descuento de valor cero y el comprador vería **"-$0.00"** en su carrito. (INCREMENTAL ya se protegía solo: `percent <= 0 → continue` y `totalCents === 0 → applies:false`.)
- `validateTiers` acepta 0 y **rechaza la campaña con todos los niveles a 0%** (no descontaría nada y ocuparía cuota).
- El input del formulario usa las constantes: el `Math.max(1, …)` del `onChange` era lo que impedía teclear 0, más que el `min={1}`.
- `tieredDiscountLabel` y el resumen del preview usan el **máximo**, no el último nivel: con un 0% al final anunciaban "hasta 0%".

### 📌 Detalle de producto que el merchant debe entender

Con la 1ª unidad al 0%, la unidad que se queda a precio normal es **la más cara del carrito**, no la primera que añadió. Es la regla "mayor % al más barato" decidida el 24/07. Con un Murad de $100 y otro de $50, el de $100 es el que no lleva descuento.

### Sobre los límites de plan — no hay conflicto

TIERED se topa por **cantidad de campañas activas** (`getActiveCampaignCountByType`), no por variantes: no crea filas en `CampaignProduct`, así que aporta 0 al conteo de variantes con o sin 0%. El porcentaje de un nivel no es entrada de ninguna de las dos mediciones. Y un 0% **solo puede quitar descuento, nunca añadirlo**: no existe forma de usarlo para obtener más cobertura de la que el plan concede.

> El hueco que sí sigue abierto es otro, anterior y aceptado conscientemente: BxGy/Escalonado "toda la tienda" se topan por cantidad de campañas, no por tamaño de catálogo. El 0% no lo empeora.

---

## ═══ EL DEPLOY ═══

### Secuencia ejecutada

```
1. cd extensions/tiered-discount && npm run build      # recompilar el Wasm
2. npx vitest run                                       # 12/12 fixtures
   npm test                                             # 37/37 calculadora
3. commits en dev (por ruta, NUNCA git add -A)
4. shopify app config use shopify.app.toml
   shopify app deploy --no-release --force              # -> discountflow-7
   shopify app config use dev                           # en un finally
5. shopify app config use shopify.app.toml
   shopify app release --version=discountflow-7 --force
   shopify app config use dev                           # en un finally
6. git checkout main && git merge --ff-only dev && git push origin main
```

**Los pasos 4 y 5 llevan el retorno a `dev` encadenado en un `finally`**, para que la config de producción no quede activa ni aunque el comando falle. En ningún momento se arrancó `shopify app dev` con la config de producción.

### Por qué se pudo usar `--force`

`shopify.app.toml` **no se modifica desde el 2026-05-25** (`a489bc6`), muy anterior al deploy del 24/07 que creó `discountflow-6`, y sin cambios locales. Cualquier configuración que el deploy subiera era por tanto **idéntica a la ya viva**, así que el resumen que `--force` oculta no contenía cambios. Y con `--no-release` nada se activaba hasta el release explícito.

### Verificación post-deploy (hecha)

| Comprobación | Resultado |
|---|---|
| `git branch -r --contains d54d0da` | `origin/main` ✅ |
| `main` = `dev` = `origin/main` | los tres en `5bcddba`, sin divergencia ✅ |
| `GET /assets/TieredCampaignForm-ort-vtvK.js` | **200**, 13.530 bytes ✅ |
| Clamp viejo `Math.max(1, Math.min(99` en el bundle servido | **AUSENTE** → es el código nuevo ✅ |
| `GET /` | 200 ✅ |
| `shopify app versions list` | activa la del **2026-07-28 18:37:56** (= `discountflow-7`); la del 24/07 (`discountflow-6`) inactiva ✅ |

Vercel tardó **120 s** desde el push en servir el bundle nuevo.

> La tabla de `versions list` trunca el número de versión (el CLI asume 80 columnas fuera de un TTY). Lo que identifica la versión activa sin ambigüedad es la fecha de creación más el output del propio `release`.

### La ventana entre release y Vercel

Duró ~2 minutos y era la segura por diseño: Function nueva + app vieja = los escalonados no descuentan, y **Mudrad 2 estaba pausada** → impacto cero.

---

## ═══ ⏳ PENDIENTE DE VERIFICAR (Jonas) ═══

1. **Campaña nueva de prueba** en SkinUp con `1→0%, 2→10%, 3→15%, 4→20%` y carrito de 4 unidades → la 1ª a precio normal. No reconfigurar Mudrad 2 para esto.
2. **Mudrad 2** sigue `PAUSED` e intacta. Al reactivarla se le reescribe el metafield automáticamente (capa 5), por el listado o por la pantalla de edición.
3. 🔴 **Logs de Vercel, 24-48 h — lo más importante.** `readQueryData` afecta a **todos** los tipos de campaña, no solo TIERED. Si alguna query venía fallando en silencio para Greta o NYZA, ahora lanzará una excepción donde antes se veía "0 productos". **Es el cambio de mayor radio del lote.** Lo que aparezca son fallos reales que antes se tragaban, no regresiones — pero hay que verlos.

---

## ═══ 🔴 SEGURIDAD — SIGUE TODO PENDIENTE ═══

Sin novedades desde el 24/07. **Van cuatro días.**

- [ ] **El repo de GitHub sigue PÚBLICO** → volver a privado. Es un clic. *(Vercel despliega repos privados sin problema; ponerlo público nunca fue necesario.)*
- [ ] **`C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` todavía existe** con las 7 claves de producción dentro. Moverlo al gestor y borrarlo.
- [ ] **Rotar:** `SHOPIFY_API_SECRET` de producción, contraseña de Neon y el secreto de la app Dev.

---

## ═══ PENDIENTES TÉCNICOS HEREDADOS ═══

- 🔴 **Campañas programadas no se activan nunca**: `vercel.json` declara el cron `/api/cron/sync-campaigns` y **la ruta no existe** → 404 cada medianoche desde siempre. Bug de producto vigente. Quien construya ese cron debe meter dentro los dos checks de límites: activaría campañas **sin merchant presente**.
- 🟡 **Endpoint de pausa** (`app/routes/api.internal.pause-over-limit.tsx`) sigue **sin desplegar y sin trackear**, deliberadamente fuera de este deploy. Caso Vermú sin cerrar (FREE, 578 variantes, límite 50; la puerta de entrada ya está cerrada por el enforcement, falta apagar la campaña actual).
- 🟡 Quitar los logs `[tiered-debug]` y `[tiered-attribution]`.
- 🟡 `"Descuento por cantidad"` duplicado en 3 sitios que deben coincidir o la atribución se rompe en silencio.
- 🟡 Bug latente: un escalonado sobre una **colección vacía** ya no descuenta todo (capa 1), pero conviene revisar el mensaje que ve el merchant.
- 🟡 Dashboard de Inicio (`app._index.tsx`) con el contador viejo para TIERED.
- 🟡 `connect_timeout=20` en las URLs de Neon (el `P1001` vuelve tras cada suspensión del branch dev).
- 🟡 **Decisión pendiente:** `combinesWith.productDiscounts` sigue en `false`. Dato nuevo de hoy: SkinUp tiene **otro descuento automático de app activo** (`Pack 2 Flo`), así que en cualquier carrito donde ambos apliquen **uno de los dos se pierde en silencio**. El escenario que motivó la duda ahora tiene un caso real detrás.

---

## ═══ NOTAS PARA RETOMAR ═══

### Aprendido hoy sobre el entorno

- **El CLI de Shopify SÍ está autenticado aquí** (`contacto@appsdeveloperspro.com`) y acepta `--force` para saltar los prompts → **los deploys de Function son ejecutables sin intervención manual**. `shopify app config link` sigue sin poder ser interactivo, pero `deploy` y `release` sí funcionan.
- **El CLI recompila la Function al desplegar** (`Building function… Running javy… Done!`) pese a `[extensions.build] command = ""`. El riesgo de subir un Wasm viejo era menor de lo estimado — aun así, recompilar antes no cuesta nada.
- **Para verificar que Vercel desplegó de verdad**: sondear el hash del bundle de cliente (`/assets/TieredCampaignForm-*.js`) y comprobar que el código viejo ya no está dentro. Es la única sonda fiable cuando los cambios son de servidor; el 200 de la raíz no discrimina.
- `shopify app versions list` **trunca el número de versión** fuera de un TTY. Guiarse por la fecha.
- **`npm run build` modifica `.vercel/react-router-build-result.json`, que está TRACKEADO.** Revertirlo antes de commitear.
- 🔴 **Nunca `shopify app dev` con la config de producción activa** — reescribiría la `application_url` de prod y rompería el OAuth de los tres clientes.
- **Líneas base de `typecheck`: 103** (`main` = 100 histórico + los del endpoint sin trackear en dev). Los errores son de las clases `AdminApiContext` vs `AdminClient` y `Record<string,unknown>` vs `InputJsonValue`, la convención ya rota del repo.
- **Suites:** `npm test` (37 tests) y `cd extensions/tiered-discount && npx vitest run` (12 fixtures).

### Regla de negocio confirmada de paso

En modo INCREMENTAL las unidades se agrupan entre **todas** las líneas elegibles del carrito, se ordenan de más cara a más barata y los tramos se reparten por posición (el % más alto a la unidad más barata). Un carrito de 3×$100 + 2×$50 da `[10,15,20,20,20]` → $45.00 y $20.00. **No se calcula por línea.**

---

*Cierre de jornada 2026-07-28. Un falso positivo cerrado con evidencia, un bug latente real blindado, los niveles al 0% en producción. Un deploy de Function + código, sin incidencias.*
