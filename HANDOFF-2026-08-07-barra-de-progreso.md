# 🚀 HANDOFF — Barra de progreso por lotes (2026-08-07)

> **Todo en la rama `dev`. Producción NO se tocó en ningún momento del día.**
> El handoff anterior, [`HANDOFF-2026-07-28-falso-positivo-skinup-y-blindaje.md`](HANDOFF-2026-07-28-falso-positivo-skinup-y-blindaje.md), sigue vigente para el estado de producción.

---

# ═══ 1. ESTADO ACTUAL ═══

| Pieza | Estado |
|---|---|
| Rama de trabajo | **`dev`**, 5 commits por delante de `main` |
| `main` | **`5bcddba`** — sin tocar hoy |
| Working tree | **limpio** |
| Producción (Vercel) | **`5bcddba`** — nada de hoy está desplegado |
| Shopify Function | **`discountflow-7` ★ activa** — sin cambios hoy |
| Migraciones en prod | ninguna nueva |

### Commits del día, en orden

```
f47b285  feat(jobs): motor de trabajos por lotes con progreso (D1)
91cb704  docs: actualizar el handoff del 28/07 al estado post-despliegue
4313a44  chore(billing): trackear el endpoint interno de pausa por limite de plan
881d712  feat(jobs): operaciones reales con barra de progreso (D2)
53b2299  fix(jobs): interruptor de la barra visible en el listado de campanas
```

### Flag `jobs:batched`

| Entorno | Estado |
|---|---|
| **dev** (`calendario-envios-test-final`) | **ENCENDIDO** — `features={"jobs:batched":true}` |
| **producción** (Greta, NYZA, Vermú, SkinUp) | **APAGADO** — nada llegó a producción; y aunque llegara, el flag nace apagado (fail-closed) |

### Migración nueva (aplicada SOLO al branch `dev` de Neon)

`20260807120000_add_campaign_jobs` — **puramente aditiva**: 2 `CREATE TYPE`, 3 `ADD COLUMN`
(nullable o con default), 1 `CREATE TABLE`, 5 índices, 1 FK sobre la tabla nueva.
**Cero `ALTER` de columnas existentes, cero `DROP`.** Verificado con grep antes de aplicar.

---

# ═══ 2. QUÉ SE HIZO HOY ═══

## El problema que resuelve

Crear, activar, pausar o eliminar campañas grandes tardaba minutos con la UI diciendo
solo «Guardando…». Los clientes creían que se colgaba. Peor: si Vercel mataba la función
a mitad, quedaban precios rebajados en unos productos y no en otros, **sin rollback y sin
que nadie se enterara** — el `catch` que borra la campaña nunca corre cuando el proceso
muere, solo cuando se lanza una excepción.

### 🔴 El techo que no se puede bajar

Shopify permite ~**5 mutaciones/segundo sostenidas** (bucket de 1.000 puntos, recuperación
50 pts/s, ~10 pts por mutación). Una mutación = un producto.

| Catálogo | Productos | Suelo de Shopify |
|---|---|---|
| 500 variantes | 100 | 20 s |
| 6.000 variantes | 1.200 | 4 min |
| 20.000 variantes | 4.000 | **~13 min** |

**Ninguna arquitectura baja de ahí.** La barra no compensa una falta de optimización: es
la única solución posible. La competencia tiene barra por el mismo motivo.

## D1 — el motor (commit `f47b285`)

Motor completo + operación `NOOP`, que recorre exactamente el mismo camino que las
operaciones reales **sin poder tocar un precio**. Ninguna pantalla existente se modificó.

