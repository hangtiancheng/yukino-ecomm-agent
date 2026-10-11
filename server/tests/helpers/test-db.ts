import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";

/**
 * Provision a throwaway Postgres database with the prisma migrations applied.
 * Sets process.env.DATABASE_URL so dynamically imported db modules bind to it.
 */
export async function provisionTestDatabase(prefix: string): Promise<{
  dbName: string;
  admin: Client;
  cleanup: () => Promise<void>;
}> {
  const baseUrl = new URL(
    process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1:5432/postgres",
  );
  const dbName = `${prefix}_${Date.now()}_${process.pid}`;
  const admin = new Client({ connectionString: baseUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  const migrationsDir = path.join(process.cwd(), "prisma/migrations");
  const migrations = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const targetUrl = new URL(`/${dbName}`, baseUrl).toString();
  const target = new Client({ connectionString: targetUrl });
  await target.connect();
  try {
    for (const migration of migrations) {
      await target.query(
        fs.readFileSync(
          path.join(migrationsDir, migration.name, "migration.sql"),
          "utf8",
        ),
      );
    }
  } finally {
    await target.end();
  }

  process.env.DATABASE_URL = targetUrl;
  return {
    dbName,
    admin,
    cleanup: async () => {
      delete process.env.DATABASE_URL;
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
