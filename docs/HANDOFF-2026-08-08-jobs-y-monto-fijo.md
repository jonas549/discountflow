# HANDOFF — 2026-08-08 · Arreglos del motor de jobs + escalonados por monto fijo

> Escrito para alguien que no vivió el día. No asume contexto previo.
>
> **Todo está en la rama `dev`. Producción no se tocó en ningún momento.**
> El handoff de ayer, [`HANDOFF-2026-08-07-barra-de-progreso.md`](../HANDOFF-2026-08-07-barra-de-progreso.md),
> explica cómo se construyó el motor de jobs. Este cuenta cómo se arregló y qué se
> añadió encima.

---

## Qué es esta app, en cuatro líneas

DiscountFlow es una app pública de Shopify que aplica descuentos a las tiendas de sus
clientes. Hay cuatro tipos de campaña: **Porcentaje** y **Rango de precio** modifican el
precio real de cada variante vía Admin API; **BxGy** y **Escalonado** usan una Shopify
Function (código compilado a Wasm que corre en la infraestructura de Shopify, en el
checkout). Clientes reales en producción: Greta Baby Kids, NYZA, Vermú Moda y SkinUp.

---

# ═══ 1. ESTADO DEL REPO ═══

| Pieza | Estado |
|---|---|
| Rama de trabajo | **`dev`**, 16 commits por delante de `main` |
| `main` | **`5bcddba`** — sin tocar hoy |
| Producción (Vercel) | **`5bcddba`** — **nada de estos 16 commits está desplegado** |
| Shopify Function en producción | **`discountflow-7` ★ activa** — sin cambios desde el 28/07 |
| Working tree | limpio |
| Migraciones pendientes de aplicar a producción | **2** (ver abajo) |

## Los 16 commits, en orden

Los seis primeros son de **ayer** (7 de agosto), y ya estaban en `dev` al empezar el día:

```
f47b285  feat(jobs): motor de trabajos por lotes con progreso (D1)
91cb704  docs: actualizar el handoff del 28/07 al estado post-despliegue
4313a44  chore(billing): trackear el endpoint interno de pausa por limite de plan
881d712  feat(jobs): operaciones reales con barra de progreso (D2)
53b2299  fix(jobs): interruptor de la barra visible en el listado de campanas
8ccba30  docs: handoff completo de la jornada (barra de progreso D1+D2)
```

Los diez siguientes son de **hoy**:

| Commit | Qué hizo |
|---|---|
| `09625e5` | **El registro del job sobrevive al borrado de su campaña.** La FK pasa de `Cascade` a `SetNull` |
| `fccc0cd` | **La barra entiende que el job terminó y cierra sola.** El 404 deja de tratarse como error de red |
| `aa3a061` | **El precio se calcula en centavos enteros.** Arregla el medio centavo perdido |
| `38e5b3b` | **Los errores de validación se limpian al corregir el campo.** El formulario dejaba de responder |
| `603a236` | **Solo se sellan las unidades que salieron bien.** Las fallidas ya no se dan por hechas |
| `f30065c` | **Documentación del sistema de cobro**, leída del código |
| `fee220f` | **E1** — el cálculo admite niveles en monto fijo |
| `b3c8fa7` | **E2** — la Function entiende los niveles en monto fijo |
| `b8c3700` | **E3** — el formulario permite elegir monto fijo |
| `a268112` | **El campo de monto acepta decimales**, con punto o coma |

## 🔴 Qué commits tocan la Function y cuáles no

Solo **dos** de los dieciséis:

```
fee220f  E1 — toca app/lib/discounts/tiered-calc.ts   ← se compila DENTRO del Wasm
b3c8fa7  E2 — toca extensions/tiered-discount/src/
```

**Los otros catorce son solo Vercel.** Esto gobierna todo el plan de despliegue de
mañana: hay dos operaciones distintas, con orden obligatorio (sección 7).

## Migraciones pendientes de aplicar a producción

```
20260807120000_add_campaign_jobs        (de ayer)  — crea CampaignJob, 3 columnas nuevas
20260808180000_job_survives_campaign    (de hoy)   — la FK pasa a SET NULL
```

Ambas son **aditivas y sin pérdida de datos**. Cero `DROP` de columnas o tablas.

**No hay que aplicarlas a mano.** El `buildCommand` de `vercel.json` es
`npm run setup && npm run build`, y `setup` es `prisma generate && prisma migrate deploy`.
El deploy de Vercel las aplica solo, contra el `DATABASE_URL` de las variables de entorno
de Vercel. Si la migración falla, el build falla y no se publica nada — que es el
comportamiento que queremos.

## Estado del entorno de desarrollo

- Tienda de pruebas: `calendario-envios-test-final.myshopify.com`
- **Plan `PROFESSIONAL`**, puesto hoy con un `UPDATE` directo a la base de `dev` porque
  el plan FREE topa en 50 variantes y no dejaba probar con volumen. Solo afecta a la
  base de dev. **El código del enforcement no se tocó.**
- Flag `jobs:batched` = **`true`** en dev. En producción está apagado y nace apagado
  (fail-closed).
- Base de datos de dev: branch `dev` de Neon (`ep-nameless-credit-ap5b1c49`).
  Producción es `ep-morning-block-aph2jfrg` — si aparece ese host en algún sitio
  mientras trabajás en dev, algo está mal.

---

# ═══ 2. LOS INCIDENTES DE LA MAÑANA ═══

