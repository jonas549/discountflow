-- Nuevo tipo de campaña: CART_VALUE ("gastá $100 y ahorrás $10").
--
-- Puramente aditiva, igual que las que añadieron TIERED y PACK: agrega un valor
-- al enum y no toca ni una fila existente. No se revierte en un rollback (un
-- valor de enum de más es inofensivo); forward-fix siempre.
ALTER TYPE "CampaignType" ADD VALUE 'CART_VALUE';
