-- El registro de un job deja de depender de la existencia de su campaña.
--
-- Antes: onDelete Cascade. La operación DELETE terminaba, borraba la campaña, y el
-- cascade se llevaba el job entero — incluidos "errors" y "lastError", que se guardan
-- en BD precisamente porque los logs de Vercel Hobby se retienen solo 1 hora.
--
-- Ahora: SET NULL. El job queda como registro histórico con campaignId = NULL.
-- Puramente aditiva y reversible: no borra datos ni reescribe filas existentes.

ALTER TABLE "CampaignJob" DROP CONSTRAINT "CampaignJob_campaignId_fkey";

ALTER TABLE "CampaignJob" ALTER COLUMN "campaignId" DROP NOT NULL;

ALTER TABLE "CampaignJob" ADD COLUMN "campaignName" TEXT;

ALTER TABLE "CampaignJob" ADD CONSTRAINT "CampaignJob_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