| Archivo | Qué hace |
|---|---|
| `app/lib/jobs/constants.ts` | ⭐ **`DEADLINE_MS` y todos los números, en un solo sitio**, cada uno con su porqué |
| `app/lib/jobs/job-state.ts` | Máquina de estados pura (sin BD): terminales, transiciones válidas, `isClaimable`, `isStalled`, `percentOf` |
| `app/lib/jobs/jobs.server.ts` | Crear (idempotente), reclamar (lease), latir, `handOffToNextBatch`, terminar, cancelar, buscar zombis |
| `app/lib/jobs/chain.server.ts` | 🔴 Origen derivado de la petición + **guardia anti-producción** + `waitUntil` con fallback local |
| `app/lib/jobs/runner.server.ts` | El bucle de un lote: reclamar → resolver → trabajar hasta el plazo → guardar → soltar lease → encadenar |
| `app/lib/jobs/operations/index.ts` | Registro y contrato de operaciones (`OpContext` con el cliente Shopify inyectado) |
| `app/lib/jobs/operations/noop.ts` | La operación de pruebas |
| `app/lib/features.server.ts` | `hasFeature()` **fail-closed** |
| `app/lib/shopify/fake-admin.ts` | Cliente Shopify falso: catálogos sintéticos, THROTTLED/userError/latencia a voluntad |
| `app/routes/api.jobs.run.tsx` | Worker. Responde **202 antes de trabajar** |
| `app/routes/api.jobs.$jobId.status.tsx` | Estado (contrato de la barra) + cancelar + re-patear |
| `app/components/JobProgress.tsx` | La barra: completa y modo `compact` para el shell |
| `app/routes/app.jobs-demo.tsx` | Banco de pruebas manual |
| `app/lib/jobs/job-state.test.ts` | 20 tests puros |
| `app/lib/jobs/engine.dbtest.ts` | Batería contra Postgres real |

## D2 — operaciones reales (commit `881d712`)

| Archivo nuevo | Qué hace |
|---|---|
| `app/lib/jobs/operations/campaign-ops.ts` | Los 4 workers: APPLY, REACTIVATE, REVERT, DELETE |
| `app/lib/jobs/errors.ts` | `JobFatalError` — distingue "reintentar" de "morir ya" |
| `app/lib/jobs/enqueue.server.ts` | Puerta de entrada desde las rutas + barrido perezoso + guardia 409 |
| `app/lib/shopify/paged-resolve.server.ts` | Resolución **página a página** con cursor serializable |

### Cableado

| Ruta | Qué se le hizo |
|---|---|
| `app.campaigns.new.percentage.tsx` | Encola `APPLY`. Con flag apagado cae al camino síncrono **intacto** |
| `app.campaigns.new.range.tsx` | Ídem |
| `app.campaigns._index.tsx` | Pausar → `REVERT`, Reactivar → `REACTIVATE`, Eliminar → `DELETE`. Barra por fila. Botones deshabilitados con job en curso. Barrido de zombis en el loader. **Interruptor visible del flag** |
| `app.campaigns.$id.edit*.tsx` (×4) | **409 en el servidor** si la campaña tiene job en curso |
| `app.tsx` | Franja compacta bajo la navegación para seguir el progreso navegando |
| `admin-api.ts` | Único cambio: `readQueryData` pasa a ser `export` |

### Alcance final

| Tipo | Crear | Activar | Pausar | Eliminar |
|---|---|---|---|---|
| **Porcentaje** | ✅ | ✅ | ✅ | ✅ |
| **Rango de precio** | ✅ | ✅ | ✅ | ✅ |
| **BxGy** | ❌ D3 | ✅ | ✅ | ✅ |
| **Escalonado** | ❌ D3 | ✅ | ✅ | ✅ |

### ¿Toca la Shopify Function?

# ✅ NO
Ni el Wasm ni `tiered-calc.ts`. Todos los despliegues de este trabajo son **solo de
Vercel**, con Instant Rollback y sin la coreografía de orden del 28/07.

## La decisión de la opción C

Se evaluó llevar también **crear** BxGy/TIERED al motor y **se descartó**, con tres razones:

1. **BxGy/TIERED activar/pausar/eliminar son UNA mutación**: instantáneos. La barra ahí es
   cosmética. El único caso real es crear un TIERED sobre un catálogo enorme.
2. **Porcentaje y Rango son el 100 % del problema reportado por clientes** (541 y 578
   variantes, los timeouts, las quejas). Eso entró completo.
3. 🔴 **Cerrarlo obliga a tocar `tiered.ts` —el archivo que despliega la Function— en la
   misma entrega que reescribe la ruta de precios.** Dos superficies de fallo
   independientes en un solo despliegue. El acuerdo era no mezclarlas nunca.

Detalle completo y las opciones A/B en [`docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md`](docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md).

## El fix del interruptor visible (commit `53b2299`)

Ver el bug #6 abajo. El interruptor pasó de estar escondido en `/app/jobs-demo` a una
franja arriba del listado de campañas, que dice en qué estado está y qué implica cada uno.
**Solo fuera de producción** — allí el flag se mueve con un `UPDATE`.

