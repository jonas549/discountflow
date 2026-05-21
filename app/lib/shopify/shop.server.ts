import { prisma } from "../db";

export async function getOrCreateShop({
  domain,
  accessToken,
  scopes,
}: {
  domain: string;
  accessToken: string;
  scopes?: string | null;
}) {
  return prisma.shop.upsert({
    where: { domain },
    create: {
      domain,
      accessToken,
      scopes: scopes ?? "",
    },
    update: {
      accessToken,
      scopes: scopes ?? undefined,
      updatedAt: new Date(),
    },
  });
}
