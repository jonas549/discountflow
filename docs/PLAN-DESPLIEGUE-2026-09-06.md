# Plan de despliegue · 2026-09-06 · Los tres tipos nuevos

**Análisis previo. Nada desplegado.** Todo lo que se afirma acá está verificado
contra el código; lo que no se pudo verificar dice explícitamente cómo
verificarlo y quién tiene que hacerlo.

> ## ⚠️ Actualizado el 2026-09-06 por la tarde
>
> Jonas probó todo en el navegador y **aprobó los tres tipos**. Lo que cambió
> respecto de la primera versión de este plan:
>
> | Antes decía | Ahora |
> |---|---|
> | «Confirmá de qué rama despliega Vercel» | 🟢 **`main`**. Confirmado |
> | «Corré la consulta de FREE con BxGy/Escalonado» | 🟢 **Hecha: 3 filas, ninguna en FREE.** El riesgo de F4 sobre clientes vivos está **cerrado** |
> | «Dejá el cupón oculto, no se probó nunca» | 🔴 **Ya no aplica: se sube TODO, los tres tipos visibles.** Decisión de Jonas |
> | «Qué ve el comprador cuando el cupón no califica: sin confirmar» | 🟢 **Confirmado**: el mensaje de Shopify («válido pero no aplicable») y, si ya lo usó, «el código ya fue usado». Los dos claros |
> | «Considerá dejar monto de compra fuera» | 🔴 **Ya no aplica**: se sube, y el cupón ahora puede excluirlo |
> | — | 🟢 **El despliegue lo ejecuta Claude**, con la aprobación de Jonas |
> | Tests 327 · fixtures 70 | **Tests 344 · fixtures 81** · typecheck 173 |
>
> 🟢 **CIERRE (2026-09-06, noche): Jonas completó la ronda entera del cupón y
> aprobó todo.** Cálculo, alcance por productos y por colección, límite total de
> usos, uso por cliente, mínimo de monto, mínimo de cantidad, método código,
> método automático, el viaje de ida y vuelta conservando el código, la exclusión
> de monto de compra, el banner de combinación imposible, pausar, reactivar y
> eliminar. **Los tres tipos están cerrados.**
>
> El detalle de lo que se agregó y arregló durante el día está en las §13.1 a
> §13.5. Ya no hay nada pendiente de probar.
>
> El estado general del proyecto vive ahora en **`docs/ESTADO.md`**.

---

## 0 · El salto, medido

| | |
|---|---|
| Producción hoy | Vercel **`e7be44d`** + app version **`discountflow-8`** |
| A desplegar | **32 commits** en `dev`. **Todo commiteado** |
| Diff | 160 archivos, +48.516 / −7.392 (incluye los assets generados del widget) |
| Migraciones pendientes | **3**, todas `ALTER TYPE ... ADD VALUE` |
| Extensiones | de **1** Function a **4** + 1 bloque de tema |
| Tests de la app | 344 verdes |
| Fixtures contra el Wasm real | **81/81** (tiered 16 · pack 13 · order 16 · **cupón 36**) |
| Typecheck | 173 (base 170) · Build verde |
| **Scopes** | 🟢 **IDÉNTICOS** a producción → **ningún merchant tiene que re-autorizar** |

---

## 1 · Qué le pasa a un cliente con campañas activas (F4)

### La respuesta corta

**Nada se re-evalúa. Ninguna campaña activa deja de funcionar.** Verificado, no
supuesto.

### Por qué, con la evidencia

Un despliegue de Vercel **no ejecuta ninguna mutación contra Shopify y no
escribe ninguna fila de `Campaign`**. Los descuentos que hoy descuentan son
objetos que viven en Shopify y nadie los toca. Para que una campaña cambiara,
algo tendría que releer los límites y actuar. Busqué los tres caminos posibles:

| Camino | Qué encontré |
|---|---|
| Comprobación al cargar la pantalla | 🟢 **No existe.** Los 9 call sites de `comprobarTipoDeCampana` están **todos en `action`**, ninguno en `loader`. `comprobarLimitesAlReactivar` se llama desde 3 sitios, los 3 dentro del `action` del listado |
| Un cron que pause | 🟢 **No existe.** `vercel.json` declara `/api/cron/sync-campaigns` **y la ruta no está en el repo** — el cron da 404 cada noche. No pausa nada (es el pendiente viejo, que acá juega a favor) |
| El panel interno de pausa | 🟢 **No alcanza.** `api.internal.pause-over-limit` cubre **solo PERCENTAGE y RANGE** (límite de variantes), exige `CRON_SECRET`, no está enlazado en la UI y pausa **de a una campaña por POST manual**. No puede tocar BxGy ni Escalonado |

### Qué SÍ cambia, y para quién exactamente

El único cambio de comportamiento sobre los tipos vivos está en el plan **FREE**:

| Plan | Antes (`main`) | Después (`dev`) |
|---|---|---|
| **FREE** · BxGy | `maxBxgy: null` → la comprobación **se saltaba entera** | `incluido: false` → **prohibido** |
| **FREE** · Escalonado | `maxTiered: null` → **se saltaba** | `incluido: false` → **prohibido** |
| LITE / ESSENTIAL / PROFESSIONAL | 4/2, 10/10, sin tope | **idénticos** |

Ese `null` que significaba a la vez «sin sublímite» y «saltate la comprobación»
es el agujero que F4 cerró: **una tienda gratuita podía crear y activar BxGy y
Escalonadas sin límite.**

**Una tienda en FREE con un BxGy o un Escalonado ACTIVO pierde, a partir del
despliegue:**

| Operación | Antes | Después |
|---|---|---|
| La campaña sigue descontando en la tienda | ✅ | ✅ **sigue igual** |
| Crear otra de ese tipo | ✅ (el agujero) | ❌ bloqueado — **intencional** |
| **Re-activarla después de pausarla** | ✅ | ❌ **bloqueado** |
| **Editar un BxGy** | ✅ | ❌ **bloqueado** |
| Editar un Escalonado | ✅ | ✅ — `edit_.tiered.tsx` **no tiene puerta por tipo** |
| Pausar / eliminar | ✅ | ✅ |

