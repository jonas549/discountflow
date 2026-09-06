# Traspaso · 2026-09-06 · Tres despliegues a producción en un día

> **Si lo que buscás es DESPLEGAR, andá directo a
> `docs/DESPLIEGUE-A-PRODUCCION.md`.** Ese archivo es el procedimiento canónico y
> se escribió hoy, precisamente, para que nunca más haya que reconstruirlo de un
> handoff.
>
> Este documento cuenta **qué pasó hoy**. El estado vivo está en `docs/ESTADO.md`.

---

## 1 · Dónde quedó todo

| | Al empezar el día | **Al terminar** |
|---|---|---|
| Vercel (producción) | `e7be44d` | 🟢 **`582498d`** |
| App version en Shopify | `discountflow-8` | 🟢 **`discountflow-11`** |
| `main` | `e7be44d` | **`582498d`** |
| `dev` | `fe62c81` | `6848185` (un commit de docs por encima de `main`) |
| Config local de Shopify | dev | 🟢 **dev** (se volvió, como corresponde) |
| Tipos de campaña vivos en producción | 4 | 🟢 **7** |

**Tres despliegues, en este orden:**

| # | Qué subió | Vercel | App version |
|---|---|---|---|
| 1 | Los tres tipos nuevos (pack, monto de compra, cupón) + `app_proxy` + 3 migraciones | `3d84c3f` | **`discountflow-10`** |
| 2 | Arreglos del cupón + textos de planes | `92b7d4e` | *(sin app version)* |
| 3 | Los dos modos de cálculo del cupón | **`582498d`** | **`discountflow-11`** |

Verificación de la última: **363** tests de app · **91** fixtures contra el Wasm
real (tiered 16 · pack 13 · order 16 · cupón 46) · typecheck **175**, solo
`TS2345` / `TS2322` / `TS2367`.

---

## 2 · 🔴 Lo más importante del día: el procedimiento de despliegue

Hoy, con tres clientes que pagan y campañas descontando en vivo, se reportaron
como **bloqueos duros** dos cosas que eran **falsas**:

1. Que hacían falta credenciales de la base de producción para correr las
   migraciones. **No**: corren solas dentro del build de Vercel.
2. Que sin el CLI de Vercel no se podía desplegar. **No**: Vercel despliega desde
   `main`, y **el `git push` ES el deploy**.

Jonas lo cortó con esto, y tenía razón:

> *«Frená y revisá tu memoria antes de responder. Los push, el deploy de la
> Function y el cambio de versión en Shopify los venís haciendo vos en este
> proyecto desde hace MESES.»*

**Lo único cierto de las tres afirmaciones era que el token de Vercel está
vencido**, y eso solo impide *ver* el build y usar Instant Rollback — no
desplegar.

👉 **De ahí salió `docs/DESPLIEGUE-A-PRODUCCION.md`.** Tiene el árbol de decisión
(¿hace falta app version?), los dos procedimientos, cómo verificar sin acceso a
Vercel, el rollback y las trampas. **Ese archivo se lee ANTES de desplegar,
siempre.**

---

## 3 · Lo que se construyó hoy

### 3.1 · El formulario del cupón, completo

Se agregó lo que faltaba, **verificando primero por introspección contra la
tienda real** qué soporta `discountCodeApp` y qué no:

| | |
|---|---|
| **A qué aplica** | Toda la tienda · productos · colecciones. Fail-closed: alcance vacío → **no descuenta nada** |
| **Límite de usos** | Total (`usageLimit`) y por cliente (`appliesOncePerCustomer`) |
| **Mínimos de compra** | Monto o cantidad, en el metafield (la API **no** tiene `minimumRequirement` para app discounts) |
| **Elegibilidad** | 🔴 **No se construyó.** `segments` da `ACCESS_DENIED`: pide `read_customers` → re-autorización de los 6 merchants + Protected Customer Data |

🔴 **La documentación de shopify.dev estaba equivocada**: mostraba
`appliesToOncePerCustomer`. La introspección contra la tienda probó que el campo
real es **`appliesOncePerCustomer`**. **Ganó la introspección.** Quedó un test
que prohíbe el nombre malo.

### 3.2 · Método: código o automático

Dos mutaciones distintas (`discountCodeApp*` vs `discountAutomaticApp*`).
🔴 **Cambiar de método no es editar: es otro objeto.** Se borra el viejo y se
crea el nuevo, **borrando primero** a propósito: al revés, un fallo al borrar
dejaría los dos vivos y el comprador cobraría el cupón dos veces.

