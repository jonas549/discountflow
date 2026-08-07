# 🚀 HANDOFF — Barra de progreso por lotes (D1 + D2, 2026-08-07)

> **Todo en la rama `dev`. Producción no se tocó en ningún momento.**
> El handoff anterior, [`HANDOFF-2026-07-28-falso-positivo-skinup-y-blindaje.md`](HANDOFF-2026-07-28-falso-positivo-skinup-y-blindaje.md), sigue vigente para el estado de producción y el blindaje de los escalonados.

---

## ═══ QUÉ ES ESTO ═══

Crear, activar, pausar y eliminar campañas grandes tardaba minutos con la UI diciendo
solo «Guardando…». Los clientes creían que se había colgado. Peor: si Vercel mataba la
función a mitad, quedaban precios rebajados en unos productos y no en otros, **sin
rollback y sin que nadie se enterara**.

Ahora esas cuatro operaciones se trocean en lotes encadenados con progreso visible, y
una interrupción deja un estado **detectable y reanudable** en vez de invisible.

### El techo que no se puede bajar

El API de Shopify permite ~**5 mutaciones por segundo sostenidas** (bucket de 1.000
puntos, recuperación de 50 pts/s, ~10 pts por mutación). Una mutación = un producto.

| Catálogo | Productos | Suelo de Shopify |
|---|---|---|
| 500 variantes | 100 | 20 s |
| 6.000 variantes | 1.200 | 4 min |
| 20.000 variantes | 4.000 | **~13 min** |

**Ninguna arquitectura baja de ahí.** La barra no es un consuelo por no poder optimizar:
es la única solución posible. La competencia tiene barra por el mismo motivo.

---

## ═══ ARQUITECTURA ═══

```
Merchant pulsa "Crear y activar"
   │
   ├─ action crea CampaignJob (QUEUED) y responde en <500 ms con { jobId }
   │  waitUntil( POST /api/jobs/run )
   ▼
┌─ INVOCACIÓN LOTE #1 ──────────────────────────┐
│ 1. reclama el job (lease por UPDATE condicional)│
│ 2. responde 202 YA, trabaja en waitUntil        │
│ 3. resuelve/aplica hasta DEADLINE_MS (45 s)     │
│ 4. SUELTA el lease (-> QUEUED)                  │
│ 5. waitUntil( POST /api/jobs/run )              │
└──────────────────┬──────────────────────────────┘
                   ▼  … #2 … #N
   La UI sondea GET /api/jobs/:id/status al ritmo que le dicta el servidor.
   Si ve el latido rancio (>90 s), pide que lo despierten. Nunca procesa trabajo.
```

### Piezas y por qué

| Pieza | Por qué es así |
|---|---|
| **Lease por `UPDATE` condicional** | Dos workers simultáneos: uno afecta 1 fila, el otro 0. Sin ventana entre comprobar y escribir |
| **Sello `CampaignProduct.processedByJobId`** | "Lo que queda" es una CONSULTA, no un cursor. Reanudar es exacto aunque el catálogo cambie, y reprocesar es imposible |
| **`Campaign.activeJobId` con `@unique`** | Cerrojo de una operación por campaña. Diez clics simultáneos = un job |
| **Lote acotado por TIEMPO (45 s)** | Un número fijo de productos no significa nada constante: 20 productos pueden ser 20 o 2.000 variantes, y pueden entrar en backoff o no |
| **202 antes de trabajar** | Si el worker trabajara antes de responder, el `fetch` del lote anterior seguiría abierto en su `waitUntil` y la invocación #1 viviría hasta que acabara la #18 |
| **Origen derivado de la petición** | `SHOPIFY_APP_URL` del `.env` de desarrollo **apunta a producción**. Un motor que la leyera haría que cada lote de prueba golpease las tiendas de clientes reales |
| **Flag `jobs:batched` fail-closed** | Apagarlo devuelve el camino síncrono de siempre, intacto, en segundos y sin desplegar |

### 🔴 Tres trampas que ya mordieron — documentadas en el código

1. **`handOffToNextBatch` no es opcional.** Un lote que terminaba sin soltar el lease
   dejaba al siguiente retirándose con `busy`: **la cadena moría en silencio**, con el
   job aparentando estar vivo. Solo apareció al correr 20.000 unidades reales; con una
   tanda que cabe en un lote el fallo es invisible.
