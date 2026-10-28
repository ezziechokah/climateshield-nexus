import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Database } from "../db.js";

export function signWebhook(secret: string, timestamp: string, nonce: string, rawBody: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
}

export function createHmacWebhookVerifier(input: { provider: string; secret: string; database: Database; now?: () => number; toleranceSeconds?: number }) {
  const now = input.now ?? Date.now;
  const toleranceMs = (input.toleranceSeconds ?? 300) * 1000;
  return async (req: Request, res: Response, next: NextFunction) => {
    const timestamp = req.header("x-webhook-timestamp") ?? "";
    const nonce = req.header("x-webhook-nonce") ?? "";
    const signature = req.header("x-webhook-signature") ?? "";
    const timestampNumber = Number(timestamp);
    const body = req.rawBody?.toString("utf8");
    if (!req.is("application/json") || !body) return res.status(415).json({ error: "WEBHOOK_CONTENT_TYPE_INVALID" });
    if (!input.secret || !/^\d{10,13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
      return res.status(401).json({ error: "WEBHOOK_AUTHENTICATION_FAILED" });
    }
    const timestampMs = timestamp.length === 10 ? timestampNumber * 1000 : timestampNumber;
    if (Math.abs(now() - timestampMs) > toleranceMs) return res.status(401).json({ error: "WEBHOOK_EXPIRED" });
    const expected = Buffer.from(signWebhook(input.secret, timestamp, nonce, body), "hex");
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return res.status(401).json({ error: "WEBHOOK_AUTHENTICATION_FAILED" });
    try {
      await input.database.execute("INSERT INTO webhook_nonces (provider,nonce,expires_at) VALUES (?,?,?)", [input.provider, nonce, new Date(now() + toleranceMs).toISOString()]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505" || (error as Error).message.toLowerCase().includes("unique")) return res.status(409).json({ error: "WEBHOOK_REPLAY_REJECTED" });
      return res.status(503).json({ error: "WEBHOOK_REPLAY_STORE_UNAVAILABLE" });
    }
    next();
  };
}