# ESTADO · última actualización 2026-09-07

> El archivo que hay que leer primero. Dice dónde está todo **hoy**, sin
> reconstruirlo de los handoffs. Si algo de acá contradice a un handoff viejo,
> manda esto.

> 🔴 **Para desplegar a producción: `docs/DESPLIEGUE-A-PRODUCCION.md`.**
> Es el procedimiento canónico —árbol de decisión, los dos caminos, cómo
> verificar sin acceso a Vercel, rollback y trampas—. **Se lee antes de tocar
> nada.** Si un handoff viejo dice otra cosa, gana ese archivo.

---

## Dónde está el código

| | |
|---|---|
| **Producción (Vercel)** | 🟢 **`main` = `709cead`** · **build VERDE y confirmado**: el testigo del manifest se movió (`72c35394` → `c1e6a9a2`) y la sanidad por ruta da 200/410/400/404 |
| App version en Shopify | 🟢 **`discountflow-11`** — 4 Functions + bloque de tema + `[app_proxy]` |
| **Ramas** | `main` = `dev` = **`709cead`**, las dos pusheadas |
| Base de datos | Neon, ramas separadas. 🟢 **Migraciones aplicadas en el build**, incluida `20260907160000_job_skipped_units` |
| Tests de la app | **402** verdes (`npm test` — es `node --test`, **no** vitest) |
| Fixtures contra el Wasm real | **91/91** · tiered 16 · pack 13 · order 16 · **cupón 46** |
| Typecheck | **173** = línea base medida contra `HEAD`, **cero nuevos** · solo `TS2345`, `TS2322`, `TS2367` |
| Build | Verde |

---

## Los 7 tipos de campaña

| Tipo | En producción | En `dev` | Probado en navegador |
|---|---|---|---|
| Porcentaje | ✅ vivo | = | ✅ |
| Rango | ✅ vivo | = | ✅ |
| BxGy | ✅ vivo | = | ✅ |
| Escalonado | ✅ vivo | = **cero diff** | ✅ |
| **Pack armable** | 🟢 **vivo** | = | ✅ escritorio, móvil, carrito, checkout |
| **Monto de compra** | 🟢 **vivo** | = | ✅ |
| **Cupón sobre precio original** | 🟢 **vivo** | = | ✅ **cerrado el 2026-09-06** — ronda completa |

### Cupón — lo verificado en el navegador (2026-09-06)

Cálculo sobre el precio original · alcance por productos · alcance por
colecciones · límite total de usos · uso por cliente · mínimos de compra.
**Todo correcto.**

- Cuando el carrito no califica, el comprador ve el mensaje de Shopify:
  *«válido pero no aplicable, revisá los términos»*. Cuando ya lo usó:
  *«el código ya fue usado»*. **Los dos son claros** — la pregunta que quedó
  abierta el 05/09 está cerrada.
- **Cupón + monto de compra conviven**: en un pedido real se vieron las dos
  líneas identificadas por separado (**−$10,80** el cupón, **−$3,46** el de
  monto).

### 🟢 Cupón — ronda completa aprobada (2026-09-06, cierre)

Probado y funcionando en el navegador: cálculo sobre el precio original ·
alcance por productos · alcance por colección · límite total de usos · uso por
cliente · mínimo de monto · mínimo de cantidad · **método código** · **método
automático** · **el viaje de ida y vuelta entre métodos conservando el código** ·
**exclusión de monto de compra** · **el banner de combinación imposible** ·
pausar · reactivar · eliminar.

**Los tres tipos nuevos están cerrados. Listos para producción.**

### Cómo se llegó ahí — lo que se agregó y arregló durante el día

1. **Exclusión de descuentos por monto de compra** (§ abajo).
2. **Método: código o automático.**
3. **Dos arreglos del 06/09 por la tarde**, reportados por Jonas:
   - 🔴 **El código se perdía al pasar a automático.** Se blanqueaba a propósito
     y era un error de criterio: la config guarda **siempre** lo que el merchant
     escribió, y qué se le manda a Shopify lo decide la mutación (la automática
     no manda `code`, porque ese campo no existe en el input). Además ahora se
     **dice en pantalla** que el código quedó guardado, porque el campo
     desaparece y sin el aviso no hay forma de saberlo.
   - El **pie del panel** decía «cuando el comprador escribe el código» incluso
     con el método en automático. Ahora hay un texto por método.

   Pasos de verificación: **§13.4** del plan de despliegue.
