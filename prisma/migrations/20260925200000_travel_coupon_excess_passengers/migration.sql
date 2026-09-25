-- Cupones de viaje: el stock cuenta pasajeros; el canje guarda cuántos no entraron.
-- ADITIVA: una columna nueva con valor por defecto.
ALTER TABLE "TravelCouponRedemption" ADD COLUMN "excessPassengers" INTEGER NOT NULL DEFAULT 0;
