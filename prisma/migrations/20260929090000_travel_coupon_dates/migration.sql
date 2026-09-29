-- Cupones de viaje: fechas por campaña (varias campañas sobre el mismo viaje).
-- ADITIVA: dos columnas nuevas con valor por defecto. Lista vacía = TODAS las
-- fechas, que es como se comportaban las campañas guardadas antes.
ALTER TABLE "TravelCouponCampaign" ADD COLUMN "dateOptionName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TravelCouponCampaign" ADD COLUMN "dateValues" JSONB NOT NULL DEFAULT '[]';