4. **Dos bugs más, reportados el 06/09 y arreglados**, con el estado real de la
   tienda leído para diagnosticarlos (`§13.5` del plan):
   - 🔴 **El listado imprimía `"Toda la tienda"` a mano** para todos los
     cupones. Lo escribí el 05/09, cuando el cupón no tenía alcance; al
     agregarle «A qué aplica» la constante se quedó. **El formulario tenía
     razón, el listado mentía.** Ahora sale de la config
     (`originalPriceProductsLabel`).
   - 🔴 **El cupón automático no aplicaba nunca — y no era un fallo de código.**
     La campaña guardada pedía mínimo **$120** y excluía una campaña de monto
     que descuenta desde **$50**: para aplicar hacía falta carrito ≥120 y <50 a
     la vez. **Ventana vacía, y la app lo guardó sin decir nada.** Ahora hay un
     banner rojo arriba del formulario que lo nombra y dice cómo salir.

---

## 🔴 La matriz de `combinesWith`, que explica todo lo de exclusiones

`combinesWith` es **bilateral**: para que dos descuentos se sumen, **cada uno**
tiene que aceptar la clase del otro. Con que uno diga no, **Shopify descarta al
otro en silencio**.

| Campaña | clase | `orderDiscounts` | `productDiscounts` |
|---|---|---|---|
| **Cupón** | PRODUCT | `true` | `true` |
| **Monto de compra** | ORDER | `false` | **`true`** |
| **Pack** | PRODUCT | **`true`** | `false` |
| **Escalonado** | PRODUCT | `false` | **`false`** |
| **BxGy** | PRODUCT | `false` | **`false`** |

**Lo que se deduce, y está confirmado con pedidos reales:**

| Par | ¿Conviven? | Por qué |
|---|---|---|
| Cupón + **monto de compra** | 🟢 **Sí** | El cupón acepta orden, el monto acepta producto. Visto en un pedido real |
| Pack + monto de compra | 🟢 Sí | Por eso el pack pasó a `orderDiscounts: true` el 05/09 |
| Cupón + **pack** | ❌ No | El pack no acepta descuentos de producto |
| Cupón + **escalonado** | ❌ No | El escalonado no acepta nada |
| Cupón + **BxGy** | ❌ No | Ídem |
| Monto de compra + escalonado / BxGy | ❌ No | Ninguno acepta descuentos de orden |

🔴 **Consecuencia para el producto**: el **único** par que el merchant puede
decidir es **cupón + monto de compra**. Todo lo demás lo resuelve Shopify solo,
eligiendo uno de los dos sin decírselo a nadie. Ofrecer una casilla para
escalonados o BxGy sería una casilla que no hace nada.

⚠️ **Y por lo mismo, la exclusión de packs que el cupón ya traía desde el 05/09
es redundante**: el cupón nunca aplica junto a un pack. Se dejó puesta (es
inofensiva) y está marcada como tal. **Decisión pendiente**: quitarla o dejarla.

---

## Cómo funciona la exclusión por monto de compra (lo nuevo)

El merchant marca, desde el cupón, qué campañas de monto de compra lo anulan.
La Function del cupón **recalcula** si esa campaña está aplicando:

```
subtotal del carrito  >=  umbral más bajo de la campaña excluida  →  el cupón no aplica
```

**Por qué recalcula en vez de mirar qué se aplicó**, que sería más elegante: la
API ofrece `cart.discountApplications` y `cart.lines[].discountAllocations`, con
acceso al metafield de cada descuento aplicado. **Pero no está confirmado que un
descuento generado por otra Function en la misma pasada aparezca ahí.** Si no
apareciera, la casilla del merchant no haría nada y nadie se enteraría — la
familia de fallo que este repo ya pagó cuatro veces.

**Recalcular no tiene esa duda, y no es una aproximación**: se compara contra
`cart.cost.subtotalAmount`, **el mismísimo campo** que lee la Function de monto
de compra para decidir, en el mismo instante y con el mismo valor.

⚠️ **Lo que sí implica**: el umbral viaja como una **foto** en el metafield del
cupón. Si el merchant cambia los niveles de la campaña de monto, **hay que
volver a guardar el cupón**. El formulario lo dice.

---

## Cómo funciona el método código / automático (lo nuevo)

| | Código | Automático |
|---|---|---|
| Mutaciones | `discountCodeApp*` | `discountAutomaticApp*` |
| El comprador | escribe un código | no hace nada |
| **Límite de usos** | 🟢 sí | 🔴 **NO EXISTE** |

🔴 **`DiscountAutomaticAppInput` no tiene `usageLimit` ni
`appliesOncePerCustomer`** — verificado por introspección contra la tienda
(2026-09-06, API 2025-10). No es una decisión de producto: es la API. El
formulario **esconde** esa sección en automático y explica por qué.

