import { migrate, closeDatabase } from "../lib/db";
try { process.loadEnvFile(".env.local"); } catch {}
migrate().then(() => console.log("Migrations applied."))
  .catch(() => { console.error("Migration failed. Check database configuration and migration integrity."); process.exitCode=1; })
  .finally(closeDatabase);
