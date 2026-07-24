# 📓 Sesión 2026-07-24 — Registro completo

> De montar el ambiente de desarrollo a desplegar el 4º tipo de campaña en producción, en un solo día.
> **13 commits · 37 archivos · +11.007 / −298 líneas.**
>
> Documentos relacionados: [`docs/PLAN-descuentos-escalonados.md`](../PLAN-descuentos-escalonados.md) (análisis técnico y registro por fases) · [`HANDOFF-2026-07-24.md`](../../HANDOFF-2026-07-24.md) (estado del ambiente dev).

---

## 0. Resumen de un vistazo

| | |
|---|---|
| **Ambiente dev** | Montado y funcionando (Neon branch + app Dev + dev store + rama Git) |
| **Feature nueva** | Descuentos Escalonados — 4º tipo de campaña, vía Shopify Functions |
| **Estado** | ✅ **EN PRODUCCIÓN** (Function `discountflow-6` activa + código desplegado + migración aplicada) |
| **Clientes afectados** | Greta Baby Kids (ESSENTIAL), NYZA (FREE), Vermú Moda (FREE) — **sin downtime, sin reautorización** |
| **Bugs encontrados y resueltos** | 7 |
| **Hallazgos documentados y NO tocados** | 3 |

---

## 1. Parte 1 — Ambiente de desarrollo separado

### Por qué era el P0
Tres hallazgos que explicaban por qué hasta ese día **trabajar en local ya tocaba producción**:

1. `shopify.web.toml` L7: el arranque corre `prisma migrate deploy` → cada `shopify app dev` migraba la BD del `.env`.
2. `.env` apuntaba a producción entera (Neon `ep-morning-block-aph2jfrg` + secreto de la app de prod).
3. `shopify.app.toml` L52 `automatically_update_urls_on_dev = true` con el `client_id` de producción → `shopify app dev` podía reescribir las URLs de la app de prod y romper el OAuth de los 3 clientes.

### Lo que se montó (Pasos 1–6)

| Recurso | Identificador |
|---|---|
| Branch Neon `dev` | `br-quiet-pine-ap25d3yl` · endpoint `ep-nameless-credit-ap5b1c49` · **schema-only** (sin datos de clientes → sin PII) |
| App Partner "DiscountFlow Dev" | `client_id 4e80c45a67c8b263d8b725d4c4c2ece0` |
| Dev store | `calendario-envios-test-final.myshopify.com` |
| Rama Git | `dev`, desde `main`, pusheada a `jonas549/discountflow` |

- **`shopify.app.dev.toml` escrito a mano.** Desviación: el CLI no puede correr `shopify app config link` de forma no interactiva en este entorno (stdin=null → *"Failed to prompt"*).
- **`.env` reemplazado** por credenciales 100% dev. Corregido de paso un bug viejo: faltaba `read_orders` en `SCOPES`.
- **Baseline de Prisma con `migrate resolve --applied`** en vez de `migrate deploy`: el branch era schema-only y ya tenía las tablas. `migrate diff` dio cero drift. Son **4** migraciones previas, no 3.
- **Backup del `.env` de producción** en `C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` (fuera del repo).

### Decisiones de arquitectura del entorno

- **Neon Free = 1 proyecto pero 10 branches** → se usa un *branch* `dev`, no un proyecto nuevo.
- **Vercel Preview descartado**: timeout de 60 s, retención de 30 días y config extra de OAuth por cada URL. Se trabaja en **local + túnel Cloudflare**.
- **Webhooks PCD comentados en `shopify.app.dev.toml`** (`orders/create` + los 3 GDPR) para poder instalar la app Dev sin la aprobación de Protected Customer Data. **Solo en dev**: `shopify.app.toml` conserva los 6.

---

## 2. Parte 2 — Descuentos Escalonados: análisis y arquitectura

### Qué se pidió
Un 4º tipo de campaña con niveles por cantidad y **dos modos**:

- **MODO A · UNIFORME** — al alcanzar el nivel, TODAS las unidades reciben ese %.
  `3 × $100 con 1→10%, 2→15%, 3→20%` → los 3 al 20% → **paga $240**
