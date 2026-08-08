# Sistema de cobro — DiscountFlow

> Documento de referencia. Todo lo de aquí está **leído del código**, con la ruta y la
> línea al lado para que se pueda comprobar. Lo que no cuadra está apartado al final, en
> [Dudas y cosas que no cierran](#dudas-y-cosas-que-no-cierran) — no mezclado con lo que
> sí funciona.
>
> Escrito el 2026-08-08 contra la rama `dev`.

---

## El mapa en un párrafo

DiscountFlow cobra a través de **Shopify Managed Pricing**: Shopify muestra la página de
precios, cobra, y gestiona altas, bajas y pruebas. La app **no crea suscripciones ni toca
dinero**. Lo único que hace es *enterarse* de qué plan tiene cada tienda, guardarlo en una
columna de su base de datos, y usar ese valor para permitir o bloquear acciones. Enterarse
ocurre de dos formas: un **sondeo cada 15 minutos** contra la API de Shopify, y una **URL
de retorno** a la que Shopify manda al merchant tras aprobar un cambio de plan.

```
  Shopify (cobra)                     DiscountFlow (obedece)
  ─────────────────                   ──────────────────────
  Managed Pricing  ──── merchant ───▶ /app/plans/confirm ──▶ Shop.plan
  activeSubscriptions ── sondeo ────▶ syncShopPlanIfStale ─▶ Shop.plan
                                                              │
                                                              ▼
                                                  enforcement en cada acción
```

---

## 1. Los planes y sus límites

**Definidos en un solo sitio:** [`app/lib/billing/plan-limits.ts`](../app/lib/billing/plan-limits.ts).
Es un módulo sin imports de servidor, así que se puede usar también en el cliente; las
consultas a base de datos viven aparte en `plan-limits.server.ts`.

```ts
// plan-limits.ts:4
export const PLANS = ["FREE", "LITE", "ESSENTIAL", "PROFESSIONAL"] as const;
```

| Plan | Campañas activas | Variantes | BxGy activas | Escalonadas activas | Precio | Handle |
|---|---|---|---|---|---|---|
| **FREE** | 2 | 50 | — | — | 0 | `free` |
| **LITE** | 5 | 750 | 4 | 2 | 9,99 | `lite` |
| **ESSENTIAL** | 50 | 6.000 | 10 | 10 | 27,99 | `essential` |
| **PROFESSIONAL** | 100 | 10.000 | — | — | 44,99 | `professional` |

`plan-limits.ts:11-52`. `trialDays` está en **0 en los cuatro planes**.

### Qué significa cada límite

- **Campañas activas** — cuenta `Campaign` con `status = ACTIVE` de la tienda
  (`plan-limits.server.ts:4`). Borradores y pausadas **no ocupan cuota**.
- **Variantes** — cuenta filas de `CampaignProduct` pertenecientes a campañas **ACTIVE**
  (`plan-limits.server.ts:14`). Solo PERCENTAGE y RANGE crean esas filas; **BxGy y
  Escalonado devuelven 0 por diseño**, porque no editan precios de variantes.
- **BxGy / Escalonado activas** — un sublímite aparte, por *cantidad de campañas* de ese
  tipo (`getTypeCampaignLimit`, `plan-limits.ts:58`). `null` significa "sin sublímite
  propio": FREE se apoya en su límite general de 2, y PROFESSIONAL queda acotado de facto
  por sus 100 generales.

> **Por qué BxGy y Escalonado se topan por cantidad y no por tamaño:** no crean filas de
> `CampaignProduct`, así que no hay nada que contar. Un escalonado sobre "toda la tienda"
> consume **cero** cuota de variantes. Es una contrapartida aceptada a conciencia, no un
> descuido — ver el hueco documentado en [§9](#9-bugs-históricos-y-huecos-conocidos).

### Dónde se guarda el plan

```prisma
// prisma/schema.prisma:44-46
plan            String    @default("FREE")
planActivatedAt DateTime?
lastSyncAt      DateTime?
```

Es una columna **`TEXT`, no un enum de Postgres** (migración
`20260523154212_add_plan_and_billing_fields`). La base no valida el valor.

---

## 2. Cómo se cobra: Shopify Managed Pricing

### Qué hace Shopify y qué hace la app

| | Quién |
|---|---|
| Mostrar la página de precios y los planes | **Shopify** |
| Cobrar la tarjeta, prorratear, facturar | **Shopify** |
| Altas, bajas, cambios de plan, cancelaciones | **Shopify** |
| Saber qué plan tiene la tienda | **La app** (sondeo + URL de retorno) |
| Permitir o bloquear acciones según el plan | **La app** |

La app **no llama nunca a `appSubscriptionCreate`** ni a ninguna mutación de cobro. Solo
lee.

### La pantalla de planes

[`app/routes/app.plans.tsx`](../app/routes/app.plans.tsx) pinta las tarjetas de los cuatro
planes, con el actual marcado, y el botón lleva **fuera de la app**, al admin de Shopify:

```ts
// app.plans.tsx:229
const pricingUrl =
  `https://admin.shopify.com/store/${shopName}/charges/${appHandle}/pricing_plans`;
```

- `shopName` = el dominio de la sesión sin `.myshopify.com` (`:35`).
- `appHandle` = `process.env.SHOPIFY_APP_HANDLE`, con `"discountflow-1"` de reserva
  (`:37`). ⚠️ Ver [Dudas §2](#2-shopify_app_handle-no-está-definido).

El loader de esta pantalla **fuerza el sondeo** pasando `lastSyncAt: null`, saltándose la
ventana de 15 minutos (`:25-28`), con el razonamiento de que el merchant está a punto de
tomar una decisión de dinero y no puede ver un plan viejo.

### La vuelta desde Shopify

Cuando el merchant aprueba un plan, Shopify lo devuelve a la **welcome link** configurada
en el Partner Dashboard, que debe ser:

```
https://discountflow-app.vercel.app/app/plans/confirm
```

Shopify le añade `?plan_handle=lite&shop=mi-tienda.myshopify.com`.
[`app/routes/app.plans_.confirm.tsx`](../app/routes/app.plans_.confirm.tsx) lee ese
parámetro, lo traduce con `handleToPlan()` y escribe el plan:

```ts
// app.plans_.confirm.tsx:16-34
const planHandle = url.searchParams.get("plan_handle") ?? "free";
const newPlan = handleToPlan(planHandle);
...
await prisma.shop.update({
  where: { id: shop.id },
  data: { plan: newPlan, planActivatedAt: now, lastSyncAt: now },
});
```

`handleToPlan()` (`plan-limits.ts:66`) pasa el handle a mayúsculas y comprueba que esté en
la lista; **cualquier cosa que no reconozca cae a `FREE`**.

> 🔴 Esta ruta **no verifica contra Shopify que la suscripción exista**. Ver
> [Dudas §1](#1-appplansconfirm-se-fía-del-parámetro-de-la-url).

### No hay webhooks de cobro

Verificado: `shopify.app.toml` declara `app/uninstalled`, `app/scopes_update`,
`orders/create` y los tres de GDPR. **No hay `app_subscriptions/update`**, y tampoco existe
ninguna ruta de webhook de billing en `app/routes/`.

Es coherente con Managed Pricing, que no emite webhooks de suscripción. **El sondeo es la
única vía por la que la app se entera de un cambio hecho desde el lado de Shopify.**

---

## 3. Cómo llega el plan a la base de datos: el sondeo

Todo ocurre en **`syncShopPlanIfStale()`**,
[`app/lib/shopify/shop.server.ts:25`](../app/lib/shopify/shop.server.ts).

### Cada cuánto corre

```ts
// shop.server.ts:22
const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 min
```

Si `lastSyncAt` tiene menos de 15 minutos, **sale sin consultar nada** y devuelve la tienda
tal cual (`:35-43`).

### Quién lo llama

| Sitio | Cuándo |
|---|---|
| `app/routes/app.tsx:22` | En **cada carga del shell** de la app — o sea, prácticamente en cada navegación |
| `app/routes/app.plans.tsx:25` | En la pantalla de planes, **forzado** (`lastSyncAt: null`) |

No hay cron ni tarea de fondo: el sondeo solo ocurre **si el merchant está usando la app**.

### Qué consulta

```graphql
query {
  currentAppInstallation {
    activeSubscriptions {
      name
      status
      lineItems {
        plan { pricingDetails { __typename ... on AppRecurringPricing { planHandle } } }
      }
    }
  }
  shop { currencyCode }
}
```

`shop.server.ts:46-68`. Dos cosas de esta consulta importan:

1. **`currentAppInstallation.activeSubscriptions`** (plural). El campo
   `AppInstallation.activeSubscription` en singular **no existe** y usarlo tumbaba el sync
   entero — ver [§9, bug #2](#bug-2--todas-las-tiendas-de-pago-quedaron-en-free).
2. **Se lee `planHandle`, no `name`.** El nombre del plan está localizado según el idioma
   de la tienda, así que no se puede comparar de forma fiable; el handle es estable
   (`:116-117`).

### Cómo decide

```
¿la respuesta trae errors?              → no toca NADA, ni el plan ni lastSyncAt   (:100-105)
¿alguna suscripción está FROZEN?        → conserva el plan, actualiza lastSyncAt   (:107-114)
                                          y currency (FROZEN = impago en curso)
busca la primera ACTIVE o PENDING       → de ahí saca planHandle                   (:118-128)
mapea handle → plan con handleToPlan()                                             (:129)
¿hay suscripción Y el mapeo NO es FREE? → sube el plan                             (:140-141)
en cualquier otro caso                  → conserva el plan actual                  (:142-150)
```

Al final escribe `plan`, `currency` y `lastSyncAt`, y solo toca `planActivatedAt` **si el
plan cambió de verdad** (`:152-160`).

Si la llamada revienta (red, API caída), el `catch` **no toca nada** y deja `lastSyncAt`
como estaba, de modo que el siguiente intento vuelve a probar (`:161-165`).

---

## 4. La salvaguarda anti-degradación

Es la regla más importante del sistema y merece su propia sección.

```ts
// shop.server.ts:138-150
// Never degrade to FREE on ambiguity: only change plan when we positively
// recognize an active/pending paid plan. Otherwise keep the current plan.
let newPlan = shop.plan;
if (active && mapped && mapped !== "FREE") {
  newPlan = mapped;                       // ← ÚNICO camino que cambia el plan
} else if (active) {
  // suscripción activa pero handle no reconocido → conserva y avisa por log
} else {
  // ninguna suscripción → conserva y avisa por log
}
```

### Qué hace exactamente

**El sondeo solo puede SUBIR el plan, nunca bajarlo.** El único camino que reasigna
`newPlan` exige las tres cosas a la vez: que haya suscripción activa o pendiente, que su
handle se reconozca, y que el resultado no sea `FREE`. Cualquier ambigüedad —sin
suscripción, handle desconocido, error de la API— deja el plan como estaba.

### Por qué existe

Por el **bug #2** de [§9](#bug-2--todas-las-tiendas-de-pago-quedaron-en-free): una consulta
mal formada hizo que ninguna tienda se sincronizara y **todas las tiendas de pago
aparecieran como FREE**, con sus campañas bloqueadas de golpe. La salvaguarda convierte ese
fallo en inofensivo: si la app no está segura, el merchant conserva lo que tenía. El error
se paga en logs, no en clientes bloqueados.

### La contrapartida, dicha claramente

**Una cancelación no se refleja nunca por el sondeo.** Si un merchant se da de baja desde
Shopify, `activeSubscriptions` deja de traer su plan, el sondeo cae en el `else` de "no
active sub" y **conserva el plan de pago indefinidamente**. La única vía por la que un plan
baja hoy es el webhook de desinstalación ([§5](#5-desinstalar-y-reinstalar)) o una
escritura manual en la base.

Es una decisión consciente en su origen —vale más regalar plan que bloquear a quien paga—
pero **no está compensada por ningún proceso posterior**. Ver
[Dudas §5](#5-una-cancelación-no-baja-el-plan-nunca).

---

## 5. Desinstalar y reinstalar

### Al desinstalar

[`app/routes/webhooks.app.uninstalled.tsx`](../app/routes/webhooks.app.uninstalled.tsx),
disparado por el topic `app/uninstalled`:

```ts
// :16-29
await prisma.session.deleteMany({ where: { shop } });          // 1. sesiones OAuth fuera
await prisma.campaign.updateMany({                             // 2. ACTIVE → PAUSED
  where: { shopId: shopRecord.id, status: "ACTIVE" },
  data: { status: "PAUSED" },
});
await prisma.shop.update({                                     // 3. plan y sync a cero
  where: { id: shopRecord.id },
  data: { plan: "FREE", lastSyncAt: null },
});
```

Tres efectos, en orden:

1. **Las sesiones se borran** — ya no sirven.
2. **Las campañas activas pasan a PAUSED**, para que al reinstalar no aparezcan como
   activas cuando en la tienda ya no hay ningún descuento aplicado.
3. **El plan vuelve a FREE y `lastSyncAt` a `null`.** Poner `lastSyncAt` en `null` es lo
   que garantiza que el primer sondeo tras reinstalar consulte de verdad en vez de
   confiarse de la ventana de 15 minutos.

**Los datos de `Shop` y `Campaign` se conservan**: el merchant puede volver en 48 h. El
borrado real ocurre por el webhook `shop/redact` unas 48 h después.

⚠️ **Los precios NO se revierten al desinstalar.** El comentario del archivo (`:6-8`) lo
dice: una vez desinstalada, la app ya no tiene acceso a la API de la tienda, así que no
podría revertirlos aunque quisiera. **Los productos se quedan con el precio rebajado.**

### Al reinstalar

No hay ninguna lógica especial. El flujo normal se encarga:

1. OAuth crea sesión nueva; `getOrCreateShop()` (`shop.server.ts:6`) hace `upsert` por
   dominio y **reutiliza la fila existente** — el historial de campañas sigue ahí.
2. `lastSyncAt` es `null`, así que el primer `syncShopPlanIfStale` consulta de verdad.
3. Si la suscripción sigue viva en Shopify, el plan **vuelve a subir solo**.
4. Las campañas siguen en `PAUSED`: el merchant decide cuáles reactivar.

---

## 6. Cómo se aplica el enforcement

Hay **tres límites distintos** y se comprueban en sitios distintos.

### 6.1 Límite de campañas activas

Se comprueba **antes de crear la campaña**, en el `action` de cada ruta de creación y de
edición, y en el listado al reactivar:

| Ruta | Línea |
|---|---|
| `app.campaigns.new.bxgy.tsx` | `:176` |
| `app.campaigns.new.percentage.tsx` | dentro del bloque `shouldActivate` |
| `app.campaigns.new.range.tsx`, `new.tiered.tsx` | ídem |
| `app.campaigns.$id.edit.tsx` | `:244` |
| `app.campaigns.$id.edit_.range.tsx` | `:223` |
| `app.campaigns.$id.edit_.bxgy.tsx` | `:219` |
| `app.campaigns._index.tsx` (reactivar) | `:81` |

Devuelve **422** con `errors.general` y `limitExceeded: true`.

### 6.2 Límite de variantes (solo PERCENTAGE y RANGE)

Se pasa la cuota restante como opción `maxVariants`, y la función de aplicación lanza
`PlanLimitError` **después de resolver la selección y antes de escribir nada**:

```ts
// app/lib/discounts/percentage.ts:119   (y range.ts:84)
if (total > opts.maxVariants) throw new PlanLimitError(total, opts.maxVariants);
```

El comentario de `percentage.ts:113` lo resume: *"Lanzar en este punto deja cero efectos
secundarios."* Ni una fila en la base, ni una mutación en Shopify.

**En el motor de jobs por lotes** el mismo control vive en la fase de resolución:

```ts
// app/lib/jobs/operations/campaign-ops.ts:402
if (payload.maxVariants !== undefined && totalVariants > payload.maxVariants)
  throw new JobFatalError(`La selección alcanza … y tu plan admite …`, { planLimit: true });
```

Se comprueba **antes de la primera mutación**, así que abortar no deja ni un precio tocado
— la misma garantía que el camino síncrono. El job termina en `FAILED` con el motivo a la
vista.

### 6.3 Sublímite por tipo (BxGy y Escalonado)

`getTypeCampaignLimit(plan, type)` (`plan-limits.ts:58`) contra
`getActiveCampaignCountByType()` (`plan-limits.server.ts:40`). Solo cuentan las **ACTIVE**,
así que pausar una para activar otra es válido y deseado.

### El error tipado

[`app/lib/billing/plan-limit-error.ts`](../app/lib/billing/plan-limit-error.ts) define
`PlanLimitError` con `requested` y `allowed`. Se detecta con `isPlanLimitError()`, que
compara **`err.name`, no `instanceof`**:

> *"si el bundler llegara a duplicar el módulo, `instanceof` fallaría en silencio y el
> error de límite se reportaría como un 500 genérico, perdiendo el banner de Ver planes"*
> (`:23-27`)

### Qué ve el merchant

Los textos están en [`app/i18n.ts:345-377`](../app/i18n.ts):

| Situación | Mensaje |
|---|---|
| Campañas | *"Límite alcanzado: tienes N de M campañas disponibles en tu plan. Actualiza para crear más."* |
| Variantes | *"Límite alcanzado: tienes N de M variantes en uso. Actualiza para incluir más productos."* |
| Tipo | *"Tienes N de M campañas BxGy activas en tu plan. Pausa una para activar esta, o actualiza tu plan."* |

Acompañados de un botón **"Ver planes"** que lleva a `/app/plans`.

### La propiedad que hace todo esto seguro

**Ninguna campaña ya activa se re-evalúa nunca.** Los límites se comprueban solo al
*crear*, *activar* o *reactivar*. Bajar los límites de un plan, o que un merchant quede por
encima de su cuota, **no apaga nada de golpe**: simplemente no puede crear más. Es
estructural, no una precaución añadida.

El corolario es que **una tienda puede quedar legítimamente por encima de su límite** —y de
ahí nace la herramienta de la sección siguiente.

---

## 7. El endpoint interno de pausa por límite

[`app/routes/api.internal.pause-over-limit.tsx`](../app/routes/api.internal.pause-over-limit.tsx)

Panel HTML interno para el caso de arriba: una tienda que ya está por encima de su cuota y
a la que hay que apagarle campañas a mano.

- **No está enlazado desde ninguna parte de la UI.**
- Exige `CRON_SECRET`, aceptado por cabecera `Authorization: Bearer`, query `?secret=` o
  campo del formulario (`:46-55`).
- **GET** → dry-run: lista qué campañas habría que pausar. **No toca nada.**
- **POST** → ejecuta el pausado de **una** campaña concreta.

### Cómo elige

`buildPlan()` (`:64`) recorre las tiendas y, si el total de variantes activas supera el
límite del plan, marca **las campañas más grandes primero** hasta volver a estar dentro.
Determinista y explicable. Alcance: solo PERCENTAGE y RANGE.

### El orden no negociable

```
1º revertir precios en Shopify
2º marcar PAUSED  ← solo si el revert volvió SIN errores
```

Del encabezado del archivo (`:11-16`): al revés, un corte a mitad dejaría la campaña
*"pausada"* con los descuentos vivos en la tienda, **y nadie volvería a revertirlos**
porque el flujo de pausa de la UI ya se habría consumido.

El POST además **recalcula en el servidor** y devuelve **409** si la campaña ya no figura
como excedida: *"el formulario no decide nada por su cuenta"* (`:15-16` del action).

Usa `unauthenticated.admin(domain)` para obtener sesión sin merchant delante.

> ⛔ **No cambiar a `Shop.accessToken`**: esa columna es una copia que nunca se refresca, y
> con `expiringOfflineAccessTokens: true` queda muerta.

**Estado:** existe en la rama `dev` desde el commit `4313a44`. Su **POST real nunca se ha
ejercitado** — sería el primer uso de `unauthenticated.admin` en el repo. El próximo merge
a `main` lo desplegaría.

---

## 8. Recorrido completo de un merchant

```
1. Instala          → getOrCreateShop crea la fila. plan = "FREE" (default de la columna)
2. Usa la app       → cada carga de /app dispara syncShopPlanIfStale (ventana de 15 min)
                      sin suscripción → conserva FREE
3. Toca el límite   → 422 + "Límite alcanzado" + botón Ver planes
4. Abre /app/plans  → sondeo FORZADO; botón → admin.shopify.com/.../pricing_plans
5. Paga en Shopify  → Shopify cobra. La app no interviene.
6. Shopify redirige → /app/plans/confirm?plan_handle=lite
                      → Shop.plan = "LITE", planActivatedAt = ahora, lastSyncAt = ahora
7. Sigue usando     → el sondeo confirma LITE contra activeSubscriptions cada 15 min
8. Desinstala       → sesiones borradas · campañas ACTIVE → PAUSED · plan → FREE
                      ⚠️ los precios rebajados SE QUEDAN rebajados
9. Reinstala        → upsert reutiliza la fila · lastSyncAt null fuerza sondeo
                      · si la suscripción vive, el plan vuelve solo
```

---

## 9. Bugs históricos y huecos conocidos

### Bug #1 — La consulta usaba un campo que no existe

**Síntoma:** todas las tiendas en `FREE`, incluidas las de pago.
**Causa:** la consulta pedía `AppInstallation.activeSubscription` (**singular**), que no
existe en la API. La consulta lanzaba siempre → el `catch` se tragaba el error → **ninguna
tienda se sincronizó jamás** → todas se quedaron en el `FREE` por defecto.
**Arreglo:** `currentAppInstallation.activeSubscriptions` (plural) + mapeo por `planHandle`
+ la salvaguarda anti-degradación. Commit `83efba4`.
**Lección:** un `catch` que solo hace `console.error` convierte un fallo permanente en un
silencio permanente.

### Bug #2 — Todas las tiendas de pago quedaron en FREE

Es la consecuencia del #1 y la razón de ser de la [salvaguarda](#4-la-salvaguarda-anti-degradación).
Los merchants que pagaban vieron sus campañas bloqueadas por límite de plan.
**Lección grabada en el código:** ante cualquier ambigüedad, conservar el plan. Regalar
plan sale mucho más barato que bloquear a quien paga.

### Bug #3 — El nombre del plan está localizado

Se intentó identificar el plan por `name`. El nombre viene traducido al idioma de la
tienda, así que el mapeo fallaba en tiendas no inglesas. **Se usa `planHandle`, que es
estable** (`shop.server.ts:116-117`).

### Bug #4 — Fallos de Shopify que se tragaban en silencio

`bulkUpdateVariantPrices` dejaba pasar `json.errors` y `userErrors` sin mirarlos: contaba
como aplicadas variantes que Shopify **nunca** cambió, y el conteo de cuota quedaba mal.
Endurecida el 26/07 (lanza + backoff ante THROTTLED). Es el mismo patrón que después
apareció en `readQueryData` y en `runDiscountMutation`.

### Hueco #1 — BxGy y Escalonado no consumen cuota de variantes

No crean filas de `CampaignProduct`, así que un escalonado sobre "toda la tienda" cuenta
**0 variantes**. Se topan por *cantidad de campañas activas*. Contrapartida aceptada a
conciencia: contar variantes ahí obligaría a resolver el catálogo entero solo para medir.

### Hueco #2 — `edit_.tiered.tsx` no comprueba ningún límite

Hoy es inocuo porque esa ruta no cambia el estado de la campaña. Dejará de serlo el día que
lo haga.

### Hueco #3 — El conteo de RANGE es una cota superior

Cuenta las variantes candidatas antes de aplicar la regla de rebaja, así que bloquea antes
de tiempo, **nunca de más**. Falla del lado seguro.

### Hueco #4 — El cron declarado no existe

`vercel.json` declara `/api/cron/sync-campaigns` a medianoche y **la ruta no existe** en
`app/routes/` (verificado). Devuelve 404 cada noche desde siempre. No es de cobro, pero le
pega de lleno: las campañas con `startsAt` nunca arrancan y **las que tienen `endsAt` nunca
se detienen**. Si algún día se construye, debe llevar los dos checks de límite dentro, o
será una puerta trasera al enforcement.

---

## Dudas y cosas que no cierran

> Esto es lo que encontré leyendo el código y **no puedo documentar como si estuviera
> bien**. No lo he tocado.

### 1. `/app/plans/confirm` se fía del parámetro de la URL

[`app.plans_.confirm.tsx`](../app/routes/app.plans_.confirm.tsx) son 37 líneas y **escribe
el plan directamente desde `?plan_handle=`, sin verificar contra Shopify que exista esa
suscripción**:

```ts
const planHandle = url.searchParams.get("plan_handle") ?? "free";
const newPlan = handleToPlan(planHandle);
await prisma.shop.update({ ..., data: { plan: newPlan, ... } });
```

Cualquier merchant autenticado que visite
`/app/plans/confirm?plan_handle=professional` **se sube a PROFESSIONAL sin pagar**. No hace
falta nada más que la URL.

El daño se autolimita: el siguiente sondeo (≤15 min) leería `activeSubscriptions`… pero
**la salvaguarda anti-degradación impide que baje**. O sea que el plan regalado **se queda
puesto**.

**Lo que yo esperaría:** que `/confirm` consultase `activeSubscriptions` y solo escribiera
el plan si Shopify confirma la suscripción, usando el `plan_handle` únicamente como pista.
Ya figuraba como pendiente ("blindar /confirm") desde junio.

### 2. `SHOPIFY_APP_HANDLE` no está definido

`app.plans.tsx:37` lee `process.env.SHOPIFY_APP_HANDLE` con `"discountflow-1"` de reserva.
**No aparece en `.env`** (comprobado) y tampoco hay `handle` en `shopify.app.toml`.

Si el handle real de la app en el Partner Dashboard no es exactamente `discountflow-1`, el
botón "Actualizar" lleva a un **404 del admin de Shopify** — y es el único camino de la app
hacia el cobro. **No lo puedo verificar desde el código: hay que mirarlo en el Partner
Dashboard.**

### 3. `trialDays` está en 0, pero la UI habla de pruebas

Los cuatro planes tienen `trialDays: 0` (`plan-limits.ts`), y sin embargo `i18n.ts` tiene
textos de prueba gratis (`prueba: (days) => …`, `dashCard.trial`). O el texto está muerto,
o alguien esperaba que hubiera trial. **No sé cuál de las dos.**

### 4. `Shop.plan` es texto libre

La columna es `TEXT NOT NULL DEFAULT 'FREE'`, no un enum de Postgres, así que un valor
inválido entra sin que nada chille. El endpoint de pausa se protege
(`api.internal.pause-over-limit.tsx:73` cae a `FREE` si el valor no está en `PLAN_LIMITS`),
pero **las rutas de campañas hacen `PLAN_LIMITS[plan]` directo**: un valor corrupto daría
`undefined` y reventaría al leer `.campaigns`.

No es explotable desde fuera hoy —solo se escribe desde `/confirm` y el sondeo, y ambos
pasan por `handleToPlan()`— pero **cualquier escritura manual en la base puede romperlo**,
y ese es justamente el procedimiento que se usa en desarrollo.

### 5. Una cancelación no baja el plan nunca

Explicado en [§4](#la-contrapartida-dicha-claramente). Un merchant que cancela conserva su
plan de pago en la app **indefinidamente**: el sondeo no puede bajarlo por diseño, no hay
webhook de billing, y el único camino de bajada es desinstalar.

Entiendo por qué la salvaguarda es así —y no la tocaría a ciegas—, pero **hoy no hay nada
que cierre el círculo**. Lo que yo esperaría es alguna forma de distinguir "no sé qué plan
tiene" (conservar, correcto) de "Shopify me confirma que no tiene ninguna suscripción"
(bajar). La consulta actual ya devuelve lo suficiente para separar ambos casos: una
respuesta **sin errores** y con `activeSubscriptions: []` es una confirmación, no una
ambigüedad.

### 6. `getVariantCount` y el límite se miden distinto

`getVariantCount()` cuenta filas de `CampaignProduct` de campañas **ACTIVE**, pero el
enforcement al activar suma `getVariantCount + getCampaignVariantCount(esta campaña)`
porque en ese momento la campaña todavía no está activa
(`plan-limits.server.ts:20-32`). Está bien resuelto y documentado; lo anoto solo porque es
fácil de romper si alguien "simplifica" los dos contadores en uno.

---

## Ficheros de referencia

| Qué | Dónde |
|---|---|
| Planes, límites, `handleToPlan` | `app/lib/billing/plan-limits.ts` |
| Consultas de conteo | `app/lib/billing/plan-limits.server.ts` |
| Error tipado de límite | `app/lib/billing/plan-limit-error.ts` |
| El sondeo y la salvaguarda | `app/lib/shopify/shop.server.ts` |
| Pantalla de planes | `app/routes/app.plans.tsx` |
| Vuelta desde Shopify | `app/routes/app.plans_.confirm.tsx` |
| Desinstalación | `app/routes/webhooks.app.uninstalled.tsx` |
| Panel interno de pausa | `app/routes/api.internal.pause-over-limit.tsx` |
| Límite en el motor de jobs | `app/lib/jobs/operations/campaign-ops.ts:402` |
| Límite en el camino síncrono | `app/lib/discounts/percentage.ts:119`, `range.ts:84` |
| Textos al merchant | `app/i18n.ts:345-377` |
| Columnas de plan | `prisma/schema.prisma:44-46` |
