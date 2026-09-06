# Traspaso · 2026-09-06 · El cupón, completo

El formulario del cupón sobre precio original pedía nombre, código y porcentaje.
Hoy pide, además, **a qué aplica**, **límite de usos** y **requisitos mínimos de
compra**. Y quedó auditado qué de eso le falta a las otras seis campañas.

---

## 1 · Estado del código

| | |
|---|---|
| Rama | `dev` |
| `main` | **`e7be44d`** — intacto. Ni un push, ni un deploy, ni una escritura a la base de producción |
| Producción | **Sin tocar.** Sigue en `e7be44d` + Function `discountflow-8` |
| Tests de la app | **327**, todos verdes (`npm test`) |
| Fixtures del cupón contra el Wasm real | **25/25** (eran 14) |
| Typecheck | **172** — línea base era 170. Los códigos siguen siendo solo `TS2345`, `TS2322` y `TS2367` |
| Build | Verde |
| Migraciones | **Ninguna.** Todo lo nuevo vive dentro del JSON de `config` |

🔴 **Se toca la Function `code-original-price`**: cambian su consulta de entrada,
su handler y `original-price-calc.ts`, que se compila dentro del Wasm. Las otras
tres Functions no se tocan — se comprobó que solo el cupón importa ese módulo.

---

## 2 · 🔴 Lo primero: qué se puede y qué no

Antes de escribir una línea se introspeccionó el schema real de la tienda de dev
(API **2025-10**, la que usa la app), porque los docs de shopify.dev se
contradicen entre páginas. **Los docs se equivocaron en un nombre de campo**, así
que esta tabla vale más que ellos.

| Lo que pediste | ¿Nativo en `DiscountCodeAppInput`? | Dónde quedó |
|---|---|---|
| **A qué aplica** (productos / colecciones) | ❌ **No existe** | Nuestra Function, leyendo el metafield |
| **Límite total de usos** | 🟢 **Sí** — `usageLimit: Int` | Se lo manda a Shopify |
| **Un uso por cliente** | 🟢 **Sí** — `appliesOncePerCustomer: Boolean` | Se lo manda a Shopify |
| **Mínimo de compra / de cantidad** | ❌ **No existe** `minimumRequirement` | Nuestra Function |
| **Segmentos de clientes** | 🟢 Sí — `context: DiscountContextInput` | 🔴 **No construido: falta un scope.** §6 |

### 2.1 · 🔴 El nombre del campo que los docs traen mal

```
docs (algunas páginas):  appliesToOncePerCustomer   ← NO EXISTE
schema real de la tienda: appliesOncePerCustomer    ← el bueno
```

Un campo inventado no falla en un test: falla en la mutación, y el merchant lee
un error de la API sobre un campo que no vio en ninguna pantalla. Hay un test
que prohíbe el nombre malo (`original-price-client.test.ts`).

Cómo se comprobó, para que se pueda repetir:

```graphql
{ __type(name:"DiscountCodeAppInput"){ inputFields(includeDeprecated:true){ name isDeprecated deprecationReason } } }
```

⚠️ Sin `includeDeprecated: true` la introspección **oculta** los campos
deprecados, y se concluye que no existen. Con él aparecen los dos que importan:

```
DEPRECADO: customerSelection → Use `context` instead.
DEPRECADO: functionId        → Use `functionHandle` instead.
```

### 2.2 · Deuda que salió de ahí: `functionId` está deprecado

Las **cinco** familias de descuento de la app mandan `functionId`. Sigue
funcionando en 2025-10, pero Shopify dice que se use `functionHandle`. **No se
cambió hoy**: toca las cinco y el cupón no lo necesita para funcionar. Queda
anotado en los pendientes.

---

## 3 · Lo que se construyó

Tres secciones nuevas, en el orden de la pantalla nativa de Shopify:
`4 · A qué aplica` → `5 · Requisitos mínimos` → `6 · Límite de usos`. Las
exclusiones y la programación pasaron a 7 y 8.

### 3.1 · A qué aplica

