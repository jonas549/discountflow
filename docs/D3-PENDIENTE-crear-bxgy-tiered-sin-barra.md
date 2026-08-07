# D3 pendiente — crear BxGy y Escalonado no tienen barra de progreso

**Estado:** decidido dejarlo fuera de D2 (2026-08-07). Falta elegir entre dos enfoques.

## El hueco

Tras D2, la barra cubre:

| Tipo | Crear | Activar | Pausar | Eliminar |
|---|---|---|---|---|
| **Porcentaje** | ✅ | ✅ | ✅ | ✅ |
| **Rango de precio** | ✅ | ✅ | ✅ | ✅ |
| **BxGy** | ❌ **hueco** | ✅ | ✅ | ✅ |
| **Escalonado (TIERED)** | ❌ **hueco** | ✅ | ✅ | ✅ |

Crear una campaña BxGy o Escalonada sigue por el camino síncrono de siempre. Funciona
exactamente como antes de D2 — no hay regresión — pero sin barra y sin troceado.

## Por qué no encaja en el motor tal cual está

El motor reanuda gracias al sello `CampaignProduct.processedByJobId`: una fila por
variante, y "lo que queda" es una consulta. **BxGy y TIERED no crean ni una fila de
`CampaignProduct`** (decisión de julio de 2026: su lista de productos vive dentro del
metafield del descuento, no en nuestra base).

Eso convierte la creación de un TIERED de "toda la tienda" sobre un catálogo grande en
el único caso que el troceado no cubre:

- `resolveTieredProductIds` recorre ~80 páginas de Shopify para juntar ~4.000 GIDs;
- esa lista **no tiene dónde acumularse entre lotes**;
- si la invocación muere a mitad, no hay nada que reanudar: se empieza de cero.

Es exactamente el fallo que el troceado viene a evitar, y aparece en el tipo de campaña
que hoy más pesa (SkinUp).

> **BxGy es un caso mucho más leve**: su creación no pagina el catálogo entero, así que
> el riesgo real está concentrado en TIERED con selección amplia.

## Las dos salidas

### Opción A — acumular los GIDs en `CampaignJob.payload`

Cada página de resolución añade sus GIDs al JSON del job.

- ✅ No toca el modelo de datos ni la decisión de julio.
- ❌ ~200 KB de JSON leídos y reescritos en cada una de las ~80 páginas ≈ **16 MB de
  tráfico** por campaña grande.

### Opción B — usar `CampaignProduct` como borrador y borrarlo al final

Resolver creando filas, construir el metafield a partir de ellas y borrarlas.

- ✅ Reutiliza el mecanismo de reanudación tal cual, sin código nuevo.
- ❌ Rompe la decisión de julio de que TIERED no cree esas filas.
- ❌ **Inflaría el conteo de variantes del plan mientras dure el job**, porque
  `getVariantCount` cuenta las filas de campañas `ACTIVE`. Habría que crear la campaña
  como `DRAFT` (como ya hace D2 para porcentaje y rango) para que no cuente.

## Por qué se aplazó

No fue por esfuerzo, sino por no mezclar superficies de fallo: cerrarlo obliga a tocar
`tiered.ts`, el archivo que despliega la Shopify Function, **en la misma entrega que
reescribe la ruta de precios**. Son dos riesgos independientes en un solo despliegue, y
el acuerdo era no mezclarlos nunca.

## Al retomar

1. Medir cuántos productos resuelve de verdad una campaña TIERED típica. Si el máximo
   realista son unos cientos de GIDs, la opción A deja de ser cara y gana por simple.
2. Si aparecen catálogos de miles, la opción B es la que escala — con la campaña naciendo
   en `DRAFT` para no contaminar la cuota del plan.
3. Sea cual sea, va en un despliegue **propio**, separado de cualquier cambio en la ruta
   de precios.
