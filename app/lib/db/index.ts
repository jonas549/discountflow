// Re-export the Prisma singleton so callers can import from ~/lib/db
// instead of ~/db.server directly.
export { default as prisma } from "~/db.server";
