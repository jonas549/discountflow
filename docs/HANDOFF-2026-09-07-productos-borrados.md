# Traspaso · 2026-09-07 · Pausar campañas con productos borrados

> Estado vivo: `docs/ESTADO.md`. Procedimiento de despliegue:
> `docs/DESPLIEGUE-A-PRODUCCION.md`.
>
> **PRODUCCIÓN = `709cead`**, build **verde y confirmado**. App version
> **`discountflow-11` sin tocar**. `main` = `709cead`; `dev` tiene además
> `305610c` (solo documentación).

---

## 1 · Qué pasó, en dos frases

Jonas reportó campañas de **PORCENTAJE** fallando en producción —el tipo más
viejo, el que nunca había fallado— con un número que no cerraba: **102
incidencias sobre 8 variantes**. La causa raíz **no era del código**: Greta borró
productos y variantes de su catálogo entre el **03/09**, cuando las campañas se
aplicaron sin un solo error, y el **07/09**, cuando quiso pausarlas.

**Lo que estaba en juego no era el mensaje de error: era plata.**

---

## 2 · 🔴 Lo primero que se miró, y estaba sangrando

**14 variantes de Greta vendiéndose rebajadas con la campaña PAUSADA.**

| Producto | Variantes | Paga | Debería | Pierde |
|---|---|---|---|---|
| Jesusito Praga | 4 | 23,00 | 41,00 | −18,00 c/u |
| Cubre tirantes Siena | 4 | 25,20 | 36,00 | −10,80 c/u |
| jersey liso Rosa empolvado | 3 | 25,20 | 36,00 | −10,80 c/u |
| jersey liso Gris | 2 | 25,20 | 36,00 | −10,80 c/u |
| Pelele pasacinta Rosa terciopelo | 1 | 28,70 | 41,00 | −12,30 |

**−181,50 por cada tanda de una unidad de cada una.** Trece de «outlet invierno»
y una de «Campaña verano», las dos PAUSED desde las 15:27.

🟢 **El número está descontado de solapes.** La verificación inicial dio **15**
variantes rebajadas; una de ellas —*Ranita redonda Azucena*— lo estaba
**legítimamente**, por la campaña ACTIVE «Nueva Colección Estampada 20%». Sin ese
descarte se le habría reportado a Jonas un número inflado.

⚠️ **Jonas reparó los precios él, por su cuenta.** Este trabajo fue solo la app.

---

## 3 · 🔴 Los dos errores de Shopify NO son lo mismo

Es la distinción que gobierna todo el arreglo:

| Mensaje de `userErrors` | Qué significa | Coste |
|---|---|---|
| `Product does not exist` | El producto se borró entero | **Inofensivo.** No hay precio que revertir |
| `Product variant does not exist` | El producto **VIVE**; murió una variante | 🔴 **El caro** |

**Por qué el segundo cuesta dinero:** `productVariantsBulkUpdate` recibe **todas
las variantes de un producto en una sola mutación**. Basta con que una no exista
para que Shopify rechace el lote entero, así que **las variantes hermanas vivas
tampoco se revertían** y se quedaban rebajadas con la campaña pausada.

---

## 4 · Los tres fallos encadenados, y qué hace cada arreglo

| | Antes | Ahora |
|---|---|---|
| **Producto borrado** | Contaba como incidencia y degradaba el job a `COMPLETED_WITH_ERRORS` | Se **saltea**, se **sella**, y la campaña **se pausa** |
| **Variante borrada** | Tumbaba la mutación del producto entero | Se consulta qué variantes existen hoy y se **reintenta solo con las vivas** |
| **El bucle** | La unidad fallida no se sellaba dentro del lote y el lote **giraba sobre ella hasta agotar los 45 s** | El runner **refresca `ctx.job.errors` tras cada ola** → tope de **2 intentos** |

### 🔴 El bucle, que es el que explica el número imposible

