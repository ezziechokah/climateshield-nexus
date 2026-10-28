import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, scrypt, timingSafeEqual, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { assessClimate, recommendationsFor } from "@climateshield/climate-engine";
import { farmSchema, farmUpdateSchema, feedbackSchema, notificationConsentSchema, registrationSchema } from "@climateshield/contracts";
import { db, initializeDatabase } from "./db.js";
import { explainAssessment } from "./explanations.js";
import { ClimateProviderError, fetchNasaPowerHistorical, fetchOpenMeteoForecast } from "./providers/climate.js";
import { createRecoveryDelivery } from "./services/recovery-delivery.js";
import { createRateLimiter } from "./services/rate-limit.js";

const app = express();
const port = Number(process.env.API_PORT ?? 4000);
const production = process.env.NODE_ENV === "production";
const localSimulatorAllowed = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
if (production) {
  throw new Error("Production deployment is not supported yet: secure web sessions, verified identity recovery, authenticated provider webhooks, and operational migrations are not fully verified.");
}
await initializeDatabase();
const rateLimiter = createRateLimiter();
const recoveryDelivery = createRecoveryDelivery();
const sessionCookieName = process.env.NODE_ENV === "production" ? "__Host-climateshield-session" : "climateshield-session";
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
if (trustedProxyHops > 0) app.set("trust proxy", trustedProxyHops);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb", verify: (req, _res, buffer) => { (req as Request).rawBody = Buffer.from(buffer); } }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", process.env.WEB_ORIGIN ?? "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Client-Channel, Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.vary("Origin");
  const origin = req.header("origin");
  const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  if (origin && origin !== allowedOrigin) return res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const createLimitMiddleware = (limiter: ReturnType<typeof createRateLimiter>) => (group: string, maximum: number, windowSeconds: number, identity: (req: Request) => string = () => "") =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `climateshield:${group}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}:${identity(req)}`;
      const decision = await limiter.consume(key, maximum, windowSeconds);
      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        return res.status(429).json({ error: "RATE_LIMITED", message: "Please retry later." });
      }
      next();
    } catch {
      return res.status(503).json({ error: "RATE_LIMIT_UNAVAILABLE", message: "Request protection is temporarily unavailable." });
    }
  };
const limit = createLimitMiddleware(rateLimiter);
export { createLimitMiddleware };

