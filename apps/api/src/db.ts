import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

export type DbRow = Record<string, unknown>;
export type Database = {
  query<T extends DbRow = DbRow>(sql: string, values?: unknown[]): Promise<T[]>;
  one<T extends DbRow = DbRow>(sql: string, values?: unknown[]): Promise<T | undefined>;
  execute(sql: string, values?: unknown[]): Promise<number>;
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "sqlite" | "postgres";
};

function postgresPlaceholders(sql: string) {
  let position = 0;
  return sql.replace(/\?/g, () => `$${++position}`);
}

class SqliteDatabase implements Database {
  readonly kind = "sqlite" as const;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  }

  async query<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    const statement = this.#db.prepare(sql);
    return statement.all(...values.map(sqliteValue) as (string | number | null | bigint | Uint8Array)[]) as T[];
  }

  async one<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T | undefined> {
    const statement = this.#db.prepare(sql);
    return statement.get(...values.map(sqliteValue) as (string | number | null | bigint | Uint8Array)[]) as T | undefined;
  }

  async execute(sql: string, values: unknown[] = []): Promise<number> {
    const result = this.#db.prepare(sql).run(...values.map(sqliteValue) as (string | number | null | bigint | Uint8Array)[]);
    return Number(result.changes);
  }

  async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async close() { this.#db.close(); }
  pragmaRows<T>(name: string) { return this.#db.prepare(`PRAGMA table_info(${name})`).all() as T[]; }
}

const sqliteValue = (value: unknown) => typeof value === "boolean" ? Number(value) : value;

async function loadMigrations() {
  const directory = resolve(process.cwd(), "migrations");
  const files = (await readdir(directory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(files.map(async (file) => ({
    version: file.slice(0, -4),
    sql: await readFile(resolve(directory, file), "utf8"),
  })));
}

class PostgresDatabase implements Database {
  readonly kind = "postgres" as const;
  readonly #pool: Pool;
  readonly #client?: PoolClient;

  constructor(pool: Pool, client?: PoolClient) {
    this.#pool = pool;
    this.#client = client;
  }

  async query<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    const queryable = this.#client ?? this.#pool;
    const statement = postgresPlaceholders(sql);
    const result = values.length
      ? await queryable.query<T & QueryResultRow>(statement, values)
      : await queryable.query<T & QueryResultRow>(statement);
    return result.rows;
  }

  async one<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, values))[0];
  }

  async execute(sql: string, values: unknown[] = []): Promise<number> {
    const statement = postgresPlaceholders(sql);
    const queryable = this.#client ?? this.#pool;
    const result = values.length ? await queryable.query(statement, values) : await queryable.query(statement);
    return result.rowCount ?? 0;
  }

  async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    if (this.#client) return work(this);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresDatabase(this.#pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() { if (!this.#client) await this.#pool.end(); }
}

const databaseUrl = process.env.DATABASE_URL;
const databaseMode = process.env.DATABASE_MODE ?? (databaseUrl ? "postgres" : "sqlite");
if (databaseMode === "postgres" && !databaseUrl) throw new Error("DATABASE_URL is required when DATABASE_MODE=postgres.");
if (databaseMode === "sqlite" && process.env.NODE_ENV === "production") throw new Error("SQLite cannot be used in production.");
if (databaseMode !== "sqlite" && databaseMode !== "postgres") throw new Error("DATABASE_MODE must be sqlite or postgres.");
if (process.env.NODE_ENV === "production" && databaseMode === "postgres" && process.env.DATABASE_SSL !== "true") throw new Error("DATABASE_SSL=true is required for production PostgreSQL connections.");
const localSqlite = databaseMode === "sqlite";

if (process.env.NODE_ENV === "production" && !databaseUrl) {
  throw new Error("DATABASE_URL is required in production.");
}

export const db: Database = localSqlite
  ? new SqliteDatabase(resolve(process.env.DATABASE_PATH ?? "./data/climateshield.sqlite"))
  : new PostgresDatabase(new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5000),
      idleTimeoutMillis: 30000,
      statement_timeout: Math.max(1000, Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 10000)),
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    }));