---

# ═══ 3. BUGS ENCONTRADOS Y CORREGIDOS ═══

## 🔴 #1 — El lease no se soltaba: la cadena moría en silencio

- **Síntoma:** el primer lote trabajaba, escribía progreso y devolvía `chained: true` —
  todo *parecía* correcto. El job se quedaba congelado a mitad para siempre.
- **Causa:** al terminar un lote limpio el job quedaba `RUNNING` con su `leaseNonce` y el
  latido recién puesto. El `claimJob` del lote siguiente no casaba con ninguna de sus tres
  ramas (ni `QUEUED`, ni latido rancio) y se retiraba con `busy`.
- **Por qué era peligroso:** silencioso por completo. Sin error, sin log, con el job
  aparentando estar vivo. En producción: una campaña de Greta clavada al 8 % sin aviso.
- **Cómo se detectó:** ⭐ **solo apareció al correr las 20.000 unidades reales.** Con 200
  unidades todo cabe en UN lote y nunca hace falta un relevo: el fallo es invisible. Una
  corrida chica lo habría dado por verde.
- **Arreglo:** `handOffToNextBatch()` — antes de encadenar se suelta el lease
  (`RUNNING → QUEUED`, `leaseNonce = null`, latido fresco). Documentado en grande en
  `jobs.server.ts` y en el punto de relevo de `runner.server.ts`.

## 🔴 #2 — `MAX_ATTEMPTS` anulado: re-pateo infinito

- **Síntoma:** el test del freno dejaba el job en `QUEUED` con `attempts=0` en vez de
  `FAILED` con `attempts=5`.
- **Causa:** al cablear las operaciones reales metí `handOffToNextBatch` también en el
  camino de error, y esa función reseteaba `attempts: 0`. El contador volvía a cero en cada
  fallo y **nunca alcanzaba el tope**.
- **Por qué era peligroso:** un job que revienta siempre en el mismo punto se re-patea para
  siempre. En Vercel **Hobby**, agotar la cuota de invocaciones **no degrada el servicio:
  lo APAGA hasta 30 días**. Un solo job envenenado podía tumbar la app de todos los
  clientes durante un mes.
- **Cómo se detectó:** mirando el estado de los jobs en la base durante la corrida, antes
  de que el test cerrara.
- **Arreglo:** `handOffToNextBatch(jobId, nonce, { resetAttempts })`. `true` tras un lote
  limpio (si no, un job sano de 18 lotes llegaría a `attempts=18` y moriría por funcionar
  bien), `false` tras uno que revienta.

## 🔴 #3 — Cancelar entre lotes no encolaba el revert compensatorio

- **Síntoma:** al cancelar un APPLY no aparecía el REVERT que deshace lo aplicado.
- **Causa:** **entre lote y lote el job pasa por `QUEUED`**, así que la mayoría de las
  cancelaciones caen en la vía rápida de `requestCancel` (que termina el job en el acto
  porque no hay worker que pueda enterarse). La lógica compensatoria vivía **solo en el
  runner**, que en ese camino nunca se ejecuta.
- **Por qué era peligroso:** los productos ya rebajados **se quedaban rebajados**, sin
  registro y sin que nadie lo supiera. Es exactamente el sangrado de margen silencioso que
  todo este sistema existe para evitar.
- **Cómo se detectó:** consultando la base a mitad de la batería: el APPLY figuraba
  `CANCELLED` y no había ningún REVERT detrás.
- **Arreglo:** `createCompensatingRevert()` en `jobs.server.ts`, invocada desde **los dos**
  caminos. Acotada con `onlyStampedBy` a lo que el job cancelado llegó a tocar.

## 🟡 #4 — La lista de incidencias solo guardaba el último lote

- **Síntoma:** «3 productos con incidencias» y el detalle de uno solo.
- **Causa:** `failures` era local al lote y `flushProgress` sobrescribe el campo `errors`
  entero. El contador sí acumulaba bien.
- **Por qué importaba:** que el número y el detalle no cuadren hace dudar de toda la
  pantalla, incluida la parte que sí es correcta.
- **Cómo se detectó:** al investigar por qué un test contó 3 errores en vez de 2 (los otros
  2 resultaron ser caídas de Neon).
- **Arreglo:** la lista se **siembra** con las incidencias ya guardadas al empezar el lote.

