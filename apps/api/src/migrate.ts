import { db, migrateDatabase } from "./db.js";

try {
  const applied = await migrateDatabase();
  console.log(applied ? `Applied ${applied} PostgreSQL migration(s).` : "PostgreSQL schema is already current.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exitCode = 1;
} finally {
  await db.close();
}