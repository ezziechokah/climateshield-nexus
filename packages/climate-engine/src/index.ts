export type RiskLevel = "INSUFFICIENT_DATA" | "LOW" | "MODERATE" | "HIGH";
export type ClimateInput = {
  precipitationNext7DaysMm: number | null;
  maximumTemperatureC: number | null;
  consecutiveDryDays: number | null;
};
export type RiskAssessment = {
  riskType: "DRY_SPELL" | "HEAVY_RAIN" | "HEAT_STRESS";
  level: RiskLevel;
  explanation: string;
  inputValue: number | null;
  unit: string;
  method: string;
};

export type ClimateQuality = { status: "VALID" | "STALE" | "POOR" | "CONTRADICTORY" };

export function assessClimate(input: ClimateInput, quality: ClimateQuality = { status: "VALID" }): RiskAssessment[] {
  const band = (value: number | null, low: number, high: number): RiskLevel =>
    quality.status !== "VALID" || value === null || !Number.isFinite(value)
      ? "INSUFFICIENT_DATA"
      : value >= high ? "HIGH" : value >= low ? "MODERATE" : "LOW";
  const validInput = (value: number | null, minimum: number, maximum: number) => value === null || (Number.isFinite(value) && value >= minimum && value <= maximum);
  const dryDays = validInput(input.consecutiveDryDays, 0, 365) ? input.consecutiveDryDays : null;
  const precipitation = validInput(input.precipitationNext7DaysMm, 0, 2000) ? input.precipitationNext7DaysMm : null;
  const maximumTemperature = validInput(input.maximumTemperatureC, -90, 65) ? input.maximumTemperatureC : null;
  return [
    {
      riskType: "DRY_SPELL", level: band(dryDays, 4, 7),
      explanation: dryDays === null ? `Dry-spell input is unavailable or invalid (${quality.status.toLowerCase()} data quality).` : `${dryDays} consecutive dry days in the selected input.`,
      inputValue: dryDays, unit: "days",
      method: "Illustrative screening bands: moderate at 4 days and high at 7 days; not locally validated.",
    },
    {
      riskType: "HEAVY_RAIN", level: band(precipitation, 35, 60),
      explanation: precipitation === null ? `Rainfall input is unavailable or invalid (${quality.status.toLowerCase()} data quality).` : `${precipitation} mm precipitation in the selected 7-day input.`,
      inputValue: precipitation, unit: "mm / 7 days",
      method: "Illustrative screening bands: moderate at 35 mm and high at 60 mm; not a flood forecast or locally validated.",
    },
    {
      riskType: "HEAT_STRESS", level: band(maximumTemperature, 32, 36),
      explanation: maximumTemperature === null ? `Maximum temperature input is unavailable or invalid (${quality.status.toLowerCase()} data quality).` : `${maximumTemperature} C maximum temperature in the selected input.`,
      inputValue: maximumTemperature, unit: "C",
      method: "Illustrative screening bands: moderate at 32 C and high at 36 C; crop-specific thresholds are not validated.",
    },
  ];
}

export function recommendationsFor(risks: RiskAssessment[], language: "en" | "sw" = "en") {
  return risks.filter((risk) => risk.level === "MODERATE" || risk.level === "HIGH").map((risk) => {
    if (risk.riskType === "DRY_SPELL") return {
      riskType: risk.riskType,
      title: language === "sw" ? "Fuatilia unyevunyevu wa udongo" : "Monitor soil moisture",
      action: language === "sw" ? "Kagua unyevunyevu wa udongo na panga matumizi ya maji kulingana na rasilimali ulizonazo." : "Check soil moisture and plan water use around available resources.",
      why: language === "sw" ? "Taarifa ya hali ya hewa inaonyesha siku nyingi bila mvua." : "The selected input indicates an extended period without rain.",
      limitation: "General decision support only. No irrigation quantity or crop-specific prescription is provided; consult an extension officer.",
    };
    if (risk.riskType === "HEAVY_RAIN") return {
      riskType: risk.riskType,
      title: language === "sw" ? "Kagua mifereji ya maji" : "Check field drainage",
      action: language === "sw" ? "Kagua njia za maji shambani na ufuatilie taarifa rasmi za hali ya hewa." : "Check field drainage paths and monitor official weather updates.",
      why: language === "sw" ? "Taarifa ya hali ya hewa inaonyesha uwezekano wa mvua nyingi." : "The selected input indicates elevated rainfall.",
      limitation: "This is not a flood warning and cannot describe conditions at an individual field.",
    };
    return {
      riskType: risk.riskType,
      title: language === "sw" ? "Punguza kazi wakati wa joto kali" : "Review work during hot periods",
      action: language === "sw" ? "Fuatilia dalili za msongo wa joto kwa mimea na panga kazi za shambani wakati wa baridi zaidi." : "Monitor crops for heat stress and consider scheduling field work during cooler hours.",
      why: language === "sw" ? "Joto la juu limeonyeshwa katika taarifa ya hali ya hewa." : "The selected input indicates elevated maximum temperature.",
      limitation: "General guidance only. Crop-specific thresholds and interventions require local expert review.",
    };
  });
}

export const demoClimateFixture: ClimateInput = Object.freeze({ precipitationNext7DaysMm: 48, maximumTemperatureC: 34, consecutiveDryDays: 5 });