## 🟡 #5 — Los imports sin extensión rompían el runner de Node

- **Síntoma:** `ERR_MODULE_NOT_FOUND` / `does not provide an export named 'prisma'`.
- **Causa:** el resolvedor ESM de Node rechaza imports sin extensión y de directorio; Vite
  los resuelve. Además `db.server.ts` exporta por **defecto**, no nombrado.
- **Arreglo:** extensiones `.ts` explícitas en todos los módulos del motor, e import por
  defecto de Prisma. `bxgy.ts` y `tiered.ts` se cargan con **import dinámico** para no
  tocarlos (`tiered.ts` queda deliberadamente fuera de esta entrega).

## 🔴 #6 — La feature se entregó apagada y con el interruptor escondido

- **Síntoma:** «D2 no funciona». La barra no aparecía nunca, «Guardando…» eterno, las
  campañas se creaban igual, los borrados se congelaban.
- **Causa raíz, con evidencia:**
  ```
  features={}                    ← el flag jamás se encendió
  CampaignJob: 0 filas           ← el motor NUNCA se invocó
  enqueue.server.ts:30-31        → { enqueued: false, reason: "flag-off" }
  new.percentage.tsx:207         → applyPercentageDiscount(...)  ← el camino viejo
  ```
  **D2 no falló: D2 nunca se ejecutó.** Todo lo observado era el comportamiento anterior,
  intacto — incluido el «Guardando…» eterno, que es justamente el bug que D2 arregla.
- **Por qué pasó:** el fail-closed por defecto es correcto y se queda. Lo que estaba mal es
  que **el único interruptor exigía editar a mano la URL dentro del iframe del admin**, y en
  el handoff eso era el punto 3 de una lista de diez, en una línea.
- **Coste real: cinco horas.**
- **Arreglo:** interruptor visible en el listado de campañas (commit `53b2299`).
- **Bonus:** al construirlo se cazó que `Btn` usa `type="button"` por defecto, así que
  dentro de un `<form>` **no enviaba nada**. Sin ese detalle habría entregado un
  interruptor visible que no hacía nada — el mismo error con otra cara.

---

# ═══ 4. PRUEBAS ═══

## Comandos exactos

```bash
npm test                                            # 57 puros, ~0,5 s
npm run test:jobs                                   # batería del motor contra Postgres
cd extensions/tiered-discount && npx vitest run     # 12 fixtures contra el Wasm
npm run typecheck                                   # línea base 108
npm run build                                       # y después: git checkout .vercel/react-router-build-result.json

# Solo los workers reales (sin el e2e de 20.000, que tarda mucho):
node --experimental-strip-types --env-file=.env --test-concurrency=1 \
  --test-name-pattern="APPLY|REVERT|DELETE|cancelar un APPLY|al terminar la bater" \
  --test app/lib/jobs/engine.dbtest.ts

# Tamaño del e2e (por defecto 20.000):
JOBS_TEST_UNITS=1500 npm run test:jobs
```

## Batería del motor (D1) — **10/10**

| # | Verificación | Resultado |
|---|---|---|
| 1 | 20.000 unidades encadenando lotes | ✅ **67 lotes · peor lote 33,4 s · total 1.434 s · `intentos=1`** |
| 2 | Ninguna invocación > 90 s | ✅ peor 33,4 s → margen 2,7× |
| 3-5 | Matar al 10 / 50 / 90 % y reanudar | ✅ exacto, sin solapes ni huecos |
| 6 | 10 disparos simultáneos → 1 job | ✅ |
| 7 | Zombi detectado (<90 s) y recuperado | ✅ |
| 8 | Dos workers: el lease los serializa | ✅ |
| 9 | Cancelar → `CANCELLED` + cerrojo liberado | ✅ |
| 10 | `attempts=5` y para | ✅ |
| — | Invariante: 0 campañas bloqueadas | ✅ |

## Workers reales (D2) — **6/8**, sobre 5.000 variantes / 1.000 productos