Toda la tienda / Productos específicos / Colecciones, con el **mismo
`resourcePicker` de App Bridge** que usan Escalonado y BxGy — el mismo
componente, no un parecido — y los mismos chips (`ProductChips`,
`CollectionChips`).

**Solo esos tres modos.** Escalonado ofrece además tags, proveedor y tipo de
producto; acá se dejaron fuera a propósito porque son los tres que pediste y los
tres que ofrece Shopify. Agregarlos es un renglón en
`resolveOriginalPriceProductIds`, no un rediseño.

**Las colecciones se expanden a productos al guardar**, dentro de
`createOriginalPriceDiscount` / `updateOriginalPriceDiscount` — el mismo sitio
que en Escalonado, para que el admin y el motor de jobs resuelvan igual. La
Function solo entiende productos: dentro del checkout no se puede consultar qué
hay en una colección.

⚠️ **Consecuencia que el formulario dice en voz alta**: si el merchant agrega
productos a la colección después, hay que volver a guardar la campaña para que
entren.

🔴 **Falla cerrado.** `scope: "all"` es lo único que autoriza descontar el
catálogo entero. Una lista de productos vacía significa «no descuentes nada»,
nunca «descontá todo» — es el bug latente del 2026-07-28 (colección vacía
descontaba todo), y hay una fixture contra el Wasm real que lo sostiene:
`alcance-lista-vacia-sin-all-no-descuenta-nada.json`.

Y una línea **sin producto identificable** queda **fuera**, no dentro: si no se
puede afirmar que el merchant lo eligió, la duda descuenta de menos.

### 3.2 · Límite de usos

Los dos, y los dos **nativos**:

- Casilla + número para el total.
- Casilla para «un uso por cliente» (Shopify identifica por email o teléfono).

**Al ser nativos, Shopify los hace cumplir antes de llamar a nuestra Function**:
un código agotado se rechaza en el carrito con su propio mensaje. Es exactamente
lo que hacía falta para los influencers — que el código **deje de funcionar**, no
que aplique $0.

Dos detalles que parecen menores y no lo son:

- **La casilla y el número van separados.** Si el límite se dedujera de que el
  campo tenga un número, destildar la casilla no lo quitaría. Con test.
- 🔴 **Los límites se reescriben también al ACTUALIZAR.** Es la lección del
  `combinesWith` que no se reescribía, con otro campo: sin eso, quitar el límite
  en el formulario dejaría el viejo vivo en Shopify — la app diría «sin límite» y
  el código se agotaría a los 100 usos. Un test cuenta que `limitesDeUso` se use
  **dos** veces.

### 3.3 · Requisitos mínimos de compra

Sin mínimo / Monto mínimo / Cantidad mínima de artículos. Uno solo, como en
Shopify. Los comprueba nuestra Function, **antes de calcular un peso**, y con su
propio motivo en el log.

**Las dos decisiones se copiaron del comportamiento nativo, que es con lo que el
merchant compara:**

1. 🔴 **Solo cuentan los artículos EN ALCANCE.** De la ayuda de Shopify: *«si el
   descuento aplica a un producto o colección concretos, solo esos artículos
   contribuyen al mínimo»*. Un carrito de $300 del que solo $50 están en la
   campaña **no** llega a un mínimo de $100. Con fixture:
   `minimo-solo-cuenta-lo-que-esta-en-alcance.json`.
2. **Se mide sobre el precio de HOY, no sobre el comparativo.** Es lo que el
   comprador ve. Medirlo sobre el original haría que un carrito de $85 «llegara»
   a un mínimo de $90 y nadie podría explicarlo. El formulario lo dice junto al
   campo, y hay fixture.

Y se compara **en centavos**: `33,33 × 3` da `99.99000000000001` en decimales y
un `>=` mal escrito lo dejaría pasar como $100. Es el mismo medio centavo del
2026-08-08.

El monto mínimo acepta **coma decimal** (`1.500,50`), porque es como se escribe
acá y `Number` no entiende ninguno de los dos separadores.

---

## 4 · 🔴 Lo que NO se puede verificar desde acá

**Que se vea bien, y qué ve el comprador cuando el cupón no califica.**

