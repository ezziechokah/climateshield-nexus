import nodemailer from "nodemailer";

export type RecoveryDelivery = {
  deliver(input: { email: string; token: string; expiresMinutes: number }): Promise<{ mode: "EMAIL_SENT" | "SIMULATED_NOT_SENT" }>;
};

class SimulatedRecoveryDelivery implements RecoveryDelivery {
  async deliver() { return { mode: "SIMULATED_NOT_SENT" as const }; }
}

class SmtpRecoveryDelivery implements RecoveryDelivery {
  readonly #transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 5000,
    socketTimeout: 10000,
  });

  async deliver(input: { email: string; token: string; expiresMinutes: number }) {
    const origin = process.env.RECOVERY_PUBLIC_ORIGIN;
    if (!origin || !process.env.SMTP_FROM) throw new Error("SMTP_FROM and RECOVERY_PUBLIC_ORIGIN are required for recovery email delivery.");
    const link = new URL("/recover", origin);
    link.hash = new URLSearchParams({ token: input.token }).toString();
    await this.#transport.sendMail({
      from: process.env.SMTP_FROM,
      to: input.email,
      subject: "ClimateShield Nexus account recovery",
      text: `Use this one-time link within ${input.expiresMinutes} minutes: ${link.toString()}\nIf you did not request this, ignore this message.`,
    });
    return { mode: "EMAIL_SENT" as const };
  }
}

export function createRecoveryDelivery(environment = process.env.NODE_ENV): RecoveryDelivery {
  if (process.env.SMTP_HOST && process.env.SMTP_FROM) return new SmtpRecoveryDelivery();
  if (environment === "production") throw new Error("Production requires configured SMTP_HOST and SMTP_FROM for account recovery delivery.");
  return new SimulatedRecoveryDelivery();
}