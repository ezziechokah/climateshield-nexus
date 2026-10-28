import { afterEach, describe, expect, it } from "vitest";
import { explainAssessment } from "./explanations.js";

afterEach(() => {
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_MODEL;
  vi.unstubAllGlobals();
});

import { vi } from "vitest";

const input = {
  language: "en" as const,
  risks: [{ riskType: "HEAT_STRESS", level: "MODERATE", explanation: "34 C", method: "Illustrative threshold" }],
  recommendations: [{ riskType: "HEAT_STRESS", title: "Monitor", action: "Observe crops", why: "Input is elevated", limitation: "Ask an extension officer" }],
  provenance: { source: "DEMO", simulated: true, retrievedAt: "2026-10-27T00:00:00.000Z", attribution: "Synthetic" },
  uncertainty: ["Not locally validated"],
};

describe("optional structured explanation", () => {
  it("uses deterministic templates without credentials", async () => {
    const result = await explainAssessment(input);
    expect(result.mode).toBe("DETERMINISTIC_TEMPLATE");
  });

  it("falls back when provider output violates the schema", async () => {
    process.env.AI_API_KEY = "test-only";
    process.env.AI_BASE_URL = "https://example.test";
    process.env.AI_MODEL = "test-model";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 })));
    const result = await explainAssessment(input);
    expect(result.mode).toBe("DETERMINISTIC_TEMPLATE");
  });
});