Lo verificable sin navegador está verificado: 327 tests, 25 fixtures contra el
Wasm real, typecheck, build, y un test que comprueba que **las ~30 claves de
texto nuevas existen** (`t.claveMalEscrita` no se queja: devuelve `undefined` y
React pinta un hueco — es la familia de bug de `tipoLabel`, que ya apareció dos
veces).

Lo que falta es del navegador, y hay **una pregunta abierta que importa**:

> 🔴 **Cuando el comprador aplica el código y no califica** —el producto no está
> en la campaña, o el carrito no llega al mínimo— **¿qué ve?**
>
> Con un descuento nativo, Shopify dice «tenés que gastar $X». Con uno de app,
> Shopify acepta el código y llama a la Function; si la Function no devuelve
> nada, **no está confirmado** si el carrito muestra el código aplicado con $0,
> un mensaje de «no válido», o nada. No se pudo confirmar en la documentación y
> **no se afirma sin verlo**.
>
> Si sale un estado confuso, el arreglo no es de la Function: es decirlo en el
> formulario («el comprador no verá por qué») o replantear el mínimo.

Los pasos para probarlo están en la §7.

---

## 5 · 🔴 La auditoría: qué de esto le falta a las otras seis

Lo pediste para no descubrirlo de a una. Verificado por introspección, no por
memoria.

| Tipo | Cómo crea el descuento | A qué aplica | Límite de usos | Mínimos | Segmentos |
|---|---|---|---|---|---|
| **Porcentaje** | No crea descuento: **edita precios** | ✅ tiene | ⛔ imposible | ⛔ imposible | ⛔ **imposible** |
| **Rango** | No crea descuento: **edita precios** | ✅ tiene | ⛔ imposible | ⛔ imposible | ⛔ **imposible** |
| **BxGy** | `DiscountAutomaticBxgyInput` (nativo) | ✅ tiene | 🟡 **hay uno sin usar** | ✅ inherente («compra X») | 🟡 disponible, sin usar |
| **Escalonado** | `discountAutomaticApp*` | ✅ tiene | ⛔ no existe en automáticos | ✅ inherente (cantidad) | 🟡 disponible, sin usar |
| **Pack** | `discountAutomaticApp*` | ✅ inherente (lista curada) | ⛔ no existe | ✅ inherente (mín. 2 productos) | 🟡 disponible, sin usar |
| **Valor de carrito** | `discountAutomaticApp*` | ➖ no aplica (clase ORDER) | ⛔ no existe | ✅ **es** su razón de ser | 🟡 disponible, sin usar |
| **Cupón** | `discountCodeApp*` | ✅ **hoy** | ✅ **hoy** | ✅ **hoy** | 🟡 disponible, bloqueado |

**Las cuatro conclusiones que salen de la tabla:**

1. 🟢 **«A qué aplica» solo le faltaba al cupón.** Ya está. Nada que hacer en las
   otras seis.
2. ⛔ **El límite de usos no es una carencia de las otras: es imposible.** Un
   descuento automático no tiene código que redimir, y la introspección confirma
   que `DiscountAutomaticAppInput` **no** tiene `usageLimit` ni
   `appliesOncePerCustomer`. **No hay nada que arreglar y no hay que prometerlo.**
3. 🟡 **Menos en BxGy, donde SÍ hay un control sin usar.**
   `DiscountAutomaticBxgyInput` tiene **`usesPerOrderLimit`**, que limita cuántas
   veces aplica el BxGy **en un mismo pedido**. Hoy no se manda, así que un
   «compra 2 llevá 1» con 20 unidades en el carrito aplica **diez veces**. Puede
   ser lo que el merchant quiere o puede ser una sangría; hoy no puede elegir.
   **Es el hueco más caro que encontró esta auditoría** y no lo pediste — queda
   como decisión tuya.
4. 🟡 **Los segmentos le faltan a las siete**, y a **Porcentaje y Rango no se les
   puede dar nunca**: cambian el precio del producto en la tienda, y un precio no
   distingue quién lo mira. Si la elegibilidad por cliente pasa a importar,
   **esos dos tipos quedan fuera para siempre** — vale saberlo antes de
   prometerlo en una pantalla de precios.