type SessionUser = { id: string; email: string; name: string; role: string; language: string };
declare global {
  namespace Express {
    interface Request { user?: SessionUser; authSessionHash?: string; authCsrfToken?: string; authViaCookie?: boolean; rawBody?: Buffer }
  }
}

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieValue = (header: string | undefined, name: string) => header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const secureCookie = (token: string, clear = false) => `${sessionCookieName}=${clear ? "" : encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; ${clear ? "Max-Age=0" : "Max-Age=28800"}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const safeTokenEqual = (value: string, expected: string) => {
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};
const derivePassword = promisify(scrypt);
const passwordHash = async (password: string, salt = randomBytes(16).toString("hex")) => `${salt}:${(await derivePassword(password, salt, 64) as Buffer).toString("hex")}`;
const verifyPassword = async (password: string, saved: string) => {
  const [salt, expected] = saved.split(":");
  const actual = await derivePassword(password, salt, 64) as Buffer;
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
};

app.use(limit("public", 120, 60));

const asyncRoute = (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

async function authenticate(req: Request, res: Response, next: NextFunction) {
  const bearer = req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const cookie = cookieValue(req.header("cookie"), sessionCookieName);
  const credential = bearer ?? (cookie ? decodeURIComponent(cookie) : undefined);
  if (!credential) return res.status(401).json({ error: "UNAUTHENTICATED" });
  const sessionHash = hash(credential);
  const row = await db.one<SessionUser & { csrf_token: string }>(`SELECT users.id, users.email, users.name, users.role, users.language, sessions.csrf_token
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.deleted_at IS NULL`, [sessionHash, now()]);
  if (!row) return res.status(401).json({ error: "SESSION_EXPIRED" });
  req.authSessionHash = sessionHash;
  req.authCsrfToken = row.csrf_token;
  req.authViaCookie = !bearer && Boolean(cookie);
  if (req.authViaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const csrf = req.header("x-csrf-token");
    if (!csrf || !row.csrf_token || !safeTokenEqual(csrf, row.csrf_token)) return res.status(403).json({ error: "CSRF_VALIDATION_FAILED" });
  }
  req.user = row;
  next();
}

function sendAuthenticatedResponse(req: Request, res: Response, input: { token: string; csrfToken: string; user: SessionUser }, status = 200) {
  const { token, csrfToken, user } = input;
  if (req.header("x-client-channel")?.toLowerCase() === "web") {
    res.setHeader("Set-Cookie", secureCookie(token));
    return res.status(status).json({ user, csrfToken });
  }
  return res.status(status).json({ token, user });
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "FORBIDDEN" });
  next();
}

app.get("/health", (_req, res) => res.json({ status: "ok", mode: production ? "production" : "local", database: db.kind }));
app.get("/ready", asyncRoute(async (_req, res) => {
  await db.query("SELECT 1 AS ready");
  const rateLimitReady = await rateLimiter.ping();
  if (!rateLimitReady) return res.status(503).json({ status: "not-ready", dependencies: { database: "ready", rateLimiter: "unavailable" } });
  res.json({ status: "ready", dependencies: { database: "ready", rateLimiter: rateLimiter.mode } });
}));

app.post("/auth/register", limit("register", 5, 3600, (req) => String(req.body?.email ?? "").toLowerCase()), asyncRoute(async (req, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() });
  const { name, email, phone, password, language } = parsed.data;
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO users (id,email,phone,name,language,role,password_hash,created_at) VALUES (?,?,?,?,?,'FARMER',?,?)", [id, email, phone, name, language, await passwordHash(password), now()]);
      await tx.execute("INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)", [hash(token), id, csrfToken, new Date(Date.now() + 8 * 3600_000).toISOString(), now()]);
      await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), id, "ACCOUNT_REGISTERED", "USER", id, "{}", now()]);
      await tx.execute("INSERT INTO notification_preferences (user_id,sms_opted_out,consent_at,updated_at) VALUES (?,true,NULL,?)", [id, now()]);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505" || (error as Error).message.includes("UNIQUE")) return res.status(409).json({ error: "ACCOUNT_EXISTS" });
    throw error;
  }
  sendAuthenticatedResponse(req, res, { token, csrfToken, user: { id, email, name, role: "FARMER", language } }, 201);
}));

app.post("/auth/login", limit("login", 10, 900, (req) => String(req.body?.email ?? "").toLowerCase()), asyncRoute(async (req, res) => {
  const parsed = z.object({ email: z.string().email().transform((v) => v.toLowerCase()), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const user = await db.one<SessionUser & { password_hash: string }>("SELECT id,email,name,role,language,password_hash FROM users WHERE email = ? AND deleted_at IS NULL", [parsed.data.email]);
  if (!user || !await verifyPassword(parsed.data.password, user.password_hash)) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.execute("INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)", [hash(token), user.id, csrfToken, new Date(Date.now() + 8 * 3600_000).toISOString(), now()]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), user.id, "LOGIN_SUCCEEDED", "USER", user.id, "{}", now()]);
  });
  sendAuthenticatedResponse(req, res, { token, csrfToken, user: { id: user.id, email: user.email, name: user.name, role: user.role, language: user.language } });
}));

app.get("/auth/session", authenticate, asyncRoute(async (req, res) => {
  if (!req.authViaCookie || !req.authSessionHash) return res.json({ user: req.user, csrfToken: null });
  res.json({ user: req.user, csrfToken: req.authCsrfToken });
}));

app.post("/auth/recovery/request", limit("recovery-request", 5, 3600, (req) => String(req.body?.email ?? "").toLowerCase()), asyncRoute(async (req, res) => {
  const parsed = z.object({ email: z.string().email().transform((value) => value.toLowerCase()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const user = await db.one<{ id: string }>("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [parsed.data.email]);
  if (!user) return res.json({ message: "If the account exists, recovery instructions will be sent through the configured channel." });
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM recovery_tokens WHERE user_id = ?", [user.id]);
    await tx.execute("INSERT INTO recovery_tokens (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
      [hash(token), user.id, new Date(Date.now() + 15 * 60_000).toISOString(), now()]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)",
      [randomUUID(), user.id, "RECOVERY_REQUESTED", "USER", user.id, "{}", now()]);
  });
  try {
    const delivery = await recoveryDelivery.deliver({ email: parsed.data.email, token, expiresMinutes: 15 });
    res.json({ message: "If the account exists, recovery instructions will be sent through the configured channel.", ...(localSimulatorAllowed && delivery.mode === "SIMULATED_NOT_SENT" ? { demonstrationToken: token, delivery: delivery.mode } : {}) });
  } catch {
    await db.execute("DELETE FROM recovery_tokens WHERE token_hash = ?", [hash(token)]);
    res.json({ message: "If the account exists, recovery instructions will be sent through the configured channel." });
  }
}));

app.post("/auth/recovery/complete", limit("recovery-complete", 10, 900), asyncRoute(async (req, res) => {
  const parsed = z.object({ token: z.string().min(20).max(100), password: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const tokenHash = hash(parsed.data.token);
  const recovery = await db.one<{ user_id: string }>("SELECT user_id FROM recovery_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", [tokenHash, now()]);
  if (!recovery) return res.status(400).json({ error: "RECOVERY_TOKEN_INVALID_OR_EXPIRED" });
  await db.transaction(async (tx) => {
    const marked = await tx.execute("UPDATE recovery_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", [now(), tokenHash, now()]);
    if (!marked) throw new Error("RECOVERY_TOKEN_ALREADY_USED");
    await tx.execute("UPDATE users SET password_hash = ? WHERE id = ?", [await passwordHash(parsed.data.password), recovery.user_id]);
    await tx.execute("DELETE FROM sessions WHERE user_id = ?", [recovery.user_id]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)",
      [randomUUID(), recovery.user_id, "PASSWORD_RECOVERED", "USER", recovery.user_id, "{}", now()]);
  });
  res.json({ message: "Password updated. Sign in with the new password." });
}));

app.post("/auth/logout", authenticate, asyncRoute(async (req, res) => {
  await db.execute("DELETE FROM sessions WHERE token_hash = ?", [req.authSessionHash]);
  await db.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), req.user!.id, "LOGOUT", "USER", req.user!.id, "{}", now()]);
  if (req.authViaCookie) res.setHeader("Set-Cookie", secureCookie("", true));
  res.sendStatus(204);
}));

app.get("/farms", authenticate, asyncRoute(async (req, res) => {
  const farms = await db.query("SELECT * FROM farms WHERE user_id = ? ORDER BY created_at DESC", [req.user!.id]);
  res.json({ farms });
}));

app.get("/farms/:id/climate/historical", authenticate, limit("climate-provider", 20, 60), asyncRoute(async (req, res) => {
  const farmId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const farm = await db.one<{ id: string; latitude: number | null; longitude: number | null }>("SELECT id,latitude,longitude FROM farms WHERE id = ? AND user_id = ?", [farmId, req.user!.id]);
  if (!farm) return res.status(404).json({ error: "FARM_NOT_FOUND" });
  if (farm.latitude === null || farm.longitude === null) return res.status(400).json({ error: "COORDINATES_REQUIRED" });
  const query = z.object({ start: z.string().regex(/^\d{8}$/), end: z.string().regex(/^\d{8}$/) }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: "VALIDATION_ERROR", details: query.error.flatten() });
  try {
    const historical = await fetchNasaPowerHistorical({ latitude: farm.latitude, longitude: farm.longitude, ...query.data });
    const id = randomUUID();
    await db.execute(`INSERT INTO climate_records (id,farm_id,provider,data_kind,retrieved_at,valid_from,valid_to,latitude,longitude,units,values_json,quality,attribution,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, farm.id, historical.provider, historical.dataKind, historical.retrievedAt,
      `${query.data.start.slice(0, 4)}-${query.data.start.slice(4, 6)}-${query.data.start.slice(6, 8)}T00:00:00Z`,
      `${query.data.end.slice(0, 4)}-${query.data.end.slice(4, 6)}-${query.data.end.slice(6, 8)}T23:59:59Z`, farm.latitude, farm.longitude,
      JSON.stringify(historical.units), JSON.stringify(historical.values), JSON.stringify({ quality: "PROVIDER_HISTORICAL", farmScale: false }), historical.attribution, now()]);
    res.json({ id, ...historical, note: "Historical aggregate only; not a current forecast or a farm-scale observation." });
  } catch (error) {
    if (error instanceof ClimateProviderError) return res.status(error.status === 400 ? 400 : 502).json({ error: error.code, message: error.message });
    res.status(503).json({ error: "HISTORICAL_PROVIDER_UNAVAILABLE" });
  }
}));

