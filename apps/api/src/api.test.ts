import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let server: Server;
let origin: string;
let db: typeof import("./db.js").db;
let closeRateLimiter: typeof import("./index.js").closeRateLimiter;
let databaseDirectory: string;
let farmerToken = "";
let farmId = "";
let assessmentId = "";
let farmerId = "";
const testRun = randomUUID().replaceAll("-", "").slice(0, 8);
const farmerEmail = `farmer-${testRun}@example.test`;
const farmerPhone = `+2547${String(Number.parseInt(testRun, 16) % 100_000_000).padStart(8, "0")}`;

async function post(path: string, body: unknown, token = "", idempotencyKey = randomUUID()) {
  return fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

describe("local farmer workflows", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "";
    process.env.SMTP_HOST = "";
    process.env.SMTP_FROM = "";
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_MODE = "postgres";
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    } else {
      process.env.DATABASE_MODE = "sqlite";
      delete process.env.DATABASE_URL;
      databaseDirectory = mkdtempSync(join(tmpdir(), "nexus-test-"));
      process.env.DATABASE_PATH = join(databaseDirectory, "test.sqlite");
    }
    const api = await import("./index.js");
    closeRateLimiter = api.closeRateLimiter;
    db = (await import("./db.js")).db;
    server = api.app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db?.close();
    await closeRateLimiter?.();
    if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
  }, 30000);

  it("registers a farmer and creates an authenticated session", async () => {
    const response = await post("/auth/register", { name: "Demo Farmer", email: farmerEmail, phone: farmerPhone, password: "a-secure-demo-password", language: "en" });
    expect(response.status).toBe(201);
    const result = await response.json() as { token: string; user: { id: string; role: string } };
    farmerToken = result.token; farmerId = result.user.id;
    expect(result.user.role).toBe("FARMER");
    const defaults = await fetch(`${origin}/notification-preferences`, { headers: { Authorization: `Bearer ${farmerToken}` } });
    expect((await defaults.json() as { preferences: { sms_opted_out: boolean | number } }).preferences.sms_opted_out).toBeTruthy();
  });

  it("uses HttpOnly cookie sessions and requires session-bound CSRF for browser mutations", async () => {
    const response = await fetch(`${origin}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Channel": "web", Origin: "http://localhost:5173" },
      body: JSON.stringify({ name: "Cookie Farmer", email: `cookie-${testRun}@example.test`, phone: `+2544${String((Number.parseInt(testRun, 16) + 5) % 100_000_000).padStart(8, "0")}`, password: "cookie-session-password", language: "en" }),
    });
    expect(response.status).toBe(201);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";")[0];
    const body = await response.json() as { token?: string; csrfToken: string; user: User };
    expect(body.token).toBeUndefined();
    const withoutCsrf = await fetch(`${origin}/farms`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173", "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ name: "Cookie farm", county: "Nakuru", locality: "Molo", crop: "Maize" }) });
    expect(withoutCsrf.status).toBe(403);
    const withCsrf = await fetch(`${origin}/farms`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173", "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ name: "Cookie farm", county: "Nakuru", locality: "Molo", crop: "Maize" }) });
    expect(withCsrf.status).toBe(201);
    const foreignOrigin = await fetch(`${origin}/auth/session`, { headers: { Cookie: cookie, Origin: "https://attacker.example" } });
    expect(foreignOrigin.status).toBe(403);
    const anotherBrowser = await fetch(`${origin}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json", "X-Client-Channel": "web", Origin: "http://localhost:5173" }, body: JSON.stringify({ name: "Other Cookie", email: `other-cookie-${testRun}@example.test`, phone: `+2543${String((Number.parseInt(testRun, 16) + 6) % 100_000_000).padStart(8, "0")}`, password: "other-cookie-password", language: "en" }) });
    const otherCookie = anotherBrowser.headers.get("set-cookie")?.split(";")[0] ?? "";
    const csrfReplay = await fetch(`${origin}/farms`, { method: "POST", headers: { Cookie: otherCookie, Origin: "http://localhost:5173", "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ name: "Replay", county: "Nakuru", locality: "Molo", crop: "Maize" }) });
    expect(csrfReplay.status).toBe(403);
    const loggedOut = await fetch(`${origin}/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173", "X-CSRF-Token": body.csrfToken } });
    expect(loggedOut.status).toBe(204);
    const revoked = await fetch(`${origin}/auth/session`, { headers: { Cookie: cookie, Origin: "http://localhost:5173" } });
    expect(revoked.status).toBe(401);
  });

  it("validates farm data and scopes farms to the owning farmer", async () => {
    const invalid = await post("/farms", { name: "Bad farm", county: "Nakuru", locality: "Town", latitude: 80, longitude: 10, crop: "Maize" }, farmerToken);
    expect(invalid.status).toBe(400);
    const farmKey = randomUUID();
    const farmInput = { name: "Test plot", county: "Nakuru", locality: "Demo locality", latitude: -0.3, longitude: 36.1, crop: "Maize" };
    const created = await post("/farms", farmInput, farmerToken, farmKey);
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    farmId = ((await created.json()) as { farm: { id: string } }).farm.id;
    const repeatedFarm = await post("/farms", farmInput, farmerToken, farmKey);
    expect(repeatedFarm.status).toBe(200);
    expect(((await repeatedFarm.json()) as { farm: { id: string } }).farm.id).toBe(farmId);
    const otherPhone = `+2548${String((Number.parseInt(testRun, 16) + 1) % 100_000_000).padStart(8, "0")}`;
    const other = await post("/auth/register", { name: "Other Farmer", email: `other-${testRun}@example.test`, phone: otherPhone, password: "another-secure-password", language: "en" });
    const otherToken = ((await other.json()) as { token: string }).token;
    const sameKeyOtherFarmer = await post("/farms", { name: "Other plot", county: "Kitui", locality: "Kitui", crop: "Beans" }, otherToken, farmKey);
    expect(sameKeyOtherFarmer.status).toBe(201);
    const hidden = await fetch(`${origin}/farms`, { headers: { Authorization: `Bearer ${otherToken}` } });
    const otherFarms = (await hidden.json() as { farms: Array<{ id: string }> }).farms;
    expect(otherFarms).toHaveLength(1);
    expect(otherFarms.some((farm) => farm.id === farmId)).toBe(false);
    const list = await fetch(`${origin}/farms`, { headers: { Authorization: `Bearer ${farmerToken}` } });
    expect((await list.json() as { farms: unknown[] }).farms).toHaveLength(1);
    const forbiddenUpdate = await fetch(`${origin}/farms/${farmId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` }, body: JSON.stringify({ name: "Taken over" }) });
    expect(forbiddenUpdate.status).toBe(404);
    const update = await fetch(`${origin}/farms/${farmId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${farmerToken}` }, body: JSON.stringify({ name: "Updated plot" }) });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { farm: { name: string } }).farm.name).toBe("Updated plot");
  });

  it("creates a clearly labeled synthetic assessment and accepts owner feedback", async () => {
    const assessment = await post(`/farms/${farmId}/assess`, { source: "demo-synthetic" }, farmerToken);
    expect(assessment.status).toBe(201);
    const data = await assessment.json() as { id: string; provenance: { simulated: boolean; source: string }; recommendations: unknown[] };
    assessmentId = data.id;
    expect(data.provenance.simulated).toBe(true);
    expect(data.provenance.source).toBe("DEMONSTRATION_SYNTHETIC_FIXTURE");
    expect(data.recommendations.length).toBeGreaterThan(0);
    const feedback = await post("/feedback", { assessmentId, understandable: true, useful: true, actedOn: false, comment: "Test" }, farmerToken);
    expect(feedback.status).toBe(201);
    const feedbackKey = randomUUID();
    const firstReplay = await post("/feedback", { assessmentId, understandable: true, useful: true, actedOn: false }, farmerToken, feedbackKey);
    const secondReplay = await post("/feedback", { assessmentId, understandable: true, useful: true, actedOn: false }, farmerToken, feedbackKey);
    expect(firstReplay.status).toBe(201);
    expect(secondReplay.status).toBe(200);
    expect((await secondReplay.json() as { replayed: boolean }).replayed).toBe(true);
    const concurrentKey = randomUUID();
    const concurrentFeedback = await Promise.all([
      post("/feedback", { assessmentId, understandable: true, useful: false, actedOn: false }, farmerToken, concurrentKey),
      post("/feedback", { assessmentId, understandable: true, useful: false, actedOn: false }, farmerToken, concurrentKey),
    ]);
    expect(concurrentFeedback.map((response) => response.status).sort()).toEqual([200, 201]);
    const concurrentResults = await Promise.all(concurrentFeedback.map((response) => response.json() as Promise<{ id: string }>));
    expect(concurrentResults[0].id).toBe(concurrentResults[1].id);
    const wrongOwner = await post("/feedback", { assessmentId, understandable: true, useful: true, actedOn: false }, "invalid-token");
    expect(wrongOwner.status).toBe(401);
  });

  it("does not accept client-supplied coordinates for a farm forecast", async () => {
    const localityFarm = await post("/farms", { name: "Locality-only plot", county: "Nakuru", locality: "Molo", crop: "Maize" }, farmerToken);
    expect(localityFarm.status).toBe(201);
    const id = ((await localityFarm.json()) as { farm: { id: string } }).farm.id;
    const response = await post(`/farms/${id}/assess`, { source: "open-meteo", latitude: 0.1, longitude: 38.2 }, farmerToken);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("COORDINATES_REQUIRED");
  });

  it("completes simulated USSD registration and records SMS without delivery claims", async () => {
    const sessionId = `integration-${testRun}`;
    const phone = `+2549${String((Number.parseInt(testRun, 16) + 2) % 100_000_000).padStart(8, "0")}`;
    for (const text of ["", "1", "1", "Nakuru Town", "1", "1"]) {
      const response = await post("/simulation/ussd", { sessionId, text, phone });
      expect(response.status).toBe(200);
    }
    expect(await db.one("SELECT id FROM users WHERE phone = ?", [phone])).toBeTruthy();
    expect(await db.one("SELECT id FROM farms WHERE user_id = (SELECT id FROM users WHERE phone = ?)", [phone])).toBeTruthy();
    const sms = await post("/simulation/sms", { action: "inbound", message: "STOP" }, farmerToken);
    expect(sms.status).toBe(201);
    expect((await sms.json() as { status: string }).status).toBe("SIMULATED_OPT_OUT");
    expect(Number((await db.one<{ sms_opted_out: number }>("SELECT sms_opted_out FROM notification_preferences WHERE user_id = ?", [farmerId]))?.sms_opted_out)).toBe(1);
    const otherPhone = await post("/simulation/sms", { action: "inbound", message: "STOP", phone }, farmerToken);
    expect(otherPhone.status).toBe(403);
    const fabricatedDelivery = await post("/simulation/sms", { action: "delivery-status", status: "simulated-delivered" }, farmerToken);
    expect(fabricatedDelivery.status).toBe(400);
  });

  it("accepts the first visible USSD menu choice without requiring an extra blank turn", async () => {
    const sessionId = `first-reply-${testRun}`;
    const phone = `+2546${String((Number.parseInt(testRun, 16) + 3) % 100_000_000).padStart(8, "0")}`;
    const invalid = await post("/simulation/ussd", { sessionId, text: "9", phone });
    expect((await invalid.json() as { response: string }).response).toContain("Choose 1 or 2");
    const response = await post("/simulation/ussd", { sessionId, text: "2", phone });
    expect(response.status).toBe(200);
    expect((await response.json() as { response: string }).response).toContain("Select county");
  });

  it("rejects expired bearer sessions", async () => {
    const registration = await post("/auth/register", { name: "Expiry Test", email: `expiry-${testRun}@example.test`, phone: `+2545${String((Number.parseInt(testRun, 16) + 4) % 100_000_000).padStart(8, "0")}`, password: "expiry-test-password", language: "en" });
    const token = ((await registration.json()) as { token: string }).token;
    const tokenHash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(token).digest("hex"));
    await db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", [new Date(Date.now() - 1000).toISOString(), tokenHash]);
    const response = await fetch(`${origin}/farms`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe("SESSION_EXPIRED");
  });

  it("restricts evaluation data to admins", async () => {
    const response = await fetch(`${origin}/evaluation/summary`, { headers: { Authorization: `Bearer ${farmerToken}` } });
    expect(response.status).toBe(403);
    const exportResponse = await fetch(`${origin}/evaluation/export.csv`, { headers: { Authorization: `Bearer ${farmerToken}` } });
    expect(exportResponse.status).toBe(403);
  });

  it("uses generic password recovery responses and consumes recovery tokens once", async () => {
    const unknown = await post("/auth/recovery/request", { email: `absent-${testRun}@example.test` });
    const known = await post("/auth/recovery/request", { email: farmerEmail });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    const recovery = await known.json() as { demonstrationToken?: string; message: string };
    expect(recovery.message).toBe((await unknown.clone().json() as { message: string }).message);
    expect(recovery.demonstrationToken).toBeTruthy();
    const reset = await post("/auth/recovery/complete", { token: recovery.demonstrationToken, password: "recovered-secure-password" });
    expect(reset.status).toBe(200);
    const reuse = await post("/auth/recovery/complete", { token: recovery.demonstrationToken, password: "another-secure-password" });
    expect(reuse.status).toBe(400);
    const login = await post("/auth/login", { email: farmerEmail, password: "recovered-secure-password" });
    expect(login.status).toBe(200);
    farmerToken = ((await login.json()) as { token: string }).token;
  });

  it("records explicit notification consent and supports account export and deletion", async () => {
    const consent = await fetch(`${origin}/notification-preferences`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${farmerToken}` }, body: JSON.stringify({ smsConsent: true, language: "sw" }) });
    expect(consent.status).toBe(200);
    const exportResponse = await fetch(`${origin}/account/export`, { headers: { Authorization: `Bearer ${farmerToken}` } });
    expect(exportResponse.status).toBe(200);
    expect((await exportResponse.json() as { user: { email: string } }).user.email).toBe(farmerEmail);
    const deleted = await fetch(`${origin}/account`, { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${farmerToken}` }, body: JSON.stringify({ password: "recovered-secure-password", confirmation: "DELETE" }) });
    expect(deleted.status).toBe(204);
    const afterDelete = await fetch(`${origin}/farms`, { headers: { Authorization: `Bearer ${farmerToken}` } });
    expect(afterDelete.status).toBe(401);
    const deletionAudit = await db.one<{ actor_user_id: string | null }>("SELECT actor_user_id FROM audit_events WHERE action = 'ACCOUNT_DELETED' ORDER BY created_at DESC LIMIT 1");
    expect(deletionAudit?.actor_user_id).toBeNull();
  });
});