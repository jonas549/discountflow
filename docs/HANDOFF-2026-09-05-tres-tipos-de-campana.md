# Traspaso · 2026-09-05 · Tres tipos de campaña nuevos

Sesión larga. Salieron tres tipos de campaña, dos de ellos probados en la tienda
por Jonas y uno pendiente de que los pruebe. Este documento está escrito para que
alguien que no estuvo hoy pueda seguir mañana sin preguntar nada.

---

## 1 · Estado del código

| | |
|---|---|
| Rama | `dev` |
| Último commit | **`c3c2ae9`** |
| `main` | **`e7be44d`** — intacto. No se hizo ni un push, ni un deploy, ni una escritura a la base de producción |
| Producción | **Sin tocar.** Sigue en `e7be44d` + Function `discountflow-8` |
| Tests | **297**, todos verdes (`npm test`) |
| Typecheck | **170 errores** — ver abajo, es la línea base tolerada |
| Build | Verde |
| Widget de packs | **build 12** |

### Sobre los 170 errores de typecheck

No son regresiones. El repo arrastra desde antes tres familias de desajuste que
nadie enmascaró con `as`, a propósito:

1. `AdminApiContext` no encaja en `AdminClient` — en cada ruta que llama a una
   operación de descuento.
2. `session.accessToken` es `string | undefined` y `getOrCreateShop` pide
   `string`.
3. Prisma rechaza `Record<string, unknown>` donde quiere `InputJsonValue`.
4. En las Functions, el valor del descuento se emite como **número** y el tipo
   generado lo declara `string` (el escalar `Decimal`). **Es deliberado**: las
   fixtures contra el Wasm real verifican que el número es lo correcto. Si
   alguien lo "arregla" con `as string`, las fixtures se caen.

La línea base era 132 al empezar el día. Cada tipo nuevo suma errores de las
mismas cuatro familias porque añade rutas y una Function. **Si aparece un código
de error distinto de `TS2345`, `TS2322` o `TS2367`, eso sí es nuevo y hay que
mirarlo.**

### Qué se tocó

- **Cuatro extensiones de Function** (antes dos): `tiered-discount`,
  `pack-discount`, `order-discount` (valor de carrito) y `code-original-price`
  (cupón). Cada una aislada: una extensión exporta un handler por target, y
  mezclarlas haría que un fallo de un tipo pudiera romper otro en una tienda viva.
- **`extensions/pack-widget`**: bloque de tema del armador de packs.
- **Dos migraciones aditivas** al enum `CampaignType`: `CART_VALUE` y
  `CODE_ORIGINAL_PRICE`. Las dos aplicadas a la base de **dev**. No tocan filas.
- **Módulos de cálculo puros** en `app/lib/discounts/`: `pack-calc.ts`,
  `cart-value-calc.ts`, `original-price-calc.ts`. 🔴 **Los tres se compilan
  DENTRO del Wasm**: tocarlos obliga a desplegar la Function correspondiente.

---

## 2 · Los tres tipos

### 2.1 · PACKS — cerrado y probado de punta a punta

El comprador arma un pack eligiendo de una lista curada por el merchant, y ve el
descuento crecer en vivo.

**Probado por Jonas en la tienda de dev**, escritorio y móvil, incluido el
carrito y el checkout.

**Qué lo compone**

- `extensions/pack-discount` — la Function. 13 fixtures.
- `extensions/pack-widget` — el bloque de tema, con dos bloques: el armador y el
  aviso del carrito.
- `app/lib/discounts/pack-calc.ts` — el cálculo, compartido por el admin, la
  Function y el widget.
- Admin completo: crear, editar, activar, pausar, borrar.

**El widget se pinta ENTERO en el servidor.** No hay estado de carga. Los datos
salen de dos sitios, repartidos según cuánto duele que envejezcan:

| Dato | De dónde | Por qué |
|---|---|---|
| Qué pack, qué productos, qué niveles | Metafield de la app, leído con `app.metafields` en Liquid | Cambia solo cuando el merchant edita |
| **Precio, título, foto, variante** | `all_products[handle]`, resuelto en cada renderizado | 🔴 Hay reportes de que Shopify cachea los metafields de app en Liquid **durante horas**. Un precio viejo sería visible y vergonzoso |
| Qué hay ya en el carrito | `cart.items` en Liquid, revalidado contra `/cart.js` en segundo plano | El tema puede servir la página desde una caché con un carrito viejo |

El metafield lo reescribe la app entera —no incremental— en los cinco momentos
en que una campaña de pack cambia (crear, editar, activar, pausar, borrar), por
los dos caminos: las rutas del admin y el motor de jobs. **Nunca lanza**: si
Shopify rechaza la escritura, el widget cae al app proxy y sigue funcionando.

