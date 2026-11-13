import { Pool, type PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { ApiError } from "./api-errors";

let pool: Pool | undefined;
export function database() {
  if (!process.env.DATABASE_URL) throw new ApiError(503, "database_configuration", "Persistent storage is not configured.");
  return pool ??= new Pool({
    connectionString: process.env.DATABASE_URL, max: 10,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 10000, application_name: "jensen"
  });
}
export async function closeDatabase() { await pool?.end(); pool = undefined; }
export async function transaction<T>(work: (client: PoolClient) => Promise<T>, userId?: string): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    if (userId) await client.query("SELECT set_config('jensen.user_id',$1,true)", [userId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function migrate() {
  const client = await database().connect();
  try {
    await client.query("SELECT pg_advisory_lock(8102501)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL)");
    const directory = path.join(process.cwd(), "db", "migrations");
    for (const name of (await readdir(directory)).filter(n => n.endsWith(".sql")).sort()) {
      const sql = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) throw new Error("Applied migration checksum changed");
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations VALUES($1,$2)", [name,checksum]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { await client.query("SELECT pg_advisory_unlock(8102501)"); client.release(); }
}