- **MODO B · INCREMENTAL** — cada unidad lleva su propio % según su posición.
  Mismo carrito → 10% + 15% + 20% → **paga $255**

### El hallazgo que cambió la estimación
El análisis previo estimaba **L/XL**. Al leer el código real: **el repo ya tenía el 70% de las piezas**, porque BxGy **no** edita precios de variantes — usa `discountAutomaticBxgyCreate`, un descuento automático gestionado por Shopify. Ya existían y estaban probados en producción: crear/pausar/reactivar/eliminar descuentos automáticos, el resolver de colección→product IDs, el `SelectionPanel`, el layout con preview, y `"workspaces": ["extensions/*"]` ya declarado.

Lo genuinamente nuevo era **una sola cosa**: la Function. Estimación revisada: **32–45 h**.

### Decisiones de arquitectura

**1. La Function no puede saber de colecciones.** Su input query es estático; no se le inyectan IDs en runtime. Solución elegida: **resolver a product IDs en el servidor** al activar (reutilizando la lógica que ya existía para BxGy) y guardarlos en el metafield.
> Coste aceptado: si el merchant añade un producto a la colección después, no entra hasta re-guardar. **Excepción feliz:** modo "toda la tienda" = lista vacía = aplica a todo, sin enumerar el catálogo (esto evita el problema de los 541 productos de Greta).

**2. Modo B no emite un descuento por unidad.** Varios candidates sobre la misma línea dependerían de cómo Shopify resuelve solapamientos, que no está garantizado. En su lugar: **se calcula el dinero y se emite un único `fixedAmount` por línea**. Resultado exacto, sin ambigüedad, y como el importe se deriva de `line.cost.amountPerQuantity` el multi-moneda sale correcto gratis.

**3. Regla de producto confirmada por Jonas:** en modo incremental, **el % más alto va a la unidad MÁS BARATA**. Cae sola del ordenamiento: como los tiers crecen con la cantidad, basta ordenar las unidades de más cara a más barata.

**4. Una sola fuente de verdad del cálculo.** `app/lib/discounts/tiered-calc.ts` es un módulo **sin dependencias** que corre en dos entornos: el preview del admin y la Function compilada a Wasm. El preview no puede mentir porque *ejecuta* la misma función que el checkout, no la replica.

**5. Aritmética en centavos enteros.** Sin esto, sumar descuentos por unidad acumula deriva de coma flotante y el preview acabaría discrepando del checkout por céntimos.

### Decisiones de producto confirmadas
1. **Solo carrito/checkout** en v1 — sin theme app extension. El precio en la página de producto **no cambia**; el aviso está en el panel de preview.
2. **Los dos modos en v1.**
3. **% mayor al producto más barato.**
4. **No arreglar el bug de atribución de BxGy** en este trabajo.

---

## 3. Parte 3 — Implementación, fase por fase

| Commit | Hora | Fase |
|---|---|---|
| `a29c5cd` | 15:43 | `shopify.app.dev.toml` + handoff + plan |
| `ac19360` | 15:43 | **Calculadora pura + 24 tests** |
| `ceb4169` | 15:55 | **Shopify Function** (Wasm) + fixtures |
| `d82ffc2` | 16:01 | **Migración**: `TIERED` en el enum |
| `a37caa8` | 16:02 | **Capa de servicio** (`discountAutomaticAppCreate` + metafield) |
| `c28f5cd` | 16:12 | **Rutas** crear/editar + integración en el listado |

### Fase 1 — Calculadora pura
`tiered-calc.ts` (~300 líneas, cero imports) + `tiered-calc.test.ts` con **24 tests**, incluidos los tres ejemplos del brief.
Runner: **`node --test` nativo** (Node v22.20) → **cero dependencias nuevas**. Añadidos `package.json` → script `test`, y `tsconfig.json` → `allowImportingTsExtensions` (inerte para el build de Vite).

