import { z } from "zod";

const openMeteoSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
  daily_units: z.object({ precipitation_sum: z.literal("mm"), temperature_2m_max: z.literal("°C") }),
  daily: z.object({
    time: z.array(z.string().date()).length(7),
    precipitation_sum: z.array(z.number().finite().min(0).nullable()).length(7),
    temperature_2m_max: z.array(z.number().finite().min(-90).max(65).nullable()).length(7),
  }),
});

export type ForecastResult = {
  climate: { precipitationNext7DaysMm: number | null; maximumTemperatureC: number | null; consecutiveDryDays: null };
  provenance: { source: string; simulated: false; retrievedAt: string; validTime: string; timezone: string; freshness: "FRESH" | "STALE"; resolution: string; attribution: string };
};

type CacheEntry = { result: ForecastResult; expiresAt: number };
const forecastCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_SIZE = 500;

export class ClimateProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); }
}

export async function fetchOpenMeteoForecast(input: { latitude: number; longitude: number }, options: {
  baseUrl?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}): Promise<ForecastResult> {
  const coordinateSchema = z.object({ latitude: z.number().min(-4.8).max(5.2), longitude: z.number().min(33.8).max(42.2) });
  const coords = coordinateSchema.safeParse(input);
  if (!coords.success) throw new ClimateProviderError("INVALID_COORDINATES", "Coordinates must be within Kenya.");
  const cacheKey = `${coords.data.latitude.toFixed(5)},${coords.data.longitude.toFixed(5)}`;
  const now = options.now ?? (() => new Date());
  const cached = forecastCache.get(cacheKey);
  if (cached && cached.expiresAt > now().getTime()) return cached.result;

  const baseUrl = options.baseUrl ?? process.env.OPEN_METEO_BASE_URL ?? "https://api.open-meteo.com";
  let endpoint: URL;
  try { endpoint = new URL("/v1/forecast", baseUrl); }
  catch { throw new ClimateProviderError("INVALID_PROVIDER_URL", "Open-Meteo base URL is invalid."); }
  endpoint.search = new URLSearchParams({
    latitude: String(coords.data.latitude), longitude: String(coords.data.longitude),
    daily: "precipitation_sum,temperature_2m_max", timezone: "Africa/Nairobi", forecast_days: "7",
  }).toString();
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  const fetchCachedFallback = cached?.result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(endpoint, { signal: AbortSignal.timeout(7000), headers: { "User-Agent": "ClimateShieldNexus/0.1" } });
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 2) { await sleep(100 * (2 ** attempt)); continue; }
        lastError = new ClimateProviderError("PROVIDER_TEMPORARY_ERROR", "Open-Meteo is temporarily unavailable.", response.status);
        break;
      }
      if (!response.ok) throw new ClimateProviderError("PROVIDER_RESPONSE_ERROR", "Open-Meteo rejected the request.", response.status);
      const parsed = openMeteoSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.daily.time.length !== parsed.data.daily.precipitation_sum.length || parsed.data.daily.time.length !== parsed.data.daily.temperature_2m_max.length) {
        throw new ClimateProviderError("INVALID_PROVIDER_DATA", "Open-Meteo returned missing or malformed daily variables.");
      }
      const precipitationValues = parsed.data.daily.precipitation_sum;
      const temperatureValues = parsed.data.daily.temperature_2m_max;
      const climate = {
        precipitationNext7DaysMm: precipitationValues.some((value) => value === null) ? null : precipitationValues.reduce<number>((sum, value) => sum + (value ?? 0), 0),
        maximumTemperatureC: temperatureValues.some((value) => value === null) ? null : Math.max(...temperatureValues as number[]),
        consecutiveDryDays: null,
      };
      const result: ForecastResult = {
        climate,
        provenance: { source: "OPEN_METEO_FORECAST_API", simulated: false, retrievedAt: now().toISOString(), validTime: parsed.data.daily.time[0],
          timezone: parsed.data.timezone, freshness: "FRESH", resolution: "provider grid; not farm-specific", attribution: "Weather data by Open-Meteo.com" },
      };
      if (forecastCache.size >= MAX_CACHE_SIZE) forecastCache.delete(forecastCache.keys().next().value!);
      forecastCache.set(cacheKey, { result, expiresAt: now().getTime() + CACHE_TTL_MS });
      return result;
    } catch (error) {
      lastError = error;
      if (error instanceof ClimateProviderError) {
        if (error.code === "INVALID_PROVIDER_DATA" || error.code === "PROVIDER_RESPONSE_ERROR") throw error;
        lastError = error;
        break;
      }
      if (attempt < 2) { await sleep(100 * (2 ** attempt)); continue; }
    }
  }
  const stale = fetchCachedFallback ?? forecastCache.get(cacheKey)?.result;
  if (stale) return { ...stale, provenance: { ...stale.provenance, freshness: "STALE" } };
  if (lastError instanceof ClimateProviderError) throw lastError;
  throw new ClimateProviderError("PROVIDER_UNAVAILABLE", lastError instanceof Error ? lastError.message : "Open-Meteo is unavailable.");
}

