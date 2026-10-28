import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRateLimiter } from "./rate-limit.js";
import { createRecoveryDelivery } from "./recovery-delivery.js";

afterEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_PASSWORD;
  delete process.env.SMTP_USER;
  delete process.env.RECOVERY_PUBLIC_ORIGIN;
});

describe("rate limit and recovery service configuration", () => {
  it("uses bounded memory limits in development and rejects missing Redis in production", async () => {
    const limiter = createRateLimiter("development");
    expect(await limiter.consume("test", 1, 60)).toMatchObject({ allowed: true });
    expect(await limiter.consume("test", 1, 60)).toMatchObject({ allowed: false });
    await limiter.close();
    expect(() => createRateLimiter("production")).toThrow(/REDIS_URL/);
  });

  it.skipIf(!process.env.TEST_REDIS_URL)("uses the configured Redis service for distributed counters", async () => {
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    const limiter = createRateLimiter("test");
    const key = `integration:${randomUUID()}`;
    expect(await limiter.consume(key, 1, 30)).toMatchObject({ allowed: true });
    expect(await limiter.consume(key, 1, 30)).toMatchObject({ allowed: false });
    expect(await limiter.ping()).toBe(true);
    await limiter.close();
    delete process.env.REDIS_URL;
  });

  it("uses independent counters for different endpoint classes and identities", async () => {
    const limiter = createRateLimiter("test");
    expect(await limiter.consume("climateshield:login:ip:user-a", 1, 60)).toMatchObject({ allowed: true });
    expect(await limiter.consume("climateshield:login:ip:user-a", 1, 60)).toMatchObject({ allowed: false });
    expect(await limiter.consume("climateshield:recovery:ip:user-a", 1, 60)).toMatchObject({ allowed: true });
    expect(await limiter.consume("climateshield:login:ip:user-b", 1, 60)).toMatchObject({ allowed: true });
    await limiter.close();
  });

  it("fails closed with 503 when the distributed limiter is unavailable", async () => {
    const { createLimitMiddleware } = await import("../index.js");
    const middleware = createLimitMiddleware({ mode: "redis", close: async () => undefined, consume: async () => { throw new Error("redis offline"); } });
    const request = { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } } as never;
    const response = { statusCode: 0, headers: {} as Record<string, string>, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { return value; }, setHeader(name: string, value: string) { this.headers[name] = value; } } as never;
    const next = vi.fn();
    await middleware("login", 2, 60)(request, response, next);
    expect((response as { statusCode: number }).statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("requires SMTP recovery delivery in production and identifies development simulation", async () => {
    expect(() => createRecoveryDelivery("production")).toThrow(/SMTP_HOST/);
    const simulated = createRecoveryDelivery("development");
    await expect(simulated.deliver({ email: "farmer@example.test", token: "opaque-test-token", expiresMinutes: 15 }))
      .resolves.toEqual({ mode: "SIMULATED_NOT_SENT" });
  });

  it("sends SMTP recovery without logging or returning the token from the delivery interface", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "ClimateShield <noreply@example.test>";
    process.env.RECOVERY_PUBLIC_ORIGIN = "https://farm.example.test";
    const sendMail = vi.fn().mockResolvedValue({ messageId: "provider-message" });
    vi.spyOn((await import("nodemailer")).default, "createTransport").mockReturnValue({ sendMail } as never);
    const delivery = createRecoveryDelivery("production");
    await expect(delivery.deliver({ email: "farmer@example.test", token: "unreturned-token", expiresMinutes: 15 }))
      .resolves.toEqual({ mode: "EMAIL_SENT" });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(JSON.stringify(await delivery.deliver({ email: "farmer@example.test", token: "another-token", expiresMinutes: 15 }))).not.toContain("another-token");
  });
});