El motor de jobs (la barra de progreso para campañas grandes) se construyó ayer y hoy se
probó por primera vez a mano. Aparecieron tres problemas.

## 2.1 · La barra se quedaba pegada — en 100% y en 0%

**Lo que se veía, caso A:** se eliminaba una campaña, la barra llegaba al 100%, y ahí se
quedaba: el botón «Cancelar» seguía visible y la fila de la lista seguía diciendo
«Activa». Al refrescar el navegador, la campaña estaba efectivamente eliminada.

**Lo que se veía, caso B:** se eliminaba otra campaña y la barra se quedaba clavada en
**0%**, diciendo «Procesando 0 de 7 variantes». Parecía un problema distinto —«este
nunca arrancó»— y no lo era.

### Cómo se diagnosticó

Se consultó la base de datos en vivo mientras el caso B estaba en pantalla. El resultado
fue el que desbloqueó todo: **la tabla `CampaignJob` estaba vacía**. No había ningún job.
Tampoco la campaña.

Después se consultó la Admin API de Shopify para ver los precios reales de esos
productos: **las 7 variantes estaban en su precio original, con el `compareAtPrice`
restaurado**. Es decir, el DELETE había hecho su trabajo completo — revertir precios,
borrar la campaña — y había terminado bien.

### La causa

El modelo tenía esto:

```prisma
model CampaignJob {
  campaign Campaign @relation(..., onDelete: Cascade)
```

Cuando la operación DELETE termina, borra la campaña. **El cascade se llevaba el job por
delante en ese mismo instante.** A partir de ahí:

1. El siguiente sondeo del navegador pide `/api/jobs/:id/status` → el job ya no existe → **404**.
2. El cliente hacía `if (!res.ok) throw`, así que el 404 caía en el `catch` de errores de
   red, que reintentaba **cada 5 segundos para siempre**.
3. La guarda de pintado era `if (error && !data)`: como ya había datos de un sondeo
   anterior, **el componente seguía pintando el último payload bueno que hubiera leído**.
4. `onFinished` no se llamaba nunca, así que la lista no se revalidaba y seguía mostrando
   la campaña como activa.

### Por qué parecía intermitente y era siempre lo mismo

La barra se congelaba **en la última foto que alcanzó a leer antes de que el job
desapareciera**. En un job largo esa foto era del final (100%); en uno corto —7 variantes
tardan segundos— era del principio (0%).

**Cuanto más rápido iba el job, peor se veía.** Los dos casos eran el mismo bug.

## 2.2 · La campaña a toda la tienda que se plantó al 86%

**Lo que se veía:** una campaña de porcentaje al 20% sobre toda la tienda (139 variantes /
65 productos) se quedó clavada en 86% (56 de 65 productos). Al refrescar, la campaña no
existía.

### La pregunta que había que responder primero

Si el proceso había tocado 56 productos y luego se había caído, **¿quedaron precios
rebajados sin campaña que los respaldara?** En producción eso es dinero que se pierde en
silencio.

### Cómo se descartó, con evidencia

Se trajeron de la Admin API las **139 variantes reales** y se cruzaron con la base:

- 29 variantes tenían `compareAtPrice`, y 22 no tenían fila en `CampaignProduct`.
- Pero sus ratios `precio / compareAtPrice` eran dispersos: `0.4396`, `0.5330`, `0.6667`,
  `0.7426`, `0.7691`, `0.8198`, `0.8333`, `0.8569`, `0.8624`, `0.8970`.
- **Ninguna en `0.8000`.**

Un descuento del 20% deja el ratio en **exactamente** 0.8000, igual que la campaña de
prueba del 15% dejó cuatro variantes en exactamente 0.8500. Los 22 eran los
`compareAtPrice` de fábrica del catálogo de demostración.

**Conclusión: no quedó ningún precio huérfano.**

### Lo que NO se pudo determinar

**En qué estado quedó ese job.** La fila ya no existía —el mismo cascade— así que no hay
estado final, ni intentos, ni `lastError`. La hipótesis más consistente es que la campaña
se eliminó desde la interfaz y el cascade se llevó el job, pero **no está confirmado**.

**Este caso sigue sin causa raíz.** Con el arreglo del cascade ya puesto, la próxima vez
que ocurra el rastro va a quedar en la tabla.

## 2.3 · Por qué el cascade era el problema de fondo

El propio schema documentaba que los errores se guardan en base de datos *a propósito*,
porque los Runtime Logs de Vercel Hobby **se retienen solo 1 hora** y un job que falla de
noche no dejaría rastro por la mañana.

El cascade anulaba esa decisión: borraba el registro **justo en el momento en que más
falta hacía**, al terminar la única operación que destruye su propia campaña.

Los dos incidentes de la mañana se quedaron sin diagnóstico completo por eso. Por eso el
arreglo del cascade fue el primero: sin él no se puede diagnosticar nada más.

---

# ═══ 3. LOS ARREGLOS, UNO POR UNO ═══

## 3.1 · El job sobrevive a su campaña (`09625e5`) — toca la BD

**Qué se cambió:** la relación pasa de `onDelete: Cascade` a `onDelete: SetNull`.
`campaignId` pasa a ser nullable, y se añade una columna `campaignName` con el nombre
copiado **al crear el job**.

**Por qué esa solución y no otra:**