### Fase 2 — La Function
Generada con `shopify app generate extension --template discount --flavor typescript` (el CLI **sí** acepta flags no interactivos, a diferencia de `config link`).
- La Function **no contiene lógica de cálculo**: importa `computeTiered` desde `app/lib/discounts/tiered-calc.ts`. El bundler de `shopify app function build` resuelve el import cruzado — verificado.
- **Se eliminó el target de envío** y su código de ejemplo: menos superficie que pueda tocar el checkout.
- **Regla de oro: la Function nunca lanza.** Config ausente, corrupta o modo desconocido → `{operations: []}`.
- Lee **dos namespaces** de metafield (`$app:discountflow` y `discountflow`) porque `MetafieldInput.namespace` solo documenta alfanuméricos, guiones y guiones bajos. La app escribe en el plano.

### Fase 3 — Migración
```sql
ALTER TYPE "CampaignType" ADD VALUE 'TIERED';
```
Dos líneas. Sin `DROP`, sin `RENAME`, sin cambios de tipo, **sin tocar una sola fila**. La config del nuevo tipo va en el campo `config Json` que ya existía.

### Fase 4 — Capa de servicio
- `getTieredFunctionId()` localiza la Function en la tienda — **no se hardcodea**: dev y prod tienen IDs distintos.
- `resolveTieredProductIds()` traduce la selección a product IDs; `"all"` devuelve **lista vacía** a propósito.
- `create/update` vía `discountAutomaticAppCreate/Update` con `discountClasses: [PRODUCT]` y `combinesWith` todo en `false`.
- **No se refactorizó `bxgy.ts`**: esa ruta está en producción con clientes reales. Las 3 mutaciones genéricas se duplican, con el porqué escrito en el código.

### Fase 5 — Rutas y UI
- **`TieredCampaignForm.tsx`**: formulario compartido por crear y editar. Se hizo así en vez de clonar la ruta entera (como pasa hoy con BxGy, donde `new` y `edit` son casi el mismo archivo dos veces): ahorra ~600 líneas duplicadas.
- El selector de modo explica la diferencia con **los niveles reales que el merchant acaba de escribir y números concretos**: los mismos niveles dan "paga $240" en uniforme y "paga $255" en incremental.
- En `app.campaigns._index.tsx`: 4ª tarjeta, etiqueta en la tabla, `editHref` y las tres ramas de acciones. **+86 / −0 líneas: ninguna rama de PERCENTAGE, RANGE o BXGY fue modificada.**

---

## 4. Parte 4 — Los 7 bugs (con su root cause real)

### 🐛 1 · `Invalid value for argument type. Expected CampaignType`
**No era código.** El `shopify app dev` llevaba corriendo desde antes de la migración: tenía en memoria el cliente Prisma anterior al enum `TIERED`, y además era quien bloqueaba `query_engine-windows.dll.node`, lo que hizo fallar el `prisma generate` con `EPERM` a mitad (índices nuevos, `schema.prisma` viejo).
**Fix:** parar el dev server → `npx prisma generate` → arrancar de nuevo.

### 🐛 2 · `Field 'handle' doesn't exist on type 'ShopifyFunction'` — `e046fcd`
`ShopifyFunction.handle` **no existe en la Admin API 2025-10**, a la que está pineada la app (`ApiVersion.October25`); el schema de referencia disponible era de una versión posterior.
**Fix:** pedir solo `id`, `title` y `apiType`, y emparejar en cascada (título → apiType → descarte). El error ahora **lista las Functions que sí vio**.

### 🐛 3 · Solo una línea del carrito recibía el descuento — `c8b9d71`
Carrito con 3 líneas elegibles ($36, $108, $46): el tier del 20% se alcanzaba bien pero **solo el de $108 se descontaba**.
**Root cause:** no era el conteo ni los targets. La Function generaba los 3 candidates correctos. El fallo era `selectionStrategy: First` — *"apply the FIRST discount candidate"*. Se le mandaban 3 candidates correctos con la instrucción de usar solo uno; sobrevivía el de mayor reducción.
**Fix:** `First` → `All`, con comentario en el código para que no se revierta.
> **Por qué las fixtures no lo cazaron:** comparan el JSON que **devuelve** la Function, no lo que Shopify **hace** con él. Se añadió `uniform-tres-lineas-una-unidad.json`, que reproduce el carrito real y fija `selectionStrategy: "ALL"` como parte del contrato esperado.
> **Nota:** esa línea es compartida por los dos modos; INCREMENTAL tenía el mismo bug latente.