🔴 `DiscountAutomaticAppInput` **no tiene `usageLimit` ni
`appliesOncePerCustomer`** (introspección, API 2025-10). El formulario esconde
esa sección en automático y explica por qué.

### 3.3 · Exclusión por monto de compra, y la matriz de `combinesWith`

**`combinesWith` es bilateral**: para que dos descuentos se sumen, **cada uno**
tiene que aceptar la clase del otro. Con que uno diga que no, **Shopify descarta
al otro en silencio**. De ahí sale que **el único par que el merchant puede
decidir es cupón + monto de compra** — todo lo demás lo resuelve Shopify solo,
sin decírselo a nadie. La matriz completa está en `ESTADO.md`.

Por eso la exclusión se ofrece solo para ese par, y **recalcula** (comparando
contra `cart.cost.subtotalAmount`, el mismísimo campo que lee la otra Function)
en vez de observar `cart.discountApplications`: no está confirmado que un
descuento generado por otra Function **en la misma pasada** aparezca ahí, y si no
apareciera, la casilla del merchant no haría nada y nadie se enteraría.

### 3.4 · Los dos modos de cálculo

El error de concepto que encontró Jonas en producción: Gertrude Cardigan ($80
hoy, $108 comparativo) con un cupón del 50% dejó el checkout en **$26** cuando se
esperaba **$54**.

**No era un bug.** El cálculo implementaba fielmente el ejemplo del brief
original. El requisito cambió; el código no se había desviado.

| Modo | Regla | $100, hoy $80, cupón 50% |
|---|---|---|
| **REEMPLAZA** | El % se aplica al original y **ése es el precio final** | **$50** |
| **SUMA** | El % del original, **restado del precio de hoy** | **$30** |

En REEMPLAZA, si la oferta que el producto ya tiene es mejor, **gana la oferta y
el cupón no descuenta**. El formulario lo advierte en amarillo.

🔴 **Ausente = SUMA, y no es una preferencia**: es como se comportaban todas las
campañas guardadas antes del cambio, y cambiarles el dinero en silencio sería
inaceptable. Las campañas **nuevas** nacen en REEMPLAZA, y eso lo decide el
formulario, no el cálculo.

**La prueba de esa compatibilidad:** los 29 tests del cálculo que ya existían
pasan **sin tocar ninguno**, y **las 36 fixtures previas siguieron verdes sin
recalcular una sola**. Si el default hubiera cambiado, se caían todas.

**Por qué no se vio en meses de pruebas:** en productos **sin precio
comparativo** los dos modos dan el mismo número. El producto de las pruebas
(Cydney Plaid) tiene `compareAtPrice: null`. Solo divergen en productos realmente
rebajados — que es exactamente para lo que existe este tipo de campaña.

### 3.5 · Textos de la pantalla de planes

Los cuatro planes decían «Porcentaje, Rango de precio, BxGy», y en **GRATIS eso
era falso desde F4**. Se corrigió **el texto**, no el código, verificando cada
línea contra `PLAN_LIMITS`. Quedó un guard nuevo, `plan-features.test.ts`, que
ata la copia de pantalla a los límites reales.

---

## 4 · Los bugs de hoy, y qué enseñó cada uno

| | |
|---|---|
| 🔴 **`Section` desmonta a sus hijos al plegarse** | Plegar una sección **borraba sus campos en silencio**. Arreglado **solo en el cupón**, serializando todo el estado en inputs ocultos **arriba** del `<Form>`. **Los otros seis formularios siguen expuestos** — el `tiersJson` de monto de compra es el más caro |
| 🔴 **El listado imprimía «Toda la tienda» a mano** | Constante que quedó del 05/09, cuando el cupón no tenía alcance. **El formulario tenía razón, el listado mentía** |
| 🔴 **El código se perdía al pasar a automático** | Lo blanqueaba a propósito: **error de criterio mío**. La config guarda **siempre** lo que el merchant escribió; qué se le manda a Shopify lo decide la mutación. Ahora además se avisa en pantalla, porque el campo desaparece |
| 🔴 **Configuración imposible aceptada en silencio** | Mínimo $120 + exclusión desde $50 → ventana vacía, y la app lo guardaba sin decir nada. Ahora hay un banner rojo |
| 🔴 **`discountflow-9` descartada entera** | `theme-check` reportó `ImgWidthAndHeight` **y el deploy salió con exit 0 igual**. Se descubrió por leer el log completo. Lección: **nunca pasar el log por `tail`** |
| 🔴 **Rojo falso en `tiered-discount`** | Estuvo a punto de reportarse como un problema en la Function de SkinUp. Era un **bug de medición**: dos `$?` en el mismo `printf`, el segundo dentro de una sustitución de comando. Aislado: 16/16. **Capturar el exit code en una variable inmediatamente después del comando** |
| 🟡 **CRLF** | `core.autocrlf=true` sin `.gitattributes`: cada `git checkout` entre ramas reescribe **todo el árbol** y rompió dos tests que leen código fuente. Se normalizó la lectura en los tests |

