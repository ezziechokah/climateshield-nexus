import { z } from "zod";

const explanationSchema = z.object({
  summary: z.string().min(1).max(500),
  uncertainty: z.string().min(1).max(500),
  recommendationExplanations: z.array(z.object({
    riskType: z.enum(["DRY_SPELL", "HEAVY_RAIN", "HEAT_STRESS"]),
    explanation: z.string().min(1).max(500),
  })).max(3),
});

export type ExplanationInput = {
  language: "en" | "sw";
  risks: Array<{ riskType: string; level: string; explanation: string; method: string }>;
  recommendations: Array<{ riskType: string; title: string; action: string; limitation: string }>;
  provenance: { source: string; simulated: boolean; retrievedAt: string; attribution: string };
  uncertainty: string[];
};

export async function explainAssessment(input: ExplanationInput) {
  const fallback = {
    summary: input.language === "sw"
      ? "Haya ni makadirio ya hatari kulingana na taarifa za hali ya hewa zilizopo. Si utabiri wa uhakika."
      : "This is a risk screening based on the available climate inputs, not a guaranteed forecast.",
    uncertainty: input.uncertainty.join(" "),
    recommendationExplanations: input.recommendations.map((recommendation) => ({
      riskType: recommendation.riskType as "DRY_SPELL" | "HEAVY_RAIN" | "HEAT_STRESS",
      explanation: recommendation.action,
    })),
    mode: "DETERMINISTIC_TEMPLATE",
  };

  const key = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;
  if (!key || !baseUrl || !model) return fallback;

  const endpoint = new URL("/v1/chat/completions", baseUrl);
  const request = {
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Explain only the supplied structured assessment. Do not invent weather, change risk levels, or add actions. Use language ${input.language === "sw" ? "Kiswahili" : "English"}. Return JSON with keys summary, uncertainty, recommendationExplanations (array of riskType and explanation). State limitations and uncertainty.` },
      { role: "user", content: JSON.stringify({ risks: input.risks, recommendations: input.recommendations, provenance: input.provenance, uncertainty: input.uncertainty }) },
    ],
  };
  try {
    const response = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
    if (!response.ok) return fallback;
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const parsedJson: unknown = JSON.parse(content);
    const parsed = explanationSchema.safeParse(parsedJson);
    if (!parsed.success) return fallback;
    const allowed = new Set(input.recommendations.map((item) => item.riskType));
    if (parsed.data.recommendationExplanations.some((item) => !allowed.has(item.riskType))) return fallback;
    return { ...parsed.data, mode: "AI_PROVIDER_VALIDATED" };
  } catch {
    return fallback;
  }
}