🔴 **Cambiar de método en una campaña existente no es una edición: es otro
objeto.** No hay mutación que convierta uno en otro, así que se **borra el viejo
y se crea el nuevo**. El orden es **borrar primero**, a propósito: si se creara
antes, un fallo al borrar dejaría los dos descuentos vivos y el comprador podría
recibir el cupón dos veces.

---

## Decisiones de Jonas vigentes (no revisitar)

1. **Escalonado y BxGy NO SE TOCAN.** Están en producción funcionando.
2. **Nada de avisos automáticos sobre choques entre campañas.** Se descartó.
3. **El merchant resuelve el choque desde la campaña que está creando.**
4. **Se sube TODO**: los tres tipos nuevos **visibles**, sin ocultar tarjetas.
5. Un código por campaña (nada de lotes). Campaña = influencer.
6. La base del cupón es **siempre** el precio comparativo, sin casilla.
7. El umbral del monto de compra se mide sobre el subtotal **ya rebajado**.
8. Los niveles de pack cuentan **productos distintos**, no unidades.

## Las cinco reglas de trabajo

1. Nada listo sin verificarlo en el navegador real.
2. Tiene que poder confirmarse en 5 segundos, sin ejecutar JS, que el archivo
   servido es el que se escribió.
3. El ambiente queda listo para probar, sin comandos pendientes.
4. Se prueba desde la app, no con scripts.
5. Toda campaña nueva sigue el patrón visual de las que ya existen.

Las 4 y 5 tienen mecanismo: `app/components/campaign-forms.test.ts`.

---

## 🟢 Desplegado el 2026-09-06

| Paso | Resultado |
|---|---|
| App version | `discountflow-10` activa (19:05). `discountflow-9` descartada: traía un error de theme-check en el `<img>` del widget |
| `main` | `e7be44d` → **`3d84c3f`** por fast-forward, pusheado |
| Vercel | Build verde y promovido. Tardó ~4 min desde el push |
| **Migraciones** | 🟢 **Aplicadas.** Prueba indirecta pero sólida: el `buildCommand` es `npm run setup && npm run build` y `setup` es `prisma generate && prisma migrate deploy`. Si `migrate` hubiera fallado, la cadena `&&` cortaba, el build fallaba y el deployment no se promovía |

**Cómo se verificó que el código nuevo sirve, sin acceso a Vercel:** por RUTA, no
por assets (los hashes de Vite difieren entre el build local y el de Vercel, así
que un 404 de asset no prueba nada). Las rutas nuevas no existen en `e7be44d`:

```
/app/campaigns                     410  ← existe, pide sesión
/app/campaigns/new/pack            410  ← 🟢 antes 404
/app/campaigns/new/cart-value      410  ← 🟢
/app/campaigns/new/original-price  410  ← 🟢
/apps/discountflow/pack            400  ← 🟢 existe y rechaza la firma: el app_proxy está
/app/ruta-que-no-existe-jamas      404  ← control
```

⚠️ **Sin token de Vercel no se puede ver el estado del build ni promover ni hacer
Instant Rollback.** El sondeo por ruta es el sustituto. Rollback disponible sin
Vercel: `git revert` + push, y para la Function
`shopify app release --version=discountflow-8 --force`.

## 🟢 La ATRIBUCIÓN de los 6 tipos — desplegado 2026-09-06 (`5f78888`)