⚠️ Esa asimetría es real y está medida: de los cinco formularios de edición,
**solo `edit_.bxgy.tsx` tiene la puerta**. Pack, valor de carrito, cupón y
escalonado no la tienen. No es un problema para este despliegue —hace el riesgo
más chico— pero es una inconsistencia del enforcement.

### 🔴 Lo que hay que verificar ANTES de desplegar (yo no puedo)

No tengo credenciales de la base de producción y no las voy a pedir. **La
pregunta que decide si este punto es inofensivo o no es una sola:**

> ¿Hay alguna tienda en plan **FREE** con una campaña **BXGY** o **TIERED** en
> estado **ACTIVE**?

```sql
SELECT s.domain, s.plan, c.type, c.status, c.name
FROM "Campaign" c JOIN "Shop" s ON s.id = c."shopId"
WHERE c.status = 'ACTIVE' AND c.type IN ('BXGY','TIERED')
ORDER BY s.plan, s.domain;
```

- **Si ninguna está en FREE** → este punto es cero riesgo y podés seguir.
- **Si alguna está en FREE** → esa tienda no podrá editar ni reactivar esa
  campaña. Decidí antes: subirle el plan, o aceptarlo y avisarle.

### 🔴 Y una interacción con un pendiente viejo que sí puede morder

**`PLAN_SYNC_OBSERVACION=1` está puesta en producción**, congelando la
degradación de plan. Eso significa que puede haber tiendas cuyo plan real en
Shopify sea `free` pero que en la base sigan en un plan de pago.

Antes de F4 esa combinación era inofensiva. Después de F4, **el día que quites
esa variable, esas tiendas caen a FREE y en ese mismo momento pierden editar y
reactivar sus BxGy y Escalonadas.**

> **Regla para esta ventana: NO tocar `PLAN_SYNC_OBSERVACION` en el mismo
> despliegue.** Son dos cambios que se amplifican y hay que probarlos separados.

---

## 2 · `combinesWith` y las campañas vivas

### La respuesta corta

🟢 **No afecta a ninguna campaña de Escalonado ni de BxGy que hoy esté
descontando.** Verificado con el diff:

```
git diff main..dev -- tiered.ts bxgy.ts percentage.ts range.ts
  | grep combinesWith|orderDiscounts|productDiscounts|shippingDiscounts
→ (sin resultados)
```

Los valores de `combinesWith` de los cuatro tipos vivos **no cambian ni una
letra**. El cambio a `orderDiscounts: true` está solo en `pack.ts`,
`cart-value.ts` y `original-price.ts` — tipos que hoy no existen en producción.

Y un despliegue no reescribe descuentos existentes: `combinesWith` se manda en
`create` y en `update`, y esas mutaciones solo corren cuando el merchant
guarda una campaña. Cuando lo haga, se reescribirá con **los mismos valores que
ya tiene**.

### 🔴 Pero hay una consecuencia que no es una regresión y sí es un problema

`combinesWith` es **bilateral**: con que uno de los dos descuentos diga que no,
Shopify descarta al otro **en silencio**. Y Escalonado y BxGy siguen creándose
con `orderDiscounts: false`.

**Traducido a Greta y SkinUp:** SkinUp tiene «Radiesse Day» (escalonada) activa.
Si SkinUp crea una campaña de **monto de compra** después del despliegue, **no
va a aplicar** cuando la escalonada aplique. El formulario lo avisa en amarillo
—lista las campañas que la anulan— así que no es mudo, pero el merchant va a
probar, no va a ver el descuento, y va a escribir.

Esto es exactamente la decisión que quedó pendiente el 05/09. Tres salidas:

1. **Tomar la decisión ahora** y poner `orderDiscounts: true` en Escalonado y
   BxGy. ⚠️ Toca código en producción y también deja pasar descuentos de orden
   de **otras apps** (SkinUp tiene `Pack 2 Flo` instalada).
2. **No subir CART_VALUE en esta tanda** (ver §7).
3. **Subirlo y aceptar el aviso amarillo** como suficiente.

No hay una cuarta. Y la 1 es una decisión de producto, no una corrección.

---

## 3 · Una sola app version: qué significa

### El hecho

Un `shopify app deploy` publica **una** app version que contiene, indivisible:

```
4 Functions:  tiered-discount · pack-discount · order-discount · code-original-price
1 bloque de tema:  pack-widget
+ la configuración del .toml (incluido [app_proxy])
```

**No se puede desplegar una Function sin las otras tres.**

### Consecuencias concretas

1. **Dejar un tipo fuera no se hace quitando su Function: se hace ocultando su
   tarjeta en la app.** Una Function instalada y sin usar es inerte —no crea
   ningún descuento por sí sola— así que el costo de que viaje es cero. Lo que
   controla si el tipo existe para el merchant es el admin (Vercel), no la app
   version.

2. **El bloque de tema es opt-in.** Publicar la versión lo pone *disponible* en
   el editor de temas; **no lo inserta en la tienda de nadie**. Ninguna de las
   tres tiendas de cliente verá un cambio en su storefront hasta que alguien
   agregue el bloque a mano. Riesgo bajo.

3. 🔴 **El orden lo decide una asimetría de dependencias:**

   | Escenario | Qué pasa |
   |---|---|
   | App version primero, Vercel después | Las 4 Functions quedan instaladas y **sin usar**. Nada las referencia. **Invisible para todos.** |
   | Vercel primero, app version después | Crear una campaña de pack/monto/cupón **falla** (`getDiscountFunctionId` no encuentra la Function y **lanza**). Ruidoso, pero es un error en la cara del merchant |

   → **App version PRIMERO, Vercel DESPUÉS.** Es el mismo orden que el
   despliegue del 08/08, y por el mismo motivo.

4. **El rollback va al revés**: Vercel primero, app version después.

5. **`[app_proxy]` viaja en esta versión.** Hoy está en el toml de dev y **no
   está en el de producción** (verificado). Sin él, el widget de packs pierde su
   red de seguridad: la revalidación en segundo plano falla en silencio (eso es
   tolerable, el widget ya está pintado) pero la **reparación del catálogo
   cuando `all_products` resuelve menos de 20 handles** no funciona, y el
   comprador vería menos productos de los configurados. No afecta al dinero —eso
   lo decide la Function— pero sí a la pantalla.