app.post("/farms", authenticate, limit("farm-write", 30, 3600), asyncRoute(async (req, res) => {
  const parsed = farmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() });
  const farm = parsed.data;
  const idempotencyKey = z.string().uuid().safeParse(req.header("idempotency-key"));
  if (!idempotencyKey.success) return res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
  const id = randomUUID();
  const result = await db.transaction(async (tx) => {
    const claimed = await tx.one("INSERT INTO sync_operations (id,user_id,idempotency_key,result_json,created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id",
      [randomUUID(), req.user!.id, idempotencyKey.data, "{}", now()]);
    if (!claimed) {
      const prior = await tx.one<{ result_json: string | Record<string, unknown> }>("SELECT result_json FROM sync_operations WHERE idempotency_key = ? AND user_id = ?", [idempotencyKey.data, req.user!.id]);
      return { farm: prior ? typeof prior.result_json === "string" ? JSON.parse(prior.result_json) : prior.result_json : null, replayed: true };
    }
    await tx.execute(`INSERT INTO farms (id,user_id,name,county,locality,latitude,longitude,location_source,crop,planting_date,irrigation,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, req.user!.id, farm.name, farm.county, farm.locality,
      farm.latitude ?? null, farm.longitude ?? null, farm.locationSource, farm.crop, farm.plantingDate ?? null, farm.irrigation, now(), now()]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), req.user!.id, "FARM_CREATED", "FARM", id, "{}", now()]);
    const savedFarm = await tx.one("SELECT * FROM farms WHERE id = ? AND user_id = ?", [id, req.user!.id]);
    await tx.execute("UPDATE sync_operations SET result_json = ? WHERE user_id = ? AND idempotency_key = ?", [JSON.stringify(savedFarm), req.user!.id, idempotencyKey.data]);
    return { farm: savedFarm, replayed: false };
  });
  res.status(result.replayed ? 200 : 201).json(result);
}));

app.patch("/farms/:id", authenticate, limit("farm-write", 30, 3600), asyncRoute(async (req, res) => {
  const parsed = farmUpdateSchema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) return res.status(400).json({ error: "VALIDATION_ERROR", details: parsed.success ? undefined : parsed.error.flatten() });
  const farmId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const current = await db.one("SELECT id FROM farms WHERE id = ? AND user_id = ?", [farmId, req.user!.id]);
  if (!current) return res.status(404).json({ error: "FARM_NOT_FOUND" });
  const fields: Record<string, string> = { name: "name", county: "county", locality: "locality", latitude: "latitude", longitude: "longitude", locationSource: "location_source", crop: "crop", plantingDate: "planting_date", irrigation: "irrigation" };
  const entries = Object.entries(parsed.data).filter(([key]) => fields[key]);
  const sql = entries.map(([key]) => `${fields[key]} = ?`).join(", ");
  const values = entries.map(([, value]) => value ?? null);
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE farms SET ${sql}, updated_at = ? WHERE id = ? AND user_id = ?`, [...values, now(), farmId, req.user!.id]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), req.user!.id, "FARM_UPDATED", "FARM", farmId, JSON.stringify({ fields: entries.map(([key]) => key) }), now()]);
  });
  res.json({ farm: await db.one("SELECT * FROM farms WHERE id = ? AND user_id = ?", [farmId, req.user!.id]) });
}));