---

## 5 · 🟢 Los «descuentos fantasma»: era el ambiente, no el producto

Dos campañas (un cupón y un BxGy «Test Shopify») quedaron ACTIVAS sin poder
pausarse, las dos **en la tienda de desarrollo**. Se diagnosticó como bug de
producto y se empezó a arreglar `bxgy.ts`.

**Jonas lo frenó:** durante una sesión de QA se tocó el **panel nativo de
descuentos de Shopify** y se borraron desde ahí descuentos enlazados con campañas
de la app, que quedaron apuntando a objetos inexistentes.

**Prueba de que el producto está sano:** se pausó el BxGy **«Sensilis» de
SkinUp** y funcionó perfecto.

| | |
|---|---|
| 🟢 Cupón | El arreglo **está en producción** (`92b7d4e`) y sigue siendo válido: tolera que el descuento ya no exista al pausar/eliminar |
| 🔴 BxGy | **NO se arregló.** Se descartó al conocerse la causa. `bxgy.ts` quedó intacto |

⚠️ **Corrección a un diagnóstico propio**: se dijo que el id colgante venía del
cambio de método. La explicación buena es la misma que la del BxGy: el borrado
desde el panel nativo. El arreglo sigue valiendo (cubre los dos casos), pero la
atribución de la causa estaba equivocada.

---

## 6 · 🔴 Reglas nuevas, permanentes

1. **NUNCA se hacen pruebas de compra en tiendas de clientes.** Ni carritos ni
   checkouts, en SkinUp, Greta o Nachin. **Siempre, no solo hoy.** Se verifica en
   la tienda de desarrollo: **es la misma Function**.
2. **El panel nativo de descuentos de Shopify no se toca nunca**, tampoco
   haciendo QA. Todo se prueba desde DiscountFlow.
3. **Antes de decir «no puedo desplegar», leer `DESPLIEGUE-A-PRODUCCION.md`.**
4. **Ante un rojo inesperado, re-correr aislado antes de reportarlo.** Pasó tres
   veces hoy con las fixtures.
5. **Si la documentación de Shopify y la introspección contra la tienda no
   coinciden, gana la introspección**, y se deja un test que lo fije.

Siguen vigentes las cinco reglas del 05/09 y las decisiones de Jonas
(**escalonado y BxGy no se tocan**, nada de avisos automáticos de choques, el
merchant resuelve desde la campaña que está creando).

---

## 7 · Lo que tiene que probar Jonas

En la **tienda de desarrollo**, en este orden:

1. 🔴 **Una campaña ESCALONADA** con niveles conocidos, y el descuento en el
   carrito. Es el proxy de SkinUp: paga el precio de haber recompilado el Wasm.
2. **Los dos modos del cupón**: que el selector aparezca; el preview; Gertrude
   Cardigan → **$54 en REEMPLAZA** y **$26 en SUMA**; un cupón del 20% sobre un
   producto rebajado 26% en REEMPLAZA **no descuenta** (y el formulario lo avisa
   en amarillo).
3. Que una **campaña de cupón anterior** se abra con **«Se suma a la oferta»**
   seleccionado — es lo esperado, no un bug.
4. El **listado** carga y los tipos salen en español.

---

## 8 · Pendientes que quedan (el detalle completo, en `ESTADO.md`)

| | |
|---|---|
| 🔴 `PLAN_SYNC_OBSERVACION=1` sigue puesta | La degradación de plan está frenada |
| 🔴 El cron de campañas programadas **no existe** | Las campañas con `endsAt` nunca se detienen solas |
| 🔴 `/app/plans/confirm` escribe el plan desde la URL sin verificarlo | Cualquier merchant podría subirse de plan gratis |
| 🔴 `Section` desmonta hijos en los **otros seis** formularios | |
| 🟡 Tolerancia al descuento borrado a mano en los tipos que no son el cupón | Baja prioridad; solo hay que tocar el camino de **pausar** |
| 🟡 `usesPerOrderLimit` sin usar en BxGy · `functionId` deprecado · exclusión espejo · analítica por cupón | |
| 🔴 Repo GitHub público y secretos sin rotar | De antes |

**Lo que viene después:** **descuento de envío**, que cabe dentro de
`extensions/order-discount` porque usa otro target.