### 🔴 El landmine de la línea de comandos

`.shopify/project.json` tiene **los dos** client_id apuntando a la **misma**
tienda de dev:

```
cca497b9abcf56c14d019ee24d0260d5  ← PRODUCCIÓN
4e80c45a67c8b263d8b725d4c4c2ece0  ← DEV
```

Y existen los dos tomls. Un `shopify app deploy` sin `--config` toma
`shopify.app.toml`, que es **producción**. Eso es lo que querés ahora, pero
significa que hay que ser explícito **siempre**:

```bash
shopify app deploy --config shopify.app.toml
```

y **confirmar el client_id que imprime la CLI antes de aceptar**. Si dice
`4e80c45a...`, cancelar: ése es dev.

---

## 4 · Las migraciones

### Qué se corre

Tres, en este orden, cada una una sola línea:

```sql
20260905090000  ALTER TYPE "CampaignType" ADD VALUE 'PACK';
20260905190000  ALTER TYPE "CampaignType" ADD VALUE 'CART_VALUE';
20260905210000  ALTER TYPE "CampaignType" ADD VALUE 'CODE_ORIGINAL_PRICE';
```

**Puramente aditivas: no tocan ni una fila.** No hay `ALTER TABLE`, no hay
backfill, no hay índices.

### 🔴 Corren SOLAS en el build de Vercel

```json
"buildCommand": "npm run setup && npm run build"
"setup": "prisma generate && prisma migrate deploy"
```

Esto no es un paso que decidas hacer: **pasa como parte del deploy de Vercel**.
Y es el dato que cambia el orden del plan.

### ¿Reversible?

**No, y no importa.** Postgres no tiene `DROP VALUE` para un enum. Un rollback
deja tres valores de enum sin usar, que son **inertes**: ninguna fila los usa y
el código viejo no los menciona. Está escrito así en las propias migraciones:
*«no se revierte en un rollback; forward-fix siempre»*.

### ¿Y si falla a mitad?

Cada migración es su propia transacción y `migrate deploy` se detiene en la
primera que falle.

| Momento del fallo | Consecuencia |
|---|---|
| Cualquiera | **El build de Vercel falla → el deployment no se promociona → producción sigue sirviendo `e7be44d`.** Modo de fallo seguro |
| 1 y 2 aplicadas, 3 falla | La base queda con `PACK` y `CART_VALUE` pero no `CODE_ORIGINAL_PRICE`, y `_prisma_migrations` guarda la fallida |

🔴 **El filo de esa segunda fila**: con una migración marcada como fallida,
**todos los deploys siguientes se niegan a correr** hasta resolverla a mano
(`prisma migrate resolve`). Es decir: un fallo de migración no solo bloquea este
despliegue, bloquea el rollback-hacia-adelante también.

### La recomendación: desacoplarlas

**Correr `prisma migrate deploy` a mano contra producción ANTES de tocar
Vercel.** Beneficios:

- El build de Vercel encuentra las migraciones ya aplicadas → **no puede fallar
  por migraciones**.
- Verificás el enum antes de que ningún código dependa de él.
- Si algo sale mal, sale mal en una terminal donde estás mirando, no en un build.

Con una guarda obligatoria antes, para no equivocarte de base:

```sql
SELECT count(*) FROM "Shop";   -- producción ≈ 6 · dev = 1
```

Si devuelve 1, **estás apuntando a dev: parar.** Y usar `DIRECT_URL` (el schema
ya declara `directUrl`; Neon no acepta migraciones por la conexión pooled).

---

## 5 · El orden exacto, paso a paso

### Fase 0 — Antes de tocar nada (todo reversible)

| # | Paso | Reversible |
|---|---|---|
| 0.1 | **Commitear los 39 archivos** del cupón en `dev` | ✅ |
| 0.2 | `npm test` (327) · `npx tsc --noEmit` (172, solo TS2345/2322/2367) · `npm run build` | ✅ |
| 0.3 | Fixtures de las 4 extensiones: **70/70** | ✅ |
| 0.4 | 🔴 **Correr la consulta SQL de la §1** contra producción y decidir | ✅ (solo lectura) |
| 0.5 | **Agregar `[app_proxy]` a `shopify.app.toml`** (§8) | ✅ |
| 0.6 | Decidir qué NO subir y ocultar sus tarjetas (§7) | ✅ |
| 0.7 | Verificar las variables de entorno en Vercel (§8) | ✅ |
| 0.8 | Anotar la app version actual: **`discountflow-8`**. Es el destino del rollback | ✅ |
| 0.9 | Anotar el commit de producción: **`e7be44d`** | ✅ |

### Fase 1 — Migraciones (irreversibles pero inertes)

| # | Paso | Verificar antes de seguir |
|---|---|---|
| 1.1 | `SELECT count(*) FROM "Shop"` con las credenciales de prod | **≈6**. Si da 1, PARAR |
| 1.2 | `npx prisma migrate deploy` (con `DATABASE_URL`/`DIRECT_URL` de prod) | Las 3 aplicadas, sin error |
| 1.3 | Comprobar el enum | Los 7 valores presentes |
| 1.4 | Comprobar que no cambió nada más | `SELECT count(*) FROM "Campaign"` igual que antes |

```sql
SELECT enumlabel FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'CampaignType' ORDER BY e.enumsortorder;
```

**En este punto producción sigue corriendo `e7be44d` y no ha cambiado nada para
nadie.** El código viejo ignora los valores nuevos del enum.

### Fase 2 — App version (reversible, pero es la que importa)

| # | Paso | Verificar antes de seguir |
|---|---|---|
| 2.1 | `shopify app deploy --config shopify.app.toml` | 🔴 **Confirmar que la CLI dice `cca497b9...`** antes de aceptar |
| 2.2 | La versión se publica | Partner Dashboard → Versions: la nueva es la *released* |
| 2.3 | Comprobar las 4 Functions instaladas en una tienda | Ver abajo |
| 2.4 | 🔴 **Verificar que Escalonados sigue vivo** | Ver abajo — **es el paso que no se saltea** |