app.delete("/farms/:id", authenticate, limit("farm-write", 20, 3600), asyncRoute(async (req, res) => {
  const farmId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deleted = await db.execute("DELETE FROM farms WHERE id = ? AND user_id = ?", [farmId, req.user!.id]);
  if (deleted) await db.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), req.user!.id, "FARM_DELETED", "FARM", farmId, "{}", now()]);
  res.sendStatus(deleted ? 204 : 404);
}));

app.post("/farms/:id/assess", authenticate, limit("climate-provider", 20, 60), asyncRoute(async (req, res) => {
  const farmId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const farm = await db.one<{ id: string; crop: string; county: string; locality: string; latitude: number | null; longitude: number | null }>("SELECT id,crop,county,locality,latitude,longitude FROM farms WHERE id = ? AND user_id = ?", [farmId, req.user!.id]);
  if (!farm) return res.status(404).json({ error: "FARM_NOT_FOUND" });
  const assessmentRequest = z.object({ source: z.enum(["open-meteo", "demo-synthetic"]) }).safeParse(req.body);
  if (!assessmentRequest.success) return res.status(400).json({ error: "SOURCE_REQUIRED", message: "Choose open-meteo or demo-synthetic explicitly." });
  const source = assessmentRequest.data.source;
  let climate: { precipitationNext7DaysMm: number | null; maximumTemperatureC: number | null; consecutiveDryDays: number | null };
  let provenance: Record<string, unknown>;
  if (source === "open-meteo") {
    if (farm.latitude === null || farm.longitude === null) return res.status(400).json({ error: "COORDINATES_REQUIRED", message: "Set this farm's coordinates before requesting a location-specific forecast." });
    try {
      const forecast = await fetchOpenMeteoForecast({ latitude: farm.latitude, longitude: farm.longitude });
      climate = forecast.climate;
      provenance = forecast.provenance;
    } catch (error) {
      if (error instanceof ClimateProviderError) return res.status(error.code === "INVALID_COORDINATES" ? 400 : 502).json({ error: error.code, message: error.message, providerStatus: error.status });
      return res.status(503).json({ error: "CLIMATE_PROVIDER_UNAVAILABLE", message: "Open-Meteo could not be reached. Choose demo data explicitly to continue." });
    }
  } else {
    climate = { precipitationNext7DaysMm: 48, maximumTemperatureC: 34, consecutiveDryDays: 5 };
    provenance = { source: "DEMONSTRATION_SYNTHETIC_FIXTURE", simulated: true, retrievedAt: now(), validTime: null,
      freshness: "SIMULATED", resolution: "not applicable", attribution: "No external provider data used" };
  }
  const dataQuality = provenance.freshness === "STALE" ? "STALE" : "VALID";
  const risks = assessClimate(climate, { status: dataQuality });
  const recommendations = recommendationsFor(risks, req.user!.language === "sw" ? "sw" : "en");
  const uncertainty = ["Screening bands are illustrative and not locally validated.", ...(source === "demo-synthetic" ? ["Synthetic inputs do not describe current weather."] : []), ...(provenance.freshness === "STALE" ? ["Cached provider data is stale; risks are withheld until fresh data is available."] : [])];
  const explanation = await explainAssessment({ language: req.user!.language === "sw" ? "sw" : "en", risks, recommendations, provenance: provenance as { source: string; simulated: boolean; retrievedAt: string; attribution: string }, uncertainty });
  const payload = { farm, period: "next 7 days", climate, risks, recommendations, provenance, explanation,
    rulesetVersion: "demo-0.2.0", dataQuality, uncertainty };
  const id = randomUUID();
  const climateRecordId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO climate_records (id,farm_id,provider,data_kind,retrieved_at,valid_from,valid_to,latitude,longitude,units,values_json,quality,attribution,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [climateRecordId, farm.id, provenance.source, source === "demo-synthetic" ? "synthetic" : "forecast", now(), null, null,
      farm.latitude, farm.longitude, JSON.stringify({ precipitationNext7DaysMm: "mm", maximumTemperatureC: "C", consecutiveDryDays: "days" }),
      JSON.stringify(climate), JSON.stringify({ simulated: source === "demo-synthetic", timezone: provenance.timezone ?? null, freshness: provenance.freshness }), String(provenance.attribution), now()]);
    await tx.execute("INSERT INTO assessments (id,farm_id,user_id,climate_record_id,payload,source,engine_version,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, farm.id, req.user!.id, climateRecordId, JSON.stringify(payload), source, "demo-0.1.0", now()]);
    for (const recommendation of recommendations) await tx.execute("INSERT INTO recommendations (id,assessment_id,payload,language,evidence_quality,created_at) VALUES (?,?,?,?,?,?)",
      [randomUUID(), id, JSON.stringify(recommendation), req.user!.language, "UNVALIDATED_DEMONSTRATION_RULE", now()]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)",
      [randomUUID(), req.user!.id, "ASSESSMENT_CREATED", "ASSESSMENT", id, JSON.stringify({ source }), now()]);
  });
  res.status(201).json({ id, ...payload, assessedAt: now() });
}));