### 🐛 4 · El modo INCREMENTAL no se aplicaba — `b41af8c`
Al cambiar una campaña a incremental, el carrito seguía comportándose como uniforme, **sin ningún mensaje de error**.
Descartado primero: el modo **no vive en el Wasm** sino en el metafield. Descartado después: el cálculo (verificado con los números reales → $30.60 / $97.20 / subtotal $127.80, correcto).
**Root cause:** el manejo de errores solo miraba `json.data?.<mutación>?.userErrors`. Cuando una mutación falla **a nivel GraphQL**, Shopify devuelve `data: null` y el mensaje en `json.errors`, que no se leía. El encadenamiento opcional daba `false`, no se lanzaba excepción, se guardaba en la BD y se redirigía como si todo hubiera ido bien: `INCREMENTAL` en Postgres, `UNIFORM` en Shopify.
**Fix:** helper `runDiscountMutation()` que comprueba **las tres formas de fallar** (`json.errors`, ausencia de `data[root]`, `userErrors`) en las cinco mutaciones del archivo.

### 🐛 5 · `P1001 — Can't reach database server` (Neon)
**No había nada mal configurado.** El branch dev de Neon estaba **suspendido por inactividad** (plan Free). La prueba: `migrate status` tardó **11,1 s** (arranque en frío) contra un `connect_timeout` por defecto de Prisma de **5 s**. Verificado: DNS resuelve (A y AAAA), TCP 5432 abierto, `.env` correcto y sin rastro de prod.
**Arreglo duradero propuesto (NO aplicado, pendiente de decisión):** añadir `&connect_timeout=20` a `DATABASE_URL` y `DIRECT_URL`.

### 🐛 6 · `shopify app release` — `Flag not specified: allow-updates`
Artefacto de terminal no interactiva: el CLI exige la confirmación como flag explícito. **No se improvisó**; Jonas liberó la versión desde el Partner Dashboard.

### 🐛 7 · El push a `main` no disparó el deploy de Vercel
Detectado con un sondeo de rutas: `/app/campaigns/new/tiered` devolvía **404 igual que una ruta inexistente**, mientras `/percentage` sí respondía → código viejo sirviendo.
**Resuelto** con un commit vacío (`bb74f26`).
> ⚠️ Jonas puso el repo en **público** creyendo que esa era la causa. **Vercel despliega repos privados sin problema** — es la configuración normal. Cambiaron dos cosas a la vez, pero por cómo funciona la integración lo más probable es que lo destrabara el push nuevo. **Recomendación: volver a privado** y comprobar que el siguiente push sigue desplegando; si no, mirar Vercel → Settings → Git.

---

## 5. Parte 5 — Paridad, revert y verificación en dev store

### Verificación end-to-end en la dev store ✅
| Carrito | Resultado |
|---|---|
| 3 uds ($36 + $108 + $46), uniforme | las 3 al 20% → $28.80 + $86.40 + $36.80 = **$152.00** |
| 2 uds ($36 + $108), uniforme | ambas al 15% → $30.60 + $91.80 = **$122.40** |
| 2 uds, incremental (esperado) | $30.60 + $97.20 = **$127.80** |

### `d58a58c` — Paridad con los otros 3 tipos
- **Tarea 1** — activar borradores: replicado el bloque `shouldActivate` de los otros 3 tipos.
- **Tarea 2** — atribución en Analytics (**Opción A**): bloque nuevo en `webhooks.orders.create.tsx`, **+80 / −0 líneas**. Cruza por el **título real** vía `matchesTieredDiscountTitle()` y calcula el importe desde las **`discount_allocations`** filtradas por `discount_application_index`, no desde `total_price`/`total_discounts` (que inflarían el ROI).
- El formato del título quedó centralizado en `tiered-client.ts`. *(Al centralizarlo, el primer reemplazo solo cogió una de las dos ocurrencias por indentación distinta; se detectó revisando el `numstat` y se corrigió. Era la misma trampa que rompió la atribución de BxGy.)*

