# Traspaso · 2026-09-25 · Cupones de viaje (GeoTerraViajes), F1 + F2 + F3 en dev

> **Todo en `dev`, sin commitear. Producción no se tocó.** Sin app version: cero
> cambios en `extensions/`, en los `.toml` y en `app/lib/discounts/`.

## Qué es

Feature de **una sola tienda** (GeoTerraViajes, agencia de viajes, CLP), detrás
del flag `cupones:viaje`. Una campaña por viaje (producto), con varios cupones de
monto fijo y stock, que se liberan **solos y en orden** a medida que se agotan.
En la ficha se ven como cuadraditos; el comprador pincha uno y se aplica.

| Modalidad elegida | Qué pasa |
|---|---|
| **Pago total** | Descuento real en el checkout: código nativo `discountCodeBasic`, monto fijo, **limitado a las variantes Pago total**, una vez por pedido |
| **Reserva** | La reserva se paga completa. El cupón queda en los **atributos del carrito** → Shopify los copia al pedido → la agencia los ve en *Detalles adicionales* y lo resta del saldo |

El reglamento completo está en la cabecera de `app/lib/cupones-viaje/cupones-viaje.ts`.

## Dónde está cada cosa

```
prisma/migrations/20260925120000_travel_coupons/   ADITIVA: 1 enum + 3 tablas nuevas
app/lib/features.server.ts           + "cupones:viaje" en FeatureFlag
app/lib/cupones-viaje/
  acceso.server.ts                   🔴 el ÚNICO punto que lee el flag
  admin.server.ts                    puerta de las pantallas (404 sin flag)
  cupones-viaje.ts                   reglas PURAS (publicación, clasificación, consumo)
  cupones-viaje.server.ts            guardar, sincronizar Shopify, consumir con FOR UPDATE
  codigos-shopify.ts                 los códigos nativos (plomería interna)
  widget-tienda.js                   el widget; se sirve por el app proxy
  *.test.ts / consumo.dbtest.ts      24 + 10 tests; 5 contra Postgres real
app/components/TravelCouponCampaignForm.tsx
app/routes/app.cupones-viaje.*       listado, nueva, editar (+canjes, instalación, simular)
app/routes/apps.discountflow.cupones-viaje(.js)   proxy JSON + script
app/routes/webhooks.orders.create.tsx  bloque 7, al final, detrás del flag
app/routes/app.campaigns._index.tsx    tarjeta de entrada, solo con el flag
```

**No es un `CampaignType`** a propósito: no entra en el listado, los límites de
plan, el motor de jobs ni la atribución que comparten las tiendas que pagan.

## Verificado (no afirmado)

- **Introspección** (API 2025-10): `productVariantsToAdd` existe, `DiscountAmountInput{amount, appliesOnEachItem}`, y **`context` es OBLIGATORIO** (`{ all: "ALL" }`) — sin él, «Context can't be blank». Lo cazó la verificación contra la tienda, no la documentación.
- **Documentación**: `/cart/update.js` acepta `discount` desde mayo de 2025 (lo usa el widget).
- **Contra la tienda de dev, con los módulos reales**: el código queda solo en las 3 variantes Pago total; dos reservas agotan el Cupón 1 → Shopify lo desactiva (`EXPIRED`) y **crea y activa el Cupón 2 solo**, con `usageLimit` correcto. Todo limpiado al final.
- **Concurrencia contra Postgres real**: 10 pedidos simultáneos sobre stock 3 → exactamente 3 válidos + 7 excedentes, `used = 3`. Reintento del mismo pedido → `repetido`.
- **Proxy**: firmado → 200; sin firma → 400; **flag apagado → 404**.
- **Widget** contra un DOM mínimo con `fetch` que exige el receptor como el navegador (mutación comprobada: rompiendo la llamada caen 7 de 10).
- 441 tests · typecheck 184 = 175 base + 9 de la clase `AdminApiContext`/`AdminClient` · build verde.

## Bug que salió verificando y quedó arreglado

Si Shopify rechazaba el código al CREAR, la campaña quedaba en la base activa y
sin códigos; al reintentar desde «Nueva» habría dos. Ahora una creación que
falla se deshace entera (igual que los otros tipos). Una EDICIÓN que falla no se
deshace: la reintenta el reconciliador al abrir la campaña.

## Tres lecciones de medición (la sexta, séptima y octava de la familia)

1. El test del widget dio 7 rojos: el `fetch` falso comparaba el receptor contra
   el `sandbox` de afuera, y en `vm` el `window` del script es otro objeto.
2. Un test pasó **en vacío** con cero radios. Ahora asierta la cantidad.
3. La verificación del render leyó el `{cupon}` crudo del `<textarea>` antes que
   el panel. Buscando el texto rellenado: correcto.

## Decisiones pendientes de Jonas (no bloquearon)