app.get("/assessments", authenticate, asyncRoute(async (req, res) => {
  const rows = await db.query<{ id: string; farm_id: string; payload: string | Record<string, unknown>; source: string; created_at: string }>("SELECT id,farm_id,payload,source,created_at FROM assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [req.user!.id]);
  res.json({ assessments: rows.map((row) => ({ id: row.id, farmId: row.farm_id, source: row.source, assessedAt: row.created_at, ...(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) })) });
}));

app.post("/feedback", authenticate, limit("feedback", 20, 3600), asyncRoute(async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() });
  const input = parsed.data;
  const idempotencyKey = z.string().uuid().safeParse(req.header("idempotency-key"));
  if (!idempotencyKey.success) return res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
  if (input.assessmentId && !await db.one("SELECT id FROM assessments WHERE id = ? AND user_id = ?", [input.assessmentId, req.user!.id])) return res.status(404).json({ error: "ASSESSMENT_NOT_FOUND" });
  const id = randomUUID();
  const result = await db.transaction(async (tx) => {
    const claimed = await tx.one("INSERT INTO sync_operations (id,user_id,idempotency_key,result_json,created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id",
      [randomUUID(), req.user!.id, idempotencyKey.data, "{}", now()]);
    if (!claimed) {
      const prior = await tx.one<{ result_json: string | Record<string, unknown> }>("SELECT result_json FROM sync_operations WHERE idempotency_key = ? AND user_id = ?", [idempotencyKey.data, req.user!.id]);
      return { ...(prior ? typeof prior.result_json === "string" ? JSON.parse(prior.result_json) : prior.result_json : {}), replayed: true };
    }
    await tx.execute("INSERT INTO feedback (id,user_id,assessment_id,understandable,useful,acted_on,comment,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, req.user!.id, input.assessmentId ?? null, input.understandable, input.useful, input.actedOn, input.comment, now()]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)",
      [randomUUID(), req.user!.id, "FEEDBACK_SUBMITTED", "FEEDBACK", id, "{}", now()]);
    const feedbackResult = { id, createdAt: now() };
    await tx.execute("UPDATE sync_operations SET result_json = ? WHERE user_id = ? AND idempotency_key = ?",
      [JSON.stringify(feedbackResult), req.user!.id, idempotencyKey.data]);
    return { ...feedbackResult, replayed: false };
  });
  res.status(result.replayed ? 200 : 201).json(result);
}));