### `64b8d23` — Revert de la Tarea 1
A petición de Jonas. `edit_.tiered.tsx` restaurado **byte a byte** con `git checkout d58a58c^ --`; verificado con `git diff` vacío y grep sin rastros. **La Tarea 2 se conservó intacta.**

### 🔎 Hallazgos documentados y NO tocados
1. **Atribución de BxGy rota.** El descuento se crea como `[DiscountFlow] ${nombre}` y el webhook compara contra `campaign.name` pelado → nunca coincide. Existe desde el primer commit de BxGy (21/05). Afecta solo a la tabla interna de Analytics, no al descuento del cliente. **Decisión de Jonas: no se arregla.**
2. **El límite de variantes es decorativo en los 4 tipos.** `getVariantCount()` solo alimenta la UI; `es.planes.limiteVariantes` está definido y nunca se invoca. **Fuera de alcance.**
3. **Un borrador escalonado no se puede activar.** El listado solo reactiva campañas `PAUSED` y la edición no cambia el estado. Los otros 3 tipos sí lo permiten. **Pendiente de decisión.**

---

## 6. Parte 6 — Deploy a producción

### Pre-vuelo (solo lectura)
- **Config de producción:** `shopify.app.toml` sin cambios desde el 25/05. Evidencia concluyente: archivo editado 14:16:44 → `deploy-bundle` 14:17:16 → commit 14:17:29. Editar, desplegar y commitear en 45 segundos.
- **`git diff main..dev -- shopify.app.toml` → VACÍO.** Scopes idénticos → **ningún cliente reautoriza**. Los 6 webhooks intactos, incluidos los 3 GDPR con `compliance_topics`.
- **Separación dev/prod** confirmada por `client_id` (`cca497b9…` vs `4e80c45a…`).
- **Riesgo detectado y no previsto en el plan:** con la config de producción activa, correr `shopify app dev` en vez de `deploy` reescribiría `application_url` de la app de prod y **rompería el OAuth de los 3 clientes**. Mitigación: los tres comandos seguidos, sin nada en medio.

### Cronología del deploy

```
22:04   shopify app deploy --no-release   → "New version created: discountflow-6"  (inactiva)
        Verificado: App "DiscountFlow" (prod), discountflow-5 seguía ★ active
        → PARADA: se detecta que --no-release NO retiene la UI, solo la Function.
          Merge invertido: liberar primero, mergear después.

22:15   Jonas libera discountflow-6 desde el Partner Dashboard  → ★ ACTIVE

17:48   git merge --ff-only dev → 83efba4..64b8d23  main -> main   (fast-forward)
        6 sondeos HTTP en 2 min → todos 200. Cero downtime.
        → El deploy de Vercel NO se dispara.

18:30   git commit --allow-empty + push  → 64b8d23..bb74f26

18:30–18:33   /app/campaigns/new/tiered → 404 (código viejo)
18:34:04      /app/campaigns/new/tiered → deja de dar 404   ← NUEVO DEPLOYMENT ACTIVO
```

### Verificación final
| Ruta | Resultado |
|---|---|
| `/app/campaigns/new/percentage` | existe (control positivo) |
| **`/app/campaigns/new/tiered`** | **existe** ✅ |
| **`/app/campaigns/$id/edit/tiered`** | **existe** ✅ |
| `/app/campaigns/new/zzz-inexistente` | 404 (control negativo) |

**La migración se aplicó, y es demostrable:** `vercel.json` define `buildCommand: "npm run setup && npm run build"`, y `setup` es `prisma generate && prisma migrate deploy`. Con `&&`, el build solo llega a compilar si `migrate deploy` sale con código 0. Como el código nuevo está sirviendo, la migración corrió sin error contra la BD de producción.

---

## 7. Estado final

| Componente | Estado |
|---|---|
| Function `tiered-discount` | ★ **activa** en producción (versión `discountflow-6`) |
| Código | desplegado en Vercel (`bb74f26`) |
| Migración `add_tiered_campaign_type` | aplicada a la BD de producción |
| `main` | `bb74f26` |
| `dev` | `64b8d23` (+ el commit vacío solo vive en `main`) |
| Campañas de los 3 clientes | **intactas**, sin downtime, sin reautorización |

