import { box, choice, image, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { decideEvidence, type EvidenceStance, type JevEvidenceJudgement, type PolicyDecision } from "./policy.js";

export interface NasaEvidenceInput {
  id: string;
  title: string;
  date?: string;
  published?: string;
  mission?: string;
  instrument?: string;
  sol?: number | null;
  summary: string;
  url: string;
  credit?: string;
  evidence_type?: string;
  limitations?: string;
  image_url?: string;
  georeferencing_status?: string;
}

export interface EvaluationResult {
  evidenceId: string;
  title: string;
  stance: EvidenceStance;
  stanceConfidence: number;
  stanceProbabilities: Record<string, number>;
  relevanceScore: number;
  relevanceConfidence: number;
  relevanceLegend: unknown;
  directSupportProbability: number;
  noveltyScore: number;
  noveltyConfidence: number;
  noveltyLegend: unknown;
  model: string;
  usage: { input_tokens: number | null; output_tokens: number | null };
  decision: PolicyDecision;
  source: { url: string; mission?: string; instrument?: string; observationDate?: string; sol?: number | null; credit?: string };
}

export const JEV_EVIDENCE_MODEL = "jev-1.14.0";

const STANCE_CRITERIA = {
  supports: "The observation provides evidence that is directly or materially consistent with the stated hypothesis.",
  contradicts: "The observation provides evidence that is materially inconsistent with the stated hypothesis.",
  contextual: "The observation provides relevant context but does not directly support or contradict the hypothesis.",
  insufficient: "The supplied record does not contain enough information to determine its relationship to the hypothesis.",
} as const;

const RELEVANCE_RUBRIC = [
  "0 — Unrelated: does not address the mission objective or hypothesis.",
  "1 — Tangential: provides broad background but little bearing on the stated question.",
  "2 — Relevant: bears on the question but is indirect, incomplete, or context-dependent.",
  "3 — Directly relevant: contains direct observation or measurement closely tied to the stated question.",
] as const;

const NOVELTY_RUBRIC = [
  "0 — No apparent novelty: duplicates well-characterized information in the supplied context.",
  "1 — Low novelty: adds a small detail or another example of known evidence.",
  "2 — Moderate novelty: may constrain an interpretation or add a distinct observation.",
  "3 — High novelty potential: could materially distinguish interpretations or close a stated evidence gap.",
] as const;

function numberOr(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stanceOr(value: string): EvidenceStance {
  if (value === "supports" || value === "contradicts" || value === "contextual") return value;
  return "insufficient";
}

export type JevProvider = "typesafe" | "opencode";

export const OPENCODE_JEV_MODEL = "jev-1.13-free";
const OPENCODE_SYSTEM_ONE_ENDPOINT = "https://opencode.ai/inference/systemone/v1/systemone";

interface SystemOneAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  noul?: number;
  confidence?: number;
  legend?: unknown;
}

interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

function numberMapOrEmpty(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
}

async function evaluateWithOpenCode(
  apiKey: string,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
): Promise<SystemOneResponse> {
  const response = await fetch(OPENCODE_SYSTEM_ONE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: OPENCODE_JEV_MODEL,
      state,
      questions,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("OpenCode Jev provider request failed.");
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  if (!payload || typeof payload !== "object" || !("answers" in payload)) {
    throw new Error("OpenCode Jev returned an unexpected response. No decision was created.");
  }
  return payload as SystemOneResponse;
}

export async function evaluateNasaEvidence(input: {
  apiKey: string;
  provider?: JevProvider;
  objective: string;
  hypothesis: string;
  evidence: NasaEvidenceInput[];
}): Promise<{ model: string; evaluatedAt: string; results: EvaluationResult[]; notice: string }> {
  const provider = input.provider ?? "typesafe";
  const apiKey = input.apiKey.trim();
  const providerName = provider === "opencode" ? "OpenCode Console" : "TypeSafe";
  if (provider !== "typesafe" && provider !== "opencode") throw new Error("Choose a supported Jev provider.");
  if (!apiKey || apiKey.length > 1024) throw new Error(`Enter your ${providerName} API key (maximum 1,024 characters). The key is used for this request only.`);
  if (!input.objective.trim() || input.objective.length > 500) throw new Error("Mission objective must contain 1–500 characters.");
  if (!input.hypothesis.trim() || input.hypothesis.length > 700) throw new Error("Hypothesis must contain 1–700 characters.");
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 4) throw new Error("Select between 1 and 4 NASA evidence records per evaluation.");

  // TypeSafe remains the default provider. OpenCode is called through its
  // documented System One HTTP endpoint with the limited-time free Jev model.
  // Both keys stay request-scoped and are never copied to process.env or disk.
  const client = provider === "typesafe"
    ? new TypeSafeClient({ apiKey, defaultModel: JEV_EVIDENCE_MODEL, logLevel: "off", timeout: 90_000, retry: { maxRetries: 0 } })
    : null;
  const results: EvaluationResult[] = [];
  let effectiveModel = provider === "opencode" ? OPENCODE_JEV_MODEL : JEV_EVIDENCE_MODEL;

  // Sequential requests keep the user-controlled batch small and avoid a burst
  // of API calls. A failed item aborts the batch rather than fabricating a fallback.
  for (const record of input.evidence) {
    const state = {
      mission_objective: input.objective.trim(),
      working_hypothesis: input.hypothesis.trim(),
      nasa_observation: {
        id: record.id,
        title: record.title,
        observation_date: record.date ?? null,
        publication_date: record.published ?? null,
        mission: record.mission ?? null,
        instrument: record.instrument ?? null,
        sol: record.sol ?? null,
        evidence_type: record.evidence_type ?? null,
        summary: record.summary.slice(0, 5000),
        limitations: record.limitations ?? "Not supplied in the local source record.",
        provenance_url: record.url,
        credit: record.credit ?? null,
      },
      instruction: "Evaluate only the supplied source record. Do not infer missing coordinates, measurements, mineral identifications, or instrument results. If the record is only a published description, state that it is a description rather than an independent measurement. Distinguish supporting, contradicting, contextual, and insufficient evidence.",
    };

    const questions = {
      relationship: choice("What is the relationship of this specific observation to the stated hypothesis? Choose insufficient when the supplied record does not justify a clearer answer.", STANCE_CRITERIA),
      relevance: score("How directly relevant is this record to the mission objective and hypothesis? Apply the ordered rubric exactly.", RELEVANCE_RUBRIC),
      direct_support: noul("Does the supplied source record itself contain observation-level evidence that materially supports the stated hypothesis? Answer no when it merely repeats general background or a proposed interpretation without directly relevant observation detail."),
      novelty: score("How much potential new information might this record add relative to the stated objective, based only on the supplied summary? This is a model judgment, not a measured information-gain value.", NOVELTY_RUBRIC),
    };
    const response = (provider === "opencode"
      ? await evaluateWithOpenCode(apiKey, state, questions)
      : await client!.systemOne({ state, questions: questions as never })) as unknown as SystemOneResponse;

    if (!response.answers?.relationship || !response.answers?.relevance || !response.answers?.direct_support || !response.answers?.novelty) {
      throw new Error(`${providerName} Jev response was missing one or more required judgments. No decision was created.`);
    }

    const answers = response.answers;
    effectiveModel = response.model || effectiveModel;
    const stance = stanceOr(String(answers.relationship.choice ?? ""));
    const judgement: JevEvidenceJudgement = {
      evidenceId: record.id,
      title: record.title,
      stance,
      stanceConfidence: numberOr(answers.relationship.confidence),
      relevanceScore: numberOr(answers.relevance.score),
      relevanceConfidence: numberOr(answers.relevance.confidence),
      directSupportProbability: numberOr(answers.direct_support.noul),
      noveltyScore: numberOr(answers.novelty.score),
      noveltyConfidence: numberOr(answers.novelty.confidence),
      model: response.model || effectiveModel,
      tokens: { input: response.usage?.input_tokens ?? null, output: response.usage?.output_tokens ?? null },
    };
    const georeferenced = record.georeferencing_status === "VERIFIED_GEOREFERENCED";
    results.push({
      evidenceId: record.id,
      title: record.title,
      stance,
      stanceConfidence: judgement.stanceConfidence,
      stanceProbabilities: numberMapOrEmpty(answers.relationship.probabilities),
      relevanceScore: judgement.relevanceScore,
      relevanceConfidence: judgement.relevanceConfidence,
      relevanceLegend: answers.relevance.legend,
      directSupportProbability: judgement.directSupportProbability,
      noveltyScore: judgement.noveltyScore,
      noveltyConfidence: judgement.noveltyConfidence,
      noveltyLegend: answers.novelty.legend,
      model: response.model || effectiveModel,
      usage: {
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
      },
      decision: decideEvidence(judgement, georeferenced),
      source: {
        url: record.url,
        mission: record.mission,
        instrument: record.instrument,
        observationDate: record.date,
        sol: record.sol,
        credit: record.credit,
      },
    });
  }

  const providerNotice = provider === "opencode"
    ? " Evaluations used OpenCode Console's limited-time Jev 1.13 Free model; free-model availability may change."
    : " Evaluations used TypeSafe's Jev 1.14.0 model.";
  return {
    model: effectiveModel,
    evaluatedAt: new Date().toISOString(),
    results,
    notice: "Jev outputs are model judgments, not calibrated scientific posterior probabilities. Results are decision-support suggestions only. Original NASA products, labels, contradictory evidence and human scientific review remain authoritative. No route or safety constraint is changed automatically." + providerNotice,
  };
}


export interface RouteCandidateInput {
  id: string;
  name: string;
  profile: string;
  metrics: {
    distance_m: number;
    duration_min: number;
    energy_wh: number;
    terrain_risk_pct: number;
    environment_risk_pct: number | null;
    radiation_index_pct: number | null;
    uncertainty_pct: number;
    scientific_value_pct: number | null;
    return_feasible: boolean;
    oxygen_l?: number;
    return_oxygen_l?: number;
  };
}

export interface RouteCandidateJudgement {
  routeId: string;
  score: number;
  scoreConfidence: number;
  missionFitProbability: number;
  choiceProbability: number;
  fusionScore: number;
}

export interface RouteOptimizationResult {
  provider: JevProvider;
  model: string;
  evaluatedAt: string;
  missionPrompt: string;
  choiceRouteId: string;
  choiceConfidence: number;
  selectedRouteId: string;
  results: RouteCandidateJudgement[];
  usage: { input_tokens: number | null; output_tokens: number | null };
  policyVersion: string;
  notice: string;
}

const ROUTE_FIT_RUBRIC = [
  "0 — Poor fit: conflicts with the stated mission priorities or has clearly inferior supplied metrics.",
  "1 — Weak fit: satisfies some priorities but has substantial trade-offs for this mission.",
  "2 — Good fit: aligns with the main priorities and has reasonable trade-offs against the alternatives.",
  "3 — Strong fit: best overall alignment with the stated priorities among the supplied feasible candidates.",
] as const;

const clampProbability = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/**
 * Jev ranks only route candidates already generated and checked by MARSCOPE.
 * It cannot edit geometry or relax the Python planner's hard constraints.
 */
export async function evaluateRouteCandidates(input: {
  apiKey: string;
  provider: JevProvider;
  missionPrompt: string;
  candidates: RouteCandidateInput[];
}): Promise<RouteOptimizationResult> {
  const apiKey = input.apiKey.trim();
  const providerName = input.provider === "opencode" ? "OpenCode Console" : "TypeSafe";
  const missionPrompt = input.missionPrompt.trim();
  if (!apiKey || apiKey.length > 1024) throw new Error(`Enter your ${providerName} API key (maximum 1,024 characters).`);
  if (!missionPrompt || missionPrompt.length > 600) throw new Error("Mission prompt must contain 1–600 characters.");
  if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 4) {
    throw new Error("Jev route ranking requires between 2 and 4 candidate routes.");
  }
  const ids = input.candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[A-Z0-9_-]{1,12}$/.test(id))) {
    throw new Error("Route candidate IDs must be unique, short, stable identifiers.");
  }
  if (input.candidates.some((candidate) => candidate.metrics.return_feasible !== true)) {
    throw new Error("Only routes that pass MARSCOPE's deterministic return-resource feasibility check may be sent to Jev.");
  }

  const state = {
    mission_prompt: missionPrompt,
    candidate_routes: input.candidates.map((candidate) => ({
      id: candidate.id,
      profile: candidate.profile,
      name: candidate.name,
      metrics: candidate.metrics,
    })),
    hard_constraints: {
      instruction: "MARSCOPE has already filtered out candidates that fail its deterministic feasibility check. Do not waive or reinterpret those constraints.",
      route_geometry: "Candidate paths have already been generated by MARSCOPE multi-objective A*. Jev selects among candidates; it does not edit coordinates or create waypoints.",
    },
    decision_instruction: "Interpret the user's mission prompt as preferences, not as permission to violate hard constraints. Compare only supplied route metrics. Treat null or unavailable metrics as unknown, never as zero. Do not invent terrain facts. Prefer the best trade-off for this specific prompt and return a categorical choice among the exact candidate IDs.",
  };

  const choiceCriteria = Object.fromEntries(input.candidates.map((candidate) => [
    candidate.id,
    `${candidate.name} (${candidate.profile}). Supplied metrics: ${JSON.stringify(candidate.metrics)}`,
  ]));
  const questions: Record<string, unknown> = {
    preferred_route: choice(
      "Which exact candidate route best fits the mission prompt? Select one candidate ID. Consider all listed trade-offs and do not invent missing metrics.",
      choiceCriteria,
    ),
  };
  for (const candidate of input.candidates) {
    questions[`route_score_${candidate.id}`] = score(
      `Score candidate route ${candidate.id} from 0 to 3 for alignment with the mission prompt, comparing it with the other supplied candidates. Apply the rubric exactly.`,
      ROUTE_FIT_RUBRIC,
    );
    questions[`mission_fit_${candidate.id}`] = noul(
      `What is the probability, from 0 to 1, that candidate route ${candidate.id} is a good fit for the user's stated mission priorities based only on the supplied prompt and metrics? This is a subjective model estimate, not a safety probability.`,
    );
  }

  const client = input.provider === "typesafe"
    ? new TypeSafeClient({ apiKey, defaultModel: JEV_EVIDENCE_MODEL, logLevel: "off", timeout: 90_000, retry: { maxRetries: 0 } })
    : null;
  const response = (input.provider === "opencode"
    ? await evaluateWithOpenCode(apiKey, state, questions)
    : await client!.systemOne({ state, questions: questions as never })) as unknown as SystemOneResponse;

  const preferred = response.answers?.preferred_route;
  const rawChoice = typeof preferred?.choice === "string" ? preferred.choice.trim() : "";
  const normalizedChoice = rawChoice.replace(/^route\s+/i, "").trim();
  const matchedChoice = input.candidates.find((candidate) =>
    candidate.id.toLowerCase() === normalizedChoice.toLowerCase() ||
    candidate.name.toLowerCase() === normalizedChoice.toLowerCase() ||
    candidate.profile.toLowerCase() === normalizedChoice.toLowerCase()
  );
  const choiceRouteId = matchedChoice?.id ?? "";
  if (!ids.includes(choiceRouteId)) {
    throw new Error(`${providerName} Jev returned a route choice that did not match a supplied candidate ID. No route was changed.`);
  }

  const probabilityMap = numberMapOrEmpty(preferred?.probabilities);
  const judgements: RouteCandidateJudgement[] = input.candidates.map((candidate) => {
    const scoreAnswer = response.answers?.[`route_score_${candidate.id}`];
    const fitAnswer = response.answers?.[`mission_fit_${candidate.id}`];
    const scoreValue = finiteNumber(scoreAnswer?.score);
    const fitValue = finiteNumber(fitAnswer?.noul);
    if (scoreValue === null || fitValue === null) {
      throw new Error(`${providerName} Jev response was missing the score or Noul judgement for route ${candidate.id}. No route was changed.`);
    }
    const normalizedScore = clampProbability(scoreValue / 3);
    const missionFitProbability = clampProbability(fitValue);
    const choiceProbability = clampProbability(
      probabilityMap[candidate.id] ?? (candidate.id === choiceRouteId ? 1 : 0),
    );
    // Fusion keeps Jev's three typed judgments visible and influential. This is
    // a prototype preference score, not a calibrated success or safety probability.
    const fusionScore = 0.50 * normalizedScore + 0.30 * missionFitProbability + 0.20 * choiceProbability;
    return {
      routeId: candidate.id,
      score: Math.max(0, Math.min(3, scoreValue)),
      scoreConfidence: clampProbability(finiteNumber(scoreAnswer?.confidence) ?? 0),
      missionFitProbability,
      choiceProbability,
      fusionScore,
    };
  });

  judgements.sort((a, b) => b.fusionScore - a.fusionScore || Number(b.routeId === choiceRouteId) - Number(a.routeId === choiceRouteId));
  return {
    provider: input.provider,
    model: response.model || (input.provider === "opencode" ? OPENCODE_JEV_MODEL : JEV_EVIDENCE_MODEL),
    evaluatedAt: new Date().toISOString(),
    missionPrompt,
    choiceRouteId,
    choiceConfidence: clampProbability(finiteNumber(preferred?.confidence) ?? 0),
    selectedRouteId: judgements[0].routeId,
    results: judgements,
    usage: {
      input_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
    },
    policyVersion: "jev-route-fusion-0.1.0",
    notice: "Jev's Choice, Score and Noul outputs influence this ranking. The fusion score is an experimental preference score, not a calibrated probability of route success or safety. MARSCOPE's deterministic feasibility checks remain authoritative; Jev cannot edit path geometry or relax constraints.",
  };
}