app.get("/account/export", authenticate, asyncRoute(async (req, res) => {
  const userId = req.user!.id;
  const [user, farms, assessments, feedback, preferences] = await Promise.all([
    db.one("SELECT id,email,phone,name,language,role,created_at FROM users WHERE id = ?", [userId]),
    db.query("SELECT * FROM farms WHERE user_id = ?", [userId]),
    db.query("SELECT id,farm_id,payload,source,engine_version,created_at FROM assessments WHERE user_id = ?", [userId]),
    db.query("SELECT id,assessment_id,understandable,useful,acted_on,comment,created_at FROM feedback WHERE user_id = ?", [userId]),
    db.one("SELECT sms_opted_out,consent_at,updated_at FROM notification_preferences WHERE user_id = ?", [userId]),
  ]);
  res.json({ exportedAt: now(), user, farms, assessments, feedback, notificationPreferences: preferences });
}));

app.delete("/account", authenticate, asyncRoute(async (req, res) => {
  const parsed = z.object({ password: z.string().min(1).max(128), confirmation: z.literal("DELETE") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const user = await db.one<{ id: string; password_hash: string }>("SELECT id,password_hash FROM users WHERE id = ? AND deleted_at IS NULL", [req.user!.id]);
  if (!user || !await verifyPassword(parsed.data.password, user.password_hash)) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  await db.transaction(async (tx) => {
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), user.id, "ACCOUNT_DELETED", "ACCOUNT", null, "{}", now()]);
    await tx.execute("UPDATE audit_events SET actor_user_id = NULL WHERE actor_user_id = ?", [user.id]);
    await tx.execute("DELETE FROM users WHERE id = ?", [user.id]);
  });
  res.sendStatus(204);
}));

app.get("/notification-preferences", authenticate, asyncRoute(async (req, res) => {
  const preferences = await db.one("SELECT sms_opted_out,consent_at,updated_at FROM notification_preferences WHERE user_id = ?", [req.user!.id]);
  res.json({ preferences: preferences ?? { sms_opted_out: true, consent_at: null, updated_at: null }, note: "No notifications are sent by this application yet." });
}));

