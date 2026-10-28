import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClimateProviderError, fetchNasaPowerHistorical, fetchOpenMeteoForecast } from "./climate.js";

const forecastFixture = {
  latitude: -0.3,
  longitude: 36.1,
  timezone: "Africa/Nairobi",
  daily_units: { precipitation_sum: "mm", temperature_2m_max: "°C" },
  daily: {
    time: ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
    precipitation_sum: [0, 4, 0, 3, 0, 0, 2],
    temperature_2m_max: [29, 31, 30, 30, 29, 32, 31],
  },
};

describe("climate provider adapters", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("parses and normalizes a valid Open-Meteo forecast with provenance", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(forecastFixture), { status: 200 }));
    const result = await fetchOpenMeteoForecast({ latitude: -0.3, longitude: 36.1 }, { fetcher, sleep: async () => undefined, now: () => new Date("2026-10-27T10:00:00Z") });
    expect(result.climate).toEqual({ precipitationNext7DaysMm: 9, maximumTemperatureC: 32, consecutiveDryDays: null });
    expect(result.provenance.source).toBe("OPEN_METEO_FORECAST_API");
    expect(result.provenance.attribution).toContain("Open-Meteo");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects out-of-country farm coordinates before network access", async () => {
    const fetcher = vi.fn();
    await expect(fetchOpenMeteoForecast({ latitude: 80, longitude: 36 }, { fetcher })).rejects.toMatchObject({ code: "INVALID_COORDINATES" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed, unit-incomplete provider payloads", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...forecastFixture, daily: { ...forecastFixture.daily, precipitation_sum: [1] } }), { status: 200 }));
    await expect(fetchOpenMeteoForecast({ latitude: -0.3, longitude: 36.1 }, { fetcher, sleep: async () => undefined })).rejects.toMatchObject({ code: "INVALID_PROVIDER_DATA" });
  });

  it("retries temporary provider failures with bounded attempts", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchOpenMeteoForecast({ latitude: -0.31, longitude: 36.11 }, { fetcher, sleep })).rejects.toMatchObject({ code: "PROVIDER_TEMPORARY_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses explicitly stale cached data only after a transient network failure", async () => {
    const now = new Date("2026-10-27T10:00:00Z");
    const validFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(forecastFixture), { status: 200 }));
    await fetchOpenMeteoForecast({ latitude: -0.32, longitude: 36.12 }, { fetcher: validFetch, now: () => now, sleep: async () => undefined });
    const failedFetch = vi.fn().mockRejectedValue(new Error("offline"));
    const stale = await fetchOpenMeteoForecast({ latitude: -0.32, longitude: 36.12 }, { fetcher: failedFetch, now: () => new Date(now.getTime() + 16 * 60_000), sleep: async () => undefined });
    expect(stale.provenance.freshness).toBe("STALE");
    expect(failedFetch).toHaveBeenCalledTimes(3);
  });

  it("parses NASA POWER as historical data, not a forecast", async () => {
    const fixture = { properties: { parameter: { PRECTOTCORR: { "20260101": 2.4, "20260102": -999 }, T2M_MAX: { "20260101": 30, "20260102": 32 } }, time: { start: "20260101", end: "20260102" } }, header: { fill_value: -999 } };
    const result = await fetchNasaPowerHistorical({ latitude: -0.3, longitude: 36.1, start: "20260101", end: "20260102" }, { fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })) });
    expect(result.dataKind).toBe("historical");
    expect(result.values.precipitationMeanMmPerDay).toBe(2.4);
    expect(result.values.maximumTemperatureMeanC).toBe(31);
  });
});