export async function initializeDatabase() {
  if (db.kind === "sqlite") {
    await db.query(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en', role TEXT NOT NULL DEFAULT 'FARMER', password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, deleted_at TEXT
    )`);
    await db.query("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, created_at TEXT NOT NULL)");
    const sessionColumns = (db as SqliteDatabase).pragmaRows<{ name: string }>("sessions");
    if (!sessionColumns.some((column) => column.name === "csrf_token")) await db.query("ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT ''");
      await db.query("CREATE TABLE IF NOT EXISTS recovery_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)");
    await db.query(`CREATE TABLE IF NOT EXISTS farms (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      county TEXT NOT NULL, locality TEXT NOT NULL, latitude REAL, longitude REAL, location_source TEXT NOT NULL,
      crop TEXT NOT NULL, planting_date TEXT, irrigation TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS farms_user_id_idx ON farms(user_id)");
    await db.query("CREATE TABLE IF NOT EXISTS assessments (id TEXT PRIMARY KEY, farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, payload TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)");
    await db.query("CREATE INDEX IF NOT EXISTS assessments_user_created_idx ON assessments(user_id,created_at)");
    await db.query("CREATE TABLE IF NOT EXISTS climate_records (id TEXT PRIMARY KEY, farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE, provider TEXT NOT NULL, data_kind TEXT NOT NULL, retrieved_at TEXT NOT NULL, valid_from TEXT, valid_to TEXT, latitude REAL, longitude REAL, units TEXT NOT NULL, values_json TEXT NOT NULL, quality TEXT NOT NULL DEFAULT '{}', attribution TEXT NOT NULL, created_at TEXT NOT NULL)");
    await db.query("CREATE INDEX IF NOT EXISTS climate_records_farm_time_idx ON climate_records(farm_id,retrieved_at)");
    await db.query("CREATE TABLE IF NOT EXISTS recommendations (id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE, payload TEXT NOT NULL, language TEXT NOT NULL, evidence_quality TEXT NOT NULL, created_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, assessment_id TEXT REFERENCES assessments(id) ON DELETE SET NULL, understandable INTEGER NOT NULL, useful INTEGER NOT NULL, acted_on INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS message_events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, channel TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, provider_reference TEXT, created_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS ussd_sessions (session_id TEXT PRIMARY KEY, phone TEXT NOT NULL, state TEXT NOT NULL, values_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS notification_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sms_opted_out INTEGER NOT NULL DEFAULT 0, consent_at TEXT, updated_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS recovery_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)");
    await db.query("CREATE INDEX IF NOT EXISTS recovery_tokens_expiry_idx ON recovery_tokens(expires_at)");
    await db.query("CREATE TABLE IF NOT EXISTS webhook_nonces (provider TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(provider,nonce))");
    await db.query("CREATE INDEX IF NOT EXISTS webhook_nonces_expiry_idx ON webhook_nonces(expires_at)");
    await db.query("CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS sync_operations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,idempotency_key))");
    await db.query("CREATE INDEX IF NOT EXISTS sync_operations_user_created_idx ON sync_operations(user_id,created_at)");
    await db.query("CREATE TABLE IF NOT EXISTS notification_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, assessment_id TEXT REFERENCES assessments(id) ON DELETE SET NULL, channel TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL)");
    await db.query("CREATE TABLE IF NOT EXISTS delivery_attempts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES notification_requests(id) ON DELETE CASCADE, provider TEXT NOT NULL, provider_reference TEXT, status TEXT NOT NULL, error_code TEXT, attempted_at TEXT NOT NULL)");
    const sqlite = db as SqliteDatabase;
    const assessmentColumns = sqlite.pragmaRows<{ name: string }>("assessments");
    if (!assessmentColumns.some((column) => column.name === "climate_record_id")) await db.query("ALTER TABLE assessments ADD COLUMN climate_record_id TEXT REFERENCES climate_records(id) ON DELETE SET NULL");
    if (!assessmentColumns.some((column) => column.name === "engine_version")) await db.query("ALTER TABLE assessments ADD COLUMN engine_version TEXT NOT NULL DEFAULT 'demo-0.1.0'");
    const userColumns = sqlite.pragmaRows<{ name: string }>("users");
    if (!userColumns.some((column) => column.name === "deleted_at")) await db.query("ALTER TABLE users ADD COLUMN deleted_at TEXT");
    const farmColumns = sqlite.pragmaRows<{ name: string }>("farms");
    if (!farmColumns.some((column) => column.name === "updated_at")) await db.query("ALTER TABLE farms ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    return;
  }

  try {
    const migrations = await loadMigrations();
    const appliedRows = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
    const applied = new Set(appliedRows.map((row) => row.version));
    const missing = migrations.find((migration) => !applied.has(migration.version));
    if (missing) throw new Error(`migration ${missing.version} is not applied`);
  } catch {
    throw new Error("PostgreSQL schema is not initialized. Run `pnpm --filter @climateshield/api migrate` before starting the API.");
  }
}

export async function migrateDatabase() {
  if (db.kind !== "postgres") throw new Error("PostgreSQL migrations require DATABASE_URL and DATABASE_MODE=postgres.");
  const migrations = await loadMigrations();
  let migrationCount = 0;
  await db.transaction(async (tx) => {
    await tx.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext(?))", ["climateshield-schema-migrations"]);
    for (const migration of migrations) {
      const applied = await tx.one("SELECT version FROM schema_migrations WHERE version = ?", [migration.version]);
      if (applied) continue;
      await tx.query(migration.sql);
      await tx.query("INSERT INTO schema_migrations(version) VALUES (?)", [migration.version]);
      migrationCount += 1;
    }
  });
  return migrationCount;
}