Jonas encontró que el cupón (#1013, −$26,00) y un BxGy (#1015, −$48,00) daban
**«0 pedidos · USD 0.00 · ROI N/A»** con el pedido pagado y el descuento
identificado en el desglose. El diagnóstico encontró **tres cosas distintas**:

| Tipo | Estado antes | Qué era |
|---|---|---|
| **BxGy** | 🔴 **ROTO desde el día uno** | Bloque escrito, cruce imposible |
| **Cupón** | 🔴 **Nunca construido** | No había bloque |
| **Monto de compra** | 🔴 **Nunca construido** | No había bloque |
| **Pack** | 🟡 Construido, sin verificar | Con 15 tests, jamás un pedido real |
| **Rango** | 🟡 Construido, sin verificar | Comparte camino con Porcentaje |
| **Escalonado** | 🟢 Funcionando | 10 pedidos en SkinUp |

### 🔴 Por qué BxGy no atribuyó nunca, y es una sola línea

El descuento se crea con **`[DiscountFlow] ${nombre}`** (`bxgy.ts`, desde el
commit `cfbe02e` que trajo BxGy). El webhook lo buscaba con
`name: { in: automaticTitles }` — **`campaign.name`, sin el prefijo** (`9ad7798`,
ocho commits después, con el comentario *«y title igual al nombre de la campaña
en DiscountFlow»* al lado). Comparación exacta que **no coincide nunca**: cero
filas, cero errores, cero atribuciones, HTTP 200.

**La distinción que faltaba, y que explica todo el mapa:**

| | Qué publica Shopify como `title` de la aplicación |
|---|---|
| Descuento **nativo** (BxGy) | El **título del objeto descuento** → `[DiscountFlow] X` |
| Descuento de **Function** (escalonado, pack, monto, cupón) | El **`message` que emite la Function** |

El bloque comparaba contra el campo de la familia equivocada. Ahora las dos
puntas usan **`bxgyDiscountTitle()`** y hay test de las dos.

### 🔴 El segundo fallo de BxGy, que estaba escondido detrás del primero

El importe salía de `total_price` y `total_discounts`: **el pedido entero**. Al
arreglar el cruce, una campaña BxGy habría empezado a llevarse el ahorro de los
**otros** descuentos del pedido y a contar como recaudación productos en los que
no participó. **Los dos se arreglan juntos o el arreglo miente.** Ahora el
importe sale de las `discount_allocations`, igual que escalonados.

⚠️ **Consecuencia de producto, para decidir**: `orderAmount` cuenta solo las
líneas que el descuento **tocó**. En un «compra 2 llevá 1 gratis» esas son las
del regalo, así que un BxGy al 100% leerá **ROI 100%**. Es deliberado —nunca
puede atribuir de más—, pero no es lo que el merchant espera leer. Alternativa:
contar también las líneas «compra X», a costa de abrir la puerta a atribuir de
más. **Decisión de Jonas.**

### Cómo se reconoce cada tipo ahora

| Tipo | Señal |
|---|---|
| Porcentaje · Rango | Cruce por **variante** (`CampaignProduct`) — sin tocar |
| Escalonado | Mensaje para descartar + **productos** para elegir — sin tocar |
| Pack | **Marca en la línea** (`_df_pack`) + mensaje para el importe — sin tocar |
| **BxGy** | **Título del objeto**, `[DiscountFlow] <nombre>` |
| **Cupón con código** | **El código**, normalizado. Exacto y único en la tienda: **el camino más fiable de los seis** |
| **Cupón automático** | El **mensaje** de la Function |
| **Monto de compra** | El **mensaje** de la Function |

### 🔴 La regla que gobierna los bloques nuevos: ante la duda, no se atribuye

Dos campañas que reclaman la misma señal → **ninguna atribuye**. Es la decisión
que pidió Jonas para monto de compra (*«mejor un cero honesto que un número
inventado»*) y la misma que ya aplicaba escalonados.

Y hay una **salvaguarda contra contar dos veces el mismo ahorro**: el `message`
lo escribe el merchant, y nada le impide repetirlo entre una campaña de monto y
un cupón automático — una sola aplicación encajaría en los dos bloques.
`senalesReclamadasMasDeUnaVez` marca esas señales y **los dos bloques nuevos se
apartan**. El efecto es de una sola dirección: si un cupón comparte mensaje con
una escalonada, **el que se aparta es el cupón**. Los bloques que ya atribuyen
hoy **no leen esa función siquiera**.

### Que lo que funcionaba no se movió, verificado y no afirmado

| | |
|---|---|
| Bloque 1 (Porcentaje + Rango) | **IDÉNTICO**, byte a byte contra `HEAD` |
| Bloque 3 (Escalonado) | **IDÉNTICO** salvo el `console.log` temporal |
| Bloque 4 (Packs) | **IDÉNTICO**, 77 líneas = 77 líneas |
| Atribuciones ya guardadas | **Intactas**: el `upsert` lleva `update: {}` |

Y hay tests que fijan las cuatro señas que hacen que existan los 902 pedidos de
Greta y los 10 de SkinUp, más el cruce roto de BxGy como regresión.

### Rango y Pack: no había que construir, había que verificar

- **Rango** atribuye si escribe `shopifyVariantId` y `originalPrice` igual que
  Porcentaje. Lo hace, en los **dos** caminos que crean filas (el síncrono y el
  motor de jobs). **Quedó como test**, no como afirmación.
- **Pack** identifica la campaña por la marca de la línea, que es exacta; del
  título solo depende el **importe**. Y la suposición del título no es una
  corazonada: es el mismo mecanismo de escalonados, **confirmado en producción
  con un pedido real desde el 2026-07-25**. Hay test de que las 4 Functions
  emiten el `message` igual.

### El log temporal de julio, fuera

`[tiered-attribution]` estaba marcado como TEMPORAL desde el **2026-07-25** y
llevaba mes y medio escribiendo en **cada pedido de las 6 tiendas**. En su lugar
hay **`[attribution-miss]`**, que guarda silencio en el caso normal y solo habla
cuando un tipo tenía campañas activas y **no pudo atribuir** — justo cuando
alguien va a preguntar por qué el dashboard dice 0.

---

## 🔴 Los DOS MODOS del cupón — desplegado 2026-09-06 (`582498d` + `discountflow-11`)

Se encontró en producción un error de concepto: el cupón `PRODUCCION` al 50%
sobre Gertrude Cardigan ($80 hoy, $108 comparativo) dejó el checkout en **$26**
cuando se esperaba **$54**.

**No era un bug del código.** El cálculo implementaba fielmente el ejemplo del
brief original (*"$100, hoy a $85, cupón del 10% → queda en $75"*), que solo sale
con esa fórmula. El requisito cambió; el código no se había desviado.

### La regla de cada modo

| | Qué hace | $100 con 20% de oferta, hoy $80, cupón 50% |
|---|---|---|
| **REEMPLAZA** | El % se aplica al original y **ése es el precio final** | queda en **$50** |
| **SUMA** | El % del original, **restado del precio de hoy** | queda en **$30** |

En REEMPLAZA, si la oferta que el producto ya tiene es mejor, **gana la oferta y
el cupón no descuenta**. Un cupón del 20% sobre un producto rebajado 26% no hace
nada — el formulario lo advierte en amarillo al elegir ese modo.

### 🔴 Ausente = SUMA, y no es una preferencia

Es como se comportaban **todas** las campañas guardadas antes del cambio.
Cambiarles el dinero en silencio sería inaceptable. Las campañas **nuevas** nacen
en REEMPLAZA —lo decide el formulario, no el cálculo—.

**La prueba de esa compatibilidad**: los 29 tests del cálculo que ya existían
pasan sin tocar ninguno, y **las 36 fixtures previas siguen verdes sin recalcular
una sola**. Si el default hubiera cambiado, se habrían caído todas.

⚠️ Consecuencia visible: una campaña de cupón anterior se abre con **«Se suma a
la oferta»** seleccionado, no con Reemplaza.

### Por qué no se vio en meses de pruebas

**En productos SIN precio comparativo los dos modos dan el mismo número**: la
base es el precio actual y las dos fórmulas coinciden. El producto que se usaba
en las pruebas (Cydney Plaid) tiene `compareAtPrice: null` — verificado contra la
tienda. Solo divergen en productos realmente rebajados, que es justo para lo que
existe este tipo de campaña.

### Lección de proceso

Durante la verificación previa, `tiered-discount` dio **rojo** y estuvo a punto
de reportarse como un problema en la Function de SkinUp. **Era un bug de
medición**: dos `$?` en el mismo `printf`, el segundo dentro de una sustitución
de comando. Corrida aislada: 16/16. Con la captura correcta, las cuatro verdes.
**Capturar el código de salida en una variable inmediatamente después del
comando**, nunca dos `$?` en la misma línea.

---

## 🟢 Los "descuentos fantasma" del 2026-09-06 — fue el ambiente, no el producto

Dos campañas quedaron ACTIVAS y sin poder pausarse: un **cupón** y un **BxGy
«Test Shopify»**, las dos en la tienda de desarrollo. El síntoma era idéntico:
barra en 0%, «N unidades con incidencias», y la campaña sin pausarse.

**La causa es de ambiente, no de producto.** Durante una sesión de QA se tocó el
**panel nativo de descuentos de Shopify** y se crearon cupones enlazados de
alguna forma con las campañas de la app. Al borrar después esos descuentos desde
el panel nativo, las campañas quedaron apuntando a descuentos que ya no existen.

**La prueba de que el producto está sano**: se pausó la campaña BxGy
**«Sensilis» de SkinUp** y funcionó perfecto. Las tiendas de clientes no tienen
el problema porque nadie tocó sus descuentos desde el panel nativo.

### Qué se hizo y qué no

| | |
|---|---|
| 🟢 **Cupón** | El arreglo **está en producción** (`92b7d4e`) y sigue siendo válido: tolera que el descuento no exista al pausar/eliminar, y ya no deja un id colgando si el cambio de método falla |
| 🔴 **BxGy** | **NO se arregló.** Se empezó y se descartó al conocerse la causa. `bxgy.ts` quedó intacto |
| 🟡 **Los otros tres tipos** | Sin tocar |

### ⚠️ Corrección a un diagnóstico anterior

Al diagnosticar el cupón se dijo que lo más probable era que el id colgante
viniera del cambio de método (borrar el viejo y fallar al crear el nuevo), y se
dejó dicho que no se podía reconstruir con los datos disponibles. **Con lo que se
sabe ahora, la explicación buena es la misma que la del BxGy: el borrado desde
el panel nativo.** El arreglo del cupón sigue valiendo —cubre los dos casos— pero
la atribución de la causa estaba equivocada.

### 🟡 Pendiente de baja prioridad: la tolerancia para los demás tipos

Que esta vez haya sido QA no significa que no pueda pasar solo: **un merchant
puede borrar un descuento a mano sin querer desde Shopify → Descuentos**, y ahí
la campaña queda igual de atascada. El propio `deleteHandler` ya lo contempla
(*«El descuento puede haber sido borrado ya desde el admin de Shopify»*); el
camino de **pausar** es el que no lo contempla.

**No es urgente y hoy no afecta a nadie.** Cuando se haga, el diagnóstico ya
está: solo hay que tocar el camino de pausar —el de eliminar ya tolera— y hay
dos formas:

- **Un solo sitio en `revertHandler` (`campaign-ops.ts`)**, que cubre los cinco
  tipos. Porcentaje y Rango quedan fuera *por construcción*: la primera línea de
  `runUnits` es `if (isPriceType(...)) return runPriceUnits(...)`.
- **Cuatro archivos** (`bxgy.ts`, `tiered.ts`, `pack.ts`, `cart-value.ts`),
  replicando la tolerancia del cupón sin tocar nada compartido — a costa de la
  misma lógica en cinco sitios.

🔴 **En cualquiera de las dos, el matcher tiene que ser el texto exacto**
(`discount does not exist`, verificado contra Shopify) y **todo lo demás
relanzarse**. Si se tragara un error que no es ése —red, permisos— la campaña
quedaría marcada como pausada con el descuento **vivo descontando**, que es el
fallo caro y en la dirección contraria.

### Cómo se recupera una campaña ya dañada

**Eliminarla desde la app funciona hoy, sin ningún cambio**: `deleteHandler`
envuelve el borrado en `try/catch` y su `finalize` hace `prisma.campaign.delete`.

---

## Segundo despliegue del 2026-09-06 — `92b7d4e`

**Sin app version**: `discountflow-10` se queda. Se comprobó que `extensions/`
tenía **cero cambios reales** (los dos assets que git marcaba como modificados
daban `+-0`: solo el flip de CRLF del checkout anterior).

| Qué | |
|---|---|
| Arreglos del cupón | Pausar/eliminar toleran que el descuento ya no exista; el cambio de método ya no deja un id colgando |
| Textos de los planes | Los cuatro decían «Porcentaje, Rango de precio, BxGy», y en GRATIS eso era **falso** desde F4 |
| Guard nuevo | `plan-features.test.ts` compara el texto contra `PLAN_LIMITS` con `reglaDeTipo` |

🔴 **Cómo se verificó sin token de Vercel, cuando NO hay rutas nuevas**: el truco
de las rutas (410 vs 404) solo sirve si el deploy agrega superficie. Acá se
capturó el hash del manifest ANTES del push y se sondeó hasta que cambiara:

```
antes:   /assets/manifest-195c089f.js
después: /assets/manifest-971cefce.js   ← ~4 min
```

Es la señal genérica: cualquier build nuevo cambia ese hash.

## Estado del despliegue (plan)

**Plan completo: `docs/PLAN-DESPLIEGUE-2026-09-06.md`.** Vigente.

Ya resuelto y verificado:

- 🟢 **Vercel producción despliega desde `main`.**
- 🟢 **La consulta de FREE con BxGy/Escalonado dio 3 filas, ninguna en FREE** →
  el riesgo de F4 sobre clientes vivos está **cerrado**.
- 🟢 Los scopes son idénticos → **ningún merchant re-autoriza**.
- 🟢 `extensions/tiered-discount/` y `tiered-calc.ts`: **cero diff**.
- 🟢 El despliegue **lo ejecuta Claude**, con la aprobación de Jonas.

Falta antes de subir: commitear, `[app_proxy]` en `shopify.app.toml`, verificar
las variables de Vercel, y **que Jonas pruebe los dos cambios de hoy**.

---

## 🟢 Pausar campañas con productos borrados — DESPLEGADO 2026-09-07 (`709cead`)

**El bloqueo:** un merchant (Greta) borró productos de su catálogo y a partir de
ahí **no pudo pausar sus campañas**. Cada intento terminaba con cientos de
«incidencias» —**310 sobre 2 unidades reales**— y una campaña quedó ACTIVE a
medias.

### Los tres fallos encadenados, y qué hace cada arreglo

| | Antes | Ahora |
|---|---|---|
| **Producto borrado** | `Product does not exist` contaba como incidencia y degradaba el job a `COMPLETED_WITH_ERRORS` | Se **saltea**: no hay precio que revertir. `skippedCount` aparte, el job queda `COMPLETED` y la campaña **se pausa** |
| **Variante borrada** | 🔴 Tumbaba la mutación del producto **entero** y sus variantes vivas **se quedaban rebajadas con la campaña pausada** | Se consulta qué variantes viven y se **reintenta solo con ésas**. Las hermanas sí recuperan su precio |
| **El bucle** | La unidad fallida no se sellaba dentro del lote, `pendingUnits` la devolvía otra vez y el lote **giraba sobre ella hasta agotar los 45 s** | El runner **refresca `ctx.job.errors` tras cada ola** → tope de **2 intentos** por unidad |

🔴 **El contador no medía productos rotos: medía cuántas vueltas cupieron en el
plazo.** De ahí los 310 sobre 2 unidades.

### La salvaguarda, que es la mitad del diseño

**Ante una comprobación que no se puede hacer, NO se saltea.** Si la consulta de
variantes vivas falla (throttling, token, red), la unidad se anota como
**incidencia**, nunca como salteada. Saltear por una lectura fallida dejaría la
campaña pausada con precios rebajados vivos — el fallo caro, en la dirección
contraria. Y el matcher es el **texto exacto** de Shopify (`Product does not
exist` / `Product variant does not exist`), con un test que prohíbe ensancharlo.

### Lo salteado NO es un error, y se ve distinto

`skippedCount` y `skipped` son columnas nuevas (migración **aditiva**
`20260907160000_job_skipped_units`). Solo `errorCount` degrada el estado del job.
El aviso en pantalla va **en gris, no en ámbar**, y distingue el producto
eliminado del producto vivo al que le falta una variante — decirle «producto no
encontrado» de uno que tiene delante en su catálogo lo mandaría a buscar un
problema que no existe.

### Verificación

395 → **402 tests** (`npm test`) · typecheck **173, cero nuevos** · build verde ·
**cero diff** en `extensions/`, los cuatro `*-calc.ts` y el `.toml` de producción
→ **no hizo falta app version**.

**Los 4 casos nuevos de la batería del motor, verdes**, entre ellos el que
originó todo: *la mitad del catálogo borrado, y la campaña se pausa igual*.

🟢 **No-regresión: 10/10, exit 0.** Los **siete** tests de precios que ya existían
pasan **sin tocar ninguno**, con el catálogo de 1.000 productos: APPLY real,
APPLY interrumpido, cuota de plan, REVERT, cancelar con compensación, tolerancia
a fallos y DELETE, más el invariante de cerrojos.

⚠️ **Lección de medición, la cuarta de esta familia**: la primera corrida de la
batería estuvo **20 minutos sin mostrar una sola línea** porque se lanzó con
`| grep | head -40`, y **`head` no puede flushear**: no entrega nada hasta
acumular N líneas o hasta que el proceso muere. No se podía distinguir «va por el
test 3» de «está trabada». Va con los dos `$?` en el mismo `printf` y con el
testigo ciego del deploy server-only: **el instrumento roto, no el producto.**
Para ver progreso en vivo: salida a un log y `tail -f | grep --line-buffered`,
nunca `head` en la cadena.

---

## Pendientes vivos, por orden de lo que cuesta

| | |
|---|---|
| 🔴 **Confirmar que Vercel sirve `5f78888`** | Un dato concreto: token de Vercel válido, o que Jonas mire **Vercel → Deployments**. Si la verificación funcional falla en el primer paso, **descartar el build antes que el código** |
| 🔴 **Que Jonas verifique la atribución con pedidos reales** | Los 6 tipos. Es lo único que no se puede probar en dev: el webhook `orders/create` no está suscrito en la app Dev. Pasos en el handoff del 2026-09-06 |
| 🟡 **Decisión: qué recauda un BxGy** | Hoy `orderAmount` cuenta solo las líneas que el descuento tocó → un BxGy al 100% lee ROI 100%. Conservador a propósito. Contar las líneas «compra X» sería más útil y abre la puerta a atribuir de más |
| 🔴 **`PLAN_SYNC_OBSERVACION=1` sigue puesta** | La degradación de plan está frenada. **No tocarla en la ventana del despliegue**: con F4, quitarla haría que las tiendas que Shopify tiene en `free` pierdan editar/reactivar sus BxGy |
| 🔴 **El cron de campañas programadas no existe** | `vercel.json` lo declara y la ruta no está: las campañas con `endsAt` **nunca se detienen solas** |
| 🔴 `/app/plans/confirm` escribe el plan desde la URL sin verificarlo | Cualquier merchant podría subirse de plan gratis |
| 🔴 **`Section` desmonta a sus hijos al plegarse** | Arreglado **solo en el cupón**. En los otros **seis** formularios, plegar una sección borra sus campos en silencio. `tiersJson` de monto de compra es el más caro. §5-BIS del plan |
| 🟡 **Tolerancia al descuento borrado a mano, en los tipos que no son el cupón** | Baja prioridad. Hoy no afecta a nadie: el caso del 06/09 fue una sesión de QA sobre el panel nativo, no uso normal. Pero un merchant puede borrar un descuento sin querer y la campaña queda sin poder pausarse. Solo hay que tocar el camino de **pausar**; el de eliminar ya tolera |
| 🟡 **BxGy tiene `usesPerOrderLimit` sin usar** | Un «compra 2 llevá 1» puede aplicar **10 veces en un pedido** |
| 🟡 Segmentos de clientes | Se puede con `context`, pero `segments` da `ACCESS_DENIED`: hace falta `read_customers` → **re-autorización de todos los merchants** + PCD |
| 🟡 **Exclusión espejo: desde MONTO DE COMPRA excluir un cupón** | **Evaluada, no construida.** 🟢 Se puede para cupones de **CÓDIGO** vía `input.enteredDiscountCodes` (la raíz del input, sin `@restrictTarget`; Shopify ya los valida activos y elegibles para el carrito) — mejor mecanismo que la dirección que existe, porque no depende del orden de evaluación. 🔴 **Para cupones AUTOMÁTICOS no se puede**: no hay código que observar, y recalcular abre una circularidad. ⚠️ Si el merchant marca las **dos** direcciones, **no aplica ninguno** (cada uno se aparta por su propia regla) → hace falta un guard que avise del espejo. Decisión de Jonas pendiente: opción A (código escrito = excluido, simple, sobre-suprime si el cupón dio $0) vs B (además recalcular alcance y mínimos, más preciso, reabre la circularidad). Recomendada: **A** |
| 🟡 La exclusión de packs del cupón es redundante | Ver la matriz. Quitarla o dejarla |
| 🟡 `functionId` está deprecado | 4 tipos en `dev`, **1 en producción** (escalonado). Sin fecha de retirada; sigue en `unstable`. Va junto al salto de versión de API |
| 🟡 Analítica por cupón | Recomendación dada, sin construir. Y con el método automático **no hay código que cruzar**: habría que atribuir por título |
| 🟡 Atribución de los tres tipos nuevos | Escrita para packs; **solo verificable en producción** (Protected Customer Data) |
| Repo GitHub público y secretos sin rotar | De antes |
| **D3** | Crear BxGy y Escalonado sin barra de progreso |

## Lo que viene después del despliegue

**DESCUENTO DE ENVÍO**, con la fase 0 sin cerrar. Cabe dentro de
`extensions/order-discount` porque usa otro target.

---

## Handoffs, por si hace falta el detalle

| Fecha | Documento |
|---|---|
| **siempre** | 🔴 **`DESPLIEGUE-A-PRODUCCION.md`** — el procedimiento canónico, sin fecha |
| 2026-09-06 | **`HANDOFF-2026-09-06-atribucion.md`** (el último del día) · `HANDOFF-2026-09-06-despliegue-a-produccion.md` · `PLAN-DESPLIEGUE-2026-09-06.md` · `HANDOFF-2026-09-06-cupon-completo.md` |
| 2026-09-05 | `HANDOFF-2026-09-05-tres-tipos-de-campana.md` · `HANDOFF-2026-09-05-packs-F1-F2-F3.md` |
| 2026-09-01 | `HANDOFF-2026-09-01-caso-116943.md` |
| 2026-08-09 | `HANDOFF-2026-08-09-despliegue-produccion.md` |
| 2026-08-08 | `HANDOFF-2026-08-08-jobs-y-monto-fijo.md` · `SISTEMA-DE-COBRO.md` |