| Alternativa | Por qué se descartó |
|---|---|
| Tabla de historial aparte | Duplica escrituras y deja **dos sitios donde buscar el mismo hecho**. Diagnosticando de madrugada, eso es lo último que querés |
| Quitar la FK | Un `campaignId` colgante **no distingue** «la campaña se borró» de un bug que escribió un id inválido. `NULL` sí lo dice |

`campaignName` existe porque sin él un job archivado es un identificador opaco: el
historial diría «pasó algo» sin decir sobre qué.

**Verificado funcionando en la práctica:** al cerrar el día la base de dev tiene
**19 jobs y 0 campañas**. Todos `COMPLETED`, 18 con su nombre conservado. Antes de este
arreglo esa tabla habría estado vacía.

## 3.2 · La barra cierra sola (`fccc0cd`) — solo cliente

Cuatro cambios en `app/components/JobProgress.tsx`:

1. **Un 404 se trata como FIN, no como error.** Se avisa al padre y se deja de sondear.
2. **Tope de reintentos de red** (`MAX_ERROR_RETRIES = 5`, unos 25 segundos). Al agotarlo
   también se avisa, para que la lista deje de mostrar algo que ya no es cierto. Antes
   reintentaba indefinidamente.
3. **Una única salida del sondeo** (la función `finish`), de modo que no hay forma de
   terminar sin avisar al padre. Ese era el fallo estructural.
4. **`onFinished` pasa a un `ref`** y sale de las dependencias del efecto.

### 🟡 Bug latente que apareció solo: el sondeo duplicado

El punto 4 no estaba en la lista. Se encontró al arreglar lo demás.

Los componentes padres definen `onFinished` en línea, así que **cambia de identidad en
cada render**. Al estar en las dependencias del `useEffect`, el sondeo se reiniciaba
solo — y lo hacía justo después de revalidar la lista, que es cuando el padre
re-renderiza. Resultado: **peticiones duplicadas sobre el mismo job**, en el momento de
más carga.

Con el arreglo del cascade puesto, el 404 casi no debería ocurrir: el job sobrevive y el
sondeo lee su estado terminal real. El manejo del 404 queda como red de seguridad.

## 3.3 · Precios en centavos enteros (`aa3a061`) — solo Vercel

**Lo que se veía:** 45,50 con 15% de descuento daba **38,67** en vez de 38,68. El resto de
los precios redondeaba bien.

**La causa, reproducida:**

```
45.50 × 0.85 = 38.675
representación real en float64 = 38.674999999999997158
toFixed(2) → "38.67"
```

En coma flotante el resultado **ya es menor** que 38,675 antes de redondear. `toFixed`
hace lo correcto con el número que recibe; el número es el que está mal.

**Detalle que importa:** `Math.round(x * 100) / 100` **tampoco lo arregla** — hereda el
mismo error de origen. La única salida es aritmética entera.

**Qué se hizo:** todo el cálculo pasa a centavos enteros y solo se convierte a texto al
final. Aplicado a las tres ramas de `priceFor`, así Rango de precio queda igual que
Porcentaje. La aritmética vive en `app/lib/jobs/money.ts`, un módulo puro sin
dependencias, con tests propios.

Los tests incluyen una regresión con los precios reales de la campaña que se usó para
diagnosticarlo, para que el arreglo no mueva los que ya salían bien.

## 3.4 · Los errores de validación se limpian (`38e5b3b`) — solo Vercel

**Lo que se veía:** con el formulario vacío, pulsar «Crear y activar» mostraba los errores
correctos. Al rellenar los campos, el resumen de la derecha se actualizaba pero **los
mensajes rojos seguían ahí** y el formulario parecía trancado. Había que recargar.

**La causa:** los mensajes salían de `actionData`, que React Router conserva hasta el
siguiente envío. **Nada los recalculaba** — no dependían de ningún estado local.

**Qué se hizo:** cada error se oculta en cuanto cambia el campo que lo provocó. Al llegar
una respuesta nueva del servidor se vuelven a mostrar todos: la última palabra sobre si
el formulario es válido la tiene el servidor, no el cliente.

**⚠️ Lo que quedó sin confirmar:** también se reportó que *«el botón ya no avanza»*. Se
descartaron las tres causas mecánicas posibles —el componente `Btn` sí propaga
`type="submit"`, los campos ocultos se derivan del estado en cada render, y el `disabled`
solo depende de `isSubmitting`— y **no hay nada en el código que impida el reenvío**. La
explicación restante es que sí reenvía y el servidor rechaza otra vez, pero **no se pudo
reproducir con la pestaña de red abierta**. Sigue abierto.

## 3.5 · Solo se sellan las unidades que salieron bien (`603a236`) — solo Vercel

Este no lo reportó nadie: apareció leyendo el código durante el diagnóstico.

**El defecto:** en `runPriceUnits`, el sellado (`processedByJobId`) se aplicaba al lote
entero **sin mirar el resultado de cada mutación**:

```js
await Promise.all(units.map(async (unit) => {
  try { await bulkUpdateVariantPrices(...) }
  catch (err) { failures.push(...) }        // se registra el fallo…
}));
await prisma.campaignProduct.updateMany({
  where: { ..., shopifyProductId: { in: productIds } },   // …pero se sella TODO
  data: { processedByJobId: ctx.job.id },
});
```

**Por qué importa:** el sello es el mecanismo de reanudación —`pendingUnits` descarta lo
sellado—, así que una unidad que había fallado quedaba marcada como hecha y **no se
reintentaba nunca dentro del job**, además de contarse como procesada en la barra.