export const PATHFINDING_OBJECTIVES = [
  { id: "distance", label: "Travel distance", description: "Prefer shorter geometric travel distance." },
  { id: "time", label: "Travel time", description: "Prefer lower estimated traversal time." },
  { id: "energy", label: "Energy use", description: "Prefer lower estimated energy expenditure." },
  { id: "terrain_risk", label: "Terrain difficulty", description: "Prefer cells with lower slope, roughness and regolith mobility difficulty." },
  { id: "environment_risk", label: "Environmental risk index", description: "Prefer lower environmental-index values, only when an atmosphere/environment layer is available." },
  { id: "radiation", label: "Radiation index", description: "Prefer lower radiation-index values, only when a radiation layer is available." },
  { id: "uncertainty", label: "Data uncertainty", description: "Prefer route cells with lower uncertainty in the supplied terrain data." },
  { id: "science_opportunity_cost", label: "Scientific opportunity cost", description: "Prefer routes near higher science-potential cells. Lower cost means less missed science opportunity." },
  { id: "oxygen", label: "Oxygen consumption", description: "Prefer lower estimated oxygen consumption." },
] as const;

export type PathfindingObjective = typeof PATHFINDING_OBJECTIVES[number]["id"];
export type PathfindingWeightResult = {
  provider: JevProvider;
  model: string;
  evaluatedAt: string;
  missionPrompt: string;
  strategy: string;
  weights: Record<PathfindingObjective, number>;
  judgements: Array<{
    objective: PathfindingObjective;
    label: string;
    score: number;
    relevance: number;
    confidence: number;
    normalizedPriority: number;
    weight: number;
  }>;
  jevInfluenceShare: number;
  strategyPriorShare: number;
  usage: { input_tokens: number | null; output_tokens: number | null };
  policyVersion: string;
  notice: string;
};

