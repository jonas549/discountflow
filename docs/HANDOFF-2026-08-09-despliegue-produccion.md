# HANDOFF — Despliegue a producción del 2026-08-09

> Escrito para alguien que no vivió el día. No hace falta contexto previo para retomar.
> Todo lo que se afirma acá está confirmado, salvo lo que diga explícitamente "no confirmado".

---

## 1. ESTADO DE PRODUCCIÓN AHORA (después de hoy)

| Pieza | Estado |
|---|---|
| Vercel (web) | **`3969f0d`**, `Ready` y `Production Current` (antes del día era `5bcddba`) |
| Shopify Function | **`discountflow-8` activa** (antes era `discountflow-7`) |
| Migraciones | Las dos nuevas **aplicadas** en el build de Vercel: `20260807120000_add_campaign_jobs` y `20260808180000_job_survives_campaign` |
| Rama `main` = `dev` | Ambas en **`3969f0d`** |
| Flag `jobs:batched` | **ENCENDIDO en las 6 tiendas** (`UPDATE 6` confirmado) |
| Config local del CLI | De vuelta en **dev** (`shopify.app.dev.toml`) — seguro correr `shopify app dev` |

**Las 6 tiendas de producción** (antes se hablaba de 4-5; son **6**):

| Tienda | ¿Paga? | Nota |
|---|---|---|
| Greta Baby Kids | Sí | Campañas de porcentaje |
| SkinUp | Sí | Tiene la única campaña escalonada viva (ver abajo) |
| **Nachin** | **Sí** | **Instaló el 4 de agosto**, plan ESSENTIAL. Es la 6ª tienda |
| NYZA | No | |
| Vermú Moda | No | |
| calendario-envios-test-final | — | **La tienda de prueba de Jonas** (es también su dev store). 1000 productos importados |

### Corrección importante sobre SkinUp

Los handoffs viejos hablan de una campaña escalonada llamada **"Mudrad 2"**. **Esa campaña ya no existe: se desactivó hace ~dos semanas.** La campaña escalonada **viva** en producción hoy es **"Radiesse Day"** (SkinUp), incremental 15/20/25. Donde un handoff viejo diga "Mudrad 2 es la única escalonada viva", léase **"Radiesse Day"**.

### Rollback (si algo aparece mal en las próximas horas)

El orden se invierte respecto al despliegue: **Vercel primero, Function después.**
1. Vercel: Instant Rollback al deployment de **`5bcddba`**.
2. Function: `shopify app config use shopify.app.toml` → `shopify app release --version=discountflow-7 --force` → `shopify app config use dev` (volver a dev inmediatamente).

Las migraciones son aditivas: **no se revierten**.

### Apagado de emergencia del motor (sin desplegar, en segundos)

Mientras la barra siga siendo un flag (ver §4), el botón de pánico es un `UPDATE` a la base de **producción**:
```sql
-- Apaga el motor en TODAS las tiendas → vuelven al camino síncrono de siempre:
UPDATE "Shop" SET features = features - 'jobs:batched';
```
Apaga la **entrada** (operaciones nuevas vuelven al camino síncrono). **No detiene jobs en vuelo** — por diseño, terminan solos para no dejar estados a medias.

---

## 2. QUÉ SE HIZO HOY

### 2.1 Despliegue de la Function → `discountflow-8`
Se subió y activó la Function nueva (trae los escalonados por monto fijo, que tocan el Wasm). Secuencia: `config use shopify.app.toml` → `deploy --no-release` → `release --version=discountflow-8` → `config use dev`.

**Verificación en carrito real (SkinUp):** campaña "Radiesse Day", incremental 15/20/25, producto de $600.000 × 3 unidades → descuento $360.000, total **$1.440.000**. Exacto (90.000 + 120.000 + 150.000 = 360.000).

### 2.2 Despliegue de Vercel → `3969f0d`
`git merge --ff-only dev` sobre `main` + `git push`. Quedó `Ready` y `Production Current`. Greta, SkinUp y Nachin abren normal, precios sin cambios. Las dos migraciones aplicaron en el build.

### 2.3 Validación del motor EN PRODUCCIÓN (tienda de prueba de Jonas, 1000 productos)
Con el flag encendido solo en `calendario-envios-test-final`:
- **Pruebas chicas:** crear, activar, pausar, eliminar, recrear. La barra apareció y cerró sola en todas.
- **Campaña de porcentaje sobre toda la tienda:** 1139 variantes / 1065 productos. La barra avanzó por tandas (pasó el corte de 300 productos varias veces) y completó al 100%. Campaña activa.
- ⭐ **Pausar esa campaña grande** (la prueba que más preocupaba): completó, y se verificó en Productos que **ningún producto quedó rebajado**. Sin estados a medias.
- **Eliminar:** completó bien.

**Conclusión:** el motor está probado en producción, no en teoría. Pero **solo en la tienda de prueba**. Las otras 5 tiendas tienen el flag encendido desde hoy pero **no se ejercieron sus operaciones con el motor todavía** (no confirmado que alguna haya operado). Ver §5 (qué vigilar).