🔴 **El catálogo topa en 20 productos**, y el número no es estético: es el límite
duro de `all_products` en Liquid, que solo resuelve 20 handles **por página**. Si
el tema del merchant ya usa `all_products` en otra sección, el cupo se comparte;
el bloque cuenta cuántos resolvió, lo marca con `data-df-incompleto` y el JS lo
repara contra el proxy sin mostrar ningún estado de carga.

`MAX_PACK_CATALOG` se mudó de `pack-calc.ts` a `pack-validate.ts` para que ese
tope deje de vivir en un archivo que se compila dentro del Wasm. **Verificado
midiendo**: `dist/function.js` es byte a byte el mismo antes y después. (El
`.wasm` cambia en cada build aunque no toques nada — se comprobó con una
compilación de control antes de sacar conclusiones.)

**Qué falta**: la atribución de pedidos. No es que no esté escrita — está, con 15
tests contra el pedido real de Jonas. Es que **no se puede ejercitar en dev**.
Ver §6.

---

### 2.2 · VALOR DE CARRITO — cerrado y probado

"Gastá $100 y ahorrás $10". Descuento de clase **ORDER**, el primero de la app.

**Probado por Jonas**, incluida la convivencia con una campaña de packs.

**Qué lo compone**

- `extensions/order-discount` — la Function. **16 fixtures**, cuatro de ellas de
  la exclusión entre campañas; una reproduce el carrito exacto que falló.
- `app/lib/discounts/cart-value-calc.ts` — el cálculo, 19 tests.
- Admin completo, con el patrón visual de las demás.

**La exclusión entre campañas funciona y es la pieza importante.** Nació de un
fallo medido, no de una precaución: ver §4.6.

Cómo funciona: los descuentos declaran que **sí** pueden convivir —para que
Shopify no descarte nada por su cuenta— y **quién gana lo decide el merchant**,
con casillas en el formulario. La Function lo evalúa antes de calcular nada y
registra `motivo=excluido-por-campana`. Sin marcar, se suman.

⚠️ **Solo se pueden excluir PACKS**, y es una limitación real, no una etapa: una
línea del carrito solo lleva marca de campaña si la puso el widget de packs
(`_df_pack`). Los escalonados, BxGy, porcentaje y rango no marcan nada, así que
desde dentro de la Function no hay forma de saber si están aplicando.

🔴 **Y hay una consecuencia que sigue abierta**: los escalonados y los BxGy se
crean con `combinesWith.orderDiscounts: false`, así que **anulan el descuento por
monto igual que lo hacía el pack**. Cambiarlo toca código que sirve a clientes
que pagan, y ese `false` también bloquea descuentos de orden de **otras apps**:
es una decisión de producto, no una corrección, y **queda pendiente de Jonas**.
Mientras tanto el formulario **lista esas campañas y avisa en amarillo** que
anulan el descuento. Que no se pierda nada en silencio es la mitad del requisito,
y esa mitad está.

---

### 2.3 · CUPÓN SOBRE PRECIO ORIGINAL — entregado, pendiente de prueba

El caso real: SkinUp y otros merchants le dan un cupón a cada influencer. Si el
producto ya está rebajado, Shopify calcula el cupón sobre el precio rebajado y el
merchant regala dos veces.

```
Producto $100, hoy a $85.  Cupón del 10%.
Shopify:  10% de $85  = $8,50  →  queda en $76,50
Queremos: 10% de $100 = $10    →  queda en $75
```

**Entregado completo — tarjeta, formulario, listado, planes, activación — y NO
probado todavía por Jonas.** Es lo primero que hay que hacer mañana; los pasos
están en §8.

**Cómo se consigue**: no emitiendo un porcentaje. Se emite un **monto fijo por
unidad**, calculado por nosotros sobre el precio original, con
`appliesToEachItem: true` para que sea por unidad y no una vez por línea. Shopify
lo resta del precio actual.

**De dónde sale el precio original**: de `cost.compareAtAmountPerQuantity`, que el
schema documenta como *"el precio compareAt de una unidad antes de cualquier
descuento"*.

🔴 **Esto corrigió el diagnóstico inicial.** Se había propuesto guardar el precio
original en un metafield al aplicar una campaña nuestra. **No hace falta**:
`percentage.ts` y `range.ts` **ya escriben `compareAtPrice = precio original`** al
aplicar. El caso "el descuento es nuestro" y el caso "rebaja manual con
comparativo" se resuelven **por el mismo campo**. Un camino menos que mantener.

**Los cuatro casos, con honestidad:**

