-- Reporte de productos salteados por tener ya un descuento puesto a mano (2026-11-13).
-- Solo AÑADE una columna opcional: no reescribe ni borra datos.

ALTER TABLE "Campaign" ADD COLUMN "skipReport" JSONB;