En un APPLY eso deja un producto sin descuento. **En un REVERT deja un producto rebajado
mientras el sistema da por hecho que lo devolvió** — exactamente el sangrado silencioso
que todo el motor existe para evitar.

**Qué se hizo:** se sellan las que fueron bien; las fallidas quedan pendientes para el
siguiente lote. **Con un tope:** si la unidad ya venía fallando de antes, se sella igual.
Sin ese tope, una unidad que falla siempre haría que el job encadenase lotes de forma
indefinida, y agotar la cuota de invocaciones en Vercel Hobby **apaga el servicio hasta
30 días**.

## 3.6 · El campo de monto no aceptaba decimales (`a268112`) — solo Vercel

Reportado en la ronda 4 de QA, ya con la feature de monto fijo terminada.

**Lo que se veía:**

```
tecleado 10.50  →  quedaba 50
tecleado 5.5    →  quedaba 5
tecleado 12.34  →  quedaba 34
tecleado 10, 20, 150  →  entraban limpios
```

**Se confirmó antes de tocar nada**, porque QA lo había detectado con automatización que
teclea rápido y podía ser un artefacto. Se reprodujo simulando la secuencia pulsación a
pulsación y **da los tres números exactos**. No era artefacto: un humano lo sufre igual,
porque el separador nunca llegaba a entrar.

**La causa:** era un `<input type="number">` **controlado**. El DOM sanea el valor de un
input numérico: cuando el contenido pasa a ser `"10."` —inválido, porque está a medio
escribir— **`e.target.value` devuelve cadena vacía**. Entonces `Number("")` es 0, el
estado se resetea, React reescribe el campo a `"0"`, y los dígitos siguientes se acumulan
encima.

**Qué se hizo:** un componente `DecimalInput` con **buffer de texto**. Se guarda tal cual
lo tecleado y el número solo se propaga cuando ya es parseable. El valor externo solo pisa
el buffer si de verdad cambió, porque si no se le borraría la coma en cada pulsación.

El parser acepta **coma y punto indistintamente** (los merchants son de LATAM y España, y
en español se escribe 10,50), tolera el separador a medio escribir y admite `.5` sin el
cero de delante.

**🔴 Dónde vive y por qué:** en `app/lib/decimal-input.ts`, **deliberadamente fuera de
`tiered-calc.ts`**. Ese módulo se compila dentro del Wasm y esto es solo de interfaz.
**Por eso este arreglo no obliga a redesplegar la Function.**

---

# ═══ 4. ESCALONADOS POR MONTO FIJO ═══

Hasta hoy, las campañas escalonadas solo podían descontar un porcentaje por nivel. Ahora
también pueden descontar una cantidad fija de dinero.

## 4.1 · Las tres decisiones de producto

Las tomó Jonas antes de escribir código. Están implementadas tal cual:

### 1. El monto es POR UNIDAD

Ejemplo canónico, que además es un test y una fixture: un producto de **$10** con niveles
**1→\$1, 2→\$2, 3→\$5**, llevando 3 unidades:

- **Incremental:** cada unidad se descuenta según el nivel de su posición → paga **9 + 8 + 5**
- **Uniforme:** se alcanza el mejor nivel y ese monto va a todas → paga **5 + 5 + 5**

### 2. Si el monto supera el precio, ese producto NO descuenta

Nada, sin recorte parcial. Es el mismo criterio que ya usa Rango de precio, que ante un
precio fijo mayor o igual al original se salta la variante entera. **El precio nunca
queda en cero ni en negativo**, y hay un test que barre precios de 0,50 a 5 con un monto
de \$5 para comprobarlo.

En modo uniforme esto se reduce exactamente a «ese producto no descuenta». En incremental
se evalúa unidad a unidad, porque cada una tiene su propio monto y un nivel alto no debe
tumbar el descuento legítimo de las anteriores.

### 3. La campaña entera es de un solo tipo

O todos los niveles en porcentaje, o todos en monto. No se mezclan. Por eso `valueType`
vive en la configuración de la campaña, no en cada nivel.

## 4.2 · El modelo

`valueType: "PERCENT" | "AMOUNT"` es un eje **ortogonal** a `TierMode`:

- **`TierMode`** dice cómo se **reparte** el descuento (a todas las unidades, o según la
  posición de cada una).
- **`valueType`** dice en qué se **mide** (porcentaje o dinero).

Las cuatro combinaciones son válidas.

**Ausente = `PERCENT`.** Esto no es un detalle: es lo que mantiene vivas las campañas
creadas antes de que esto existiera, cuyo metafield no trae el campo.

### El cambio de fondo: `emit`

El resultado del cálculo gana un campo `emit` (`PERCENTAGE` | `FIXED_AMOUNT`), que pasa a
ser **el único discriminador válido**. Desde que un uniforme puede producir importes, el
modo dejó de decir qué hay que emitir. La Function ahora ramifica por `emit`.

| Modo | Unidad | Emite |
|---|---|---|
| Uniforme | Porcentaje | `percentage` |
| Uniforme | Monto | `fixedAmount` |
| Incremental | Porcentaje | `fixedAmount` |
| Incremental | Monto | `fixedAmount` |

**La Function ya sabía emitir importes** — el modo incremental lo hacía desde el
principio. Eso redujo mucho el trabajo del lado del Wasm.

## 4.3 · Las tres etapas

Se hicieron en orden, y **E1 y E2 se cerraron con los tests verdes antes de tocar la
interfaz**, porque si el modelo de datos cambia a mitad, la interfaz se rehace entera.

