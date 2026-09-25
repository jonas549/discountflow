-- Cupones de viaje: opción de que el cupón disponible llegue marcado a la ficha.
-- ADITIVA: una columna nueva con valor por defecto (las campañas existentes no cambian).
ALTER TABLE "TravelCouponCampaign" ADD COLUMN "autoApply" BOOLEAN NOT NULL DEFAULT false;
