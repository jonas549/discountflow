# 🚀 HANDOFF — Descuentos Escalonados en producción (2026-07-24, cierre de jornada)

> **Este es el handoff vigente.** El anterior (`HANDOFF-2026-07-24.md`) cubre solo el montaje del ambiente dev y quedó obsoleto a media jornada.
> Registro completo de la sesión: [`docs/sesiones/2026-07-24-escalonados-y-deploy-produccion.md`](docs/sesiones/2026-07-24-escalonados-y-deploy-produccion.md)
> Análisis técnico y decisiones de la feature: [`docs/PLAN-descuentos-escalonados.md`](docs/PLAN-descuentos-escalonados.md)

---

## ═══ ESTADO DEL LANZAMIENTO ═══

**Descuentos Escalonados (4º tipo de campaña) YA ESTÁ EN PRODUCCIÓN.**

| Pieza | Estado |
|---|---|
| Function de Shopify | **`discountflow-6` ★ activa** (liberada hoy desde el Partner Dashboard) |
| Código | mergeado a `main` — **`0d138a2`**, incluye los logs `[tiered-debug]` |
| Vercel | desplegado y Ready |
| Migración `add_tiered_campaign_type` | aplicada a la BD de producción |
| `main` y `dev` | **idénticos**, ambos en `0d138a2` |

**Clientes:** sin downtime y sin reautorización (los scopes no cambiaron).

### Rollback disponible
| Nivel | Acción |
|---|---|
| 1 | Pausar/eliminar la campaña escalonada desde la app. Los otros 3 tipos ni se enteran. |
| 2 | Vercel → Instant Rollback a **`2SZwoqemZ` / `83efba4`**. ⚠️ Antes, eliminar las campañas TIERED: el código viejo no tiene ramas TIERED y pausarlas no desactivaría el descuento en Shopify. |
| 3 | Partner Dashboard → liberar **`discountflow-5`** (un clic). Desactiva la Function. |
| — | **La migración NO se revierte.** Forward-fix siempre. |

### ⚠️ Pendiente de seguridad
El repo de GitHub **se puso PÚBLICO** para que Vercel desplegara.

> Nota técnica: **Vercel despliega repos privados sin problema** — es la configuración normal. Cambiaron dos cosas a la vez (visibilidad y un commit vacío de trigger), y por cómo funciona la integración lo más probable es que lo destrabara el push nuevo. **Recomendado: volver el repo a privado** y comprobar que el siguiente push sigue desplegando; si dejara de hacerlo, el problema real está en Vercel → Settings → Git.

- [ ] Volver el repo a **privado**
- [ ] Rotar el **secret de la app Dev** — quedó truncado (8 caracteres, no utilizable) en `HANDOFF-2026-07-24.md` línea 38, y el repo estuvo público. Quitar también esa línea.
- [ ] Rotar **`SHOPIFY_API_SECRET` de producción** y la **contraseña de Neon**
- [ ] Mover `C:\Users\Jonas\discountflow-ENV-PROD-BACKUP-2026-07-24.txt` al gestor de contraseñas y borrarlo

---

## ═══ DIAGNÓSTICO CERRADO HOY (lo más importante) ═══

**Problema reportado:** el escalonado no aplicaba descuento en **Greta** ni en **SkinUp** (clientes reales), aunque la campaña quedaba ACTIVA.

### ✅ Root cause CONFIRMADO — no es un bug de código

**1. El código funciona.** Verificado en dev store limpia: colección "Camisas" en modo Incremental → el checkout aplica correctamente (3 productos, ahorro $24.90, cada unidad con su %, el mayor % al más barato).

**2. El guardado es correcto en producción.** Los logs `[tiered-debug]` lo confirmaron en las dos tiendas:

| Tienda | `productIdsResueltos` | Descuento creado | Metafield | Status |
|---|---|---|---|---|
| Greta | **30 productos** | ✅ | completo | ACTIVE |
| SkinUp | **85 productos** | ✅ | completo | ACTIVE |