Para 2.3, en el GraphiQL de una tienda:

```graphql
{ shopifyFunctions(first: 50) { nodes { id title apiType } } }
```

Tienen que salir **4** con títulos exactos `tiered-discount`, `pack-discount`,
`order-discount`, `code-original-price`. 🔴 **Si `tiered-discount` no aparece con
ese título exacto, parar y hacer rollback**: el resolvedor nuevo empareja por
título y, con 4 Functions instaladas, ya no hay red de seguridad.

Para 2.4, en el storefront de SkinUp: armar el carrito de **«Radiesse Day»**
(3 × $600.000 → $1.440.000, el número verificado el 09/08) y confirmar que el
descuento escalonado sigue aplicando **igual**.

> Esto debería funcionar sin margen de duda, y la razón es la mejor noticia de
> todo el análisis: **`extensions/tiered-discount/` y `tiered-calc.ts` tienen
> CERO diff entre `main` y `dev`**, y sus 16 fixtures pasan contra el Wasm real.
> El `.wasm` se recompila igual (cambia en cada build aunque no toques nada),
> pero la fuente y el comportamiento son idénticos. Aun así **se verifica en el
> carrito**, porque «cero diff» no es «lo vi funcionando».

### Fase 3 — Vercel (reversible)

| # | Paso | Verificar antes de seguir |
|---|---|---|
| 3.1 | Merge `dev` → la rama de producción de Vercel (**confirmá cuál es**) y push | El build arranca |
| 3.2 | El build pasa | Las migraciones salen como *no-op* (ya aplicadas en la fase 1) |
| 3.3 | Promoción a Production | Vercel → Deployments → *Current* apunta al commit nuevo |
| 3.4 | Abrir la app en **una** tienda de cliente | Ver abajo |

Verificaciones de 3.4, en este orden:

1. **El listado de campañas carga** y muestra las campañas existentes con su tipo
   **en español** (si sale `TIERED` en crudo, el `tipoLabel` volvió a fallar).
2. **El dashboard y la analítica cargan.**
3. **Editar y volver a guardar una campaña existente de Escalonado** — sin
   cambiar nada. Es lo que ejercita `runDiscountMutation` movido de archivo y el
   resolvedor nuevo de Function.
4. **Volver a verificar el carrito de Radiesse Day** después de ese guardado.
5. Recién ahí, crear una campaña de un tipo nuevo en **tu** tienda de prueba, no
   en la de un cliente.

---

## 6 · El punto de no retorno

**No son las migraciones.** Los valores de enum de más son inertes.

🔴 **El punto de no retorno es el momento en que un merchant crea la primera
campaña de un tipo nuevo en producción.**

Desde ese instante hay filas con `type = 'PACK'` (o `CART_VALUE`, o
`CODE_ORIGINAL_PRICE'`), y el cliente Prisma de `e7be44d` **no conoce esos
valores del enum**. Al volver atrás, cualquier consulta que traiga esa fila
—empezando por el listado de campañas, que trae todas— se topa con un valor de
enum que no puede deserializar. **El resultado esperado es que la pantalla de
campañas de esa tienda se caiga entera**, no que muestre la campaña rara.

⚠️ Marco esto como *esperado* y no como *verificado*: no lo probé. Pero el
rollback no puede depender de que yo tenga razón, así que el procedimiento de la
§7 lo neutraliza borrando esas filas antes de bajar el código.

**Corolario práctico**: mientras no le anuncies los tipos nuevos a los clientes,
el rollback sigue siendo limpio. Crear la primera campaña de pack **en tu tienda
de prueba** también cruza esa línea — pero ahí la fila la podés borrar vos.

---

## 7 · Rollback completo

### Antes de empezar: ¿existe alguna campaña de tipo nuevo?

```sql
SELECT s.domain, c.id, c.name, c.type, c.status
FROM "Campaign" c JOIN "Shop" s ON s.id = c."shopId"
WHERE c.type IN ('PACK','CART_VALUE','CODE_ORIGINAL_PRICE');
```

- **Cero filas** → rollback limpio, seguí al paso R1.
- **Alguna fila** → hay que hacer **R0 primero**, o la app se cae al bajar.

### R0 — Solo si hay campañas de tipo nuevo (⚠️ el paso delicado)

1. **Desde la app todavía nueva**, pausar y eliminar cada campaña de tipo nuevo.
   Hacerlo desde la app y no por SQL es lo que garantiza que el descuento se
   borre también **en Shopify**; borrando la fila a mano queda un descuento
   huérfano descontando en la tienda y nadie que lo revierta.
2. Volver a correr la consulta: tiene que dar **cero filas**.

### R1 — Vercel primero

1. Vercel → Deployments → el deployment de **`e7be44d`** → **Promote to
   Production** (o `vercel rollback`).
2. Verificar: `/app/campaigns` carga en una tienda de cliente y muestra las
   campañas de siempre.

**Con esto ya está resuelto lo importante**: el admin vuelve a ser el conocido.
Las 4 Functions siguen instaladas pero ninguna campaña las referencia, y las
Functions no hacen nada por sí solas.

### R2 — App version después

1. Partner Dashboard → la app → **Versions** → `discountflow-8` → **Release**.
2. Verificar en el GraphiQL de una tienda: `shopifyFunctions` vuelve a listar
   solo `tiered-discount`.
3. 🔴 **Volver a verificar el carrito de Radiesse Day.** Es lo único que importa
   de este paso.

⚠️ Si algún merchant ya agregó el bloque de packs a su tema, al volver atrás la
app version ese bloque **desaparece del tema** (la extensión ya no existe en la
versión publicada). Se ve como un hueco en la página. Por eso el bloque no se le
anuncia a nadie hasta que la cosa esté estable.

### R3 — Las migraciones no se revierten

Se quedan. Tres valores de enum sin usar. **No intentar quitarlos**: Postgres no
lo soporta limpiamente y no hay nada que ganar.