| # | Verificación | Resultado |
|---|---|---|
| 1 | APPLY real, precios correctos, 1 mutación por producto | ⚠️ **falló por Neon** |
| 2 | APPLY interrumpido, sin repetir mutaciones | ✅ `cortado tras 480 · total final 1000 (esperado 1000)` |
| 3 | Cuota de plan → `FAILED` sin tocar precios | ✅ `FAILED sin mutaciones · campaña en DRAFT` |
| 4 | REVERT devuelve los precios originales | ✅ `1000 productos devueltos` |
| 5 | Cancelar → revert compensatorio acotado | ✅ `100 aplicados → deshizo exactamente 100` |
| 6 | Tolerancia a fallos por producto | ⚠️ **falló por Neon** (contó 3 en vez de 2) |
| 7 | DELETE revierte y luego borra | ✅ `1000 revertidos y campaña borrada` |
| 8 | Invariante final | ✅ `0 campañas bloqueadas · 0 jobs colgados` |

### 🔴 Los fallos son de Neon, no del código — la evidencia

Consulta a los errores que el propio job guardó:

```
APPLY COMPLETED_WITH_ERRORS errorCount=3
  lastError: Invalid `prisma.campaignProduct.updateMany()`
             Server has closed the connection.
  gid://shopify/Product/457 :: Shopify rechazó los precios: Precio inválido (simulado)
```

De los 3 errores, **1 es el fallo simulado a propósito y 2 son Neon cerrando la conexión**.

Y la corrida completa posterior (opción A):

```
tests 18 · pass 0 · fail 18
fallos por conexión (ERR_TEST_FAILURE): 18
fallos de lógica    (ERR_ASSERTION):     0     ← ni uno
```

**Cero fallos de aserción en 18.** Todos `Can't reach database server`.

### El estado de Neon

| Momento | RTT |
|---|---|
| Al calibrar los tests | **69 ms** |
| Tras horas de carga | **310-340 ms**, estable |
| Bajo carga sostenida | **cierra conexiones** |

Se añadió `connect_timeout=20` a `DATABASE_URL` y `DIRECT_URL` (pendiente desde julio) —
ayuda a *abrir* conexiones, no impide que el servidor las *cierre*. **Sospecha a
verificar en el dashboard de Neon: la cuota de cómputo del plan gratuito (~50 h/mes)
agotada.**

> ⚠️ **Cada garantía ha pasado al menos una vez a volumen, pero NO existe una sola corrida
> verde de punta a punta con todo junto.** No darlo por cerrado.

### Por qué los tests se cortan por CANTIDAD y no por TIEMPO

La primera versión cortaba con `deadlineMs: 120`, pensado para la latencia de producción
(~1-3 ms, misma región AWS). Pero los tests corren en la máquina de desarrollo, a 69 ms de
`us-east-1`: en 120 ms cabe **un** viaje, y se lo come el `createMany` de la resolución. El
lote expiraba sin procesar una sola unidad y los tests de "matar a mitad" fallaban con
«progreso intermedio: 0» — no porque el motor estuviera roto, sino porque **nunca llegaba a
haber un "mitad" que matar**. Se subió a 1.200 ms y falló por lo mismo.

La conclusión no fue «hace falta un número mayor» sino que **el tiempo es la palanca
equivocada**: un test que pasa o falla según desde qué ciudad lo corras no prueba nada.
Ahora se corta con `maxProductsPerBatch` (`CORTE_UNIDADES = 40`): con 400 unidades, los
cortes al 10/50/90 % caen siempre en los lotes 1, 5 y 9, aquí y en cualquier máquina.

**En producción manda el plazo**: `MAX_PRODUCTS_PER_BATCH` es solo una red de seguridad.

---

# ═══ 5. DECISIONES DE ARQUITECTURA ═══

## Auto-invocación encadenada, no cron ni streaming

| Alternativa | Por qué NO |
|---|---|
| **Cron de Vercel** | 🔴 **Imposible en Hobby**: los cron están limitados a **una ejecución diaria**; `*/1 * * * *` **falla el deployment**. Muerto por decreto de plataforma |
| **El polling del cliente procesa** | Si el merchant cierra el navegador, el job se detiene a mitad |
| **Streaming (SSE)** | El tope de 300 s aplica igual; a los 5 min muere con el 40 % hecho. Y no sobrevive a cerrar la pestaña |
| **Cola externa (QStash)** | Funcionaría, pero mete un proveedor y una clave más. La cadena propia resuelve lo mismo con `CRON_SECRET`, que ya existía |

**Tres disparadores, en orden:** la cadena (99 %) → el sondeo del cliente como **vigilante**
(re-patea si el latido pasa de 90 s; nunca procesa trabajo) → el cron diario como red final.