**3. La razón real de que no se viera:** esas tiendas tienen **otros descuentos automáticos activos** (campañas de Porcentaje, etc.).

> **Shopify aplica UN SOLO descuento automático de producto por carrito.**
> El escalonado se crea con `combinesWith.productDiscounts = false` (copiado de BxGy), así que los otros descuentos le ganan y **el escalonado se ignora en silencio, sin error alguno**.

**4. Por qué en dev sí funcionaba:** la dev store estaba limpia, sin descuentos compitiendo. Es exactamente el tipo de fallo que no puede reproducirse en un entorno vacío.

---

## ═══ PENDIENTE PARA MAÑANA — 2 ajustes ═══

### AJUSTE 1 · UX — el contador "0 productos" (no bloqueante)

**Qué pasa:** el listado muestra **"0 productos"** para TIERED **siempre**, en los tres modos, incluso cuando el descuento funciona perfectamente.

**Por qué:** `app/routes/app.campaigns._index.tsx` líneas ~138 y ~149 usan `_count.products`, que cuenta filas de **`CampaignProduct`** — la tabla donde PERCENTAGE y RANGE guardan los precios originales de cada variante que modifican. **TIERED no crea ninguna fila ahí, por diseño, igual que BxGy** (no edita precios; el descuento lo calcula Shopify en el carrito).

**Qué hacer:** para TIERED, contar los productos del `config` (`config.productIds.length`).

> ⚠️ Detalle a no olvidar: cuando `selectionMode === "all"`, `productIds` está **vacío a propósito** (vacío = toda la tienda para la Function). Ahí no debe mostrarse "0" sino algo tipo **"Toda la tienda"**, o se reproduce el mismo malentendido.

**Alcance: solo TIERED.** No tocar PERCENTAGE, RANGE ni BxGy. (BxGy tiene exactamente el mismo síntoma cosmético; queda a criterio de Jonas si se arregla también, pero **no en el mismo cambio**.)

### AJUSTE 2 · 🔴 DECISIÓN DE NEGOCIO — pendiente de Jonas

**¿El escalonado debe poder combinarse con otros descuentos automáticos activos?**

| Opción | Cambio | Consecuencia |
|---|---|---|
| **SÍ** | `combinesWith.productDiscounts` → `true` (**1 línea** en `app/lib/discounts/tiered.ts`) | El escalonado ya no se pierde. **Riesgo:** un producto que esté en dos campañas acumularía ambos descuentos. |
| **NO** | Dejar como está | Hay que **avisar al merchant en la app** de que no puede haber dos descuentos automáticos sobre el mismo producto, o dar prioridad al escalonado. |

**Jonas decide antes de tocar código.** Ninguna de las dos se implementa hoy.

> Contexto para decidir: los 3 tipos existentes (PERCENTAGE, RANGE, BxGy) no compiten entre sí de la misma forma — PERCENTAGE y RANGE **editan el precio de la variante**, no crean descuentos automáticos. El único que sí crea un descuento automático es BxGy, y también lleva `combinesWith` en `false`. Es decir: el conflicto real es **escalonado vs BxGy**, y **escalonado vs cualquier descuento automático que el merchant haya creado a mano** en el admin de Shopify.

---

## ═══ LIMPIEZA PENDIENTE ═══

- [ ] **Quitar los logs `[tiered-debug]`** una vez cerrados los dos ajustes. Están en:
  - `app/lib/discounts/tiered.ts` — `create/resolve`, `create/resultado`, `update/resolve`, y la función `logTieredDiscountState()` completa
  - `extensions/tiered-discount/src/cart_lines_discounts_generate_run.ts` — `fn` y `fn SIN-CONFIG`
