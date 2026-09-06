# ESTADO · última actualización 2026-09-06

> El archivo que hay que leer primero. Dice dónde está todo **hoy**, sin
> reconstruirlo de los handoffs. Si algo de acá contradice a un handoff viejo,
> manda esto.

---

## Dónde está el código

| | |
|---|---|
| **Producción (Vercel)** | 🟢 **`3d84c3f`** · despliega desde **`main`** · desplegado 2026-09-06 |
| App version en Shopify | 🟢 **`discountflow-10`** — 4 Functions + bloque de tema + `[app_proxy]` |
| **Ramas** | `main` = `dev` = **`3d84c3f`**, las dos pusheadas |
| Base de datos | Neon, ramas separadas. 🟢 **Las 3 migraciones aplicadas en el build** |
| Tests de la app | **344** verdes (`npm test` — es `node --test`, **no** vitest) |
| Fixtures contra el Wasm real | **81/81** · tiered 16 · pack 13 · order 16 · **cupón 36** |
| Typecheck | **173** (línea base 170) · solo `TS2345`, `TS2322`, `TS2367` |
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

## Pendientes vivos, por orden de lo que cuesta

| | |
|---|---|
| 🔴 Que Jonas pruebe **exclusión por monto** y **método automático** | Es lo único que frena el despliegue |
| 🔴 **`PLAN_SYNC_OBSERVACION=1` sigue puesta** | La degradación de plan está frenada. **No tocarla en la ventana del despliegue**: con F4, quitarla haría que las tiendas que Shopify tiene en `free` pierdan editar/reactivar sus BxGy |
| 🔴 **El cron de campañas programadas no existe** | `vercel.json` lo declara y la ruta no está: las campañas con `endsAt` **nunca se detienen solas** |
| 🔴 `/app/plans/confirm` escribe el plan desde la URL sin verificarlo | Cualquier merchant podría subirse de plan gratis |
| 🔴 **`Section` desmonta a sus hijos al plegarse** | Arreglado **solo en el cupón**. En los otros **seis** formularios, plegar una sección borra sus campos en silencio. `tiersJson` de monto de compra es el más caro. §5-BIS del plan |
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
| 2026-09-06 | `PLAN-DESPLIEGUE-2026-09-06.md` · `HANDOFF-2026-09-06-cupon-completo.md` |
| 2026-09-05 | `HANDOFF-2026-09-05-tres-tipos-de-campana.md` · `HANDOFF-2026-09-05-packs-F1-F2-F3.md` |
| 2026-09-01 | `HANDOFF-2026-09-01-caso-116943.md` |
| 2026-08-09 | `HANDOFF-2026-08-09-despliegue-produccion.md` |
| 2026-08-08 | `HANDOFF-2026-08-08-jobs-y-monto-fijo.md` · `SISTEMA-DE-COBRO.md` |
