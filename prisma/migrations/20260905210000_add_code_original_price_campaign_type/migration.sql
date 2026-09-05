-- Nuevo tipo de campaña: CODE_ORIGINAL_PRICE (cupón sobre el precio original).
--
-- Puramente aditiva, igual que las que añadieron TIERED, PACK y CART_VALUE:
-- agrega un valor al enum y no toca ni una fila existente. No se revierte en un
-- rollback (un valor de enum de más es inofensivo); forward-fix siempre.
ALTER TYPE "CampaignType" ADD VALUE 'CODE_ORIGINAL_PRICE';