### El 202 antes de trabajar

`/api/jobs/run` responde **202 y después trabaja** dentro de `waitUntil`. Si procesara antes
de responder, el `fetch` del lote anterior seguiría abierto los 45 s dentro de *su*
`waitUntil`, y la invocación #1 viviría hasta que terminara la #18: **una sola invocación de
14 minutos**, muy por encima del tope de 300 s, y todo el troceado no habría servido de nada.

### 🔴 El origen se deriva de la petición, nunca de una variable

`.env` de **desarrollo** tiene `SHOPIFY_APP_URL=https://discountflow-app.vercel.app` — la URL
de **producción**. `shopify app dev` reescribe el `.toml` pero deja el `.env` intacto. Un
motor que leyera esa variable haría que **cada lote de prueba en local golpease las tiendas
de clientes reales**. El fallo no se ve venir: el código parece correcto y en producción
funciona bien. Por eso el origen sale de las cabeceras de la petición entrante, más un
guardia que corta si algo resuelve al host de producción fuera de producción.

## Reanudación, no rollback automático

1. **El rollback de un APPLY es otro APPLY**: deshacer 1.720 productos son 1.720 mutaciones
   más — la misma operación larga, con el mismo tope y la misma capacidad de convertirse en
   zombi. Recursión sin caso base.
2. **La reanudación es idempotente por construcción**: "lo que queda" es una consulta, y
   repetir un producto es inofensivo (`productVariantsBulkUpdate` con los mismos precios).
3. **Un APPLY a medias no cuesta dinero**: unos productos con descuento y otros sin él. El
   merchant cobra de más en los que faltan, nunca de menos. Es un fallo *conservador*.

**La asimetría que gobierna todo:** un APPLY a medias no cuesta dinero; **un REVERT a
medias sí** — deja productos rebajados en una campaña que el merchant cree pausada.

**El rollback existe, pero como job compensatorio explícito**, nunca implícito: al cancelar
un APPLY, y con botón en la tarjeta de un job fallido.

## El sello `processedByJobId`, no un cursor

Un cursor numérico se rompe si el catálogo cambia bajo los pies del job. Con la marca por
fila, "lo que queda" es una **consulta**:

```sql
WHERE campaignId = ? AND (processedByJobId IS NULL OR processedByJobId <> :jobId)
```

Cuatro propiedades gratis: reanudación exacta sin guardar posición · reprocesar es
imposible (es un sello, no un contador) · las filas antiguas (`NULL`) son "pendientes" para
cualquier job nuevo, que es lo correcto para un REVERT sobre una campaña anterior · e
identifica lo ya tocado, que es justo lo que necesita el revert compensatorio.

**Invariante que no se puede romper:** los precios originales se persisten **ANTES** de
tocar un solo precio en Shopify. La información para revertir no puede perderse por una
interrupción.

## Los números y su razón

| Constante | Valor | Por qué |
|---|---|---|
| **`DEADLINE_MS`** | **45.000** | Peor caso = 45 s + una ola en backoff máximo (~11,5 s) ≈ 56,5 s contra el tope de 300 s → **margen 5,3×**. Menos no: el coste fijo por invocación es ~1,5 s, y con lotes de 4 s de trabajo útil (los "20 productos" que se barajaron) se desperdicia el **27 %** y la cadena pasa de 18 a **200 eslabones**, cada uno un punto de fallo. A 45 s el desperdicio baja al 3 % |
| **`CONCURRENCY`** | **4** | A 500 ms/mutación da 8/s. Como el techo sostenido son 5/s, arranca rápido quemando el bucket de 1.000 puntos (~33 s) y el **backoff que ya existía** lo hace converger solo. **No subir a 8**: no va más rápido y el bucket se **comparte con el admin del merchant** — un job agresivo le ralentiza la ficha de producto |
| `MAX_PRODUCTS_PER_BATCH` | 300 | Red de seguridad; en producción manda el plazo |
| `PROGRESS_FLUSH_UNITS` | 25 | No se escribe por unidad: 20.000 unidades serían 20.000 escrituras. El progreso se **ESCRIBE** (valor absoluto), nunca se incrementa → volcar dos veces es idempotente |
| `LEASE_STALE_MS` | 90.000 | **8× el peor caso de una unidad** (11,5 s con backoff completo) → sin falsos positivos |
| `MAX_ATTEMPTS` | 5 | Freno de mano. Ver bug #2 |

