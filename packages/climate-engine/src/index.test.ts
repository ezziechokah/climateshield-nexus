import { describe, expect, it } from "vitest";
import { assessClimate, demoClimateFixture, recommendationsFor } from "./index.js";

describe("shared climate screening", () => {
  it("returns insufficient data explicitly", () => {
    expect(assessClimate({ precipitationNext7DaysMm: null, maximumTemperatureC: null, consecutiveDryDays: null }).map((r) => r.level))
      .toEqual(["INSUFFICIENT_DATA", "INSUFFICIENT_DATA", "INSUFFICIENT_DATA"]);
  });
  it("classifies threshold boundaries", () => {
    expect(assessClimate({ precipitationNext7DaysMm: 35, maximumTemperatureC: 36, consecutiveDryDays: 7 }).map((r) => r.level))
      .toEqual(["HIGH", "MODERATE", "HIGH"]);
  });
  it("does not suggest actions for low or unknown risks", () => {
    const risks = assessClimate({ precipitationNext7DaysMm: 0, maximumTemperatureC: 20, consecutiveDryDays: null });
    expect(recommendationsFor(risks)).toEqual([]);
  });
  it("returns insufficient data for stale or poor-quality inputs", () => {
    const risks = assessClimate(demoClimateFixture, { status: "STALE" });
    expect(risks.every((risk) => risk.level === "INSUFFICIENT_DATA")).toBe(true);
    expect(recommendationsFor(risks)).toEqual([]);
  });
  it("rejects implausible values instead of assigning a risk band", () => {
    const risks = assessClimate({ precipitationNext7DaysMm: -1, maximumTemperatureC: 99, consecutiveDryDays: 900 });
    expect(risks.every((risk) => risk.level === "INSUFFICIENT_DATA")).toBe(true);
  });
  it("produces identical assessments for identical valid inputs", () => {
    expect(assessClimate(demoClimateFixture)).toEqual(assessClimate(demoClimateFixture));
  });
  it("provides localized action text with limitations", () => {
    const recommendations = recommendationsFor(assessClimate(demoClimateFixture), "sw");
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.every((item) => item.limitation.length > 10)).toBe(true);
  });
});