### 2.4 Encendido general
`UPDATE "Shop" SET features = features || '{"jobs:batched": true}'::jsonb;` (sin WHERE) → `UPDATE 6`. Las 6 tiendas quedaron con la barra activa.

### 2.5 Arreglo menor incluido en el deploy
`app/routes/app.jobs-demo.tsx`: el banco de pruebas del motor devuelve **404 en producción** (loader y action). Antes era alcanzable tecleando la URL. La franja verde del listado y su toggle ya estaban protegidos con `canToggleJobsFlag = !isProduction`.

---

## 3. 🔴 PENDIENTE PRINCIPAL PARA LA PRÓXIMA SESIÓN: la barra pasa a ser NATIVA

**Decisión de Jonas:** la barra deja de ser un flag por tienda y pasa a ser comportamiento **nativo** de la app: siempre activa, para todos, sin interruptor por tienda. Cuando cualquier merchant instale la app, la barra viene por defecto. El flag por tienda era para probar; como forma de lanzar **no escala** (con 11.000 clientes habría que encenderlo 11.000 veces, y cada tienda nueva nacería sin barra).

### Diagnóstico (ya hecho, para implementar en la próxima pasada)

**El flag se lee hoy en tres lugares independientes:**
- `app/lib/jobs/enqueue.server.ts:30` — el gate. Si no encola, el caller cae al camino síncrono.
- `app/routes/app.campaigns.new.percentage.tsx:155` (`conBarra`), usado en la línea 162.
- `app/routes/app.campaigns.new.range.tsx:165` (inline).

**El riesgo de doble aplicación está solo al CREAR** (porcentaje y rango): el `status` inicial de la campaña (`DRAFT` vs `ACTIVE`) tiene que coincidir con lo que decide el `enqueue`. Si nace `ACTIVE` pero el motor también encola, la campaña queda anunciada como activa **y** el job la aplica encima. Hoy no pasa porque los tres leen el mismo `hasFeature`. Pausar/activar/eliminar (`app.campaigns._index.tsx`) dependen de un solo punto (el enqueue), ahí no hay nada que sincronizar.

**Qué hacer:**
1. **Colapsar los tres puntos en una sola función** (ej. `motorActivo(shop)`), fuente única de verdad. Así la doble aplicación es **imposible por construcción**, no por disciplina. No poner `true` suelto en tres sitios: eso deja tres lugares que alguien puede desincronizar mañana.
2. **Mantener UN kill-switch global de emergencia** que haga caer todo al **camino síncrono** (que ya existe y está probado; es el fallback natural). Implementarlo como **una fila de config en la base** (no una env var), para poder apagar en **segundos** sin desplegar. Default: motor encendido.
   - 🔴 **Si la lectura del kill-switch falla** (hipo de base), **fallar hacia el MOTOR, no hacia el síncrono.** Un error transitorio no debe disparar el modo de emergencia solo.
3. **Qué probar (dirigido, NO la batería entera):** solo la **anti-doble-aplicación al crear** — crear+activar una campaña de porcentaje y una de rango por el camino nativo y confirmar que nace `DRAFT` y el job la activa **una sola vez**. Más una pasada rápida de pausar/eliminar por el motor. No hace falta repetir volumen, cálculos de descuento, ni los 4 tipos (ya validados hoy y en dev).
4. **El `{"jobs:batched": true}` de las 6 tiendas queda como dato muerto** tras el cambio (ya nadie lo lee). Opcional de limpiar con un `UPDATE`. No causa estado raro.

**Cuándo:** su propia pasada, con su QA en dev antes de ir a prod. No se hizo hoy a propósito (ya había sido un día completo de despliegue; meter código nuevo al final es el clásico "una cosa más" que rompe días buenos).

**Nota de estado:** hoy el flag quedó encendido en las 6 con el `UPDATE`, así que el objetivo "todos tienen la barra" **ya está cumplido**. El cambio a nativo es para que **escale** (tiendas nuevas, y no depender de un `UPDATE` manual). El problema de "las tiendas nuevas nacen sin barra" no muerde en los pocos días hasta la pasada: si entra una tienda nueva, nace en el camino síncrono (sano, el de siempre), no en un estado roto.

---

## 4. EL RESTO DE PENDIENTES (traídos de handoffs anteriores, con estado a hoy)

### 🔴 Cron de campañas programadas — cuesta dinero, sin tocar
`vercel.json` declara la ruta `/api/cron/sync-campaigns` y **la ruta no existe** → 404 cada medianoche. Dos mitades:
- `startsAt` no activa: las campañas programadas se guardan `DRAFT` y **nunca arrancan**.
- **`endsAt` no finaliza: la campaña no para nunca, sigue descontando pasada su fecha.** Esta es la que cuesta margen de forma continua.

**No se tocó hoy.** Alcance en producción **no medido** (la consulta para medirlo está en el handoff del 07/08). Cuando se haga: el cron debe **encolar un job**, no aplicar descuentos él mismo, y llevar los dos checks de límite de plan.