---

## 5-BIS · 🔴 El agujero que apareció construyendo esto, y que afecta a los otros seis

No lo pediste y no estaba buscándolo: salió de preguntarme dónde poner los
campos nuevos.

### Qué pasa

`Section` —el acordeón que usan los siete formularios— pinta a sus hijos así:

```jsx
{open && (
  <div>{children}</div>
)}
```

**Al plegarse los DESMONTA.** Y un `<input>` desmontado **no viaja en el
FormData**: el navegador solo envía lo que está en el DOM. El estado sigue vivo
en React, así que la pantalla se ve bien; lo que se guarda es otra cosa.

### Por qué es silencioso, que es lo que lo hace caro

El campo no llega vacío con un error: **no llega**. Y el parseo tiene un valor
por defecto para cada cosa que no llega:

| Campo que no llega | En qué se convierte |
|---|---|
| `selectionMode` | **`"all"` → toda la tienda** |
| `startsAt` / `endsAt` | **sin programación** |
| `tiersJson` (valor de carrito) | los niveles por defecto |
| `excludedPacksJson` | **sin exclusiones** |

Ninguno se queja. Es exactamente la familia del `?? []` y del `?? type`: lo que
no se queja se entrega roto.

### Medido, formulario por formulario

Contando qué campos con `name` viven dentro de una sección plegable:

| Formulario | Campos expuestos |
|---|---|
| **Porcentaje** | `name`, `discountPercent`, `selectionMode`, `useCompareAtPriceAsBase`, `enableExclusions`, `startsAt`, `endsAt` |
| **Rango** | `name`, `mode`, `value`, `selectionMode`, `enableExclusions`, `startsAt`, `endsAt` |
| **BxGy** | `name`, `xMinQuantity`, `yQuantity`, `discountType`, `discountValue`, `enableXExclusions`, `startsAt`, `endsAt` |
| **Escalonado** | `name`, `startsAt`, `endsAt` |
| **Pack** | `name`, `heading`, `startsAt`, `endsAt` |
| **Valor de carrito** | `name`, `message`, `valueType`, **`tiersJson`**, `excludedPacksJson`, `startsAt`, `endsAt` |
| **Cupón** | **ninguno** — arreglado hoy |

🔴 **Y los siete tienen «Programar campaña» con `defaultOpen={false}`.** Esa
sección arranca **plegada**, así que sus inputs **no están montados** cuando se
abre el formulario. Basta con que el merchant la despliegue, ponga la fecha de
fin y la vuelva a plegar antes de guardar —cerrar lo que abriste es lo normal—
para que la campaña quede **sin fecha de fin**, sin un solo error a la vista.

⚠️ Se junta con un pendiente viejo y se vuelve peor: **el cron de campañas
programadas no existe**, así que una campaña que pierde su `endsAt` no la para
nada ni nadie.

El más caro de la lista es **`tiersJson` de valor de carrito**: plegar la sección
de los niveles antes de guardar deja la campaña con los niveles por defecto. Eso
es dinero, no cosmética.

### Qué se hizo y qué no

**En el cupón está arreglado.** Todo el estado se serializa en inputs ocultos
**arriba del `<Form>`**, fuera de las secciones, y los controles visibles se
quedaron **sin `name`** para que haya una sola fuente de lo que se envía. No es
un invento: es el patrón que **`TieredCampaignForm` ya usaba** para sus niveles y
su selección — el cupón (y los demás) se desviaron de él.

Hay test que lo sostiene, y en las dos direcciones: que no quede ningún `name`
dentro de una sección, y que los quince campos que el parseo lee estén
serializados arriba.

🔴 **En los otros seis NO se tocó nada.** Son código que sirve a clientes que
pagan, el arreglo es mecánico pero toca los seis formularios, y hay que
verificarlo en el navegador uno por uno. **Es tu decisión.** El arreglo es el
mismo en todos y no cambia ni una línea de lógica: mover los `name` arriba del
`Form` y quitarlos de los controles visibles.