**Coste del sondeo en Hobby** (job de 20.000 ≈ 188 sondeos): 206 invocaciones y ~13 s de
Active CPU por job → ~4.850 jobs/mes con las invocaciones incluidas. No es el problema.

---

# ═══ 6. PENDIENTES ABIERTOS ═══

## 🟡 D3 — crear BxGy/TIERED sin barra

TIERED no crea filas de `CampaignProduct`, así que su lista de ~4.000 GIDs **no tiene dónde
acumularse entre lotes**. Dos opciones:

- **A** — acumular en `CampaignJob.payload`: no toca el modelo, pero ~16 MB de tráfico por
  campaña grande (200 KB reescritos en cada una de ~80 páginas).
- **B** — usar `CampaignProduct` como borrador y borrarlo al final: reutiliza el mecanismo
  tal cual, pero rompe la decisión de julio e inflaría el conteo de variantes del plan
  (mitigable creando la campaña en `DRAFT`).

**Al retomar:** medir cuántos productos resuelve una TIERED típica. Si son cientos, A gana
por simple. Si son miles, B es la que escala. Va en un despliegue **propio**.
Detalle en `docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md`.

## 🔴 Cron de campañas programadas — bug de producto VIVO

`vercel.json` declara `/api/cron/sync-campaigns` y **la ruta no existe** → 404 cada
medianoche desde siempre. Dos mitades:

| Mitad | Efecto | Coste |
|---|---|---|
| `startsAt` no activa | Se guardan como **DRAFT** y nunca arrancan. En el listado aparecen como "Borrador", sin pista de que estaban programadas | Venta y confianza perdidas |
| **`endsAt` no finaliza** | **La campaña no para nunca**, sigue descontando pasada su fecha | 🔴 **Margen perdido de forma continua** |

Confirmado en las 4 rutas de creación (`shouldActivate = intent === "activate" && !isScheduled`).

**Alcance sin medir** — falta esta consulta contra producción (nunca se ejecutó):

```sql
SELECT s.domain, c.name, c.type, c.status, c."startsAt", c."endsAt", c."createdAt"
FROM "Campaign" c JOIN "Shop" s ON s.id = c."shopId"
WHERE c."startsAt" IS NOT NULL OR c."endsAt" IS NOT NULL
ORDER BY c."createdAt" DESC;
```

Buscar: `DRAFT` con `startsAt` pasado (nunca arrancó) y **`ACTIVE` con `endsAt` pasado**
(lleva descontando desde que debió parar — esta es la urgente).

**Ahora que existe el motor, el cron debe ENCOLAR un job**, no aplicar descuentos él mismo
(activaría campañas de 6.000 variantes sin merchant delante), y llevar dentro **los dos
checks de límite de plan**.

## 🔴 `api.internal.pause-over-limit.tsx` trackeado en `dev`

Se trackeó hoy (`4313a44`) para que un `git clean` no lo borrara. **El próximo merge a
`main` LO DESPLEGARÍA.** Su POST real nunca se ha ejercitado. Revisarlo antes de ese merge.

## 🟡 Postgres en contenedor para los tests

Los tests del motor hacen ~2.000 viajes a un servidor a 320 ms. Con un Postgres local
correrían en **segundos** y sin cortes. La palanca correcta no es acortar los tests, es
**acercar la base**. Anotado en `engine.dbtest.ts`.

## 🔴 Seguridad — pendiente desde el 24 de julio

- [ ] **El repo de GitHub sigue PÚBLICO** → volver a privado. Es un clic.
- [ ] **`C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt`** sigue existiendo con
      las claves de producción. Mover al gestor y borrar.
- [ ] **Rotar:** `SHOPIFY_API_SECRET` de prod, contraseña de Neon, secreto de la app Dev.

## 🟡 Otros heredados

- Quitar los logs `[tiered-debug]` y `[tiered-attribution]`.
- Frente 4 (analíticas: números cortados, decimales en CLP, techo `Decimal(10,2)`).
- Frente 1 (Reviews API con el trigger de primera atribución).
- Frente 3 (escalonados por monto fijo — 🚨 toca la Function ×2).

---

# ═══ 7. CÓMO PROBAR MAÑANA ═══

## ⚠️ ANTES DE NADA