---

## 8 · Qué hay que hacer antes de subir

### El `[app_proxy]` que falta en producción

`shopify.app.toml` **no tiene** el bloque; el de dev sí. Hay que agregarlo:

```toml
[app_proxy]
url = "https://discountflow-app.vercel.app/apps/discountflow"
subpath = "discountflow"
prefix = "apps"
```

Viaja con la app version de la fase 2. Sin él, packs funciona pero pierde la
reparación del catálogo (§3.5).

### Variables de entorno en Vercel

Estas las lee el código; hay que confirmar una por una que estén en el proyecto
de **producción**:

| Variable | Nota |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | 🔴 De la **rama de producción** de Neon, no la de dev |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | De la app de **producción** (`cca497b9...`) |
| `SHOPIFY_APP_URL` | `https://discountflow-app.vercel.app` |
| `SCOPES` | El mismo string de siempre |
| `CRON_SECRET` | Lo usa el panel interno de pausa |
| **`PLAN_SYNC_OBSERVACION=1`** | 🔴 **DEJARLA PUESTA.** Ver §1 |
| `SHOPIFY_APP_HANDLE` | ⚠️ El código lo lee (`app.plans.tsx`) y **no está en el `.env` de dev**. Si falta en Vercel, la pantalla de planes muestra un aviso en vez del botón de mejorar plan. Es un pendiente viejo — comprobalo, no lo descubras después |

**Ninguna variable nueva hace falta para los tres tipos nuevos.** Verificado
listando todos los `process.env.*` del código.

### Secretos

🟢 `.env` está en `.gitignore` y **no está trackeado**. El `client_id` del toml
es público por diseño.

🔴 Sigue pendiente de antes: el **repo de GitHub quedó público** y los secretos
**sin rotar**. No bloquea este despliegue, pero mientras el repo sea público
cualquiera puede leer la estructura completa de la app.

### Git

- 39 archivos sin commitear. **Commitear y pushear** antes de todo.
- `dev` está **57 commits por delante de `origin/dev`**.
- 🔴 **Confirmá desde qué rama despliega Vercel producción.** Si es `main`, hay
  que mergear `dev` → `main`; si es `dev`, un push a `dev` **despliega solo**, y
  eso cambia el orden de todo el plan.

---

## 9 · Qué NO subir en esta tanda

### ~~1. El cupón sobre precio original — dejarlo oculto~~ ❌ ANULADO

> **Jonas probó el cupón el 2026-09-06 y lo aprobó.** Se sube visible, con las
> tres secciones nuevas y los dos cambios de la §13. La recomendación de abajo
> queda como registro de por qué se planteó, no como algo a hacer.

### ~~1-bis. El razonamiento original~~

**No lo abriste nunca en un navegador.** Ni la versión de ayer ni las tres
secciones de hoy. Por tu propia regla nº1, no está listo.

Y es el que más superficie nueva tiene: es el **primer descuento de CÓDIGO** de
la app (otra familia de mutaciones), el primero con `usageLimit` nativo, y el
único cuyo comportamiento ante un carrito que no califica **no sabemos qué le
muestra al comprador**.

**Cómo dejarlo fuera sin sacar la extensión**: su Function viaja igual (es
inerte), y se oculta la tarjeta del listado — `app.campaigns._index.tsx:1466`,
el `<a href="/app/campaigns/new/original-price">`. Una condición y listo.
Después lo probás en dev con calma, y para publicarlo **solo hace falta un
deploy de Vercel**: sin app version, sin migraciones, sin tocar Functions. Es el
despliegue más barato que existe.

### ~~2. Considerá dejar también el monto de compra~~ ❌ ANULADO

> Se sube. El choque con las escalonadas sigue siendo real —Shopify descarta uno
> de los dos— pero **el cupón ya puede excluir el descuento por monto**, que es
> el único par que de verdad convive. El razonamiento original, abajo.

Por lo de la §2: para **Greta y SkinUp**, que son los que tienen escalonadas
activas, una campaña de monto de compra **no va a aplicar** cuando la escalonada
aplique. El aviso amarillo cumple, pero el primer merchant que lo pruebe va a
escribirte.

Si lo subís, subilo sabiendo eso. Si preferís tomar antes la decisión de
`combinesWith`, se oculta igual que el cupón, con una línea.

**Packs es el que está más listo**: lo probaste de punta a punta, escritorio y
móvil, carrito y checkout.

### 3. No subir, y no construir ahora

- **El arreglo del desmontaje de `Section` en los otros seis formularios.** No
  está hecho, toca los seis formularios vivos y necesita verificación en el
  navegador uno por uno. Es un despliegue propio.
- **La migración `functionId` → `functionHandle`.** No hay fecha de retirada y
  el campo sigue en `unstable`. Va junto al salto de versión de API de octubre.
- **Quitar `PLAN_SYNC_OBSERVACION`.** §1.

---

## 10 · Momento del día

- **Un día de semana por la mañana, en tu horario.** El tráfico de storefront de
  e-commerce en Chile/Argentina es más bajo a la mañana; los picos son de tarde
  y noche.
- **Nunca viernes ni fin de semana.** El rollback necesita que estés disponible
  y que los merchants te puedan escribir.
- Dejá **2–3 horas libres después**, no 20 minutos.
- El cron nocturno de Vercel (00:00 UTC) es irrelevante: la ruta no existe.
- El sondeo de plan corre cada 15 minutos por tienda, al abrir la app. Con
  `PLAN_SYNC_OBSERVACION=1` no degrada a nadie.
- ⚠️ Tenés la presión del caso 116943 (**10/09 baja de ranking, 21/09
  retirada**). Eso empuja a subir pronto — pero es una razón para subir **menos
  cosas bien verificadas**, no para subir todo rápido.

---

## 11 · Lo que más puede salir mal, y cómo lo detectás

Ordenado por daño real, no por probabilidad.

### 1 · 🔴 El rollback deja de ser seguro sin que te enteres

**Qué pasa**: alguien crea una campaña de tipo nuevo, y a partir de ahí volver a
`e7be44d` rompe la pantalla de campañas de esa tienda (§6).

