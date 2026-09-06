# Cómo se despliega a producción

> **Este archivo manda.** Si un handoff viejo dice otra cosa, gana esto.
> Escrito el 2026-09-06 después de tres despliegues en un día, y de haber
> reportado como bloqueos cosas que en este proyecto siempre se hicieron.

---

## 0 · Antes de nada: los tres datos que se olvidan

| | |
|---|---|
| **Vercel despliega desde `main`, con el `git push`** | No hay que tocar el dashboard de Vercel para desplegar. El push ES el deploy |
| **Las migraciones corren SOLAS en el build** | `buildCommand` = `npm run setup && npm run build`, y `setup` = `prisma generate && prisma migrate deploy`. **No se corren a mano.** Si fallan, el build falla y producción se queda donde estaba |
| **El CLI de Shopify está autenticado; el de Vercel NO** | `shopify app deploy/release` se puede ejecutar. `vercel whoami` da token inválido: no se puede ver el estado del build, ni promover, ni hacer Instant Rollback |

🔴 **Nunca reportar "no puedo desplegar" sin haber leído este archivo.** El
2026-09-06 se reportaron como bloqueos duros dos cosas falsas: que hacían falta
credenciales de la base de producción para las migraciones, y que sin Vercel CLI
no había despliegue posible. Las dos eran erróneas.

---

## 1 · ¿Hace falta app version?

**La pregunta que decide todo el procedimiento.** Se contesta con un comando:

```bash
for d in extensions app/lib/discounts/tiered-calc.ts app/lib/discounts/pack-calc.ts \
         app/lib/discounts/cart-value-calc.ts app/lib/discounts/original-price-calc.ts; do
  n=$(git diff --numstat HEAD -- "$d" | awk '{s+=$1+$2} END {print s+0}')
  echo "$d -> $n"
done
```

| Si cambió… | Entonces |
|---|---|
| Cualquier cosa dentro de `extensions/` | 🔴 **App version** |
| Cualquiera de los `*-calc.ts` | 🔴 **App version** — se compilan DENTRO del Wasm aunque vivan en `app/` |
| El `.toml` de producción (scopes, webhooks, `app_proxy`) | 🔴 **App version** |
| Solo `app/` sin tocar los `*-calc.ts` | 🟢 **Merge y push. Nada más** |

⚠️ Ojo con el ruido: tras un `git checkout` entre ramas, `git status` marca
archivos como modificados que tienen **`+-0`** cambios reales (ver §7). Mirar
siempre el número, no la lista.

---

## 2 · Procedimiento CON app version

**El orden no es negociable: app version primero, Vercel después.** Si se hace
al revés, crear una campaña del tipo nuevo falla porque su Function todavía no
existe. Al derecho, las Functions nuevas quedan instaladas y **sin usar**, que es
invisible para todos.

```bash
# 1 · Cambiar a la config de PRODUCCIÓN
npx shopify app config use shopify.app.toml
npx shopify app info          # 🔴 LEER el Client ID
```

🔴 **Confirmar `cca497b9abcf56c14d019ee24d0260d5`.** Si dice
`4e80c45a67c8b263d8b725d4c4c2ece0`, eso es **dev**: cancelar. Desplegar la config
de dev sobre la app de producción reescribiría `application_url` y los tres
clientes no podrían abrir la app.

```bash
# 2 · Subir SIN activar, y leer el log COMPLETO (no la cola)
npx shopify app deploy --no-release
```

🔴 **Leer el log entero.** El `theme-check` del bloque de tema reporta errores que
**no bloquean** la creación de la versión: el deploy sale con exit 0 igual. El
2026-09-06 apareció `[error]: ImgWidthAndHeight` en el `<img>` del widget y se
descartó `discountflow-9` entera por eso. Si aparece algo: arreglarlo, crear otra
versión, y activar **esa**.

⚠️ No pasar el log por `tail`: la sección del bloque de tema va **arriba** y se
pierde.

```bash
# 3 · Activar
npx shopify app release --version=discountflow-N --force

# 4 · Verificar las Functions instaladas
```