| Caso | ¿De dónde sale el original? | ¿Se puede? |
|---|---|---|
| Campaña nuestra (Porcentaje / Rango, que editan el precio) | `compareAtAmountPerQuantity` — lo escribimos nosotros | 🟢 Sí |
| Rebaja manual con precio comparativo | `compareAtAmountPerQuantity` — lo escribió el merchant | 🟢 Sí |
| Descuento automático de Shopify u otra app | **No hace falta**: esos no bajan el precio, aplican una asignación encima. `amountPerQuantity` ya ES el original | 🟢 Sí, gratis |
| Precio editado a mano, **sin** comparativo | Ningún lado | 🔴 Imposible — y Jonas decidió que no hay que protegerlo (§3.6) |

**Qué lo compone**

- `extensions/code-original-price` — la Function. **14 fixtures**, incluida la del
  caso del brief.
- `app/lib/discounts/original-price-calc.ts` — el cálculo, 17 tests.
- Admin completo.

🔴 **Es el primer descuento de CÓDIGO de la app.** Los otros cuatro tipos usan
`discountAutomaticApp*`; éste usa `discountCodeApp*`, que es otra familia de
mutaciones. Los nombres se parecen lo suficiente como para copiar el equivocado —
el resultado sería un descuento que aplica solo sin que nadie escriba nada— así
que hay un test que lo prohíbe.

**Qué falta**: que Jonas lo pruebe (§8), y la analítica por cupón (§7).

---

## 3 · Decisiones de producto de Jonas

Están acá con el razonamiento porque el razonamiento es lo que permite decidir
bien el próximo caso parecido.

### 3.1 · Packs — las cinco de la fase 0

1. **Un pack por carrito.** Antes de agregar, el widget quita las líneas de un
   pack anterior. Sin esto, armar el pack dos veces dejaría dos packs
   superpuestos y el total dejaría de coincidir con lo que el comprador vio.
2. **Mínimo de 2 productos distintos.** Un "pack" de un solo producto no es un
   pack.
3. **Los niveles cuentan PRODUCTOS DISTINTOS, no unidades.** Si contara unidades
   sería un escalonado, y ese tipo ya existe. Dos unidades del mismo producto no
   alcanzan el nivel de 2 productos.
4. **Por encima del último nivel, el descuento se mantiene.** No hay nivel que
   "se pase".
5. **Un producto al 0% entra al pack pero no rebaja.** El 0% es un interruptor
   con significado y se conserva en la normalización.

### 3.2 · Modo A de packs, oculto

`PER_PRODUCT` (cada producto con su propio %) **se retiró de la interfaz y el
código NO se borró**. La razón es de producto: si cada producto lleva su
descuento fijo, el comprador elige los dos de mayor porcentaje y arma el pack con
esos. No incentiva combinar nada, y ese caso ya lo cubre una campaña de
Porcentaje normal.

Sigue funcionando todo: el cálculo, la Function, el widget y las fixtures. Las
campañas ya guardadas en ese modo se abren y se editan igual — el formulario
detecta que su modo no está en la lista ofrecida y vuelve a mostrar el selector
solo para ellas. **Para reactivarlo: añadir `"PER_PRODUCT"` a
`PACK_MODOS_OFRECIDOS`. Es la única línea.**

### 3.3 · Valor de carrito: el umbral se mide sobre el subtotal YA REBAJADO

Opción B. Un carrito de $278 al que un pack le aplicó 30% queda en $194,60, y es
**$194,60** lo que se compara contra los umbrales.