**Cómo lo detectás**: no lo detectás después — se previene antes. **Corré la
consulta de la §7 antes de cualquier rollback, siempre.**

**Mitigación**: no anunciar los tipos nuevos hasta que hayan pasado 24–48 h.

### 2 · 🔴 Un cliente en FREE pierde editar/reactivar su BxGy

**Qué pasa**: §1. La campaña sigue descontando, pero no la puede tocar.

**Cómo lo detectás**: **no hay log ni alerta** — el merchant ve un mensaje de
límite de plan y te escribe. Es exactamente el patrón del caso 116943.

**Mitigación**: la consulta SQL del paso 0.4. Es la más importante de todo el
plan.

### 3 · 🔴 `shopify app deploy` apuntado a la app equivocada

**Qué pasa**: los dos client_id están en `.shopify/project.json` y hay dos
tomls. Deployar la config de dev sobre la app de producción reescribiría
`application_url` y los `redirect_urls` → **los tres clientes no pueden abrir la
app**.

**Cómo lo detectás**: instantáneo y total. Al abrir la app: pantalla en blanco o
error de OAuth.

**Mitigación**: `--config shopify.app.toml` explícito y **leer el client_id que
imprime la CLI antes de confirmar**. Rollback: re-release de
`discountflow-8`.

### 4 · 🔴 Una migración a medias bloquea los deploys siguientes

**Qué pasa**: §4. Una migración marcada como fallida bloquea también el
forward-fix.

**Cómo lo detectás**: el build de Vercel falla con `P3009`.

**Mitigación**: correrlas a mano antes (fase 1). Es la razón principal de que el
plan las desacople.

### 5 · 🟡 El monto de compra no aplica y parece roto

**Qué pasa**: §2, `combinesWith` bilateral con las escalonadas de Greta/SkinUp.

**Cómo lo detectás**: en los logs de Vercel de la Function — busca
`[order-discount]` y el motivo. Si el descuento lo descartó **Shopify** por
`combinesWith`, **no hay log de nadie**: la Function ni se llama. Eso es lo que
lo hace difícil. La señal es «el merchant dice que no aplica y en el carrito no
aparece ninguna línea».

**Mitigación**: no subirlo, o decidir `combinesWith` antes.

### 6 · 🟡 El resolvedor de Function no encuentra `tiered-discount`

**Qué pasa**: con 4 Functions instaladas se cae la red de seguridad de «la única
Function de descuento». Si el título de la Function instalada en producción no
es exactamente `tiered-discount`, **crear o editar una escalonada lanza**.

**Cómo lo detectás**: al instante y en la cara — mensaje de error al guardar, con
la lista de Functions encontradas. Las campañas activas **no** se afectan.

**Mitigación**: el paso 2.3, antes de tocar Vercel. Verificado: los
`locales/en.default.json` y el `uid` de `tiered-discount` son **idénticos** entre
`main` y `dev`, así que el título va a casar. Igual se comprueba.

### 7 · 🟡 Vercel Hobby y las invocaciones del app proxy

**Qué pasa**: cada carga de una página con el widget puede llamar al app proxy.
Si el plan sigue siendo **Hobby**, packs puede quemar la cuota — y en Hobby
pasarse **apaga el servicio** (es lo que ya casi pasó el 07/08 con el
re-pateo infinito de jobs).

**Cómo lo detectás**: Vercel → Usage. Vigilalo las primeras 48 h si algún
merchant agrega el bloque.

**Mitigación**: **Vercel Pro** (ya estaba recomendado el 09/08), o no anunciar el
bloque de packs todavía.

### Qué mirar en las primeras 48 horas

| Dónde | Qué buscar |
|---|---|
| Logs de Vercel | `[plan-sync]` · `[function-id]` · `[tiered-` · errores 500 en `/app/campaigns` |
| Logs de las Functions (Partner Dashboard) | `sin-descuento motivo=` de las cuatro |
| Vercel → Usage | Invocaciones, si alguien agregó el bloque |
| El carrito de Radiesse Day (SkinUp) | Que siga dando $1.440.000 |
| Tu bandeja | Es el canal de detección real del punto 2 |

---

## 12 · Resumen ejecutivo

**Lo que da tranquilidad, verificado:**

- Los scopes son idénticos → **nadie re-autoriza**.
- `extensions/tiered-discount/` y `tiered-calc.ts`: **cero diff**. 16/16 fixtures.
- `combinesWith` de los cuatro tipos vivos: **sin cambios**.
- El motor de jobs: cambios **aditivos**, y el único hunk que toca el camino de
  precios vivo es **un comentario**.
- Nada re-evalúa campañas activas: **no hay comprobación en `loader`, no hay
  cron, y el panel de pausa no cubre BxGy ni Escalonado**.
- Las migraciones son inertes y su fallo **no promociona el deploy**.

**Lo que hay que verificar antes, ya filtrado (2026-09-06 tarde):**

| | |
|---|---|
| ~~La consulta SQL de FREE con BxGy/Escalonado~~ | 🟢 **Hecha. 3 filas, ninguna en FREE.** Cerrado |
| ~~Confirmar la rama de Vercel~~ | 🟢 **`main`** |
| ~~Dejar el cupón oculto~~ | 🟢 Anulado: probado y aprobado, se sube visible |
| ~~Decidir sobre monto de compra~~ | 🟢 Anulado: se sube, y el cupón puede excluirlo |
| 🔴 **Que Jonas pruebe los dos cambios de hoy** | §13. Es lo único que frena el despliegue |
| 🔴 **No tocar `PLAN_SYNC_OBSERVACION`** | Sigue en pie, y con F4 encima es más importante que antes |
| 🔴 **Agregar `[app_proxy]`** al toml de producción | Sigue en pie |
| 🔴 Correr las migraciones **a mano y antes**, con la guarda del `count(*)` | Sigue en pie |
| 🔴 Commitear y pushear | Sigue en pie |

---

## 13 · Los dos cambios del cupón del 2026-09-06 (tarde)

Hechos **después** de que Jonas probara y aprobara. 🔴 **Pendientes de prueba**;
son lo único que frena el despliegue.

