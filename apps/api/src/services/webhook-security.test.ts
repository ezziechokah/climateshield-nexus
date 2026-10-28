import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { Database } from "../db.js";
import { createHmacWebhookVerifier, signWebhook } from "./webhook-security.js";

function fixtureRequest(timestamp: string, nonce: string, signature: string) {
  return { body: { event: "message", id: "sample" }, rawBody: Buffer.from('{"event":"message","id":"sample"}'), is: (type: string) => type === "application/json", header: (name: string) => ({ "x-webhook-timestamp": timestamp, "x-webhook-nonce": nonce, "x-webhook-signature": signature }[name.toLowerCase()]) } as unknown as Request;
}
function fixtureResponse() {
  const res = { code: 200, payload: undefined as unknown, status(code: number) { this.code = code; return this; }, json(value: unknown) { this.payload = value; return this; } };
  return res as unknown as Response & typeof res;
}
function fakeDatabase(execute = vi.fn().mockResolvedValue(1)): Database {
  return { kind: "sqlite", query: vi.fn(), one: vi.fn(), execute, transaction: vi.fn(), close: vi.fn() } as unknown as Database;
}

describe("generic webhook authentication primitive", () => {
  const nowMs = 1_800_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonce = "nonce_value_with_24_chars";
  const secret = "test-webhook-secret-only";
  const body = JSON.stringify({ event: "message", id: "sample" });

  it("accepts a valid timestamped HMAC and records its nonce", async () => {
    const database = fakeDatabase();
    const verifier = createHmacWebhookVerifier({ provider: "test", secret, database, now: () => nowMs });
    const req = fixtureRequest(timestamp, nonce, signWebhook(secret, timestamp, nonce, body));
    const res = fixtureResponse(); const next = vi.fn();
    await verifier(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(database.execute).toHaveBeenCalledOnce();
  });

  it("rejects signature tampering and expired timestamps", async () => {
    const verifier = createHmacWebhookVerifier({ provider: "test", secret, database: fakeDatabase(), now: () => nowMs });
    const bad = fixtureResponse(); const next = vi.fn();
    await verifier(fixtureRequest(timestamp, nonce, "0".repeat(64)), bad, next as NextFunction);
    expect(bad.code).toBe(401);
    const expiredTimestamp = String(Math.floor((nowMs - 600_000) / 1000));
    const expired = fixtureResponse();
    await verifier(fixtureRequest(expiredTimestamp, nonce, signWebhook(secret, expiredTimestamp, nonce, body)), expired, next as NextFunction);
    expect(expired.code).toBe(401);
  });

  it("rejects replayed nonces and fails closed if replay storage is unavailable", async () => {
    const duplicate = Object.assign(new Error("duplicate key violates unique constraint"), { code: "23505" });
    const database = fakeDatabase(vi.fn().mockRejectedValue(duplicate));
    const verifier = createHmacWebhookVerifier({ provider: "test", secret, database, now: () => nowMs });
    const req = fixtureRequest(timestamp, nonce, signWebhook(secret, timestamp, nonce, body));
    const res = fixtureResponse();
    await verifier(req, res, vi.fn() as NextFunction);
    expect(res.code).toBe(409);
    const unavailable = fixtureResponse();
    const broken = createHmacWebhookVerifier({ provider: "test", secret, database: fakeDatabase(vi.fn().mockRejectedValue(new Error("db down"))), now: () => nowMs });
    await broken(req, unavailable, vi.fn() as NextFunction);
    expect(unavailable.code).toBe(503);
  });
});