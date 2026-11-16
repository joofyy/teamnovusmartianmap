export type BackendHealth = {
  status: string;
  project: string;
  release: string;
  terrain?: {
    supported_sites: string[];
    loaded_sites: string[];
    loaded_count: number;
    load_scope: string;
  };
  integrations?: {
    configured_archives: string[];
    availability_check: string;
  };
};

export type Point = { x: number; y: number };

export type PlannerObjective = 'distance' | 'time' | 'energy' | 'terrain_risk' | 'environment_risk' | 'radiation' | 'uncertainty' | 'science_opportunity_cost' | 'oxygen';

export type MissionConstraintsPayload = {
  max_slope_deg?: number;
  max_temperature_c?: number;
  eva_limit_minutes?: number;
  energy_budget_wh?: number;
  return_reserve_fraction?: number;
  suit_mass_kg?: number;
  carried_equipment_mass_kg?: number;
  base_speed_mps?: number;
  oxygen_budget_l?: number;
  oxygen_consumption_lpm?: number;
  rest_interval_min?: number;
  rest_duration_min?: number;
  objective_weight_multipliers?: Partial<Record<PlannerObjective, number>>;
};

export type Target = {
  id: string;
  name: string;
  x: number;
  y: number;
  description: string;
  evidence_status: string;
  science_category: string;
};

export type TerrainData = {
  id: string;
  site_id: string;
  site_name: string;
  name: string;
  status: string;
  warning: string;
  width: number;
  height: number;
  cell_size_m: number;
  seed?: number;
  elevation_m: number[][];
  slope_deg: number[][];
  roughness: number[][];
  regolith: number[][] | null;
  temperature_c: number[][] | null;
  environment_index: number[][] | null;
  radiation_index: number[][] | null;
  uncertainty: number[][] | null;
  science_potential: number[][] | null;
  obstacle: boolean[][];
  valid_mask?: boolean[][] | null;
  targets: Target[];
  cell_units: string;
  layer_provenance: string;
  available_layers?: string[];
  coordinate_info?: Record<string, unknown>;
};

export type RouteMetrics = {
  distance_m: number;
  duration_min: number;
  energy_wh: number;
  terrain_risk_pct: number;
  environment_risk_pct: number | null;
  radiation_index_pct: number | null;
  uncertainty_pct: number | null;
  scientific_value_pct: number | null;
  return_feasible: boolean;
  return_time_estimate_min: number;
  return_energy_estimate_wh: number;
  oxygen_l?: number;
  return_oxygen_l?: number;
  carried_mass_kg?: number;
  communication_assessment?: string;
  available_terrain_layers?: string[];
  nearby_targets: Target[];
  model_note: string;
};

export type Route = {
  id: string;
  profile: 'conservative' | 'balanced' | 'science_first';
  name: string;
  summary: string;
  path: Point[];
  metrics: RouteMetrics;
  search: {
    expanded_nodes: number;
    generated_labels: number;
    runtime_ms?: number;
    edge_cache_hits?: number;
    edge_cache_misses?: number;
    max_labels_per_cell?: number;
    pareto_labels_at_goal: number;
    objective_vector: Record<string, number>;
    approximate_frontier: boolean;
  };
  weights: Record<string, number>;
  is_pareto: boolean;
  tradeoff_summary?: string;
  diversity?: {
    max_corridor_overlap_pct: number;
    unique_corridor_pct: number;
    label: string;
    interpretation: string;
  };
};

export type PlanResponse = {
  plan_id: string;
  site_id?: string;
  planning_runtime_ms?: number;
  terrain_id: string;
  start: Point;
  goal: Point;
  constraints: MissionConstraintsPayload;
  routes: Route[];
  scientific_note: string;
};

export type ReplanResponse = {
  plan_id: string;
  path: Point[];
  metrics: RouteMetrics;
  obstacle: Point;
  algorithm: string;
  expanded_during_repair: number;
  total_expanded_lifetime: number;
  obstacles_added: Point[];
  notice: string;
};

export type MissionEvent = {
  id: string;
  sequence: number;
  timestamp_utc: string;
  type: string;
  title: string;
  summary: string;
  data: Record<string, unknown>;
};

export type DatasetRecord = {
  id: string;
  name: string;
  mission: string;
  instrument: string;
  access_type: string;
  format: string;
  coverage: string;
  crs: string;
  resolution: string;
  observation_date: string;
  units: string;
  availability: string;
  use: string;
  url: string;
  implementation: string;
};

export type RegistryResponse = {
  datasets: DatasetRecord[];
  common_coordinate_policy: Record<string, string>;
};


export type BenchmarkResult = {
  algorithm: string;
  runtime_ms: number;
  expanded_nodes: number;
  objective_cost: number;
  distance_m: number;
  duration_min: number;
  energy_wh: number;
  terrain_risk_pct: number;
  scientific_value_pct: number | null;
  return_feasible: boolean;
  path: Point[];
};


export type OfficialSource = {
  id: string; name: string; organization: string; kind: string; url: string;
  documentation: string; format: string; coverage: string; availability: string;
  integration: string; description: string; limitations: string;
};

export type ArchiveResult = {
  archive: string; endpoint: string; query: Record<string, unknown>; record_count: number;
  records: Record<string, unknown>[]; raw: unknown; documentation: string; note: string;
};

export type ScienceAnswer = {
  answer: string; evidence: Array<{ id: string; title: string; date: string; published?: string; instrument?: string; sol?: number | null; summary: string; url: string; credit?: string; limitations?: string; retrieval_score?: number }>;
  mode: string; caution: string; model?: string; response_id?: string; generation_note?: string;
};

export type OfflineStatus = {
  package_count: number;
  tile_count: number;
  packages: Array<{
    filename: string;
    layer_id?: string | null;
    title?: string | null;
    tile_count: number;
    resolution_m_per_pixel?: number | null;
    bbox_wsen?: number[] | null;
    size_bytes: number;
  }>;
  warnings: string[];
  availability_scope: string;
};


export type JezeroPoi = {
  id: string;
  name: string;
  latitude: number;
  longitude_east: number;
  precision: string;
  description: string;
};
export type JezeroPoisResponse = {
  site: string;
  coordinate_convention: string;
  dem: { name: string; url: string; documentation: string; pixel_scale_m: number; format: string; vertical_units: string };
  points: JezeroPoi[];
  notice: string;
};

export type SensitivitySweepItem = {
  value: number;
  feasible: boolean;
  distance_m: number | null;
  duration_min: number | null;
  energy_wh: number | null;
  terrain_risk_pct: number | null;
  return_feasible: boolean;
  runtime_ms: number | null;
  path: Point[];
  route_id: string | null;
  profile: string | null;
  error?: string;
};

export type SensitivityResponse = {
  site_id: string;
  parameter: string;
  parameter_label: string;
  sweep: SensitivitySweepItem[];
  terrain_id: string;
  notice: string;
};

export type RouteReportResponse = {
  report_markdown: string;
  report_json: Record<string, unknown>;
};