app.put("/notification-preferences", authenticate, asyncRoute(async (req, res) => {
  const parsed = notificationConsentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() });
  const optedOut = !parsed.data.smsConsent;
  await db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO notification_preferences (user_id,sms_opted_out,consent_at,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET sms_opted_out=excluded.sms_opted_out,consent_at=excluded.consent_at,updated_at=excluded.updated_at`,
      [req.user!.id, optedOut, parsed.data.smsConsent ? now() : null, now()]);
    if (parsed.data.language) await tx.execute("UPDATE users SET language = ? WHERE id = ?", [parsed.data.language, req.user!.id]);
    await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)",
      [randomUUID(), req.user!.id, parsed.data.smsConsent ? "SMS_CONSENT_GRANTED" : "SMS_CONSENT_WITHDRAWN", "NOTIFICATION_PREFERENCE", req.user!.id, "{}", now()]);
  });
  res.json({ smsConsent: parsed.data.smsConsent, updated: true, note: "Consent preference recorded; no SMS is sent by this application yet." });
}));

app.get("/evaluation/summary", authenticate, requireAdmin, limit("admin", 60, 60), asyncRoute(async (_req, res) => {
  const recentAudit = await db.query("SELECT action,target_type,created_at FROM audit_events ORDER BY created_at DESC LIMIT 100");
  res.json({
    farmers: Number((await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'FARMER' AND deleted_at IS NULL"))?.count ?? 0),
    farms: Number((await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM farms"))?.count ?? 0),
    assessments: Number((await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assessments"))?.count ?? 0),
    feedback: await db.query("SELECT understandable,useful,acted_on,created_at FROM feedback ORDER BY created_at DESC"),
    messageEvents: await db.query("SELECT channel,status,COUNT(*) AS count FROM message_events GROUP BY channel,status"),
    auditEvents: recentAudit,
    dependencies: { database: { status: "ready", adapter: db.kind }, climateProviders: { openMeteo: "on-demand; live health not checked", nasaPower: "on-demand; live health not checked" }, messaging: "simulator only" },
    note: "Counts are database records only; no pilot impact or yield outcomes are inferred.",
  });
}));

app.get("/evaluation/export.csv", authenticate, requireAdmin, limit("admin-export", 5, 3600), asyncRoute(async (_req, res) => {
  const rows = await db.query<{ created_at: string; understandable: number | boolean; useful: number | boolean; acted_on: number | boolean; assessment_source: string | null }>(`SELECT feedback.created_at, feedback.understandable, feedback.useful, feedback.acted_on,
      assessments.source AS assessment_source
    FROM feedback LEFT JOIN assessments ON assessments.id = feedback.assessment_id
    ORDER BY feedback.created_at DESC`);
  const escape = (value: string | number | boolean | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = ["created_at,understandable,useful,acted_on,assessment_source", ...rows.map((row) => [row.created_at, row.understandable, row.useful, row.acted_on, row.assessment_source].map(escape).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=climateshield-evaluation.csv");
  res.send(csv);
}));

app.post("/simulation/ussd", limit("ussd-simulator", 30, 60), asyncRoute(async (req, res) => {
  if (!localSimulatorAllowed) return res.sendStatus(404);
  const schema = z.object({ sessionId: z.string().min(1).max(100).default("local-session"), text: z.string().max(120).default(""), phone: z.string().regex(/^\+[1-9]\d{7,14}$/).default("+254700000001") });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const sessionId = parsed.data.sessionId;
  let session = await db.one<{ phone: string; state: string; values_json: string | Record<string, string>; updated_at: string }>("SELECT phone,state,values_json,updated_at FROM ussd_sessions WHERE session_id = ?", [sessionId]);
  if (session && Date.now() - new Date(session.updated_at).getTime() > 5 * 60_000) {
    await db.execute("DELETE FROM ussd_sessions WHERE session_id = ?", [sessionId]);
    session = undefined;
  }
  let state = session?.state ?? "LANGUAGE";
  const values = session ? (typeof session.values_json === "string" ? JSON.parse(session.values_json) : session.values_json) : {};
  const answer = parsed.data.text.trim().split("*").at(-1) ?? "";
  if (!session) values.phone = parsed.data.phone;
  if (session || answer) {
    if (state === "LANGUAGE") {
      if (!["1", "2"].includes(answer)) return res.json({ mode: "SIMULATOR", sessionId, response: "Choose 1 or 2.\n1. English\n2. Kiswahili", completed: false, note: "Local provider simulator; no carrier session." });
      values.language = answer === "2" ? "sw" : "en"; state = "COUNTY";
    }
    else if (state === "COUNTY") {
      if (!["1", "2"].includes(answer)) return res.json({ mode: "SIMULATOR", sessionId, response: "Choose 1 or 2.\n1. Nakuru\n2. Kitui", completed: false, note: "Local provider simulator; no carrier session." });
      values.county = answer === "2" ? "Kitui" : "Nakuru"; state = "LOCALITY";
    }
    else if (state === "LOCALITY") { values.locality = answer.slice(0, 60) || "Other locality"; state = "CROP"; }
    else if (state === "CROP") {
      if (!["1", "2"].includes(answer)) return res.json({ mode: "SIMULATOR", sessionId, response: "Choose 1 or 2.\n1. Maize\n2. Beans", completed: false, note: "Local provider simulator; no carrier session." });
      values.crop = answer === "2" ? "Beans" : "Maize"; state = "CONSENT";
    }
    else if (state === "CONSENT") {
      if (!["1", "2"].includes(answer)) return res.json({ mode: "SIMULATOR", sessionId, response: "Choose 1 to agree or 2 to cancel.\n1. Agree\n2. Cancel", completed: false, note: "Local provider simulator; no carrier session." });
      if (answer === "2") {
        await db.execute("DELETE FROM ussd_sessions WHERE session_id = ?", [sessionId]);
        return res.json({ mode: "SIMULATOR", sessionId, response: "Registration cancelled. No data was saved.", completed: true });
      }
      state = "DONE";
    }
  }
  let response = "";
  if (state === "LANGUAGE") response = "Welcome to ClimateShield Nexus\n1. English\n2. Kiswahili";
  else if (state === "COUNTY") response = "Select county\n1. Nakuru\n2. Kitui";
  else if (state === "LOCALITY") response = "Enter locality name:";
  else if (state === "CROP") response = "Select crop\n1. Maize\n2. Beans";
  else if (state === "CONSENT") response = "Demo registration stores your phone and farm details. Consent?\n1. Agree\n2. Cancel";
  else {
    const existing = await db.one<{ id: string }>("SELECT id FROM users WHERE phone = ?", [values.phone]);
    if (existing) {
      await db.execute("DELETE FROM ussd_sessions WHERE session_id = ?", [sessionId]);
      return res.status(409).json({ error: "ACCOUNT_LINK_REQUIRED", message: "This phone is already registered. Verify ownership through an authorized account-linking flow; the simulator will not merge records by phone number." });
    }
    const userId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO users (id,email,phone,name,language,role,password_hash,created_at)
        VALUES (?,?,?,'USSD farmer',?,'FARMER',?,?)`, [userId, `${values.phone.replace(/\D/g, "")}@ussd.local`, values.phone, values.language ?? "en", await passwordHash(randomBytes(32).toString("hex")), now()]);
      await tx.execute(`INSERT INTO farms (id,user_id,name,county,locality,location_source,crop,irrigation,created_at,updated_at)
        VALUES (?,?,?,?,?,'assisted',?,'unknown',?,?)`, [randomUUID(), userId, "USSD farm", values.county, values.locality, values.crop, now(), now()]);
      await tx.execute("INSERT INTO notification_preferences (user_id,sms_opted_out,consent_at,updated_at) VALUES (?,false,?,?) ON CONFLICT(user_id) DO UPDATE SET consent_at=excluded.consent_at,updated_at=excluded.updated_at", [userId, now(), now()]);
      await tx.execute("INSERT INTO message_events (id,user_id,channel,status,detail,created_at) VALUES (?,?, 'sms-simulator','SIMULATED_NOT_SENT',?,?)", [randomUUID(), userId, "Registration confirmation; no carrier message sent", now()]);
      await tx.execute("INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)", [randomUUID(), userId, "USSD_REGISTRATION_SIMULATED", "USER", userId, JSON.stringify({ simulator: true }), now()]);
      await tx.execute("DELETE FROM ussd_sessions WHERE session_id = ?", [sessionId]);
    });
    return res.json({ mode: "SIMULATOR", sessionId, response: "Registration recorded in the local demo registry. Confirmation SMS was simulated, not sent.", completed: true, profileId: userId, values, note: "No live USSD session or SMS transmission occurred." });
  }
  await db.execute("INSERT INTO ussd_sessions (session_id,phone,state,values_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,values_json=excluded.values_json,updated_at=excluded.updated_at", [sessionId, values.phone, state, JSON.stringify(values), now()]);
  res.json({ mode: "SIMULATOR", sessionId, response, completed: false, note: "Local provider simulator; no carrier session." });
}));