| Etapa | Commit | Qué entró |
|---|---|---|
| **E1** | `fee220f` | El cálculo puro: tipos, `normalizeTiers`, las dos ramas de cómputo, la validación, la regla del monto que se pasa de precio |
| **E2** | `b3c8fa7` | La Function: la config admite `valueType`, se lo pasa al cálculo, y los candidates ramifican por `emit`. 4 fixtures nuevas |
| **E3** | `b8c3700` | El formulario: selector de unidad, input de monto, preview, resumen, explicador de modos, etiqueta del listado |

## 4.4 · 🔴 La trampa: `tiered-calc.ts` vive en `app/` pero se compila en el Wasm

```ts
// extensions/tiered-discount/src/cart_lines_discounts_generate_run.ts:25
} from '../../../app/lib/discounts/tiered-calc';
```

**El archivo parece código de la app y no lo es.** La Function lo importa, así que
cualquier cambio ahí **obliga a desplegar la Function**, aunque el diff no toque la
carpeta `extensions/`.

Esto ya mordió una vez: el 28 de julio, la feature de «niveles al 0%» se planificó con la
premisa «no toca la Function» y era falsa. El descarte del 0% vivía en `normalizeTiers`,
dentro del Wasm.

**Regla:** antes de decir «esto no toca la Function», comprobar si el cambio roza
`tiered-calc.ts`.

## 4.5 · Retrocompatibilidad — lo que protege a las campañas vivas

Tres capas, todas verificadas:

1. **`valueType` ausente = `PERCENT`** en la Function, en el parseo del formulario, en la
   configuración y al abrir una campaña para editarla.
2. **`normalizeTiers` descarta un nivel al que le falta el campo de su tipo**, igual que
   antes descartaba los que no tenían `percent`. Un nivel al 0 se conserva (es un
   interruptor con significado: «desde aquí, precio normal»), pero un nivel **sin** el
   campo es basura y se va.
3. **`toFunctionConfig` emite `valueType` siempre**, también en las campañas de
   porcentaje. Un metafield explícito no depende de que el lector acierte con el valor por
   defecto — es la misma lección del campo `scope`, que antes se infería de una lista
   vacía y causó un incidente.

### Un fallo que se cazó durante E1, y conviene recordar

La primera versión trataba «nivel sin el campo que le toca» como **un nivel al 0**. Eso
**cambiaba el comportamiento de las campañas existentes** con datos parciales: un nivel
que antes se descartaba pasaba a cortar el descuento de las unidades siguientes. Lo
detectó un test propio antes de llegar a las fixtures.

---

# ═══ 5. LAS PRUEBAS ═══

## 5.1 · Estado actual, todo verde

| Verificación | Resultado |
|---|---|
| `npm test` | **97/97** |
| `npm run typecheck` | **108** — línea base exacta, cero errores nuevos |
| `npm run build` | verde |
| Fixtures contra el Wasm | **16/16** — las **12 originales sin tocar** + 4 nuevas |

**La línea base de `typecheck` es 108 y no debe subir.** Son errores preexistentes
(desajustes de tipos entre `AdminApiContext` y `AdminClient`, y de la sesión de Shopify).
No se enmascaran con `as` porque el repo no lo hace en ningún sitio.

### Comandos exactos

```bash
npm test                                             # 97 tests puros, <1 s
npm run typecheck                                    # debe dar 108
npm run build                                        # y después:
git checkout .vercel/react-router-build-result.json  # el build modifica un archivo trackeado

# Las fixtures contra el Wasm REAL (recompila la Function en local, no despliega nada):
cd extensions/tiered-discount && npm run build && npx vitest run
```

## 5.2 · La condición innegociable

**Las 12 fixtures existentes de la Function tienen que pasar sin tocarlas.** Si una sola
cambia de resultado, hay que parar.

El motivo es concreto: **«Mudrad 2», de SkinUp, es la única campaña escalonada viva en
toda la producción**. Esas fixtures son lo que garantiza que sigue comportándose igual.

Se corrieron **tres veces** hoy: al cerrar E1, al cerrar E2 y al cerrar E3. Verdes las
tres.

## 5.3 · Las rondas de QA

Las pruebas manuales las hizo Jonas con Cowork. **El túnel de desarrollo se cayó tres
veces durante el día**, lo que cortó varias rondas a medias.

> ⚠️ El detalle de las rondas 1 a 3 no está registrado en este documento porque quien lo
> escribe no las presenció. Lo que queda como evidencia es lo que dejaron en la base de
> datos de dev y lo que se reportó por escrito.

**Lo que se puede afirmar leyendo la base de dev al cierre:**

- **19 jobs, todos `COMPLETED`, con 0 errores** entre todos: 7 APPLY, 7 DELETE,
  3 REVERT, 2 REACTIVATE.
- Hay campañas de prueba llamadas `QA R3 Rango 10`, o sea que se llegó al menos a la
  ronda 3 con Rango de precio.
- **Un APPLY de 139 variantes / 65 productos completado al 100% con 0 errores**, y su
  DELETE correspondiente también completo. Es el mismo caso «toda la tienda» que por la
  mañana se plantó al 86%: **con los arreglos puestos corrió de punta a punta**.
- Los 19 jobs tienen `campaignId` nulo y 18 conservan su `campaignName`: el arreglo del
  cascade funcionando. El que no lo tiene es anterior al arreglo.

