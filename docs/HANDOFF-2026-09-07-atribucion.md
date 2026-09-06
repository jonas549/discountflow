# Traspaso · 2026-09-07 · La atribución de los seis tipos

> Estado vivo: `docs/ESTADO.md`. Procedimiento de despliegue:
> `docs/DESPLIEGUE-A-PRODUCCION.md`.
>
> **PROD = Vercel `5f78888` · app version `discountflow-11` sin tocar.**
> Este despliegue **no toca la Function**: cero cambios en `extensions/`, en los
> cuatro `*-calc.ts` y en el `.toml` de producción, medido con `git diff --numstat`.

---

## 1 · Qué era cada cosa

Jonas encontró que un cupón (#1013, −$26,00) y un BxGy (#1015, −$48,00) daban
**«0 pedidos · USD 0.00 · ROI N/A»** con el pedido pagado y el descuento
identificado en el desglose. Eran **tres problemas distintos**:

| Tipo | Antes | Ahora |
|---|---|---|
| **BxGy** | 🔴 Roto desde el día uno | 🟢 Arreglado, cruce e importe |
| **Cupón sobre precio original** | 🔴 Nunca construido | 🟢 Construido, los dos métodos |
| **Monto de compra** | 🔴 Nunca construido | 🟢 Construido |
| **Pack** | 🟡 Construido, sin verificar | 🟡 Verificado por equivalencia; falta un pedido |
| **Rango de precio** | 🟡 Construido, sin verificar | 🟢 Verificado con test |
| **Escalonado** | 🟢 Funcionando | 🟢 **Sin tocar** |

**BxGy tenía dos fallos encadenados**, y el segundo estaba escondido detrás del
primero: el cruce comparaba el título contra `campaign.name` cuando el descuento
se crea como `[DiscountFlow] <nombre>`; y el importe salía de `total_price` /
`total_discounts` — **el pedido entero**. Arreglar solo el cruce habría hecho
que una campaña BxGy se llevara el ahorro de los otros descuentos del pedido.

El detalle completo, con la distinción entre el **título del objeto** (nativos)
y el **`message` de la Function**, está en `ESTADO.md`.

---

## 2 · 🔴 QUÉ COMPRAR Y QUÉ TENÉS QUE VER

Todo en **tu tienda de pruebas** (la que tiene instalada la app de producción).
🔴 Nunca en SkinUp, Greta ni Nachin.

**Antes de empezar**, dos cosas:

1. **El webhook llega solo si la tienda tiene la app de PRODUCCIÓN.** La app Dev
   no tiene `orders/create` suscrito. La prueba de que la tuya la tiene: la
   campaña de Porcentaje «Jonas Gonzalez» atribuyó 1 pedido.
2. **El dashboard tarda lo que tarde el webhook**, que es del orden de segundos.
   Si a los dos minutos sigue en 0, es un fallo, no una demora.

### Orden de las pruebas, de la más importante a la menos

#### 1 · 🔴 ESCALONADO — el control, y va PRIMERO

**Qué comprar:** 3 unidades de un producto de una campaña escalonada.

**Qué tenés que ver:** el pedido atribuido, con su recaudación y su ROI.

**Por qué primero:** es lo que **ya funcionaba** (10 pedidos en SkinUp). Si esto
dejó de atribuir, el despliegue rompió algo y hay que hacer rollback **antes** de
seguir probando. Es el único gate de rollback de esta lista.

#### 2 · CUPÓN CON CÓDIGO — el que más importa

**Qué comprar:** un producto **con precio comparativo**, aplicando el código de
una campaña de cupón. Anotá el descuento que muestra el checkout.

**Qué tenés que ver:** 1 pedido atribuido a esa campaña, con
**`descuento atribuido` = exactamente el del checkout** y la recaudación = el
precio de lista de las líneas que el cupón descontó.

**Por qué es el más fiable de los seis:** se cruza por el **código**, que Shopify
obliga a que sea único en la tienda. No hay ambigüedad posible.

⚠️ Si sale 0, el log dirá por qué: es el único punto del que no tengo un payload
real. Ver §3.

#### 3 · BXGY — el que estaba roto

**Qué comprar:** lo que dispare la oferta (p. ej. 2 unidades para llevar 1).

**Qué tenés que ver:** 1 pedido atribuido a la campaña BxGy, y el
**descuento atribuido = el de la oferta y nada más**.

🔴 **Y lo que hay que mirar con lupa:** meté en el mismo carrito **otro
descuento** (otra campaña, o uno tuyo del panel nativo). La campaña BxGy tiene
que llevarse **solo su parte**. Si se lleva la suma de los dos, avisame y hago
rollback: es exactamente el riesgo que señalaste.

⚠️ **Y una cosa que vas a ver y que es esperada, no un bug:** en un «llevá 1
gratis», la **recaudación** atribuida sale igual al descuento (ROI 100%). Cuenta
solo las líneas que el descuento **tocó** —las del regalo—, que es lo que hace
imposible atribuir de más. Contar también las líneas «compra X» sería más útil de
leer y abre la puerta a lo contrario. **Es una decisión tuya**, está anotada como
pendiente.

#### 4 · MONTO DE COMPRA

**Qué comprar:** lo suficiente para pasar el umbral de la campaña.

**Qué tenés que ver:** 1 pedido atribuido, con la recaudación = **todo el
carrito** (es un descuento de orden: se reparte entre todas las líneas) y el
descuento = el del checkout.

🔴 **La prueba que pediste:** si tenés **dos** campañas de monto activas **con el
mensaje por defecto**, el pedido tiene que quedar **sin atribuir a ninguna**. Es
deliberado: son indistinguibles y preferimos el cero honesto. Para que atribuya,
ponéle a cada una un **mensaje distinto** y volvé a probar.

#### 5 · PACK

**Qué comprar:** un pack armado desde el widget.

**Qué tenés que ver:** 1 pedido atribuido con su descuento.

⚠️ Si aparece **con pedidos y recaudación pero con descuento 0 / ROI N/A**, el
cruce de la campaña funcionó y lo que falló es el título del que sale el
importe. No es un cero total y se arregla en una línea: el log trae el título
real.

#### 6 · CUPÓN AUTOMÁTICO

**Qué comprar:** lo que califique para una campaña de cupón en método
**automático** (sin escribir código).

**Qué tenés que ver:** 1 pedido atribuido. Y con **dos** cupones automáticos que
compartan mensaje, **ninguno** atribuye — igual que en monto de compra.

#### 7 · RANGO DE PRECIO

**Qué comprar:** un producto de una campaña de rango.

**Qué tenés que ver:** 1 pedido atribuido, con el descuento = la diferencia entre
el precio original y el que pagaste.

**Por qué va último:** comparte el bloque con Porcentaje, que atribuye 902
pedidos en Greta, y ya quedó verificado con test que escribe las mismas dos
columnas de las que depende el cruce. Es confirmación, no búsqueda.

---

## 3 · Si alguno sale 0, esto es lo que hay

Se quitó el `console.log("[tiered-attribution]")`, que estaba marcado como
TEMPORAL desde el **2026-07-25** y llevaba mes y medio escribiendo en **cada
pedido de las 6 tiendas**.

En su lugar hay **`[attribution-miss]`**, que **guarda silencio en el caso
normal** y solo escribe cuando un tipo tenía campañas activas y **no pudo
atribuir**. Cuando habla, trae el `type`, el `title` y el `code` **reales** de
cada aplicación de descuento del pedido.

🔴 **Es el dato que cierra la única incógnita que queda**: qué campos manda
Shopify en el payload para un descuento de **app con código**. El desglose del
pedido #1013 mostraba «PRODUCCION», que es el código, pero el desglose no es el
payload. Por eso el lector acepta el código **venga en `code` o en `title`** y no
filtra por `type`: son dos apuestas y fallar cualquiera daría un cero mudo.
Aceptar los dos no puede dar un falso positivo, porque el código es único.

⚠️ **Ese log solo se lee en Vercel, y el token está vencido.** Si algo sale 0,
decímelo y vemos: o renovás el token, o lo acotamos por descarte desde la app.

---

## 4 · Lo que se verificó antes de subir, y cómo

| | |
|---|---|
| **395 tests** verdes | 32 nuevos, todos de esto |
| **Typecheck 173** | Línea base medida **contra `HEAD`** con `git stash`, no asumida: **cero errores nuevos**, y ninguno en los archivos tocados |
| **Build** | Verde |
| **Bloque 1 (Porcentaje + Rango)** | **IDÉNTICO** byte a byte contra `HEAD` |
| **Bloque 3 (Escalonado)** | **IDÉNTICO** salvo el `console.log` quitado |
| **Bloque 4 (Packs)** | **IDÉNTICO**, 77 líneas = 77 líneas |
| **Atribuciones ya guardadas** | **No se pueden reescribir**: el `upsert` lleva `update: {}` |
| **Un pedido con varios descuentos** | Test dedicado: la campaña se lleva 48, no los 68 del pedido |
| **Sin app version** | Cero diff en `extensions/`, los 4 `*-calc.ts` y el `.toml` de prod |

Lo que **no** se puede verificar antes de producción, y por eso está en la §2:
que Shopify entregue el webhook y que los campos del payload sean los supuestos.

---

## 5 · Pendientes que deja

| | |
|---|---|
| 🔴 **Verificar los 6 tipos con pedidos reales** | La §2 |
| 🟡 **Decisión: qué recauda un BxGy** | Solo las líneas tocadas (hoy) vs también las «compra X» |
| 🟡 **`[attribution-miss]` no se puede leer** | Token de Vercel vencido |
| 🟡 Analítica por cupón, más allá del pedido atribuido | Con método automático no hay código que cruzar |
| 🟡 Atribución de packs en producción | Sigue dependiendo de un pedido real |