app.post("/simulation/sms", authenticate, limit("sms-simulator", 20, 60), asyncRoute(async (req, res) => {
  if (!localSimulatorAllowed) return res.sendStatus(404);
  const schema = z.object({ action: z.enum(["send", "inbound", "delivery-status"]), message: z.string().max(500).default(""), phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), status: z.enum(["queued", "failed"]).default("queued") });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const eventId = randomUUID();
  const user = parsed.data.phone ? await db.one<{ id: string }>("SELECT id FROM users WHERE phone = ?", [parsed.data.phone])
    : await db.one<{ id: string }>("SELECT id FROM users WHERE id = ?", [req.user!.id]);
  if (user && user.id !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN", message: "A farmer can only manage their own notification preferences." });
  let detail = parsed.data.message;
  let status = parsed.data.action === "send" ? "SIMULATED_NOT_SENT" : parsed.data.action === "delivery-status" ? `SIMULATED_STATUS_${parsed.data.status.toUpperCase()}` : "SIMULATED_INBOUND";
  if (parsed.data.action === "inbound") {
    const command = parsed.data.message.trim().toUpperCase();
    if (command === "STOP" && user) {
      await db.execute("INSERT INTO notification_preferences (user_id,sms_opted_out,updated_at) VALUES (?,true,?) ON CONFLICT(user_id) DO UPDATE SET sms_opted_out=true,updated_at=excluded.updated_at", [user.id, now()]);
      status = "SIMULATED_OPT_OUT";
      detail = "STOP command processed in simulator; no response SMS sent.";
    } else if (command === "HELP") detail = "Commands: HELP, STOP. Simulator response only; no SMS sent.";
    else if (command === "INFO") detail = "Climate information request recorded; no SMS sent.";
  }
  await db.execute("INSERT INTO message_events (id,user_id,channel,status,detail,created_at) VALUES (?,?,?,?,?,?)", [eventId, user?.id ?? req.user!.id, "sms-simulator", status, detail, now()]);
  res.status(201).json({ eventId, mode: "SIMULATOR", status, message: "No SMS was sent through a mobile network." });
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ event: "api_request_failed", errorType: error instanceof Error ? error.name : "UnknownError" }));
  res.status(500).json({ error: "INTERNAL_ERROR", message: production ? "Request failed." : error instanceof Error ? error.message : "Request failed." });
});

if (production) {
  throw new Error("Production deployment is not supported yet: verified deployment topology, webhook authentication, migrations/restore operations, provider activation, and security review remain incomplete.");
}

if (localSimulatorAllowed && process.env.DEVELOPMENT_ADMIN_EMAIL && process.env.DEVELOPMENT_ADMIN_PASSWORD) {
  const email = process.env.DEVELOPMENT_ADMIN_EMAIL.toLowerCase();
  const existing = await db.one("SELECT id FROM users WHERE email = ?", [email]);
  if (!existing) await db.execute(`INSERT INTO users (id,email,phone,name,language,role,password_hash,created_at)
    VALUES (?,?,?,'Local evaluation administrator','en','ADMIN',?,?)`, [randomUUID(), email, "+254700000000", await passwordHash(process.env.DEVELOPMENT_ADMIN_PASSWORD), now()]);
}

export { app };
export const closeRateLimiter = () => rateLimiter.close();

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(port, "0.0.0.0", () => console.log(`ClimateShield API listening on http://localhost:${port} (${production ? "production" : `${db.kind} local demo`})`));
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down.`);
    server.close(() => void Promise.all([db.close(), rateLimiter.close()]).finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}