Se eligió así porque es lo que el comprador ve y lo que Shopify entrega en
`cart.cost.subtotalAmount` ("antes de impuestos y de descuentos **a nivel de
carrito**", o sea con los de producto ya dentro). El formulario **lo dice
explícitamente junto al campo donde el merchant escribe el número**, que es donde
la diferencia le cambia la cuenta.

### 3.4 · Valor de carrito: porcentaje y monto fijo, los dos

El monto fijo se recorta para no superar el subtotal.

### 3.5 · La base del cupón: SIEMPRE el precio comparativo

Sin casilla, sin opciones. Producto de $100 con 50% de descuento: comparativo
$100, precio actual $50, el cupón se aplica sobre los $100.

Se le planteó a Jonas el riesgo del merchant que usa el compare-at como **MSRP
permanente** (producto a $100 con comparativo $120 que nunca se vendió a $120):
ahí un cupón del 10% daría $12 en vez de $10. **Decidió no complicarlo con una
casilla. Si aparece un caso real, se resuelve entonces.**

### 3.6 · El caso del precio editado a mano sin comparativo: no existe

Si el merchant no pone precio comparativo, el producto no tiene descuento
visible — es simplemente su precio. No hay nada de qué proteger. El cupón cae al
comportamiento normal de Shopify sobre el precio actual.

Se evaluó y **se descartó** un camino de "foto diaria de precios": una foto no
distingue "esto está en oferta" de "el merchant bajó el precio para siempre", así
que el cupón seguiría descontando desde un precio que ya no existe.

### 3.7 · Un código por campaña

Nada de lotes de códigos (`discountRedeemCodeBulkAdd` queda fuera). El
razonamiento de Jonas: si el merchant quiere medir a cada influencer por
separado, **crea una campaña por influencer**.

🟢 Y eso resuelve la analítica sola: la fila por campaña que ya existe **es** la
fila por cupón. Sin modelo nuevo, sin pantalla nueva, sin filtro nuevo.

### 3.8 · La tabla de planes por tipo

| Tipo | FREE | LITE | ESSENTIAL | PROFESSIONAL |
|---|---|---|---|---|
| BxGy | — | 4 | 10 | sin tope |
| Escalonado | — | 2 | 10 | sin tope |
| Pack | — | — | sin tope | sin tope |
| Monto de compra | — | 2 | sin tope | sin tope |
| Cupón precio original | — | — | sin tope | sin tope |

"Sin tope" = sin sublímite propio; lo acota el tope general de campañas activas
del plan.

⚠️ **La fila de «Monto de compra» es un SUPUESTO**, no una decisión de Jonas. Está
marcado como tal en `plan-limits.ts`. Se eligió LITE con tope 2 por ser el tipo
más simple de los de pago y el mejor gancho para salir de FREE. **Si Jonas dice
otra cosa, se cambia un renglón ahí y otro en `plan-limits.test.ts`: no hay un
tercer sitio.**

La tabla decidida vive **escrita aparte del código**, en `plan-limits.test.ts`,
para que no puedan divergir en silencio.

---

## 4 · Hallazgos técnicos que costaron tiempo

Están acá para que no se repitan. Cada uno tiene un test que lo sostiene.

### 4.1 · 🔴 El asset cacheado — tres rondas perdidas

**Síntoma**: el widget de packs se quedaba en «Cargando tu pack…». Sin error, sin
petición de red, sin línea en consola. Cada vez se encontró una causa distinta,
cada arreglo se verificó, y volvía a pasar.

**Causa de fondo**: el NOMBRE del archivo. `pack-builder.js` produce siempre la
misma URL de CDN. Dentro de una sesión de `shopify app dev` el contenido cambia
pero la URL no, así que el CDN seguía sirviendo la copia vieja — y un
`Ctrl+Shift+R` no alcanza a la copia del CDN. De ahí que funcionara unas veces sí
y otras no, sin patrón.

**Arreglo estructural**: el número de build va en el **nombre** (`pack-12.js`).
Cada versión es una URL distinta y no hay nada que cachear. Y si el tema sirviera
un Liquid viejo apuntando a un archivo que ya no existe, el navegador da un **404
visible** en vez de silencio.

**La lección que Jonas señaló, y que era la mitad del problema**: *el diagnóstico
vivía dentro del archivo que no llegaba*. Ahora el build y la URL del asset salen
en un **comentario HTML** que renderiza el servidor y se lee con **Ctrl+U**, sin
ejecutar nada.

`pack-widget-build.test.ts` comprueba nueve invariantes, entre ellas que el
archivo que el Liquid pide **exista** en `assets/`, que el nombre lleve el build,
que no quede ningún build viejo, y que `assets/` contenga **solo** lo generado
(las fuentes viven en `scripts/pack-widget-src/`).

### 4.2 · El parcheo de `fetch` que rompía el `fetch` de toda la página

`fetchOriginal.apply(this, arguments)` dentro de un IIFE en modo estricto:
`this === undefined`, y `window.fetch` es una operación WebIDL con comprobación de
receptor → **`TypeError: Illegal invocation` para cada `fetch()` de la página**,
no solo los nuestros.

Node lo toleraba, así que la primera comprobación no podía fallar. Se arregló con
`fetchNativo.bind(window)`, try/catch alrededor de todo, y parcheando solo cuando
existe el nodo del aviso. Verificado con un shim de `window` que **impone** la
comprobación de receptor.

### 4.3 · El fallo de Shopify con dos bloques

Con varios bloques de una misma theme app extension activos, **los assets del
segundo en adelante pueden no servirse**. Por eso los dos bloques del widget
(`pack-builder` y `pack-notice`) piden **exactamente el mismo conjunto de
assets**, y los tres JS se concatenan en **uno solo**. Hay un test que lo exige.
**No separarlos.**

### 4.4 · 🔴 `position: fixed` anulado por el `transform` del tema

**Síntoma**: en el móvil de la tienda no aparecía **ningún** botón de agregar al
carrito. Había que scrollear entre las tarjetas y no había forma de comprar.

**Causa**: un elemento `fixed` deja de medirse contra la ventana en cuanto **un
antepasado** tiene `transform`, `filter`, `perspective`, `contain` o
`will-change` — y los temas OS 2.0 ponen `transform` en las secciones para sus
animaciones de scroll (en Dawn, `.scroll-trigger.animate--*`). El "fijo" se
anclaba a la sección, que mide miles de píxeles, y quedaba en su fondo: existía y
no se veía nunca. **No se puede arreglar desde nuestro CSS: el antepasado es del
merchant.**

**Arreglo**: `position: sticky`, que se mide contra el contenedor de scroll. Y de
paso hace exactamente lo que se pidió sin una línea de JavaScript: la barra flota
al pie mientras el widget siga abriéndose debajo y se va con la sección al llegar
al final. Su modo de fallo también es mejor: si algo impide que se pegue, el
botón **queda visible en su sitio**; `fixed` fallaba desapareciendo.

Un test prohíbe `position: fixed` en toda la hoja del widget.

**Antes de ése hubo otro con el mismo apellido**: la regla de escritorio dejaba
`top: 1em` y la móvil ponía `position: fixed; bottom: 0` sin anularlo. Un
elemento posicionado con `top` **y** `bottom` no se coloca: se **estira**. El
panel ocupaba la pantalla entera, en blanco, tapando las tarjetas.

### 4.5 · 🔴 `align-items` significa un eje distinto en grid que en flex-column

**Síntoma**: en móvil, con el pack vacío la barra del pie llegaba a los bordes de
la pantalla; al elegir dos productos **se encogía** y quedaba flotando con
márgenes.

**Causa**: `align-items` alinea en el **eje transversal**, y ese eje cambia con el
modo de disposición.

- En la rejilla del escritorio el eje transversal es el **vertical**, y ahí
  `align-items: start` es lo que impide que la columna derecha se estire hasta el
  largo de la lista de productos.
- La media query del móvil cambiaba `display` a flex en columna **pero no tocaba
  `align-items`**. El mismo `start` seguía aplicando y pasaba a gobernar el eje
  **horizontal**: cada hijo se encogía al ancho de su contenido.

Por eso el ancho dependía del texto: "Agregá 2 productos más…" es largo y llenaba
el ancho; "Ahorrás $X" es corto y la barra se encogía con él. Las tarjetas tenían
el mismo problema, invisible solo porque los nombres de producto son largos.

**Arreglo**: reponer `align-items: stretch` en la regla móvil. Es el valor por
defecto de flex y hay que escribirlo porque viene heredado otro. Con test.

### 4.6 · 🔴 `combinesWith` es BILATERAL

**Síntoma**: carrito con un pack de 4 productos, $278 de lista. El pack aplicó su
30% y dejó el carrito en $194,60. El descuento por monto de compra, que a $194,60
tenía que dar $25, **no apareció**. Ni en el carrito, ni en un log, ni en ningún
lado.

**Causa**, leída de la propia tienda y no inferida:

```
[DiscountFlow] Pack prueba          PRODUCT  order:false  product:false
[DiscountFlow · PRUEBA F1] ...      ORDER    order:false  product:true
```

Los **dos** descuentos tienen que decir que sí. Con que uno diga que no, Shopify
descarta al otro — y no se lo dice a nadie.

**Y la revisión de la recomendación anterior**, que importa para decidir bien el
próximo caso: se había dicho que alcanzaba con una casilla de `combinesWith`. No
alcanza. La casilla solo ofrece dos comportamientos:

| `combinesWith` | Qué pasa |
|---|---|
| `true` | Los dos se suman. Siempre |
| `false` | No se suman, y **Shopify elige uno con su criterio, en silencio** |

La segunda fila es exactamente el fallo que había que eliminar. No es casilla
*contra* exclusión: es **casilla (siempre en `true`, para que Shopify no descarte
nada) MÁS exclusión (del merchant, en nuestra Function, con log)**.

`combinesWith` se reescribe **también al actualizar** el descuento. Sin eso, un
descuento creado antes del arreglo se quedaría con la combinación vieja para
siempre y el fallo seguiría vivo en las campañas existentes.

### 4.7 · 🔴 El fallback silencioso de `tipoLabel`

`tipoLabel` termina en `?? type`: cuando falta una entrada no rompe nada, solo
escribe la constante del enum en la pantalla. **Pasó dos veces seguidas** —
`PACK` primero y `CART_VALUE` después — en el listado, el dashboard, analítica y
el panel interno de pausa a la vez. Las dos veces lo encontró Jonas mirando la
app, no un test.

Es la misma familia de bug que este repo ya arregló cuatro veces en otro sitio
(`?? []` convirtiendo un fallo en "no hay nada"): **lo que no se queja se entrega
roto.**

**Arreglo**: `app/i18n.test.ts` lee el enum `CampaignType` **del schema de
Prisma** y exige texto para todos los valores. La fuente de verdad es el enum, no
una lista escrita en el test, así que un tipo nuevo falla antes de llegar a una
pantalla. Más un test que prohíbe pintar `{x.type}` a mano en las cuatro
pantallas donde se muestra (las plantillas `${x.type}` de los logs quedan fuera a
propósito: un log tiene que decir la constante).

### 4.8 · Otros, más cortos

- **Custom properties y fallback.** `--x: rgba(...)` seguido de
  `--x: color-mix(...)` **no** cae a la primera si el navegador no entiende
  `color-mix`: las custom properties guardan texto sin validar, la validación
  ocurre al sustituir el `var()`, y un resultado inválido va al **valor inicial**,
  no a la declaración anterior. En un navegador sin `color-mix`, bordes y fondos
  quedaban transparentes. Se arregla con `@supports`.
- **`hidden` no ocultaba.** `[hidden]{display:none}` es un selector de atributo de
  la hoja del navegador y pierde contra `.df-pack{display:grid}`, que es de clase.
  Hizo falta `.df-pack[hidden]{display:none!important}`.
- **`properties` tiene dos formas.** En la Ajax Cart API es un **objeto**; en el
  payload REST del pedido es un **array de `{name,value}`**. Confundirlas no da
  error: da **cero atribuciones en silencio**. Se lee con una función que tolera
  las dos.
- **El dinero del widget no era el del tema.** El widget formateaba con `Intl` y
  el resto de la tienda con `money_format`: en una tienda chilena eso ponía
  `$7,000.00` al lado de `$7.000`. Ahora el bloque pasa `shop.money_format` y el
  widget lo aplica.
- **`json.errors` no siempre es un array.** Con un token vencido Shopify devuelve
  una cadena, y un `.map` revienta **tapando el error de verdad** detrás del fallo
  del manejador de errores. Costó una ronda entera.
- **El `.gitignore` sin salto de línea final.** Un `echo >>` pegó la regla nueva
  al final de la última línea y se colaron al repo 37 archivos generados. Ya
  destrackeados.

---

## 5 · Agujeros que se cerraron

### 🔴 El plan FREE podía crear BxGy y Escalonados sin límite

`PLAN_LIMITS` solo sabía de **cantidades** (`maxBxgy`/`maxTiered`), y `null`
significaba "sin sublímite" — que las rutas interpretaban como **saltarse la
comprobación entera**. FREE tenía `maxBxgy: null`, así que **una tienda del plan
gratuito podía crear y activar campañas BxGy y Escalonadas**, acotada solo por el
tope general de 2. La tabla de planes decía lo contrario desde hacía meses.

**Arreglo**: "no incluido" y "incluido sin tope" son ahora dos estados distintos y
explícitos (`TypeRule`), en vez de compartir el valor `null`. Y la comprobación,
que vivía **copiada en cinco sitios**, se colapsó en una sola función
(`comprobarTipoDeCampana`). Con los tipos nuevos habrían sido nueve copias.

### Otros

- **El widget mostraba «0 productos» mientras el carrito mostraba el pack.** No
  leía el carrito existente. Dos verdades distintas sobre lo mismo en la misma
  pantalla.
- **La barra de progreso salía vacía** con los números correctos, dos veces, con
  dos técnicas distintas. Cuando dos técnicas fallan igual, el problema deja de
  ser la técnica. Toda la geometría se movió a estilos **en línea** desde el JS,
  que ganan a cualquier hoja del tema sin `!important`.
- **La atribución de packs** se sacó a un módulo puro con 15 tests, y devuelve
  `titulosNoReconocidos` para que un desajuste de título sea **diagnosticable** en
  vez de un cero silencioso.

---

## 6 · 🔴 Lo que NO se puede probar en dev

**La atribución de pedidos.** Está escrita y con tests, pero no se puede
ejercitar en la tienda de desarrollo:

- `orders/create` está **comentado** en `shopify.app.dev.toml`.
- El bundle de dev registra solo 2 suscripciones de webhook.
- La API REST de pedidos devuelve
  `HTTP 403 … not approved to access … protected customer data`.

Está gateado por **Protected Customer Data**, aprobado en producción (mayo 2026)
y no en dev.

**Consecuencia práctica**: la atribución de packs, la de valor de carrito y la
del cupón se entregan verificadas con **tests contra payloads reales de pedido**,
y se confirman **en producción**. No hay que pedirle a Jonas que las pruebe en
dev — ya se cometió ese error una vez en esta sesión y hubo que rectificarlo.

---

## 7 · Analítica por cupón — recomendación, sin implementar

Es lo que a Jonas más le importa del tipo nuevo. La recomendación quedó dada y
**no construida**:

- **La decisión "un código por campaña" ya resolvió la mitad.** Campaña =
  influencer, así que la fila por campaña **es** la fila por cupón. Sin modelo
  nuevo, sin pantalla nueva, sin filtro nuevo.
- **Cómo se mide**: `discount_applications[]` trae la aplicación del código, y
  cada `line_items[].discount_allocations[]` apunta a ella **por índice**. Se
  puede sumar exactamente lo que descontó nuestro cupón, línea por línea. Es más
  preciso que la atribución de BxGy, que cruza por *título*.
- **No se apoya en la de packs**: packs necesita la marca `_df_pack` porque no
  deja rastro propio en el pedido. Un cupón sí: el código es un identificador
  exacto. Camino más corto, mismo webhook.
- **Lo único que falta agregar**: que el código se vea en la fila de analítica
  (en el listado ya se ve).
- **No duplicar** el contador de usos por código: Shopify ya lo muestra en su
  pantalla de Descuentos. ⚠️ Su informe *«Sales by discount»* está limitado por
  plan de Shopify; **no se verificó desde cuál**.

---

## 8 · Lo primero de mañana: que Jonas pruebe el cupón

La tienda de dev está **limpia y lista**. Solo están las dos campañas de Jonas
(*Pack prueba* y *Test 2*), las cuatro Functions registradas, y ningún dato
sembrado. El script de siembra de F1 **se borró**: existía para sustituir al
admin, y el admin ya existe.

1. **App → Campañas → Crear.** Siete tarjetas. La última es «Cupón sobre precio
   original», con ilustración propia (código arriba, `$100` tachado en verde y
   `$85` en gris).
2. **Crear primero la rebaja**, porque es el caso real de SkinUp: tarjeta
   «Porcentaje» → **5 Panel Camp Cap** → **15%** → activar. Queda a **$40,80** con
   **$48,00 tachado**. La app pone el comparativo sola.
3. **Crear → «Cupón sobre precio original»**: nombre, código `MARIA10`, 10%.
   El panel derecho tiene que decir **«Este cupón −$10,00»** contra **«Un cupón
   normal −$8,50»**. Escribir `maria 10` en el código tiene que convertirse solo
   en `MARIA10`. Activar.
4. **Listado**: tipo en español y el chip `MARIA10`.
5. **Tienda → 5 Panel Camp Cap → carrito → aplicar `MARIA10`.**
   🔴 **El descuento tiene que ser −$4,80** (10% de $48,00), no −$4,08. La línea
   queda en **$36,00**. Ése es el número que decide si el tipo funciona.

⚠️ *Test 2* (monto de compra) está activa y se sumará sobre el total. Es
correcto: la línea a mirar es la del cupón, que el carrito muestra con su nombre.

---

## 9 · Reglas de trabajo que fijó Jonas hoy

No son preferencias. Cada una nació de algo que salió mal.

1. **Nada se declara listo sin verificarlo en el navegador real.** *"Los tests
   pasan" no es "funciona".* Si no se puede verificar desde donde uno está, se
   dice así y no se declara terminado.
2. **Tiene que existir una forma de confirmar en cinco segundos, sin ejecutar
   JavaScript, que el archivo que sirve el tema es el que se acaba de escribir.**
   De ahí el comentario HTML con el build, legible con Ctrl+U.
3. **El ambiente tiene que quedar listo para probar.** Sin comandos pendientes,
   sin scripts que fallan, sin cosas que Jonas tenga que borrar. Si algo no se
   puede hacer desde acá, se dice claro y se explica por qué, en vez de pasarle
   un comando que puede fallar.
4. **Se prueba desde la app, no con scripts.** La entrega es el recorrido
   completo: entrar, ver la tarjeta, darle a Crear, llenar el formulario,
   activar, e irse a la tienda. No se divide en "primero la Function y probás por
   script, después el admin".
5. **Toda campaña nueva sigue el patrón visual de las que ya existen.** No es
   cuestión de gusto: es la marca del producto. Antes de entregar, hay que abrir
   las pantallas equivalentes y compararlas.

Las reglas 4 y 5 tienen mecanismo, no solo buena voluntad:
`app/components/campaign-forms.test.ts` recorre los **siete** formularios y exige
la estructura común —rejilla de dos columnas con panel de 320px, panel lateral
fijo, resumen en vivo, `ActionBar`, textos desde i18n— y comprueba que ninguna
ilustración se repita entre tarjetas.

⚠️ **Porcentaje y Rango son anteriores al kit compartido**: tienen el esqueleto
pero lo pintan con piezas propias (`DiscountPreview` y una barra de acciones a
mano). Están listados como **deuda explícita** en ese test, en vez de bajarle el
listón a todos. Una campaña nueva no puede acogerse a esa excepción.

Y la regla vieja que sigue vigente: **todo en `dev`, producción no se toca.** Ni
un push a `main`, ni un `shopify app deploy` contra la app de producción, ni una
consulta de escritura a la base de producción.

---

## 10 · Pendientes

### De esta sesión

| | |
|---|---|
| 🔴 Que Jonas pruebe el cupón | §8. Es lo primero |
| 🔴 Decisión de Jonas: `combinesWith` de escalonados y BxGy | Hoy anulan el descuento por monto y el cupón. Cambiarlo toca código en producción y afecta a descuentos de **otras apps**. §2.2 |
| Confirmar la fila de planes de «Monto de compra» | Es un supuesto marcado. §3.8 |
| Analítica por cupón | Recomendación dada, sin construir. §7 |
| Atribución de los tres tipos | Escrita; solo verificable en producción. §6 |
| Reiniciar `shopify app dev` en algún momento | `prisma generate` no pudo reemplazar el motor nativo porque el proceso lo tiene abierto. Los tipos **sí** se regeneraron y no hay nada roto |

### Lo que viene

**DESCUENTO DE ENVÍO**, el cuarto tipo del plan original.

🟢 Sale más barato de lo normal: usa un target **distinto**
(`cart.delivery-options.discounts.generate.run`), y una extensión **sí** puede
declarar varios targets distintos. Cabe dentro de `extensions/order-discount` sin
crear una quinta extensión.

Antes de arrancar hay que cerrar una fase 0 con Jonas: si el umbral se mide igual
que en valor de carrito (subtotal ya rebajado), si es envío gratis o un
porcentaje del envío, si aplica a todos los métodos o a algunos, y en qué planes
entra.

### Backlog anterior, todavía abierto

- 🔴 **El cron de campañas programadas no existe.** `vercel.json` declara
  `/api/cron/sync-campaigns` y la ruta no está: las campañas con `endsAt` **nunca
  se detienen solas**. Cada consulta que sirve campañas activas comprueba la
  ventana de fechas a mano para compensar, pero el descuento en Shopify sigue
  vivo.
- 🔴 **`PLAN_SYNC_OBSERVACION=1` sigue puesta**: la degradación de plan está
  frenada. El gate para apagarla (leer el `planHandle` de Greta/SkinUp/Nachin) no
  se cumplió.
- 🔴 **`/app/plans/confirm` escribe el plan desde el parámetro de la URL sin
  verificarlo contra Shopify**: cualquier merchant podría subirse de plan gratis.
- **Repo GitHub público** y secretos sin rotar.
- **La barra de progreso pasa a ser nativa sin flag** (colapsar los tres puntos de
  lectura en uno, con kill-switch).
- **D3**: crear BxGy y Escalonado sin barra de progreso.

---

## 11 · Mapa rápido de archivos

```
app/lib/discounts/
  pack-calc.ts              🔴 se compila en el Wasm de pack-discount
  pack-validate.ts             el tope de 20 productos vive acá, FUERA del Wasm
  pack-client.ts               config, metafield, PACK_MODOS_OFRECIDOS
  pack.ts                      crear/editar/activar/pausar/borrar
  pack-attribution.ts          módulo puro, 15 tests
  pack-widget-metafield.ts     qué viaja al metafield que lee Liquid (puro)
  pack-widget-metafield.server.ts   la escritura en Shopify
  pack-widget-payload.server.ts     la consulta compartida con el app proxy

  cart-value-calc.ts        🔴 se compila en el Wasm de order-discount
  cart-value-client.ts / cart-value.ts / cart-value-form.ts
  cart-value.server.ts         qué campañas pueden chocar (compartido)

  original-price-calc.ts    🔴 se compila en el Wasm de code-original-price
  original-price-client.ts / original-price.ts / original-price-form.ts

  discount-mutation.ts         `runDiscountMutation`, mira las TRES formas de fallar
  function-id.ts               resuelve la Function por handle

extensions/
  pack-discount/  order-discount/  code-original-price/  tiered-discount/
  pack-widget/                 bloque de tema; las FUENTES en scripts/pack-widget-src/

scripts/
  build-pack-widget.mjs        const BUILD = 12  ← subirlo al tocar el widget
  pack-widget-src/             pack-builder.js, pack-notice.js, pack-styles.css
  dev-sincronizar-metafield-pack.mjs   siembra el metafield del widget en dev

app/components/
  campaign-forms.test.ts    🔴 el patrón visual de los siete formularios
app/
  i18n.test.ts              🔴 ningún tipo puede salir en crudo
```

**Al tocar el widget de packs**: subir `const BUILD` en
`scripts/build-pack-widget.mjs`, cambiarlo en los **dos** bloques Liquid
(comentario, `data-df-build` y los `asset_url`) y correr
`npm run build:pack-widget`. `pack-widget-build.test.ts` comprueba que todo
coincida y que el archivo exista de verdad.
