import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Apply pending SQL in apps/api/drizzle/. Called from the API process on
 * boot (not the worker — two processes racing migrate is a mess) so a
 * first-hour `docker compose up` / `pnpm dev` doesn't require a separate
 * `db:migrate` step. Idempotent; drizzle tracks applied files in
 * `__drizzle_migrations`.
 *
 * A dedicated max:1 client is required — the migrator issues a lock
 * session and the app's pooled `db` client is the wrong shape.
 */
export async function applyMigrations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // src/db/migrate.ts and dist/db/migrate.js are both two levels above
  // apps/api/drizzle/.
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log(`Applied migrations from ${migrationsFolder}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}
