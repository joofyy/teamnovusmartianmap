import type { MarsSite, JezeroPoisResponse, ArchiveResult, BenchmarkResult, MissionConstraintsPayload, OfficialSource, OfflineStatus, PlanResponse, Point, ReplanResponse, RegistryResponse, ScienceAnswer, TerrainData } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body instanceof FormData
      ? { ...(init?.headers ?? {}) }
      : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
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
  sites: () => request<{ sites: MarsSite[]; note: string }>('/api/sites'),
  terrain: (siteId = 'gale') => request<TerrainData>('/api/terrain?site_id=' + encodeURIComponent(siteId)),
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
  offlinePackage: async (planId?: string) => {
    const response = await fetch(`${API_BASE}/api/offline/package`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: planId }) });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(typeof payload.detail === 'string' ? payload.detail : `Package export failed (${response.status})`); }
    return response.blob();
  },
  offlineStatus: () => request<OfflineStatus>('/api/offline/status'),
  plan: (siteId: string, start: Point, goal: Point, constraints: MissionConstraintsPayload) =>
    request<PlanResponse>('/api/routes', { method: 'POST', body: JSON.stringify({ site_id: siteId, start, goal, constraints }) }),
  benchmark: (siteId: string, start: Point, goal: Point, constraints: MissionConstraintsPayload) =>
    request<{ benchmark_scope: string; results: BenchmarkResult[]; warning: string }>('/api/benchmark', { method: 'POST', body: JSON.stringify({ site_id: siteId, start, goal, constraints }) }),
  replan: (planId: string, obstacle: Point) =>
    request<ReplanResponse>('/api/replan', { method: 'POST', body: JSON.stringify({ plan_id: planId, obstacle }) }),
  updateCondition: (planId: string, cell: Point, kind: string, value: number) =>
    request<{ plan_id: string; path: Point[]; metrics: ReplanResponse['metrics']; update: Record<string, unknown>; expanded_during_repair: number; notice: string }>('/api/replan/condition', { method: 'POST', body: JSON.stringify({ plan_id: planId, cell, kind, value }) }),
  reset: () => request<{ status: string }>('/api/reset', { method: 'POST' }),
};
