import type { JevEvidenceAssessmentResponse, JevPathfindingWeights, JevProvider, JevStatus, JezeroPoisResponse, ArchiveResult, BenchmarkResult, MissionConstraintsPayload, MissionEvent, OfficialSource, OfflineStatus, PlanResponse, Point, ReplanResponse, RegistryResponse, RouteReportResponse, ScienceAnswer, SensitivityResponse, TerrainData } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? 'http://localhost:8000' : '')).replace(/\/$/, '');

function requireApiBase(path: string): void {
  if (!API_BASE) {
    throw new Error(
      `Backend URL is not configured. Set VITE_API_BASE to the HTTPS URL of the MARSCOPE backend deployed from this fork, then redeploy the frontend. Requested endpoint: ${path}`
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  requireApiBase(path);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: init?.body instanceof FormData
        ? { ...(init?.headers ?? {}) }
        : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'browser network request failed';
    throw new Error(
      `Could not reach the API at ${API_BASE}${path}. Check that the Render service is running and that its CORS settings allow this Vercel domain. Browser detail: ${detail}`
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.detail === 'string' ? payload.detail : `API request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  jezeroPois: () => request<JezeroPoisResponse>('/api/jezero/pois'),
  health: () => request<{ status: string; release: string }>('/api/health'),
  jevStatus: () => request<JevStatus>('/api/jev/status'),
  jevPathfindingWeights: (payload: { provider: JevProvider; apiKey: string; missionPrompt: string; site_id: string }) =>
    request<JevPathfindingWeights>('/api/jev/pathfinding-weights', { method: 'POST', cache: 'no-store', body: JSON.stringify(payload) }),
  jevEvidenceAssessment: (payload: { provider: JevProvider; apiKey: string; objective: string; hypothesis: string; evidence: Array<{ id: string; title: string; summary: string; url: string; mission?: string }> }) =>
    request<JevEvidenceAssessmentResponse>('/api/jev/evidence-assessment', { method: 'POST', cache: 'no-store', body: JSON.stringify(payload) }),
  terrain: (siteId = 'jezero') => request<TerrainData>(`/api/terrain/${encodeURIComponent(siteId)}`),
  registry: () => request<RegistryResponse>('/api/registry'),
  dataCatalog: () => request<{ sources: OfficialSource[]; archives_connected: string[]; note: string }>('/api/data/catalog'),
  pdsSearch: (keywords: string, limit = 20) => request<ArchiveResult>(`/api/data/pds/search?keywords=${encodeURIComponent(keywords)}&limit=${limit}`),
  inspectPdsLabel: async (file: File) => {
    const form = new FormData(); form.append('file', file);
    return request<Record<string, unknown>>('/api/data/pds/inspect-label', { method: 'POST', body: form });
  },
  odeSearch: (instrument: string, bbox: { minLat: number; maxLat: number; westLon: number; eastLon: number; limit?: number }) => {
    const params = new URLSearchParams({ instrument, min_lat: String(bbox.minLat), max_lat: String(bbox.maxLat), west_lon: String(bbox.westLon), east_lon: String(bbox.eastLon), limit: String(bbox.limit ?? 40) });
    return request<ArchiveResult>(`/api/data/ode/search?${params.toString()}`);
  },
  downloadOfficialFile: (url: string) => request<{ stored_filename: string; sha256: string; size_bytes: number; final_url: string; content_type: string; limitations: string[] }>('/api/data/download', { method: 'POST', body: JSON.stringify({ url }) }),
  trekLayers: () => request<{ layers: Array<{ id: string; title: string; coverage_wsen: number[]; resolution_text: string; use: string }> }>('/api/data/trek/layers'),
  cacheTrekTiles: (layerId: string, bbox: number[], maxTiles = 96) => request<{ stored_filename: string; tile_count: number; total_bytes: number; matrix: string; resolution_m_per_pixel: number; notice: string }>('/api/data/trek/cache', { method: 'POST', body: JSON.stringify({ layer_id: layerId, bbox_wsen: bbox, max_tiles: maxTiles }) }),
  askScience: (question: string) => request<ScienceAnswer>('/api/science/ask', { method: 'POST', body: JSON.stringify({ question }) }),
  observations: () => request<{ imports: Array<{ instrument: string; source_file: string; sha256: string; imported_utc: string; row_count: number; summary: Record<string, unknown>; provenance_note: string }>; count: number }>('/api/observations'),
  importObservations: async (file: File, instrument: string, mapping: Record<string, string>) => {
    const form = new FormData(); form.append('file', file); form.append('instrument', instrument); form.append('mapping_json', JSON.stringify(mapping));
    return request<{ import: Record<string, unknown>; stored_record: string }>('/api/observations/import', { method: 'POST', body: form });
  },
  importDem: async (file: File, verticalUnits: string, siteId: string) => {
    const form = new FormData(); form.append('file', file); form.append('width', '96'); form.append('height', '96'); form.append('vertical_units', verticalUnits); form.append('site_id', siteId);
    return request<{ terrain: TerrainData; provenance: Record<string, unknown>; notice: string }>('/api/terrain/import-dem', { method: 'POST', body: form });
  },
  importLayer: async (file: File, layer: string, min: number, max: number, unit: string, siteId: string, band = 1) => {
    const form = new FormData(); form.append('file', file); form.append('layer', layer); form.append('value_min', String(min)); form.append('value_max', String(max)); form.append('source_unit', unit); form.append('band', String(band)); form.append('site_id', siteId);
    return request<{ terrain: TerrainData; provenance: Record<string, unknown>; notice: string }>('/api/terrain/import-layer', { method: 'POST', body: form });
  },
  offlinePackage: async (planId?: string, siteId = 'jezero') => {
    requireApiBase('/api/offline/package');
    const response = await fetch(`${API_BASE}/api/offline/package`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: planId, site_id: siteId }) });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(typeof payload.detail === 'string' ? payload.detail : `Package export failed (${response.status})`); }
    return response.blob();
  },
  offlineStatus: () => request<OfflineStatus>('/api/offline/status'),
  plan: (siteId: string, start: Point, goal: Point, constraints: MissionConstraintsPayload) =>
    request<PlanResponse>('/api/routes', { method: 'POST', body: JSON.stringify({ site_id: siteId, start, goal, constraints }) }),
  benchmark: (siteId: string, start: Point, goal: Point, constraints: MissionConstraintsPayload) =>
    request<{ site_id: string; terrain_id: string; benchmark_scope: string; results: BenchmarkResult[]; warning: string }>('/api/benchmark', { method: 'POST', body: JSON.stringify({ site_id: siteId, start, goal, constraints }) }),
  replan: (planId: string, obstacle: Point) =>
    request<ReplanResponse>('/api/replan', { method: 'POST', body: JSON.stringify({ plan_id: planId, obstacle }) }),
  updateCondition: (planId: string, cell: Point, kind: string, value: number) =>
    request<{ plan_id: string; path: Point[]; metrics: ReplanResponse['metrics']; update: Record<string, unknown>; expanded_during_repair: number; notice: string }>('/api/replan/condition', { method: 'POST', body: JSON.stringify({ plan_id: planId, cell, kind, value }) }),
  sensitivity: (siteId: string, start: Point, goal: Point, constraints: MissionConstraintsPayload, values?: number[]) =>
    request<SensitivityResponse>('/api/sensitivity', {
      method: 'POST',
      body: JSON.stringify({ site_id: siteId, start, goal, constraints, values: values ?? [14, 18, 22, 26, 30] }),
    }),
  planWaypoints: (siteId: string, start: Point, waypoints: Point[], goal: Point, constraints: MissionConstraintsPayload) =>
    request<PlanResponse & { waypoints: Point[]; legs: Array<{ leg_index: number; from: Point; to: Point; distance_m: number; duration_min: number; energy_wh: number }> }>('/api/routes/waypoints', {
      method: 'POST',
      body: JSON.stringify({ site_id: siteId, start, waypoints, goal, constraints }),
    }),
  missionEvents: (planId: string) =>
    request<{ plan_id: string; events: MissionEvent[] }>(`/api/missions/${encodeURIComponent(planId)}/events`),
  recordMissionEvent: (planId: string, payload: { event_type: string; title: string; summary: string; data?: Record<string, unknown> }) =>
    request<{ plan_id: string; event: MissionEvent; events: MissionEvent[] }>(`/api/missions/${encodeURIComponent(planId)}/events`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getRouteReport: (planId: string) =>
    request<RouteReportResponse>(`/api/routes/${encodeURIComponent(planId)}/report`),
  reset: () => request<{ status: string }>('/api/reset', { method: 'POST' }),
};