**Ronda 4 — lo reportado por escrito:**

- Las **4 combinaciones** (porcentaje/monto × uniforme/incremental) **calculan bien**.
- El selector cambia de % a \$ correctamente.
- El reseteo de niveles al cambiar de unidad funciona.
- El caso de monto mayor que el precio da 0, como corresponde.
- **Un solo bug:** el campo de monto no aceptaba decimales → arreglado en `a268112`,
  pendiente de revalidar.

## 5.4 · Lo que quedó sin probar, y por qué

| Qué | Por qué |
|---|---|
| **Regresión de escalonados por porcentaje** | Se cayó el túnel. **Es la prueba más importante que falta** |
| **El checkout con monto fijo** | Imposible sin desplegar la Function. El descuento lo calcula Shopify |
| **El formulario trancado tras error de validación** | Requiere reproducir con la pestaña de red abierta |
| **El campo de monto con decimales, ya arreglado** | El arreglo entró después de la ronda 4 |

---

# ═══ 6. PENDIENTES ═══

## 6.1 · Decidido: el campo de PORCENTAJE tiene el mismo bug del decimal

**Jonas decidió que se arregla.** Sigue siendo un `<input type="number">` controlado, así
que un merchant que quiera un nivel al **12,5 %** se topa exactamente con lo mismo:
tecleando `12,5` le quedaría `5`.

**Son dos líneas**, porque el componente `DecimalInput` ya existe. Solo hay que usarlo en
la rama del porcentaje y añadirle el tope de 99 (el monto no tiene tope; el porcentaje
sí).

**Necesita su propia pasada de QA.** No se hizo hoy por una razón concreta: la ronda 4
acababa de validar las 4 combinaciones, y tocar ese input invalidaba parte de esa
validación.

## 6.2 · La regresión de escalonados por porcentaje nunca se corrió

Se cayó el túnel antes de llegar. **Es la prueba que más falta hace** antes de desplegar,
porque es la que cubre a «Mudrad 2» de SkinUp.

⚠️ **Puede que no exista ninguna campaña escalonada vieja en la base de dev** — al cierre
hay **0 campañas**. Hay que crear una de porcentaje a mano antes de poder probar la
regresión.

Lo que hay que verificar: que una campaña escalonada de porcentaje se cree, se abra para
editar, muestre su preview y su etiqueta en el listado **exactamente igual que antes**.

## 6.3 · El checkout con monto fijo

No se puede probar sin desplegar la Function. Si se quiere probar antes de producción,
hay que desplegarla a la app de **dev** (`shopify.app.dev.toml`), que es una app distinta
con su propio `client_id`.

## 6.4 · Seguridad — arrastrado desde el 24 de julio, sin resolver

- [ ] **El repositorio de GitHub sigue siendo PÚBLICO.** Volver a privado.
- [ ] **`C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt`** sigue existiendo
      con las claves de producción. Moverlo a un gestor de contraseñas y borrarlo.
- [ ] **Rotar:** `SHOPIFY_API_SECRET` de producción, contraseña de Neon, secreto de la app
      de desarrollo.

## 6.5 · Otros

- **D3** — crear campañas BxGy y Escalonadas con barra de progreso. Hoy esas dos solo
  tienen barra en activar/pausar/eliminar; crear sigue por el camino síncrono. Detalle en
  [`docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md`](D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md).
- 🔴 **El cron de campañas programadas no existe.** `vercel.json` declara
  `/api/cron/sync-campaigns` y la ruta no está en `app/routes/`. Devuelve 404 cada
  medianoche. Consecuencia: las campañas con `startsAt` nunca arrancan y **las que tienen
  `endsAt` nunca se detienen** — esta última cuesta dinero de forma continua. El alcance
  en producción sigue **sin medir**; la consulta está en el handoff de ayer.
- **`api.internal.pause-over-limit.tsx`** está trackeado en `dev` desde el commit
  `4313a44`. **El merge a `main` lo desplegaría**, y su POST real nunca se ha ejercitado.
  Revisarlo antes.
- **Vercel Pro** — Hobby limita los cron a una ejecución diaria y tiene tope de
  invocaciones. Ver la sección de arquitectura del handoff de ayer.
- **Documentación desactualizada:** `DECISIONS.md` tiene cuatro afirmaciones que ya no son
  ciertas (dice que `vercel.json` usa `"framework": "remix"` cuando es `"react-router"`;
  da por pendiente el webhook `orders/create` que ya está activo; menciona un cron y un
  «recovery job» que no existen) y no cubre Escalonados, el motor de jobs ni el cobro.

---

# ═══ 7. EL PLAN DE DESPLIEGUE DE MAÑANA ═══

> Procedimiento paso a paso. Está escrito para ejecutarse sin tener que decidir nada
> sobre la marcha.

## 7.0 · Por qué hay dos operaciones y en qué orden

Los 16 commits se reparten en dos superficies independientes:

- **La Shopify Function** (el Wasm que corre en el checkout) — la tocan `fee220f` y `b3c8fa7`.
- **Vercel** (la aplicación web) — la tocan los otros catorce.

### 👉 La Function va PRIMERO. Vercel después.

**El motivo:** hay una ventana de minutos entre las dos operaciones, y hay que elegir en
cuál de los dos estados intermedios pasarla.

