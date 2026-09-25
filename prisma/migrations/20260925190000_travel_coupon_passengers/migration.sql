-- Cupones de viaje: el canje guarda los pasajeros (el cupón descuenta por pasajero).
-- ADITIVA: una columna nueva con valor por defecto.
ALTER TABLE "TravelCouponRedemption" ADD COLUMN "passengers" INTEGER NOT NULL DEFAULT 1;