const PATH_WEIGHT_RUBRIC = [
  "0 — Not a mission priority: the prompt does not materially value this objective, or the objective is not relevant to the stated task.",
  "1 — Secondary priority: useful, but can be traded away for more important mission goals.",
  "2 — High priority: materially influences route quality and should noticeably affect the route cost.",
  "3 — Dominant priority: one of the mission's most important route-selection objectives.",
] as const;

const STRATEGY_PRIORS: Record<string, Record<PathfindingObjective, number>> = {
  balanced: { distance: 0.16, time: 0.11, energy: 0.11, terrain_risk: 0.17, environment_risk: 0.08, radiation: 0.08, uncertainty: 0.12, science_opportunity_cost: 0.09, oxygen: 0.08 },
  risk_first: { distance: 0.05, time: 0.04, energy: 0.07, terrain_risk: 0.26, environment_risk: 0.13, radiation: 0.13, uncertainty: 0.20, science_opportunity_cost: 0.04, oxygen: 0.17 },
  efficiency_first: { distance: 0.24, time: 0.19, energy: 0.17, terrain_risk: 0.08, environment_risk: 0.04, radiation: 0.04, uncertainty: 0.06, science_opportunity_cost: 0.04, oxygen: 0.13 },
  science_first: { distance: 0.06, time: 0.04, energy: 0.05, terrain_risk: 0.08, environment_risk: 0.04, radiation: 0.04, uncertainty: 0.07, science_opportunity_cost: 0.48, oxygen: 0.13 },
  uncertainty_first: { distance: 0.06, time: 0.04, energy: 0.05, terrain_risk: 0.10, environment_risk: 0.05, radiation: 0.05, uncertainty: 0.42, science_opportunity_cost: 0.10, oxygen: 0.12 },
};