### 13.1 · Exclusión de descuentos por monto de compra

La sección «Cuándo NO aplicar este descuento» ahora lista **los descuentos por
monto de compra**, cada uno con su umbral, además de los packs.

🔴 **Escalonados y BxGy NO se agregaron, y no es una omisión.** `combinesWith`
es bilateral y los dos declaran `productDiscounts: false`, así que **Shopify
descarta el cupón por su cuenta antes de que ninguna Function opine**: no hay
nada que excluir. Ofrecer la casilla sería ofrecer algo que no hace nada. Siguen
apareciendo en el **aviso amarillo**, con el texto reescrito para decir por qué.

La matriz completa está en `docs/ESTADO.md`. El resumen: **el único par que
convive de verdad es cupón + monto de compra**, y es justo el que Jonas midió en
un pedido real (−$10,80 y −$3,46).

⚠️ **Y por lo mismo, la exclusión de packs que ya existía es redundante**: el
cupón nunca aplica junto a un pack. Se dejó puesta porque es inofensiva.
**Decisión pendiente**: quitarla o dejarla.

**Mecanismo**: la Function del cupón **recalcula** si la campaña de monto está
aplicando, comparando `cart.cost.subtotalAmount` contra el umbral más bajo de
esa campaña. Es el **mismísimo campo** que lee la Function de monto de compra,
así que no es una aproximación. Se descartó mirar
`cart.lines[].discountAllocations` —que sería más elegante— porque **no está
confirmado que un descuento de otra Function de la misma pasada aparezca ahí**,
y una casilla que no hace nada en silencio es el peor resultado posible.

⚠️ El umbral viaja como una **foto** en el metafield del cupón: si el merchant
cambia los niveles del descuento por monto, hay que volver a guardar el cupón.
El formulario lo dice.

**8 fixtures nuevas** contra el Wasm real, incluido el caso exacto de Jonas (un
producto de $98 con umbral de $50), el límite exacto ($50 = $50 sí alcanza) y el
centavo de menos ($49,99 no).

### 13.2 · Método: código o automático

El merchant elige, como en la pantalla nativa de Shopify.

🔴 **Con el método automático NO hay límite de usos**, y no es una decisión:
`DiscountAutomaticAppInput` **no tiene** `usageLimit` ni
`appliesOncePerCustomer` (verificado por introspección contra la tienda). El
formulario esconde esa sección y explica por qué, en vez de guardar campos que
Shopify no va a hacer cumplir.

🔴 **Cambiar de método en una campaña ya creada borra el descuento y lo vuelve a
crear**: son dos familias de objetos distintas en Shopify y no hay mutación que
convierta una en otra. El orden es **borrar primero**, a propósito: al revés, un
fallo dejaría los dos descuentos vivos y el comprador podría recibir el cupón
dos veces.

### 13.3 · Qué tiene que probar Jonas

**Exclusión por monto** — es el caso que él describió:

1. Con la campaña de monto de compra **activa** (umbral bajo, p. ej. $50).
2. Crear o editar el cupón → sección **«Cuándo NO aplicar este descuento»** →
   tiene que aparecer el grupo **«Descuentos por monto de compra»** con la
   campaña y su umbral entre paréntesis. **Marcarla.** Guardar.
3. Carrito con un producto de **~$98** → aplicar el cupón →
   🔴 **el cupón NO debe aplicar**, y el descuento por monto sí.
4. Desmarcar la casilla, guardar, repetir → **los dos aplican** (es lo que vio
   en el pedido real).
5. Un carrito **por debajo** del umbral con la casilla marcada → **el cupón sí
   aplica**, porque la otra campaña no está descontando.

**Método automático:**

6. Crear un cupón con método **«Descuento automático»** → el campo de código
   **desaparece**, y la sección «Límite de usos» explica que no existe.
7. Activar → en **Shopify → Descuentos** tiene que aparecer como **automático**
   (sin código). *Mirar, no editar.*
8. En la tienda, **sin escribir nada**, el descuento se aplica solo.
9. **Editar ese cupón y cambiarlo a «Código de descuento»** → guardar → en
   Shopify el automático desapareció y hay uno de código nuevo. El listado
   vuelve a mostrar el chip del código.
10. El listado: un cupón automático **no** muestra chip de código, y su etiqueta
    dice **«… · automático»**.

### 13.4 · Dos arreglos del 2026-09-06 (tarde), reportados por Jonas

**Bug: al cambiar de método se perdía el código.** Crear con código `TEST`,
editar a automático, guardar → el código quedaba inexistente.

**Causa**: yo lo blanqueaba a propósito en `buildOriginalPriceConfig`, con el
razonamiento de que el listado no mostrara un chip con un código que no existe
en Shopify. Estaba mal por dos motivos: ese problema ya se resuelve donde
corresponde —el listado mira el **método**, no si el código está vacío— y borrar
lo que el merchant escribió convierte una prueba reversible («¿y si lo pongo
automático?») en una pérdida de datos.

**Arreglo**: la config guarda **siempre** lo que el merchant escribió. Qué se le
manda a Shopify lo decide la mutación, y la automática no manda `code` porque
ese campo no existe en `DiscountAutomaticAppInput`. Son dos cosas distintas y
ahora están separadas. Y se **dice en pantalla** que el código quedó guardado,
porque el campo desaparece y sin el aviso no hay forma de saberlo.

**Y el texto contradictorio**: el panel decía «Método: Automático» y debajo «el
descuento se aplica cuando el comprador escribe el código». Ahora hay un texto
por método.

**Cómo verificarlos:**

| # | Paso | Qué tiene que pasar |
|---|---|---|
| 1 | Crear un cupón, método **Código**, código `TEST`. Guardar | Se guarda |
| 2 | Editar → método **Automático** | El campo de código desaparece **y aparece**: *«Tu código TEST se conserva: si volvés al método de código, sigue ahí»* |
| 3 | Mirar el pie del panel derecho | Tiene que decir que se aplica **solo**, sin código. 🔴 Ya **no** puede decir «cuando el comprador escribe el código» |
| 4 | Guardar | Se guarda |
| 5 | **Volver a entrar a editar** | El método es Automático **y el aviso sigue mostrando `TEST`** |
| 6 | Cambiar a **Código** | 🔴 **El campo del código tiene que venir con `TEST` ya puesto**, sin escribirlo de nuevo |
| 7 | Guardar y mirar el listado | Vuelve el chip `TEST` |
| 8 | Shopify → Descuentos | Un solo descuento, de código, con `TEST`. **Ningún automático huérfano** |