| Estado intermedio | Qué pasa |
|---|---|
| **Function nueva + app vieja** | La Function entiende perfectamente el formato viejo. La app todavía no ofrece montos fijos. **Nadie nota nada** |
| **App nueva + Function vieja** | El merchant puede crear una campaña de monto fijo. La Function vieja no encuentra `percent`, descarta todos los niveles y **no descuenta nada**. Campaña activa y muda |

El segundo caso es *fail-closed* —no cobra mal, simplemente no aplica— pero deja al
merchant con una campaña que no funciona y sin saber por qué.

Es **el mismo razonamiento que ya se documentó el 28 de julio**: «app vieja + Function
nueva es la combinación segura».

## 7.1 · ANTES DE ARRANCAR — comprobaciones

```bash
cd C:/Users/Jonas/Desktop/nuevaApp/discountflow

# 1. Rama y estado
git checkout dev
git status                     # tiene que estar LIMPIO
git log --oneline -1           # debe ser a268112

# 2. Todo verde
npm test                       # 97/97
npm run typecheck              # 108, ni uno más
npm run build
git checkout .vercel/react-router-build-result.json

# 3. Las fixtures de la Function — LA CONDICIÓN INNEGOCIABLE
cd extensions/tiered-discount && npm run build && npx vitest run
# 16/16. Si alguna de las 12 originales falla, SE PARA AQUÍ.
cd ../..
```

**Además, antes de tocar nada:**

- [ ] Correr la **regresión de escalonados por porcentaje** en dev (pendiente 6.2).
- [ ] Decidir si entra el arreglo del campo de porcentaje (pendiente 6.1). **Si entra,
      hay que volver a pasar QA antes de desplegar.**
- [ ] Revisar `api.internal.pause-over-limit.tsx`, que se desplegará con el merge.

## 7.2 · OPERACIÓN 1 — La Shopify Function

### ⚠️ La advertencia más importante de este documento

El CLI de Shopify trabaja contra **la configuración activa**. Hay dos:

- `shopify.app.toml` → **la app de PRODUCCIÓN**, la que usan Greta, NYZA, Vermú y SkinUp.
- `shopify.app.dev.toml` → la app de desarrollo.

**Si te quedás en la configuración de producción y después corrés `shopify app dev`, el
CLI puede reescribir las URLs de la app de producción y dejar a los clientes reales
apuntando a un túnel de tu máquina.** Volver a `dev` **inmediatamente** después del
release no es una recomendación: es parte del procedimiento.

### La secuencia

```bash
cd C:/Users/Jonas/Desktop/nuevaApp/discountflow

# 1. Apuntar a PRODUCCIÓN
shopify app config use shopify.app.toml

# 2. Verificar que de verdad cambió, ANTES de desplegar
cat .shopify/project.json          # debe mostrar el client_id de producción:
                                   # cca497b9abcf56c14d019ee24d0260d5

# 3. Construir y subir, SIN publicar todavía
shopify app deploy --no-release --force
# Anotá el número de versión que devuelve. Debería ser discountflow-8.

# 4. Publicar esa versión
shopify app release --version=discountflow-8 --force

# 5. 🔴 VOLVER A DEV INMEDIATAMENTE
shopify app config use dev
cat .shopify/project.json          # confirmá que ya NO es el client_id de producción
```

**Notas:**

- El CLI está autenticado en este entorno (`contacto@appsdeveloperspro.com`) y acepta
  `--force` para saltarse los prompts.
- **El CLI recompila la Function al desplegar**, aunque `[extensions.build] command` esté
  vacío. Verificado el 28/07. No hay riesgo de subir un Wasm viejo.
- `dist/` está en `.gitignore`: el Wasm no viaja en el repositorio, se construye en el
  despliegue.

### Verificar entre las dos operaciones

Con la Function nueva ya viva y la app **todavía vieja**:

1. En el Partner Dashboard, confirmar que **`discountflow-8` figura como la versión
   activa (★)**.
2. 🔴 **Ir a SkinUp y comprobar «Mudrad 2»** — ver sección 7.5. **Esta es la verificación
   que no se puede saltar.**
3. Esperar unos minutos y mirar que no aparezcan errores nuevos.

**Si algo va mal aquí, el rollback es solo de la Function:** volver a publicar
`discountflow-7`. La app ni se enteró.

## 7.3 · OPERACIÓN 2 — Vercel

```bash
git checkout main
git merge --ff-only dev            # tiene que ser fast-forward; si no lo es, PARAR
git push origin main
```

El despliegue se dispara con el push. **El build corre `prisma migrate deploy`
automáticamente** (`buildCommand: "npm run setup && npm run build"`), así que las dos
migraciones pendientes se aplican solas contra la base de producción. Si una falla, el
build falla y no se publica nada.

> **Precedente:** el 24 de julio un push a `main` no disparó el despliegue. **Hay que
> confirmar en el panel de Vercel que el despliegue arrancó y quedó como Production
> Current.**

### Verificar después

1. **En el panel de Vercel:** que el despliegue está `Ready` y es `Production Current`.
2. **Que las migraciones se aplicaron:** en el log del build tiene que aparecer
   `20260807120000_add_campaign_jobs` y `20260808180000_job_survives_campaign`.
3. **Que la app abre** en las tiendas reales y el listado de campañas carga.
4. **Que la barra de progreso NO aparece.** El flag `jobs:batched` nace **apagado**
   (fail-closed), así que todos los clientes siguen por el camino síncrono de siempre.
   **Esto es lo esperado**, y es lo que hace que el despliegue sea seguro: el motor de
   jobs se despliega pero no se activa.