const AVAILABLE_LAYER_BY_OBJECTIVE: Partial<Record<PathfindingObjective, string>> = {
  environment_risk: "atmosphere",
  radiation: "radiation",
  science_opportunity_cost: "science",
};

function normalizeWeights(raw: Partial<Record<PathfindingObjective, number>>, active: PathfindingObjective[]): Record<PathfindingObjective, number> {
  const total = active.reduce((sum, id) => sum + Math.max(0, raw[id] ?? 0), 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Jev did not provide usable pathfinding priorities.");
  const result = {} as Record<PathfindingObjective, number>;
  for (const objective of PATHFINDING_OBJECTIVES) result[objective.id] = active.includes(objective.id) ? Math.max(0, raw[objective.id] ?? 0) / total : 0;
  return result;
}

/**
 * Converts Jev's typed judgments into the actual normalized objective-weight
 * vector consumed by MARSCOPE's weighted multi-objective A* and LPA* search.
 * Jev controls 90% of the vector; the selected strategy prior contributes 10%.
 */
export async function evaluatePathfindingWeights(input: {
  apiKey: string;
  provider: JevProvider;
  missionPrompt: string;
  availableLayers: string[];
  missionContext?: Record<string, string | number | boolean | null>;
}): Promise<PathfindingWeightResult> {
  const apiKey = input.apiKey.trim();
  const providerName = input.provider === "opencode" ? "OpenCode Console" : "TypeSafe";
  const missionPrompt = input.missionPrompt.trim();
  if (!apiKey || apiKey.length > 1024) throw new Error(`Enter your ${providerName} API key (maximum 1,024 characters).`);
  if (!missionPrompt || missionPrompt.length > 600) throw new Error("Mission prompt must contain 1–600 characters.");
  if (!Array.isArray(input.availableLayers) || input.availableLayers.length > 32 || input.availableLayers.some((item) => typeof item !== "string" || item.length > 64)) {
    throw new Error("Available terrain layers must be a list of short layer identifiers.");
  }
  const availableLayers = new Set(input.availableLayers);
  const missionContext = input.missionContext ?? {};
  const contextEntries = Object.entries(missionContext);
  if (contextEntries.length > 20 || contextEntries.some(([key, value]) =>
    !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) ||
    (typeof value === "string" && value.length > 120) ||
    (typeof value === "number" && !Number.isFinite(value)) ||
    !(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
  )) {
    throw new Error("Mission context must contain at most 20 short, simple fields.");
  }
  const activeObjectives = PATHFINDING_OBJECTIVES.filter((objective) => {
    const requiredLayer = AVAILABLE_LAYER_BY_OBJECTIVE[objective.id];
    return !requiredLayer || availableLayers.has(requiredLayer);
  });
  if (activeObjectives.length < 5) throw new Error("The terrain does not expose enough supported planner objectives for adaptive weighting.");

  const strategyCriteria = {
    balanced: "Balanced across movement cost, terrain difficulty, uncertainty and resources.",
    risk_first: "Give the strongest emphasis to terrain and environmental risk indicators and data uncertainty.",
    efficiency_first: "Give the strongest emphasis to distance, travel time, energy and oxygen efficiency.",
    science_first: "Give the strongest emphasis to scientific opportunity while retaining meaningful movement and terrain costs.",
    uncertainty_first: "Give the strongest emphasis to choosing paths through better-characterized terrain.",
  };
  const state = {
    mission_prompt: missionPrompt,
    mission_context: missionContext,
    available_terrain_layers: [...availableLayers],
    objectives: activeObjectives.map((objective) => ({ id: objective.id, label: objective.label, definition: objective.description })),
    weight_semantics: "All planner objective components are normalized non-negative costs. A larger weight makes the A* search prioritize reducing that objective's cumulative cost. The science_opportunity_cost is lower near cells with higher science potential.",
    instruction: "Set route-preference weights for this mission. Interpret the prompt as preferences only. Never alter hard constraints, invent unavailable terrain layers or treat missing layers as zero-valued evidence. All available objectives will receive a positive floor before normalization.",
  };
  const questions: Record<string, unknown> = {
    mission_strategy: choice("Which strategic focus best summarizes the user's mission prompt? Select exactly one strategy key.", strategyCriteria),
  };
  for (const objective of activeObjectives) {
    questions[`priority_${objective.id}`] = score(
      `How important should ${objective.label} be in the route cost weights for this mission? ${objective.description} Evaluate its importance from the mission prompt, not whether its current measured value is high or low.`,
      PATH_WEIGHT_RUBRIC,
    );
    questions[`relevance_${objective.id}`] = noul(
      `Estimate from 0 to 1 how relevant prioritizing ${objective.label} is to satisfying the user's mission prompt, based only on the supplied objective definition, mission text and available terrain layers. This is a subjective preference estimate, not a safety probability.`,
    );
  }

  const response = (input.provider === "opencode"
    ? await evaluateWithOpenCode(apiKey, state, questions)
    : await new TypeSafeClient({ apiKey, defaultModel: JEV_EVIDENCE_MODEL, logLevel: "off", timeout: 90_000, retry: { maxRetries: 0 } }).systemOne({ state, questions: questions as never })) as unknown as SystemOneResponse;

  const strategyRaw = response.answers?.mission_strategy?.choice?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
  if (!Object.prototype.hasOwnProperty.call(STRATEGY_PRIORS, strategyRaw)) {
    throw new Error(`${providerName} Jev returned an unknown mission strategy. No path weights were applied.`);
  }
  const strategy = strategyRaw as keyof typeof STRATEGY_PRIORS;
  const jevPrior: Partial<Record<PathfindingObjective, number>> = {};
  const judgementDraft: Array<{ objective: PathfindingObjective; label: string; score: number; relevance: number; confidence: number; rawPriority: number }> = [];
  for (const objective of activeObjectives) {
    const scoreAnswer = finiteNumber(response.answers?.[`priority_${objective.id}`]?.score);
    const relevanceAnswer = finiteNumber(response.answers?.[`relevance_${objective.id}`]?.noul);
    if (scoreAnswer === null || relevanceAnswer === null || scoreAnswer < 0 || scoreAnswer > 3 || relevanceAnswer < 0 || relevanceAnswer > 1) {
      throw new Error(`${providerName} Jev returned an invalid priority judgement for ${objective.id}. No path weights were applied.`);
    }
    const normalizedScore = scoreAnswer / 3;
    const relevance = clampProbability(relevanceAnswer);
    const rawPriority = Math.max(0.025, 0.75 * normalizedScore + 0.25 * relevance);
    jevPrior[objective.id] = rawPriority;
    judgementDraft.push({
      objective: objective.id,
      label: objective.label,
      score: scoreAnswer,
      relevance,
      confidence: clampProbability(finiteNumber(response.answers?.[`priority_${objective.id}`]?.confidence) ?? 0),
      rawPriority,
    });
  }
  const normalizedJev = normalizeWeights(jevPrior, activeObjectives.map((item) => item.id));
  const normalizedStrategy = normalizeWeights(STRATEGY_PRIORS[strategy], activeObjectives.map((item) => item.id));
  const jevInfluenceShare = 0.90;
  const strategyPriorShare = 0.10;
  const weights = {} as Record<PathfindingObjective, number>;
  for (const objective of PATHFINDING_OBJECTIVES) {
    weights[objective.id] = jevInfluenceShare * normalizedJev[objective.id] + strategyPriorShare * normalizedStrategy[objective.id];
  }
  const judgements = judgementDraft.map((item) => ({
    objective: item.objective,
    label: item.label,
    score: item.score,
    relevance: item.relevance,
    confidence: item.confidence,
    normalizedPriority: normalizedJev[item.objective],
    weight: weights[item.objective],
  })).sort((a, b) => b.weight - a.weight);

  return {
    provider: input.provider,
    model: response.model || (input.provider === "opencode" ? OPENCODE_JEV_MODEL : JEV_EVIDENCE_MODEL),
    evaluatedAt: new Date().toISOString(),
    missionPrompt,
    strategy,
    weights,
    judgements,
    jevInfluenceShare,
    strategyPriorShare,
    usage: { input_tokens: response.usage?.input_tokens ?? null, output_tokens: response.usage?.output_tokens ?? null },
    policyVersion: "jev-weighted-a-star-1.0.0",
    notice: "These weights are mission preferences that directly affect A* edge-cost scalarization, Pareto-frontier pruning and LPA* repair. They are not probabilities of route success or safety. Deterministic terrain/resource hard constraints are unchanged; unavailable spatial layers receive zero weight.",
  };
}

export interface JevImageBoxResult {
  model: string;
  evaluatedAt: string;
  source: { id: string; url: string; imageUrl: string; imageBytes: number };
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number | null;
  notice: string;
}

/**
 * Experimental image annotation. Box coordinates are fractions of the source
 * image dimensions only; they are never interpreted as Mars coordinates.
 */
export async function locateBoxworkInNasaImage(input: { apiKey: string; imageBytes: Uint8Array }): Promise<JevImageBoxResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > 1024) throw new Error("Enter your TypeSafe API key (maximum 1,024 characters). The key is used for this request only.");
  if (!(input.imageBytes instanceof Uint8Array) || input.imageBytes.byteLength < 10_000 || input.imageBytes.byteLength > 20 * 1024 * 1024) {
    throw new Error("The NASA panorama image is empty or exceeds the 20 MB annotation limit.");
  }

  // Image reasoning is an explicitly experimental TypeSafe capability. Its
  // candidate rectangle remains image-relative and requires human validation.
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: "jev-preview",
    logLevel: "off",
    timeout: 90_000,
    defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
  });
  const response = await client.systemOne({
    model: "jev-preview",
    state: {
      source_record: "NASA/JPL PIA26560 — Curiosity Views Boxwork Patterns at a Distance",
      instrument: "Mastcam panorama, Sol 4536, acquired 2025-05-22 from 23 source frames",
      task: "Inspect the supplied rover-local photograph only. Identify one visually clear candidate boxwork ridge/hollow pattern, if present. Do not infer mineralogy, exact location, scale, danger, or any Mars latitude/longitude. If no clear candidate exists, return a box for the most visually relevant area and require human review.",
      panorama: image(new Uint8Array(input.imageBytes)),
    },
    questions: {
      candidate_region: box("Locate a single visually clear candidate boxwork ridge and adjacent hollow pattern. Return the tightest useful rectangle around the visual feature; it is an image annotation only."),
    },
  });

  const answer = response.answers.candidate_region;
  const candidate = answer.box;
  const values = [candidate.top, candidate.bottom, candidate.left, candidate.right];
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) || candidate.top >= candidate.bottom || candidate.left >= candidate.right) {
    throw new Error("Jev returned an invalid image-relative box. No annotation was saved.");
  }
  return {
    model: response.model || "jev-preview",
    evaluatedAt: new Date().toISOString(),
    source: {
      id: "NASA-PIA26560",
      url: "https://www.jpl.nasa.gov/images/pia26560-curiosity-views-boxwork-patterns-at-a-distance/",
      imageUrl: "https://d2pn8kiwq2w21t.cloudfront.net/original_images/jpegPIA26560.jpg",
      imageBytes: input.imageBytes.byteLength,
    },
    box: { top: candidate.top, bottom: candidate.bottom, left: candidate.left, right: candidate.right },
    confidence: typeof answer.confidence === "number" ? answer.confidence : null,
    notice: "Experimental Jev Box annotation. Coordinates are normalized image fractions, not Mars coordinates. A rover image is not georegistered by this operation. Validate the region visually and do not use it for navigation or geological classification without expert review.",
  };
}