### 🟡 Campo de PORCENTAJE con el bug del separador decimal
El campo de porcentaje tiene el mismo bug del decimal que ya se arregló en el campo de monto (un `<input type="number">` controlado que resetea al teclear el separador). **Decidido arreglarlo, no hecho.** Son dos líneas usando el `DecimalInput` que ya existe (`app/lib/decimal-input.ts`) + tope de 99. **Necesita su propia pasada de QA** (no se hizo hoy).

### 🟡 D3 — crear BxGy/TIERED sin barra
El motor cubre **crear** solo Porcentaje y Rango. **Crear** BxGy o Escalonado **NO usa la barra** aunque el flag esté encendido: nacen por el camino síncrono. Activar/pausar/eliminar de esos tipos sí usan el motor (son una sola mutación, la barra ahí es cosmética). El caso real pendiente es crear un TIERED sobre un catálogo enorme. Detalle y opciones en `docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md`. **Sin cambios hoy.**

### 🔴 Seguridad — pendiente desde julio, sin tocar
- **El repo de GitHub** (`github.com/jonas549/discountflow`): la memoria lo marca como **público**; **no confirmado hoy**. Si es público, volver a privado.
- **Backup del `.env` de producción** en `C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` (claves de prod en texto plano en el escritorio). Mover a un gestor y borrar.
- **Rotar secretos:** `SHOPIFY_API_SECRET` de prod, contraseña de Neon, secreto de la app Dev.

### 🟡 Vercel Pro — ahora más relevante
Producción sigue en **Vercel Hobby**. Hobby **apaga el servicio hasta 30 días** si se agota la cuota de invocaciones. Con el motor **ahora encendido en las 6 tiendas**, un job que entrara en bucle podría quemar cuota y tumbar la app para todos. El `MAX_ATTEMPTS = 5` está para evitarlo, pero **subir a Pro elimina el riesgo de raíz** (y sin Fluid compute el `DEADLINE_MS = 45s` tendría que bajar a ~20s). Recomendado.

### 🟡 Logs de debug temporales — quitar
Siguen en el código: `[tiered-debug]`, `[tiered-attribution]`, y `[plan-sync]` (este último es ruidoso, imprime en cada carga de `/app`). Limpiar cuando se pueda.

### ⏸️ Agujero de `/app/plans/confirm` — EN PAUSA por decisión de Jonas
`/confirm` escribe el plan del parámetro de la URL sin verificarlo contra Shopify. **Confirmado y reproducido en dev el 2026-08-09.** Un merchant podría subirse de plan sin pagar tecleando la URL; el sondeo no lo corrige (la salvaguarda anti-degradación lo mantiene). **No es explotable por accidente** (requiere teclear la URL a mano), por eso es compatible con cero reportes en un año. **Decisión: no arreglarlo todavía.** El diseño del arreglo (verificar contra Shopify + reintentos por el desfase post-cobro, sin tocar la cancelación) está escrito en `docs/SISTEMA-DE-COBRO.md` §1, marcado como "decidido pero pospuesto". Se retoma después de este despliegue.

---

## 5. QUÉ VIGILAR EN LAS PRÓXIMAS 24-48 HORAS

- **Logs de Vercel**, buscando excepciones nuevas del motor (`chain`, `runner`, `campaign-ops`). Con las 5 tiendas de cliente recién pasadas al motor, es donde puede aparecer algo que la tienda de prueba no mostró.
- **Excepciones de `readQueryData`**: desde el 28/07 lanza en vez de tragarse los fallos. Lo que aparezca son **fallos reales que antes pasaban desapercibidos**, no regresiones.
- 🔴 **Consumo de invocaciones**: si aparece una lluvia de llamadas a `/api/jobs/run` o jobs re-encolándose, es el síntoma de un bucle que puede quemar la cuota Hobby. Si pasa: apagar el motor (`UPDATE` de §1) y revisar.
- **Que las campañas existentes de los clientes que pagan** (Greta, SkinUp, Nachin) sigan bien cuando las pausen/editen/eliminen — ahora esas operaciones van por el motor, camino que en prod solo ejerció la tienda de prueba.

---

## 6. DATOS DE REFERENCIA RÁPIDA

- **Constantes del motor** (`app/lib/jobs/constants.ts`): corte por lote = 45s / 300 productos / 3000 variantes, lo que llegue primero. `MAX_ATTEMPTS = 5`. `LEASE_STALE_MS = 90s`.
- **Client IDs:** producción `cca497b9abcf56c14d019ee24d0260d5` (`shopify.app.toml`, name "DiscountFlow"); dev `4e80c45a67c8b263d8b725d4c4c2ece0` (`shopify.app.dev.toml`, name "DiscountFlow Dev").
- 🔴 **`app/lib/discounts/tiered-calc.ts` vive en `app/` pero se compila DENTRO del Wasm.** Cualquier cambio ahí obliga a redesplegar la Function, aunque el diff no toque `extensions/`.
- **La base de dev y la de prod son branches separados de Neon.** El `.env` del repo apunta a **dev**. Para tocar prod hay que apuntar a la rama `main` de Neon a propósito. Guardia: `SELECT count(*) FROM "Shop"` → dev = 1, prod = 6.