```graphql
{ shopifyFunctions(first: 50) { nodes { id title apiType } } }
```

Tienen que salir **4**, con los títulos exactos `tiered-discount`,
`pack-discount`, `order-discount`, `code-original-price`.

🔴 **Si `tiered-discount` no aparece con ese título exacto: parar y hacer
rollback.** El resolvedor (`function-id.ts`) empareja por título, y con cuatro
Functions instaladas ya **no hay red de seguridad**: la de "la única Function de
descuento" no puede cumplirse nunca.

⚠️ `shopifyFunctions` devuelve las Functions **de la app que consulta**. Con un
token de la app de dev se verifica dev, no producción. Si es lo único disponible,
**decirlo** y pasarle la verificación a Jonas.

```bash
# 5 · VOLVER A DEV INMEDIATAMENTE
npx shopify app config use shopify.app.dev.toml
npx shopify app info          # confirmar 4e80c45a...
```

🔴 **Este paso no se saltea.** Con la config de producción activa, un
`shopify app dev` accidental reescribe la `application_url` de producción.

Después, el procedimiento sin app version.

---

## 3 · Procedimiento SIN app version

```bash
# Testigo ANTES del push — ver §4
curl -s https://discountflow-app.vercel.app/ | grep -oE 'manifest-[a-z0-9]+\.js'

git checkout main
git merge --ff-only dev
git push origin main          # ← ESTO es el deploy
git checkout dev
git push origin dev           # dejar las ramas sincronizadas
```

El build tarda **~4 minutos**. Sondear antes da un falso negativo — pasó.

---

## 4 · Cómo verificar el deploy sin acceso a Vercel

Dos técnicas. **Elegir según si el deploy agrega rutas nuevas.**

### A · Por RUTA (solo si el deploy agrega rutas)

Una ruta que existe y pide sesión responde **410**; una que no existe, **404**.

```bash
for r in "/app/campaigns" "/app/campaigns/new/lo-nuevo" "/app/no-existe"; do
  printf "%-40s %s\n" "$r" "$(curl -s -o /dev/null -w '%{http_code}' "https://discountflow-app.vercel.app$r")"
done
```

🔴 **NO usar los hashes de los assets**: Vite genera hashes distintos en el build
local y en el de Vercel, así que un 404 de `/assets/*.js` **no prueba nada**.

### B · Por TESTIGO del manifest (siempre funciona)

Capturar `manifest-<hash>.js` **antes** del push y sondear hasta que cambie.
Cualquier build nuevo lo cambia.

```bash
for i in $(seq 1 40); do
  m=$(curl -s https://discountflow-app.vercel.app/ | grep -oE 'manifest-[a-z0-9]+\.js' | head -1)
  [ -n "$m" ] && [ "$m" != "$ANTES" ] && { echo "cambió: $m"; break; }
  sleep 15
done
```

### C · Salud, siempre

```
/                                 200
/app/campaigns                    410   existe, pide sesión
/apps/discountflow/pack           400   existe y rechaza la firma → app_proxy OK
/app/no-existe                    404   control
```

### D · Las migraciones

No hay forma directa sin credenciales, pero hay una **prueba indirecta sólida**:
el `buildCommand` es `npm run setup && npm run build`. Si `migrate deploy`
fallara, la cadena `&&` corta, el build falla y **el deployment no se promociona**.
Si el código nuevo está sirviendo, las migraciones aplicaron.

---

## 5 · Rollback

**Orden invertido: Vercel primero, Function después.**

| | Cómo | ¿Se puede sin Vercel CLI? |
|---|---|---|
| **1 · Vercel** | Instant Rollback desde el dashboard | 🔴 **No.** Alternativa: `git revert` + push a `main` (un build completo, ~4 min) |
| **2 · Function** | `config use shopify.app.toml` → `release --version=<anterior> --force` → `config use dev` | 🟢 **Sí**, un comando |
| **3 · Migraciones** | **No se revierten.** Son `ALTER TYPE ADD VALUE`: aditivas e inertes | — |

🔴 **ANTES de cualquier rollback, comprobar si hay campañas de un tipo nuevo:**