Alternativa de una línea, si preferís algo global: que `Section` oculte con CSS
(`display: none`) en vez de desmontar. Arregla los siete de golpe, pero cambia el
comportamiento de un componente que usan todas las pantallas — y por eso tampoco
se hizo sin preguntarte.

---

## 6 · 🔴 Segmentos: se puede, pero cuesta un scope nuevo

**Sí es posible**, y por la vía nativa: `context: DiscountContextInput`, con
`all`, `customers { add remove }` y `customerSegments { add remove }`. Está en el
schema de la tienda hoy, tanto para descuentos de código como automáticos.

**Lo que lo frena no es la API: es que no se pueden LISTAR los segmentos.**
Verificado contra la tienda:

```
{ segments(first:2){ nodes{ id name } } }
→ "Access denied for segments field." (ACCESS_DENIED)
```

Los scopes de la app son `read_products, write_products, read_discounts,
write_discounts, read_orders`. Para ofrecer un selector de segmentos hace falta
**`read_customers`**, y eso significa:

- **Cambiar los scopes de la app** → **todos los merchants tienen que volver a
  aceptar los permisos** la próxima vez que abran la app. Greta, SkinUp, NYZA,
  Vermú, Nachin incluidos.
- `read_customers` es **Protected Customer Data**. La app tiene el Nivel 1
  aprobado (mayo 2026) para `read_orders`; **no está confirmado** que cubra
  clientes sin una revisión nueva.
- Y como pasa con `orders/create`, **probablemente no se pueda probar en dev** —
  es el mismo muro que impidió probar la atribución.

Por eso **no está puesto en el formulario**. Ponerlo sin poder listar segmentos
sería una pantalla que no funciona, que es exactamente lo que pediste evitar.
**Es una decisión tuya**, y si la tomás, el trabajo es: subir el scope, un
selector de segmentos, y `context` en la mutación de los cinco tipos que lo
admiten.

---

## 7 · Cómo probarlo, en un solo recorrido

La tienda de dev queda lista. **Hay que reiniciar `shopify app dev`** para que
recompile la Function del cupón (cambió su consulta de entrada), y ese comando lo
corrés vos: es interactivo y reescribe la URL del túnel.

🔴 **Antes que nada**: si ayer quedó alguna campaña de cupón **activa**, hay que
**volver a guardarla**. Su metafield se escribió sin `scope`, y la Function
ahora falla cerrado: sin `scope` no descuenta nada. Es deliberado (§3.1) y solo
afecta a campañas activadas antes de hoy. En producción no hay ninguna.

### El recorrido

1. **App → Campañas → Crear → «Cupón sobre precio original».**
2. **Sección 4, A qué aplica** → *Productos específicos* → **Seleccionar
   productos** → elegí **5 Panel Camp Cap**. Tiene que aparecer su chip.
3. **Sección 5, Requisitos mínimos** → *Monto mínimo de compra* → **50**.
   Debajo tiene que decir que se mide **solo sobre los productos a los que
   aplica el cupón** y **sobre el precio de hoy**.
4. **Sección 6, Límite de usos** → tildá el total, poné **2**, y tildá también
   **un uso por cliente**.
5. **Panel derecho**: el resumen tiene que mostrar las tres filas nuevas —
   `Aplica a: 1 producto`, `Mínimo: $50,00`, `Límite de usos: 2 veces · 1 por
   cliente`. Si alguna dice «Sin definir» o sale vacía, ahí está el problema.
6. Código `MARIA10`, 10%, **Activar**.
7. **Shopify → Descuentos → `MARIA10`**: la pantalla nativa tiene que mostrar el
   límite de 2 usos y «uno por cliente». Eso prueba que los campos nativos
   llegaron. *(Mirar, no editar.)*
8. **Tienda, y acá están las cuatro pruebas de verdad:**

   | Carrito | Qué tiene que pasar |
   |---|---|
   | **5 Panel Camp Cap** ($40,80 con $48 tachado) | 🔴 **−$4,80** (10% de $48), línea a **$36,00** |
   | Un producto **distinto** solo | El cupón **no descuenta** |
   | 5 Panel Camp Cap **+ otro producto caro** | Descuenta **solo** la línea del Panel Camp Cap |
   | Algo en alcance por **menos de $50** | **No descuenta** — 🔴 **y acá anotá QUÉ VE el comprador** (§4) |