- [ ] **Quitar el `console.log("[tiered-attribution] …")`** de `app/routes/webhooks.orders.create.tsx` cuando se valide la atribución.
- [ ] **Validar la atribución en Analytics con un pedido real.** Quedó implementada (Opción A: cruce por título real + importe desde `discount_allocations`) pero **sin validar**. Falta hacer un pedido con un escalonado aplicado y confirmar en el log el formato del título. Si no llega `[DiscountFlow] <nombre>`, el ajuste es **una línea** en `matchesTieredDiscountTitle()` (`app/lib/discounts/tiered-client.ts`), único sitio donde vive ese formato.

---

## ═══ NOTAS TÉCNICAS PARA RETOMAR ═══

### Dónde se leen los logs
- **`[tiered-debug] create/*`, `update/*`, `estado/*`** y **`[tiered-attribution]`** → son código de servidor → **Vercel → Logs**, filtrar por el prefijo.
- **`[tiered-debug] fn`** → la Function corre en la infraestructura de Shopify, en un sandbox Wasm → **NO llegan a Vercel**. Se leen con `npx shopify app logs --config=shopify.app.toml` o en el Partner Dashboard.

> ⚠️ **Los logs de la Function están commiteados pero NO liberados.** Requieren `shopify app deploy` + release aparte, que publica una versión nueva a todos los merchants. No se hizo porque no fue necesario. Si mañana no aparecen, es por esto.

### Procedimiento de deploy (el que funcionó)
```
# 1. Function (solo si cambió extensions/) — los 3 comandos SEGUIDOS
npx shopify app config use shopify.app.toml
npx shopify app deploy --no-release        # crea la versión sin publicarla
npx shopify app config use dev             # ← INMEDIATAMENTE

# 2. Liberar desde el Partner Dashboard (o `shopify app release --version=X --allow-updates --config=shopify.app.toml`)
# 3. Merge a main → Vercel despliega solo
git checkout main && git merge --ff-only dev && git push origin main && git checkout dev
```

> 🔴 **NUNCA `shopify app dev` con la config de producción activa.** `shopify.app.toml` tiene `automatically_update_urls_on_dev = true`: reescribiría la `application_url` de producción y rompería el OAuth de todos los clientes.
>
> 💡 `--no-release` retiene **la Function, no la interfaz**. La tarjeta la controla el merge a `main` (Vercel). Por eso el orden correcto es **liberar primero, mergear después**.

### Otros hallazgos documentados y NO tocados
1. **Un borrador escalonado no se puede activar.** El listado solo reactiva campañas `PAUSED` y la edición no cambia el estado. Los otros 3 tipos sí lo permiten desde su pantalla de edición. Se implementó y **se revirtió** por decisión de Jonas (`64b8d23`). Pendiente de decisión.
2. **Atribución de BxGy rota** desde su primer commit (21/05): el descuento se crea como `[DiscountFlow] ${nombre}` y el webhook compara contra `campaign.name` pelado → nunca coincide. Afecta solo a la tabla interna de Analytics, no al descuento del cliente. **Decisión: no se arregla.**
3. **El límite de variantes es decorativo en los 4 tipos.** `getVariantCount()` solo alimenta la UI; `es.planes.limiteVariantes` está definido y nunca se invoca.
4. **`npm run typecheck` ya venía rojo** en 14 archivos por versiones duplicadas de `@shopify/shopify-api`. Tapa errores reales.
5. **`connect_timeout=20`** pendiente en las URLs de Neon de dev: sin él, el `P1001` vuelve cada vez que el branch se suspende por inactividad (el `connect_timeout` por defecto de Prisma es 5 s y el arranque en frío tarda ~11 s).
6. **PCD para la app Dev** pendiente → hasta entonces `orders/create` sigue comentado en `shopify.app.dev.toml` y **la atribución no se puede probar en dev**.

### Suites de regresión
```
npm test                                    # 24 tests de la calculadora
cd extensions/tiered-discount && npx vitest run   # 7 fixtures contra el Wasm compilado
```

---

*Cierre de jornada 2026-07-24. Feature en producción, root cause del incidente cerrado, 2 ajustes pendientes.*