`runPriceUnits` decide si sellar una unidad fallida mirando `ctx.job.errors`. Ese
campo era **la foto de la base al empezar el lote y no se refrescaba en toda la
fase de trabajo**. Resultado: dentro de un mismo lote la unidad nunca constaba
"como fallida de antes", nunca se sellaba, `pendingUnits` la devolvía otra vez, y
el lote daba vueltas sobre ella hasta que expiraba el plazo.

🔴 **El contador no medía productos rotos: medía cuántas vueltas cupieron en el
plazo.** De ahí `errorCount=310` sobre **2 unidades reales**.

**Por qué el tope de `failedBefore` (del 2026-08-08) no lo frenaba:** funcionaba
solo *entre* lotes, cuando el job se recarga de la base en la siguiente
invocación. Dentro del mismo lote era ciego.

### 🟢 La salvaguarda es la mitad del diseño

**Si la comprobación de existencia FALLA, no se saltea.** Throttling, token
caducado, red: la unidad se anota como **incidencia**, nunca como salteada.
Saltear por una lectura fallida dejaría la campaña pausada con precios rebajados
vivos — **el fallo caro, en la dirección contraria**.

Dos decisiones que la sostienen:

- **El matcher es el TEXTO EXACTO** de Shopify (`Product does not exist` /
  `Product variant does not exist`) y **todo lo demás se relanza**. Es la misma
  regla que la tolerancia del cupón del 06/09. Hay un test que enumera seis
  mensajes que **no** deben reconocerse.
- **`getExistingVariantIds` LANZA** en vez de hacer `?? []`. No se reusó
  `getProductVariants` justamente por eso: su `?? []` convertiría un token
  caducado en "el producto no existe" y se saltearían productos **vivos**. Es el
  quinto fallo tragado que este repo persigue.

### Lo salteado no es un error, y se ve distinto

`skippedCount` y `skipped` son columnas nuevas (migración **aditiva**
`20260907160000_job_skipped_units`). **Solo `errorCount` degrada el estado del
job.** El aviso en pantalla va **en gris y no en ámbar**, y distingue el producto
eliminado del producto vivo al que le falta una variante — decirle «producto no
encontrado» de uno que tiene delante en su catálogo lo mandaría a buscar un
problema que no existe.

---

## 5 · 🔴 Cómo se repara una campaña que quedó sucia

| Estado | Qué hacer | Ventana de descuentos |
|---|---|---|
| **ACTIVE a medias** (caso «40% update») | **Pausar** | 🟢 Ninguna |
| **PAUSED** («outlet invierno», «Campaña verano») | **Reactivar → Pausar** | ⚠️ Breve, los descuentos se aplican de verdad |
| **PAUSED**, sin ventana | **Eliminar** | 🟢 Ninguna, pero pierde la campaña |

**Por qué un job nuevo reprocesa todo:** `pendingWhere` descarta lo sellado *por
ese mismo job* (`processedByJobId != ctx.job.id`), y el job nuevo tiene otro id.
Revertir algo ya revertido es idempotente.

⚠️ **Revertir restaura el precio guardado AL APLICAR.** En Camisa Jacinto el
original guardado es **17,94** y hoy está a **19,00**: alguien le subió el precio
después, y al pausar la app **lo bajará a 17,94**. Es el comportamiento de
siempre, no algo que introduzca este arreglo, pero hay que saberlo antes de tocar
precios a mano.

🟢 **Hay margen de plan de sobra** para reactivar: Greta está en ESSENTIAL con
15 campañas activas de 50 y 477 variantes de 6.000.

---

## 6 · Alcance: a quién le podía pasar