9. **El límite**: usá el código en dos pedidos. En el tercero, Shopify tiene que
   rechazarlo en el carrito.

⚠️ *Test 2* (monto de compra) sigue activa y se suma al total. La línea a mirar
es la del cupón, que el carrito muestra con su nombre.

---

## 8 · Archivos

```
app/lib/discounts/
  original-price-calc.ts      🔴 se compila en el Wasm · scope + mínimos, puros y probados
  original-price-client.ts       config, `scope` explícito, qué viaja al metafield
  original-price-form.ts         parseo y validación de los campos nuevos
  original-price.ts              mutaciones + `limitesDeUso` + resolución de colecciones
app/components/
  OriginalPriceCampaignForm.tsx  las tres secciones nuevas y el resumen
app/routes/
  app.campaigns.new.original-price.tsx        valores por defecto
  app.campaigns.$id.edit_.original-price.tsx  rehidrata los chips por título
app/i18n.ts                      ~30 claves nuevas en `nuevoCupon`
extensions/code-original-price/
  src/*.graphql                  🔴 pide `merchandise.product.id`
  src/*.ts                       alcance fail-closed + mínimos, con logs distintos
  tests/fixtures/                25 fixtures (14 actualizadas + 11 nuevas)
```

**Al tocar el alcance o los mínimos**: viven en `original-price-calc.ts`, que se
compila **dentro del Wasm**. Cualquier cambio ahí obliga a desplegar la Function.

---

## 9 · Pendientes

### Nuevos de hoy

| | |
|---|---|
| 🔴 Que pruebes el recorrido de la §7 | Incluido el paso 8, que es lo único que no se puede verificar desde acá |
| 🔴 **Qué ve el comprador cuando no califica** | §4. Es una pregunta abierta, no una suposición |
| 🔴 **Decisión: segmentos de clientes** | Se puede, cuesta `read_customers` → re-autorización de **todos** los merchants + posible revisión de PCD. §6 |
| 🟡 **Decisión: `usesPerOrderLimit` en BxGy** | Hoy un «compra 2 llevá 1» puede aplicar diez veces en un pedido. §5 |
| `functionId` está deprecado | Las cinco familias lo mandan. Funciona en 2025-10; migrar a `functionHandle` cuando se toquen. §2.2 |
| Los chips del editor topan en 250 productos | `getProductsByIds` corta ahí. El descuento aplica a todos igual: es solo lo que se ve al editar |
| 🔴 **Decisión: el desmontaje de `Section` en los otros seis formularios** | Plegar una sección borra sus campos en silencio. En el cupón está arreglado; en los otros seis no se tocó. §5-BIS |

### Lo de ayer, sin cerrar

- 🔴 **Que pruebes el cupón de punta a punta** — la §7 de hoy **reemplaza** a la
  §8 del handoff de ayer: es el mismo recorrido, con las tres secciones nuevas.
- 🔴 **Decisión: `combinesWith` de escalonados y BxGy.** Siguen anulando el
  descuento por monto y el cupón.
- Confirmar la fila de planes de «Monto de compra» (es un supuesto marcado).
- Analítica por cupón (recomendación dada, sin construir).
- Atribución de los tres tipos: escrita, solo verificable en producción.

### Backlog anterior

- 🔴 El cron de campañas programadas **no existe**: las campañas con `endsAt`
  nunca se detienen solas.
- 🔴 `PLAN_SYNC_OBSERVACION=1` sigue puesta.
- 🔴 `/app/plans/confirm` escribe el plan desde la URL sin verificarlo.
- Repo GitHub público y secretos sin rotar.
- La barra de progreso a nativa sin flag. **D3**.

### Lo que viene

**DESCUENTO DE ENVÍO**, con la fase 0 sin cerrar (§10 del handoff de ayer).
