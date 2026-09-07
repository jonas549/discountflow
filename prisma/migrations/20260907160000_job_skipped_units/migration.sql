-- Un producto o una variante que ya no existe en Shopify NO es un error.
--
-- Antes, revertir una campaña cuyo merchant había borrado productos dejaba el job
-- en COMPLETED_WITH_ERRORS y llenaba "errors" de incidencias que el merchant no
-- podía accionar: no hay precio que devolver a un producto que no existe. Peor,
-- las que fallaban se reintentaban dentro del mismo lote hasta agotar el plazo, y
-- una variante borrada tumbaba la mutación del producto ENTERO, dejando sin
-- revertir a sus variantes vivas.
--
-- Estas dos columnas separan "no se pudo, hay que mirarlo" de "ya no existe, se
-- saltea". El conteo va aparte del de errores porque la lista se topa, y con
-- decenas de productos borrados el número exacto es justo lo que hay que decirle
-- al merchant.
--
-- Puramente aditiva: valores por defecto, no reescribe ninguna fila existente.

ALTER TABLE "CampaignJob" ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CampaignJob" ADD COLUMN "skipped" JSONB;