2. **`resetAttempts` decide si el freno funciona.** Reiniciar el contador tras un lote
   que revienta anula `MAX_ATTEMPTS` por completo y el job se re-patea para siempre —
   lo que agota la cuota de Hobby, donde agotarla **apaga el servicio hasta 30 días**.
3. **Cancelar entre lotes.** Entre lote y lote el job pasa por `QUEUED`, así que la
   mayoría de las cancelaciones se resuelven por la vía rápida de `requestCancel`, sin
   pasar por el runner. Si el revert compensatorio vive solo en el runner, **los precios
   ya aplicados se quedan rebajados sin que nadie lo sepa**.

---

## ═══ ALCANCE ═══

| Tipo | Crear | Activar | Pausar | Eliminar |
|---|---|---|---|---|
| **Porcentaje** | ✅ | ✅ | ✅ | ✅ |
| **Rango de precio** | ✅ | ✅ | ✅ | ✅ |
| **BxGy** | ❌ D3 | ✅ | ✅ | ✅ |
| **Escalonado** | ❌ D3 | ✅ | ✅ | ✅ |

El hueco está documentado en [`docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md`](docs/D3-PENDIENTE-crear-bxgy-tiered-sin-barra.md).
Resumen: TIERED no crea filas de `CampaignProduct`, así que su lista de productos no
tiene dónde acumularse entre lotes. Se aplazó para no tocar `tiered.ts` —el archivo que
despliega la Shopify Function— en la misma entrega que reescribe la ruta de precios.

### ¿Toca la Function?

# ✅ NO

Ni el Wasm ni `tiered-calc.ts`. Todos los despliegues de este trabajo son solo de
Vercel, con Instant Rollback disponible y sin la coreografía de orden del 28/07.

---

## ═══ CÓMO PROBARLO EN EL DEV STORE ═══

1. `npx shopify app dev`
2. Abre la app y cambia el final de la ruta por **`/app/jobs-demo`**.
3. El flag sale **APAGADO (fail-closed)** — es lo correcto. Pulsa **Encender**.
4. Ve a **Campañas → Descuento por porcentaje**, elige productos y **Crear y activar**.
5. Vuelves al listado y la campaña aparece con la **barra debajo de su fila**, más una
   franja fina bajo la navegación que la sigue por toda la app.
6. **La prueba que importa:** cierra la pestaña a mitad y vuelve a entrar. La barra
   reaparece **donde iba**.
7. Con un job en curso, los botones Editar/Pausar/Eliminar salen deshabilitados, y el
   `action` devuelve **409** aunque se salte la UI.
8. **Cancelar** a mitad → el job queda `CANCELLED` y arranca solo un **revert
   compensatorio** que deshace exactamente lo aplicado.
9. Para volver atrás: apaga el flag en `/app/jobs-demo` y todo vuelve al camino síncrono.

---

## ═══ PENDIENTES ═══

- 🔴 **`api.internal.pause-over-limit.tsx` ya está trackeado en `dev`**: el próximo merge
  a `main` **lo desplegaría**. Revisarlo antes de ese merge.
- 🟡 **D3**: crear BxGy/TIERED sin barra (documento aparte).
- 🟡 **Cron de campañas programadas**: `vercel.json` declara `/api/cron/sync-campaigns` y
  **la ruta no existe** → 404 cada medianoche desde siempre. Las campañas con fecha de
  inicio se guardan como **borrador y nunca arrancan**, y las que tienen fecha de fin
  **nunca se detienen**. Ahora que existe el motor, el cron debe encolar un job, no
  aplicar descuentos él mismo — y llevar dentro los dos checks de límite de plan.
- 🟡 Quitar los logs `[tiered-debug]` y `[tiered-attribution]`.
- 🟡 **Los tests del motor contra Neon son lentos y frágiles**: el branch `dev` del plan
  gratuito pasó de 69 ms a ~320 ms de RTT y llegó a cerrar conexiones a mitad de la
  batería. La palanca correcta no es acortar los tests, es **acercar la base** (Postgres
  local en contenedor). Ver la nota de `CORTE_UNIDADES` en `engine.dbtest.ts`.