| | Hoy | Dónde se cambia |
|---|---|---|
| ¿Una vez por pedido o por pasajero? | **Por pedido** (no puede regalar de más) | `UNA_VEZ_POR_PEDIDO` |
| ¿Se respeta un canje que llega con el cupón agotado? | Se registra como **Excedente** y decide la agencia | pantalla de canjes |
| ¿Vuelve el stock si se cancela el pedido? | **No** (no recibimos `orders/cancelled`; suscribirlo = app version) | — |
| ¿Se suma a otros códigos? | **No**: `combinesWith` producto y orden en `false` | `COMBINACION` en `codigos-shopify.ts` |
| Nota verificada escrita EN el pedido | No: pide `write_orders` (scope nuevo = app version) | F4 |

## Limitaciones conocidas

- **La app de dev NO recibe `orders/create`** (Protected Customer Data). En dev,
  el canje se ejercita con el botón **Simular pedido**, que corre exactamente
  `registrarPedido` (el mismo camino del webhook). El canje con un webhook real
  solo se puede ver en producción.
- El atributo del carrito lo escribe el navegador: la verdad es la tabla de
  **Canjes** de la campaña (validada por el webhook), no «Detalles adicionales».
- Fechas nuevas en el viaje → hay que volver a guardar la campaña.

## Encender en producción (cuando toque)

`git push` a `main` (sin app version) y, solo para la tienda:

```sql
UPDATE "Shop" SET features = features || '{"cupones:viaje": true}'::jsonb
WHERE domain = '<dominio-de-geoterra>.myshopify.com';
```

---

## Segunda ronda (misma fecha)

### El tipo se presenta como uno más: «Cupones por tandas»

- **Tarjeta** en el catálogo con el mismo `CampaignCard` de las otras siete: ilustración propia (`MockupTandas`), título, descripción, ejemplo y «+ Crear». Solo con el flag.
- **Sus campañas aparecen en «Tus campañas»**, intercaladas por fecha de creación, con las mismas acciones (Editar, Pausar/Activar, Eliminar con el mismo modal). Las acciones van a SU ruta (`/app/cupones-viaje/:id` con `desde=listado` → JSON), así que la acción compartida del listado no se tocó.
- Se **borró** la pantalla de listado propia; crear y guardar vuelven a Campañas, como en los otros tipos.
- Los textos del admin ya no dicen «viaje»: «Producto y modalidades de pago».

### Monto con separador de miles mientras se escribe

`MontoInput`: muestra `100.000`, viaja `100000`. Conserva el cursor y borrar detrás de un punto borra el dígito. Verificado tecleando en **Chrome headless por CDP**, 10/10.

### «$500.000 · queda 1» — NO se reproduce

En Chrome real, con el formulario real, 100000 + stock 5 muestra «$100.000 · quedan 5». El texto «queda» en singular no existe en la app. Pendiente: pasos exactos o captura.

### El tema de GeoTerra (export en `Geoterra/`, sin trackear — no commitear)

- Online Store 2.0 basado en Dawn: plantillas JSON, `main-product` admite `@app` (ya tiene Loox) y `custom_liquid` sin límite.
- **`product.json` YA TIENE un bloque «Liquid personalizado»** en la sección principal (la imagen de cuotas del metafield `custom.cuota_12`). Según los archivos, el tema sí lo acepta.
- El selector de variantes está en modo **desplegable** (`picker_type: dropdown`), no cuadraditos.
- El primer `form` de producto de la página es el de cuotas (`product-form-installment`). Dawn actualiza los dos; el widget ahora prefiere igual el de compra.

### Typecheck

Base de `HEAD` remedida con `git stash -u`: **171** (no 175: derivó). Con los cambios: 180 = 171 + 9, los 9 de la clase `AdminApiContext`/`AdminClient`.

---

## Tercera ronda (misma fecha)

- **«Cannot find variant»**: el producto de prueba no estaba publicado en la Tienda online (`publishedAt: null`). El widget no tocaba el `id` de variante (medido en la ficha real antes y después de pinchar). Jonas lo publicó a las 17:22.
- **El monto 500.000 / 1 venía del formulario**: el código en Shopify se creó así (16:26:03) y nunca se modificó. No se reprodujo; queda un log SOLO en desarrollo (`[cupones-viaje] cupones recibidos:`). Jonas volvió a cargar 500.000 / 555.000 / 6.000.000 y se guardaron bien.
- **El widget ya no copia nada del tema**: botones `<button type="button">` con estilo propio EN LÍNEA (borde, espacio interno, esquinas, separación). Elegido: fondo = color del texto del tema, texto = fondo de la página. Copiar clases arrastraba estados (`disabled` tachaba un cupón disponible) y en temas con desplegable (GeoTerra) no había de dónde copiar.
- **Monto sin decimales siempre**, con el separador de miles de la tienda. GeoTerra usa coma (su tienda muestra «$5,890,000»), así que el cupón se verá «$500,000».
- **Verificado en la ficha real de dev** con Chrome headless: capturas sin elegir y elegido. Para entrar sin contraseña se usa el `onlineStorePreviewUrl` de un producto SIN publicar (se creó uno en borrador y se borró al terminar).
- 445 tests · typecheck 180 = 171 + 9 · build verde.