5. **Escalonados por monto fijo** ya está disponible en el formulario. Es una opción
   nueva; no cambia nada de lo existente.

### Cómo encender el motor de jobs, cuando se decida

**No se enciende el mismo día.** Cuando se quiera, y para **una tienda a la vez**:

```sql
UPDATE "Shop" SET features = features || '{"jobs:batched": true}'
WHERE domain = 'la-tienda.myshopify.com';
```

Y para apagarlo:

```sql
UPDATE "Shop" SET features = features - 'jobs:batched'
WHERE domain = 'la-tienda.myshopify.com';
```

El flag gobierna **solo la puerta de entrada**: apagarlo con jobs en vuelo deja que
terminen, en vez de generar los estados a medias que el motor viene a evitar.

## 7.4 · ROLLBACK — al revés

Si hay que volver atrás, el orden se invierte: **Vercel primero, Function después.**

Es la misma lógica. Hay que pasar por *app vieja + Function nueva*, que es la combinación
segura, y nunca por *app nueva + Function vieja*.

```bash
# 1. PRIMERO Vercel — Instant Rollback desde el panel, al deployment de 5bcddba
#    (o por CLI: vercel rollback <url-del-deployment>)

# 2. DESPUÉS la Function
shopify app config use shopify.app.toml
cat .shopify/project.json                                # confirmar producción
shopify app release --version=discountflow-7 --force     # la versión anterior
shopify app config use dev                               # 🔴 volver INMEDIATAMENTE
```

**Sobre las migraciones:** son aditivas, así que **no hace falta revertirlas**. La tabla
`CampaignJob` y las columnas nuevas simplemente quedan sin usar. Revertir la migración
sería más arriesgado que dejarla.

⚠️ **Un residuo del que hay que ser consciente:** si algún merchant llegó a crear una
campaña escalonada de monto fijo antes del rollback, esa campaña queda en la base con una
configuración que la app vieja no entiende. No revienta, pero el listado mostraría
«hasta \$0» y la Function vieja no la aplicaría. Habría que pausarla a mano.

## 7.5 · 🔴 Verificación en producción: Greta y SkinUp

### SkinUp — «Mudrad 2». Esta es la que no se puede saltar

**Es la ÚNICA campaña escalonada viva en toda la producción** (verificado en la auditoría
del 28 de julio: Greta, NYZA y Vermú no tienen escalonados). Todo el riesgo de la Function
está concentrado ahí.

Qué comprobar, en este orden:

1. **En el admin de la app:** que «Mudrad 2» sigue apareciendo **ACTIVA**, con sus niveles
   intactos y su etiqueta en porcentaje (algo como *«3 niveles · hasta N% (uniforme)»*).
   **Si dice «hasta \$0», algo salió mal** — sería señal de que se está leyendo como
   campaña de monto.
2. **En el admin de Shopify de SkinUp:** que el descuento automático sigue existiendo y
   activo.
3. **La prueba de verdad — en la tienda:** agregar al carrito un producto de la colección
   «BRAND Murad» en cantidad suficiente para alcanzar el primer nivel, y **confirmar que
   el descuento se aplica con el mismo importe de siempre**.

> Contexto útil: SkinUp tiene **otra app de descuentos activa** (`Pack 2 Flo`). Si aparece
> un descuento raro, comprobar de cuál de las dos apps viene antes de dar por hecho que es
> nuestro. En julio eso ya provocó un falso positivo que costó una sesión entera.

### Greta Baby Kids

Greta **no tiene campañas escalonadas**, así que la Function no la afecta. Lo que hay que
mirar es que el despliegue de Vercel no haya roto nada:

1. Que la app abre y el listado de campañas carga con sus campañas de porcentaje.
2. Que **la barra de progreso NO aparece** (flag apagado).
3. Que los precios de sus productos con descuento **no cambiaron**.

### En los dos casos, durante 24-48 horas

Vigilar los logs de Vercel buscando excepciones nuevas. Especialmente de `readQueryData`,
que desde el 28/07 lanza en vez de tragarse los fallos: lo que aparezca son **fallos
reales que antes pasaban desapercibidos**, no regresiones.

---

# ═══ 8. LECCIONES DEL DÍA ═══

**Los dos bugs más graves no los reportó nadie.** El sellado que marcaba como hechas las
unidades fallidas y el sondeo duplicado aparecieron leyendo el código mientras se
arreglaba otra cosa. Los dos eran silenciosos.

**Un `catch` que solo reintenta convierte un fallo permanente en un silencio permanente.**
La barra congelada era eso: el 404 se trataba como un error de red pasajero y se
reintentaba para siempre, sin decírselo a nadie.

**Antes de arreglar, confirmar que el bug existe.** El del separador decimal se reprodujo
simulando el tecleo pulsación a pulsación antes de tocar el componente, porque QA lo había
detectado con automatización y podía ser un artefacto. No lo era, y la simulación además
señaló la causa exacta.

**Un borrado en cascada puede destruir justo la evidencia que hace falta.** El modelo
documentaba que los errores se guardan en base de datos porque los logs duran una hora, y
el cascade los borraba precisamente en el caso que más cuesta diagnosticar.

**Los ficheros compartidos entre la app y el Wasm hay que marcarlos.** `tiered-calc.ts`
vive en `app/` y se compila dentro de la Function. Ya provocó una planificación errónea en
julio. Ahora lleva un aviso en grande en su cabecera.