**Cobertura de pruebas:** 24 tests de la calculadora (`npm test`) + 7 fixtures contra el Wasm compilado (`npx vitest run` en `extensions/tiered-discount`).

---

## 8. Pendientes

### Inmediato
1. **Validar la atribución con un pedido real.** Crear un escalonado, hacer un pedido y buscar en Vercel → Logs:
   `[tiered-attribution] títulos recibidos: [...] | campañas activas: [...]`
   Si es `[DiscountFlow] <nombre>` → funciona. Si llega otra cosa (p. ej. `"Descuento por cantidad"`, el `message` de la Function) → **ajuste de una línea** en `matchesTieredDiscountTitle()` dentro de `tiered-client.ts`, único sitio donde vive ese formato.
2. **Quitar el `console.log("[tiered-attribution] …")`** una vez validado.
3. **Confirmar en Vercel** que `bb74f26` figura como *Ready / Production Current*.

### Seguridad
4. **Volver el repo a privado** y verificar que el siguiente push sigue desplegando.
5. **Quitar la línea 38 de `HANDOFF-2026-07-24.md`**: contiene el secreto **truncado** de la app **Dev** (8 caracteres, no utilizable) y el repo estuvo público. **Rotar ese secreto** por higiene.
6. **Pendiente desde el montaje del ambiente dev:** rotar `SHOPIFY_API_SECRET` de **producción** y la contraseña de **Neon**; mover el backup `C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` a un gestor y borrarlo.

### Técnico
7. **`connect_timeout=20`** en `DATABASE_URL`/`DIRECT_URL` de dev (evita el `P1001` tras cada suspensión de Neon). Producción tiene la misma fragilidad.
8. **PCD para la app Dev** → descomentar `orders/create` en `shopify.app.dev.toml` y poder probar la atribución en dev.
9. `npm run typecheck` **ya venía rojo** en 14 archivos por versiones duplicadas de `@shopify/shopify-api`. Tapa errores reales.
10. Decidir sobre los 3 hallazgos documentados (§5).

---

## 9. Rollback disponible

| Nivel | Acción |
|---|---|
| 1 | Pausar/eliminar la campaña escalonada desde la app. Los otros 3 tipos ni se enteran. **Resuelve el 95%.** |
| 2 | Vercel → Instant Rollback a **`2SZwoqemZ` / `83efba4`**. ⚠️ **Antes**, eliminar cualquier campaña TIERED: el código viejo no tiene ramas TIERED y pausarla no desactivaría el descuento en Shopify. |
| 3 | Partner Dashboard → liberar **`discountflow-5`** (un clic). Desactiva la Function. |
| — | **La migración NO se revierte.** Un valor de enum sin usar no molesta; quitarlo en Postgres exige recrear el tipo. **Forward-fix siempre.** |

---

## 10. Lecciones de la sesión

1. **El schema de referencia disponible es el de la última versión, no el de 2025-10.** Dos bugs salieron de ahí (`handle`, y el susto con `functionId`). Cualquier campo nuevo hay que verificarlo contra la tienda real.
2. **Los tests de la Function validan lo que devuelve, no lo que Shopify hace con ello.** El bug de `selectionStrategy` era invisible para las fixtures. Hay una clase de fallo que solo aparece en una tienda.
3. **Un error tragado cuesta más que un error ruidoso.** El fallo del modo incremental era indetectable porque el código miraba una sola de las tres formas en que una mutación GraphQL puede fallar.
4. **Duplicar un literal en dos archivos es cómo nacen los bugs silenciosos.** Es exactamente el origen del bug de atribución de BxGy, y volvió a aparecer al centralizar el título.
5. **Una sola fuente de verdad para el cálculo** (`tiered-calc.ts`) hace que el preview del admin no pueda mentir sobre lo que hará el checkout.
6. **Separar el despliegue de la Function del despliegue del código** es lo que permitió publicar sin exponer nada a los clientes hasta el momento elegido — pero hay que recordar que `--no-release` retiene la Function, **no la interfaz**.

---

*Sesión del 2026-07-24. Producción intocada salvo en los pasos explícitamente aprobados.*
