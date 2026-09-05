-- Nuevo tipo de campaña: PACK (packs armables por el comprador).
--
-- Puramente aditiva, igual que la que añadió TIERED el 2026-07-24: agrega un
-- valor al enum y no toca ni una fila existente. No se revierte en un rollback
-- (un valor de enum de más es inofensivo); forward-fix siempre.
ALTER TYPE "CampaignType" ADD VALUE 'PACK';