| | |
|---|---|
| 🔴 **Greta** | Ya le pasaba. Tiene **14 campañas PERCENTAGE activas**, todas expuestas al pausarlas |
| 🟢 **SkinUp** | **NO podía pasarle.** No tiene ni una campaña de precio: las suyas son TIERED y BxGy, que van por Function y **no tocan precios de variante**, así que `runPriceUnits` ni se ejecuta |
| 🟡 Las dos tiendas FREE | Campañas PAUSED de 90 y 578 variantes: mismo riesgo latente si las reactivan y vuelven a pausar |

---

## 7 · ¿Lo causó el despliegue del 06/09? **No**

Medido, no supuesto:

| | |
|---|---|
| `admin-api.ts` (la mutación que falla) | **cero cambios** |
| `campaign-ops.ts` | +106 / −2, **todo** bloques nuevos de PACK / CART_VALUE / CUPÓN. `runPriceUnits`, `priceFor` y el sellado **intactos** |
| `runner.server.ts` | +2 / −1: añadir `shopId` al contexto |

Y la prueba que lo cierra: esas mismas campañas se **aplicaron el 03/09 con cero
errores** (`APPLY COMPLETED`, `errorCount=0`) con el código anterior. Lo que
cambió entre el 3 y el 7 fue **el catálogo de Greta**, no el código. El motor
nunca supo tolerar que un producto desaparezca; hasta ahora nadie había borrado
productos que estuvieran dentro de una campaña.

---

## 8 · Verificación

| | |
|---|---|
| Tests unitarios | **402** (eran 395; +7 de `admin-api.test.ts`) |
| Batería del motor | **10/10, exit 0** |
| Los 7 tests de precios previos | **Verdes sin tocar ninguno**, con catálogo de 1.000 productos |
| Los 4 casos nuevos | Verdes con catálogo chico **y** con el grande |
| Typecheck | **173** — línea base, **cero nuevos**, solo `TS2345`/`TS2322`/`TS2367` |
| Build | Verde |
| App version | **No hizo falta**: cero diff en `extensions/`, los cuatro `*-calc.ts` y el `.toml` |

Los cuatro casos nuevos:

```
[borrados]         10 productos salteados · 10 revertidos · campaña PAUSED
[variante borrada] producto 3: 1 variante fantasma salteada, 4 hermanas revertidas
[sin bucle]        producto borrado: 1 intento y se saltea
[salvaguarda]      comprobación fallida -> incidencia (2 intentos, no 310), nunca salteo
```

🟢 **El `2` de la salvaguarda es el arreglo del bucle convertido en aserción.** Si
alguien deshace el refresco de `ctx.job.errors`, ese número se dispara y el test
cae.

### Verificación del despliegue

Este deploy **sí** toca el bundle de cliente (`JobProgress.tsx`), así que el
testigo del manifest podía moverse — y se movió:

```
antes:   manifest-72c35394.js
después: manifest-c1e6a9a2.js
sanidad: / 200 · /app/campaigns 410 · /apps/discountflow/pack 400 · inventada 404
```

**La migración aplicó**: el `buildCommand` es `npm run setup && npm run build`;
si `migrate deploy` fallara, la cadena corta y el deployment no se promociona.

---

## 9 · ⚠️ Lecciones de método de esta sesión

### La cuarta de la familia «el instrumento roto, no el producto»

La primera corrida de la batería estuvo **20 minutos sin mostrar una sola línea**,
porque se lanzó con `| grep | head -40` y **`head` no puede flushear**: no
entrega nada hasta acumular N líneas o hasta que el proceso muere. No se podía
distinguir *«va por el test 3»* de *«está trabada»*, y con eso se dio una
estimación de **«3 a 8 minutos» que resultó ser una hora** — un error de un factor
de diez, dado **antes de tener una sola medición**.

Va junto con los dos `$?` en el mismo `printf` (06/09), el testigo ciego del
deploy server-only (06/09) y las fixtures corridas a medio escribir (06/09).

🔴 **Regla:** para ver progreso en vivo, salida a un log y
`tail -f | grep --line-buffered`. **Nunca `head` en la cadena de un monitor.**

