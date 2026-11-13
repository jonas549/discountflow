-- Programación de campañas (2026-11-13).
-- Solo AÑADE columnas, todas opcionales o con valor por defecto: no reescribe ni
-- borra datos, y el código anterior sigue funcionando contra este esquema.
--
-- autoStart/autoEnd nacen en false para TODAS las campañas existentes, así que
-- las que ya tenían fechas guardadas (algunas vencidas) no se disparan solas.

ALTER TABLE "Shop" ADD COLUMN "ianaTimezone" TEXT;

ALTER TABLE "Campaign" ADD COLUMN "autoStart" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "autoEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "scheduleNote" TEXT;

-- El cron busca las campañas con marca encendida; son muy pocas a la vez.
CREATE INDEX "Campaign_autoStart_startsAt_idx" ON "Campaign"("autoStart", "startsAt");
CREATE INDEX "Campaign_autoEnd_endsAt_idx" ON "Campaign"("autoEnd", "endsAt");