⚠️ El paso 8 importa: cambiar de método **borra y recrea** el descuento, y el
borrado va primero. Si quedaran los dos, el comprador podría recibir el cupón
dos veces.

### 13.5 · Los dos bugs del 2026-09-06 (noche), diagnosticados leyendo la tienda

Jonas reportó que el cupón automático no aplicaba nunca y que el listado y el
formulario mostraban alcances distintos. **Los dos se diagnosticaron leyendo el
estado real de la tienda y de la base**, no con tests — porque los tests habían
pasado verdes dos veces con los bugs adentro.

#### Lo que había de verdad en Shopify

El descuento automático **existía y estaba perfecto**:

```
DiscountAutomaticApp · ACTIVE · "[DiscountFlow] TEst cupon"
  function      : code-original-price
  classes       : PRODUCT
  combinesWith  : order=true product=true shipping=false
  metafield discountflow.original-price-config:
    {"percent":10,"scope":"selected","productIds":[7 productos],
     "minSubtotal":120,"minQuantity":null,
     "excludeIfCartValue":[{"campaignId":"cmtpstqe…","minSubtotal":50}],
     "excludeIfPackIds":["cmtps9ixg…"]}
```

🟢 **Conclusión: el cambio de método NO pierde nada.** Se recrea con el alcance,
los mínimos, las exclusiones y la combinación completos. Y `Cydney Plaid`
(`…772104`) **sí** está entre los 7 productos y **sí** está en la colección
`Camisas`.

#### Bug 1 · No era un fallo de código: la configuración era imposible

| Ajuste guardado | Qué exige |
|---|---|
| Mínimo de compra **$120** | subtotal **≥ 120** |
| Excluir «Monto de compra QA» (descuenta desde **$50**) | subtotal **< 50** |

El mínimo se mide sobre las líneas **en alcance**, que son un subconjunto del
carrito. **La intersección es vacía: el cupón no podía aplicar en ningún
carrito.** Con el carrito de $196, la campaña de monto estaba aplicando y el
cupón se anuló solo — exactamente lo que Jonas vio («solo aparece el descuento
por monto de compra»).

**El defecto es mío y es de producto, no de lógica**: la app aceptó una
combinación demostrablemente muerta y no dio **ninguna** señal. Quien especificó
la feature no pudo distinguir «excluido a propósito» de «roto», y con razón.

**Arreglo**: `exclusionQueAnulaElCupon` detecta la condición exacta
(`mínimo >= el umbral más bajo de las excluidas`) y el formulario pinta un
**banner rojo arriba de la rejilla** que nombra la campaña culpable y dice cómo
salir: bajar el mínimo por debajo de ese umbral, o quitar la exclusión.

**Probado contra el Wasm real** con los números exactos del reporte:

| Fixture | Resultado |
|---|---|
| `reporte-0906-carrito-196-excluido-por-monto` | sin descuento — reproduce el bug |
| `reporte-0906-sin-la-exclusion-el-cupon-aplica` | **−$9,80/unidad** — el método automático funciona |
| `reporte-0906-combinacion-imposible-49-no-llega-al-minimo` | sin descuento — la ventana está vacía por los dos lados |

⚠️ De paso: `Cydney Plaid` **no tiene precio comparativo** (`compareAtPrice:
null`), así que ahí el cupón calcula sobre el precio actual. Es correcto, pero la
ventaja del tipo «sobre el precio original» es nula en ese producto — para
probarlo conviene usar uno con comparativo.

#### Bug 2 · El listado imprimía una constante

```tsx
: c.type === "CODE_ORIGINAL_PRICE"
? "Toda la tienda"        // ← literal, ignoraba la config
```

Lo escribí el 05/09, cuando el cupón no tenía alcance y de verdad aplicaba a
todo. Al agregarle «A qué aplica» esta mañana, la constante se quedó. **El
formulario reflejaba lo guardado; el listado mentía.** Es la misma familia que el
`?? type` de `tipoLabel`: un valor escrito a mano que era verdad cuando se
escribió.

**Arreglo**: `originalPriceProductsLabel(config)`, con la misma semántica que
Escalonado (`—` cuando una campaña por colección todavía no resolvió productos,
en vez de un `0` que haría pensar que no aplica a nada). **Verificado con la
config real** leída de la base: ahora devuelve `"7"`.

#### Cómo verificarlos

| # | Paso | Qué tiene que pasar |
|---|---|---|
| 1 | Abrir el listado con «TEst cupon» tal como está | La columna de productos dice **7**, ya no «Toda la tienda» |
| 2 | Editarla, sin cambiar nada | 🔴 Arriba, **banner rojo**: mínimo $120 vs «Monto de compra QA» desde $50, y qué hacer |
| 3 | Bajar el mínimo a **$30** | El banner **desaparece** |
| 4 | Guardar, y carrito con **1× Cydney Plaid** ($98) | 🔴 El cupón **sigue sin aplicar**: $98 ≥ $50, la campaña de monto está aplicando y la exclusión la anula. **Es correcto** |
| 5 | Carrito de **$40** (algo en alcance por menos de $50) | 🔴 **El cupón aplica** — la campaña de monto no llega a su umbral |
| 6 | Volver a editar y **desmarcar** «Monto de compra QA» | Guardar |
| 7 | Carrito de $196 otra vez | 🔴 **Aplican los dos**: el cupón y el de monto, como en el pedido real de la mañana |
| 8 | Cambiar el alcance a **Productos → uno solo** y guardar | El listado dice **1** |

El paso 5 es el que prueba que la exclusión funciona en las dos direcciones, y el
7 el que prueba que el automático aplica cuando nada lo anula.