### 🟢 El atajo que SÍ es legítimo

Los 4 tests nuevos se bajaron de **1.000 a 20 productos**. No rebaja la vara:
cada uno asierta sobre **un producto concreto**, y con 1.000 costaban ~12 min cada
uno contra Neon sin probar ni una cosa más (medido: un APPLY de 5.000 variantes
son **383 s**). El volumen y el encadenado de lotes los cubren los tests
existentes, **que no se tocaron** y que siguen corriendo con el catálogo grande.

**El criterio:** se recorta donde el tamaño no aporta evidencia; **no** se recorta
la no-regresión del camino que sirve a clientes que pagan.

### 🔴 Un dato del runbook que quedó desfasado

**La guardia `SELECT count(*) FROM "Shop"` ya no da 6: da 7.** Entró
`miniaturshop-2.myshopify.com` el 03/09 (plan FREE). La lectura de producción de
hoy **abortó por esa guardia** antes de arrancar. **Verificar por dominio, no por
el número.**

---

## 10 · Archivos

```
app/lib/shopify/admin-api.ts        isMissingInShopify · getExistingVariantIds (LANZA)
app/lib/shopify/admin-api.test.ts   NUEVO · 7 tests, seis mensajes que NO deben matchear
app/lib/shopify/fake-admin.ts       missingProductIndexes · missingVariantIds · existsQueryFails
app/lib/jobs/operations/campaign-ops.ts   runPriceUnits: saltear, reintentar con las vivas
app/lib/jobs/operations/index.ts    SkipReason · SkippedUnit · RunUnitsResult.skipped
app/lib/jobs/runner.server.ts       🔴 refresco de ctx.job.errors + acumulación de skipped
app/lib/jobs/jobs.server.ts         JobRecord y flushProgress con los campos nuevos
app/routes/api.jobs.$jobId.status.tsx     skippedCount · skippedProducts · resumirSalteados
app/components/JobProgress.tsx      SalteadosAviso (gris, distingue producto de variante)
app/lib/jobs/engine.dbtest.ts       4 casos nuevos + catalogoChico
prisma/schema.prisma                skippedCount · skipped
prisma/migrations/20260907160000_job_skipped_units/   ADITIVA
```

**No se guarda el título del producto en `CampaignProduct`**, y un producto
borrado ya no está en Shopify, así que el aviso da el **identificador** — el
número final del GID, que es lo que el merchant ve en la URL del admin y le
permite comprobarlo por su cuenta. Inventar un nombre sería peor.

---

## 11 · Rollback, si hiciera falta

| | |
|---|---|
| Vercel | `git revert 709cead` + push a `main` (~4 min) |
| Function | **No aplica**: no se tocó |
| Migración | **No se revierte**: es aditiva e inerte. Las columnas sobrantes no molestan al código viejo |
| Precios ya reparados | **No se deshacen**: revertir el código no toca los precios que ya se restauraron |

---

## 12 · Pendientes

**De esta tanda no queda ninguno.** Lo que sigue abierto es de antes:

| | |
|---|---|
| 🔴 `PLAN_SYNC_OBSERVACION=1` sigue puesta | La degradación de plan está frenada |
| 🔴 El cron de campañas programadas no existe | Las campañas con `endsAt` nunca se detienen solas |
| 🔴 `/app/plans/confirm` escribe el plan desde la URL sin verificarlo | |
| 🔴 `Section` desmonta a sus hijos en los otros **seis** formularios | `tiersJson` de monto de compra es el más caro |
| 🟡 Decisión: qué recauda un BxGy · `usesPerOrderLimit` · segmentos · `functionId` deprecado | |
| 🟡 Verificar la atribución de los 6 tipos con pedidos reales | Del 06/09, sigue sin hacerse |
| 🔴 Repo GitHub público y secretos sin rotar | De julio |
| | **Lo que viene: DESCUENTO DE ENVÍO** |