```sql
SELECT s.domain, c.id, c.name, c.type
FROM "Campaign" c JOIN "Shop" s ON s.id = c."shopId"
WHERE c.type IN ('PACK','CART_VALUE','CODE_ORIGINAL_PRICE');
```

Si hay alguna, **el rollback ya no es limpio**: el cliente Prisma viejo no conoce
esos valores del enum y la pantalla de campañas de esa tienda se cae. Hay que
**eliminarlas desde la app primero** (así el descuento se borra también en
Shopify; borrar la fila por SQL deja un descuento huérfano descontando).

⚠️ Si algún merchant agregó el bloque de packs a su tema, al bajar la app version
**el bloque desaparece de su tema**.

---

## 6 · Qué verifica Jonas después, y en qué orden

🔴 **Nunca armar carritos ni checkouts en tiendas de clientes.** Ver
`feedback-nunca-probar-en-tiendas-de-clientes`. Se verifica en la tienda de
desarrollo: **es la misma Function**.

1. 🔴 **Una campaña ESCALONADA en la tienda de dev**, con niveles conocidos, y el
   descuento en el carrito. Es el único tipo vivo en los tres clientes que paga
   el precio de cualquier recompilación del Wasm.
2. El **listado de campañas** carga y los tipos salen **en español** (si sale
   `TIERED` en crudo, `tipoLabel` volvió a fallar).
3. **Dashboard y analítica** cargan.
4. **Editar y volver a guardar** una campaña existente sin cambiar nada.
5. Lo específico de lo que se desplegó.

Las primeras 48 h: logs de Vercel (`[plan-sync]`, `[function-id]`, 500 en
`/app/campaigns`) y **Vercel → Usage** si alguien agregó el bloque de packs — en
Hobby, pasarse de cuota **apaga el servicio**.

---

## 7 · Trampas que ya costaron tiempo

| | |
|---|---|
| 🔴 **`--config` no alcanza en `config use`** | Confirmar el client_id **leyéndolo**, no asumiendo |
| 🔴 **El log del deploy pasado por `tail`** | La sección del bloque de tema queda arriba y se pierde. Ya escondió un error de theme-check |
| 🔴 **`core.autocrlf=true` sin `.gitattributes`** | Cada `git checkout` entre ramas reescribe **todo el árbol a CRLF** y rompe los tests que leen código fuente. Git normaliza al commitear, así que el repo no se ve afectado: es ruido del árbol de trabajo. Los lectores de test ya normalizan |
| 🔴 **Dos `$?` en el mismo `printf`** | El segundo, dentro de una sustitución de comando, no refiere al comando que se cree. Produjo un **rojo falso en `tiered-discount`** que casi se reporta como un problema en la Function de SkinUp. **Capturar el código de salida en una variable inmediatamente después del comando** |
| 🔴 **Correr fixtures mientras se escriben** | Da rojo espurio. Pasó **tres veces**. Ante un rojo inesperado: **re-correr aislado antes de reportar** |
| 🟡 **Heredocs con escapes** | `\r\n` dentro de un heredoc de bash puede llegar interpretado y romper un regexp. Escribir el script a archivo con la herramienta de escritura y ejecutarlo |
| 🟡 **El primer sondeo del deploy** | El build tarda ~4 min. Sondear antes da un falso negativo |

---

## 8 · Estado de referencia

| | |
|---|---|
| App de producción | `DiscountFlow` · **`cca497b9abcf56c14d019ee24d0260d5`** |
| App de dev | `DiscountFlow Dev` · `4e80c45a67c8b263d8b725d4c4c2ece0` |
| URL de producción | `https://discountflow-app.vercel.app` |
| Tiendas | **6**, de las que **3 pagan**: Greta, SkinUp, Nachin |
| Guardia dev/prod en la base | `SELECT count(*) FROM "Shop"` → dev **1**, prod **6** |
| Variable que NO se toca en un despliegue | **`PLAN_SYNC_OBSERVACION=1`** — frena la degradación de plan. Quitarla junto con un deploy amplifica los dos cambios |

El estado actual (commit, app version, pendientes) está en **`docs/ESTADO.md`**.