**El branch `dev` de Neon puede estar suspendido o degradado.** Si algo da
`Can't reach database server`, es eso. Comprobarlo primero:

```bash
cd C:/Users/Jonas/Desktop/nuevaApp/discountflow
npx prisma migrate status      # debe decir "Database schema is up to date!"
```

## Pasos

```bash
# 1. Rama correcta
git checkout dev
git log --oneline -1           # debe ser 53b2299

# 2. Entorno (si se cambió de rama o de dependencias)
npx prisma generate            # 🔴 falla con EPERM si shopify app dev está corriendo

# 3. Levantar
npx shopify app dev
```

4. Abrir la app en `calendario-envios-test-final` → **Campañas**.
5. Arriba tiene que verse la franja verde: **«Barra de progreso por lotes: ENCENDIDA»**.
   Si no aparece, el servidor no recargó → pararlo y arrancarlo de nuevo.
6. Crear una campaña de porcentaje → vuelve **al instante**, campaña en **Borrador**, barra
   corriendo bajo su fila.
7. **La prueba que importa:** cerrar la pestaña a mitad y volver a entrar. La barra
   reaparece **donde iba**.
8. Con job en curso: Editar/Pausar/Eliminar deshabilitados, y el `action` devuelve **409**
   aunque alguien se salte la UI.
9. **Cancelar** a mitad → `CANCELLED` y arranca solo el revert compensatorio.
10. **Marcha atrás:** botón «Apagar» en la misma franja → vuelve el camino síncrono intacto.

## 🔴 OJO CON EL LÍMITE DE PLAN EN LA DEV STORE

`calendario-envios-test-final` está en **FREE: tope 50 variantes**. La colección "Camisas"
resuelve **57** → el job termina en **`FAILED`** con el motivo a la vista y **sin tocar un
solo precio**. Es el comportamiento correcto, pero **para ver la barra funcionando de
verdad hay que elegir una selección por debajo de 50 variantes**.

> Con la barra encendida, una campaña creada con "Crear y activar" nace como **Borrador** y
> pasa a **Activa** cuando el job termina. Es deliberado: si el trabajo muere a mitad o se
> pasa de cuota, no queda anunciada como activa sin serlo.

---

# ═══ 8. LECCIONES ═══

### Las corridas chicas ocultan bugs de encadenado

El bug #1 —la cadena rota— **pasó todos los tests con 200 unidades**, porque 200 caben en un
solo lote y nunca hace falta un relevo. Solo apareció con las 20.000 reales. Con la corrida
chica se habría reportado el sistema como verde y el bug habría llegado a D2 escondido,
donde el síntoma sería una campaña de Greta clavada al 8 % para siempre.

**Regla:** si se toca el bloque de relevo del runner, se corre la batería **COMPLETA**, no la
corta. Está escrito en el propio código.

### Los pasos manuales van PRIMERO y en grande

D2 se entregó detrás de un flag apagado cuyo único interruptor exigía adivinar una URL
dentro de un iframe. En el handoff eso era el punto 3 de una lista de diez. **Costó cinco
horas** y la conclusión razonable desde fuera fue "esto no funciona", cuando en realidad
nunca se había ejecutado.

**Regla:** si algo necesita un paso manual para funcionar, ese paso va primero, solo y en
grande, antes de cualquier otra explicación. Y si se puede eliminar el paso manual, se
elimina — que es lo que se hizo.

### Neon dev se degrada bajo carga

De 69 ms a 320 ms y luego a cerrar conexiones, tras horas de carga sostenida. **Tres
corridas seguidas invalidadas.** Los fallos eran siempre `Can't reach database server`,
nunca aserciones — lo que permitió separar el problema del entorno del problema del código.

**Regla:** antes de dar por malo el código, clasificar los fallos. `ERR_TEST_FAILURE` con
mensaje de conexión no es un bug del producto. Y a medio plazo, los tests no deberían
depender de una base remota.

### Una batería que solo caza bugs cuando duele es una batería que funciona

De los seis bugs del día, **tres los encontró la batería** (#1, #2, #4), uno lo encontró
consultando la base a mano (#3), y **el más caro (#6) no lo encontró nadie hasta que Jonas
intentó usarlo**. Ese es el hueco a cerrar: nada de lo automatizado prueba que la feature
esté *alcanzable* para un humano.