export type HistoricalResult = {
  provider: "NASA_POWER";
  dataKind: "historical";
  values: Record<string, number | null>;
  units: Record<string, string>;
  startDate: string;
  endDate: string;
  retrievedAt: string;
  attribution: string;
};

const powerSchema = z.object({
  properties: z.object({
    parameter: z.record(z.string(), z.record(z.string(), z.number().finite().nullable())),
    parameter_names: z.record(z.string(), z.string()).optional(),
    time: z.object({ start: z.string().regex(/^\d{8}$/), end: z.string().regex(/^\d{8}$/) }).optional(),
  }),
  header: z.object({ fill_value: z.number().optional() }).optional(),
});

export async function fetchNasaPowerHistorical(input: { latitude: number; longitude: number; start: string; end: string }, options: { baseUrl?: string; fetcher?: typeof fetch } = {}): Promise<HistoricalResult> {
  const dates = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), start: z.string().regex(/^\d{8}$/), end: z.string().regex(/^\d{8}$/) }).safeParse(input);
  if (!dates.success || input.start > input.end) throw new ClimateProviderError("INVALID_HISTORICAL_QUERY", "NASA POWER requires valid coordinates and YYYYMMDD date bounds.");
  const base = options.baseUrl ?? process.env.NASA_POWER_BASE_URL ?? "https://power.larc.nasa.gov/api/temporal/daily/point";
  const url = new URL(base);
  url.search = new URLSearchParams({ parameters: "PRECTOTCORR,T2M_MAX", community: "AG", longitude: String(input.longitude), latitude: String(input.latitude), start: input.start, end: input.end, format: "JSON" }).toString();
  const response = await (options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "ClimateShieldNexus/0.1" } });
  if (!response.ok) throw new ClimateProviderError("NASA_POWER_ERROR", "NASA POWER historical data request failed.", response.status);
  const parsed = powerSchema.safeParse(await response.json());
  if (!parsed.success) throw new ClimateProviderError("NASA_POWER_INVALID_DATA", "NASA POWER returned an unexpected response schema.");
  const parameters = parsed.data.properties.parameter;
  if (!parameters.PRECTOTCORR || !parameters.T2M_MAX) throw new ClimateProviderError("NASA_POWER_MISSING_VARIABLE", "NASA POWER response does not contain requested precipitation and temperature variables.");
  const actualStart = parsed.data.properties.time?.start;
  const actualEnd = parsed.data.properties.time?.end;
  if ((actualStart && actualStart !== input.start) || (actualEnd && actualEnd !== input.end)) throw new ClimateProviderError("NASA_POWER_DATE_MISMATCH", "NASA POWER response date range does not match the request.");
  const precipitation = Object.values(parameters.PRECTOTCORR ?? {});
  const maximumTemperature = Object.values(parameters.T2M_MAX ?? {});
  const fill = parsed.data.header?.fill_value;
  const average = (values: Array<number | null>) => {
    const valid = values.filter((value): value is number => value !== null && Number.isFinite(value) && value !== fill);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  };
  return {
    provider: "NASA_POWER", dataKind: "historical",
    values: { precipitationMeanMmPerDay: average(precipitation), maximumTemperatureMeanC: average(maximumTemperature) },
    units: { precipitationMeanMmPerDay: "mm/day", maximumTemperatureMeanC: "C" }, startDate: input.start, endDate: input.end,
    retrievedAt: new Date().toISOString(), attribution: "NASA POWER; historical daily point data",
  };
}