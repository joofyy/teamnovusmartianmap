import type { MissionSite } from '../missionSites';
import type { OfficialSource, TerrainData } from '../types';

type Props = { missionSite: MissionSite; terrain: TerrainData | null; sources: OfficialSource[] };
type ImportMetadata = Record<string, unknown>;

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="provenance-field"><span>{label}</span><strong>{value === null || value === undefined || value === '' ? 'Not available in current metadata' : value}</strong></div>;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function displayMetadata(metadata: ImportMetadata | undefined): string {
  if (!metadata) return 'Unavailable — no imported layer metadata was returned.';
  const file = typeof metadata.source_filename === 'string' ? metadata.source_filename : 'source filename unavailable';
  const unit = typeof metadata.user_declared_unit === 'string' ? metadata.user_declared_unit : typeof metadata.band_unit === 'string' ? metadata.band_unit : 'unit unavailable';
  const coverage = typeof metadata.coverage_valid_fraction === 'number'
    ? `${(metadata.coverage_valid_fraction * 100).toFixed(1)}% layer coverage`
    : 'coverage fraction unavailable';
  const sha = typeof metadata.source_sha256 === 'string' ? ` · SHA-256 ${metadata.source_sha256}` : '';
  const band = typeof metadata.source_band === 'number' ? ` · band ${metadata.source_band}` : '';
  return `${file}${band} · ${unit} · ${coverage}${sha}`;
}

export default function DataProvenancePanel({ missionSite, terrain, sources }: Props) {
  const info = terrain?.coordinate_info ?? {};
  const imported = asRecord(info.imported_layer_provenance);
  const demProvenance = asRecord(info.dem_provenance);
  const available = new Set(terrain?.available_layers ?? []);
  const mask = terrain?.valid_mask?.flat() ?? [];
  const computedCoverage = mask.length ? mask.filter(Boolean).length / mask.length : null;
  const reportedCoverage = typeof info.coverage_valid_fraction === 'number' ? info.coverage_valid_fraction : null;
  const coverage = reportedCoverage ?? computedCoverage;
  const coverageLabel = coverage === null ? null : `${(coverage * 100).toFixed(1)}% valid cells in the active route grid`;

  const layerRows = [
    { id: 'elevation', label: 'Elevation', field: 'elevation_m', unit: terrain?.cell_units ?? 'm', method: 'Imported from the active Mars DEM raster; display-only fills remain blocked and are not used for route costs.' },
    { id: 'slope', label: 'Slope', field: 'slope_deg', unit: 'degrees', method: 'Derived from valid elevation cells using the finite-difference elevation gradient.' },
    { id: 'roughness', label: 'Relative roughness', field: 'roughness', unit: 'normalized local relief', method: 'Derived from a 3 × 3 local standard deviation and normalized to the valid-data 95th percentile.' },
    { id: 'coverage_mask', label: 'Coverage / NoData mask', field: 'valid_mask', unit: 'boolean cell mask', method: 'Valid source cells are true; NoData and derivative-invalid cells are excluded from route search.' },
    { id: 'regolith', label: 'Regolith index', field: 'regolith', unit: 'user-declared normalized index', importKey: 'regolith', method: 'Only available after an explicitly mapped aligned raster is imported.' },
    { id: 'temperature', label: 'Temperature', field: 'temperature_c', unit: '°C', importKey: 'temperature_c', method: 'Only available after an explicitly mapped Celsius raster is imported.' },
    { id: 'atmosphere', label: 'Environment index', field: 'environment_index', unit: 'user-declared normalized index', importKey: 'environment_index', method: 'A user-mapped raster index; not a live weather feed.' },
    { id: 'radiation', label: 'Radiation index', field: 'radiation_index', unit: 'user-declared normalized index', importKey: 'radiation_index', method: 'A user-mapped spatial raster index; rover station time series are not spatial coverage.' },
    { id: 'uncertainty', label: 'Uncertainty index', field: 'uncertainty', unit: 'user-declared normalized index', importKey: 'uncertainty', method: 'Available only when an explicit uncertainty raster has been aligned to the active DEM.' },
    { id: 'science', label: 'Science-potential index', field: 'science_potential', unit: 'user-declared normalized index', importKey: 'science_potential', method: 'An imported index or explicitly identified evidence layer; not an autonomous geological discovery.' },
  ];

  return <section className="provenance-panel">
    <div className="provenance-heading"><div><span className="eyebrow">DATA LINEAGE</span><h3>Data provenance & confidence</h3><p>Trace the sources, processing and coverage behind the active terrain view.</p></div><span className="provenance-stamp">SOURCE-AWARE</span></div>
    <div className="provenance-active">
      <div className="provenance-section-title"><span>SELECTED SITE REFERENCE DATASET</span><b>{terrain ? terrain.status.toUpperCase() : 'NOT LOADED'}</b></div>
      <h4>{missionSite.dem.product}</h4>
      <div className="provenance-grid">
        <Field label="Reference source organisation" value={missionSite.dem.source}/>
        <Field label="Reference product resolution" value={missionSite.dem.resolutionM ? `${missionSite.dem.resolutionM} m / pixel` : null}/>
        <Field label="Reference product format" value={missionSite.dem.format}/>
        <Field label="Loaded grid" value={terrain ? `${terrain.width} × ${terrain.height} cells` : null}/>
        <Field label="Grid cell size" value={terrain ? `${terrain.cell_size_m.toFixed(2)} m` : null}/>
        <Field label="Vertical units" value={terrain?.cell_units}/>
        <Field label="Terrain identifier" value={terrain?.id}/>
        <Field label="Valid DEM coverage" value={coverageLabel}/>
        <Field label="Loaded source filename" value={typeof demProvenance.source_filename === 'string' ? demProvenance.source_filename : null}/>
        <Field label="Source SHA-256" value={typeof demProvenance.source_sha256 === 'string' ? demProvenance.source_sha256 : null}/>
        <Field label="Retrieved (UTC)" value={typeof demProvenance.retrieved_utc === 'string' ? demProvenance.retrieved_utc : null}/>
        <Field label="Source last-modified" value={typeof demProvenance.source_last_modified === 'string' ? demProvenance.source_last_modified : null}/>
        <Field label="Source file size" value={typeof demProvenance.size_bytes === 'number' ? `${(demProvenance.size_bytes / (1024 * 1024)).toFixed(2)} MB` : null}/>
        <Field label="Cache mode" value={typeof demProvenance.cache_mode === 'string' ? demProvenance.cache_mode : null}/>
      </div>
      <div className="provenance-links"><a href={missionSite.dem.downloadUrl} target="_blank" rel="noreferrer">Original product / download ↗</a><a href={missionSite.dem.documentationUrl} target="_blank" rel="noreferrer">Product documentation ↗</a><a href={missionSite.coordinateSourceUrl} target="_blank" rel="noreferrer">Landing-coordinate reference ↗</a>{typeof demProvenance.final_url === 'string' && <a href={demProvenance.final_url} target="_blank" rel="noreferrer">Resolved file URL ↗</a>}</div>
      <p className="provenance-note">{missionSite.dem.coverageNote}</p>
      <p className="provenance-warning">{typeof demProvenance.source_sha256 === 'string' ? 'The automatic source download was hashed and validated against the selected site footprint before the route grid was created. Retrieval and server-response metadata above describe the cached source record.' : 'The dataset above is the selected site catalogue reference. The active terrain response has not supplied an original filename and source hash for this raster; those fields remain unavailable rather than being inferred.'}</p>
      {terrain?.warning && <p className="provenance-warning">{terrain.warning}</p>}
    </div>

    <div className="provenance-section-title"><span>COORDINATE & GRID METADATA</span><b>{terrain ? 'RECEIVED' : 'PENDING'}</b></div>
    <div className="provenance-grid">
      <Field label="Reference latitude" value={`${missionSite.latitude.toFixed(5)}°`}/>
      <Field label="Reference longitude east" value={`${missionSite.longitudeEast.toFixed(5)}°E`}/>
      <Field label="Coordinate source" value={missionSite.coordinateSource}/>
      <Field label="Coordinate convention" value={missionSite.coordinateNote}/>
      <Field label="Projection / CRS" value={typeof info.crs === 'string' ? info.crs : null}/>
      <Field label="NoData mask" value={terrain?.valid_mask ? 'Provided by terrain response' : null}/>
      <Field label="Pixel spacing" value={Array.isArray(info.pixel_spacing_m) ? `${info.pixel_spacing_m.join(' × ')} m` : null}/>
      <Field label="Route-grid window" value={Array.isArray(info.route_grid_window_size_m) ? `${info.route_grid_window_size_m.join(' × ')} m` : null}/>
    </div>

    <div className="provenance-section-title"><span>LAYER-BY-LAYER LINEAGE</span><b>{available.size} AVAILABLE LAYERS</b></div>
    <div className="provenance-layer-list">{layerRows.map((row) => {
      const isAvailable = available.has(row.id) || (row.id === 'coverage_mask' && Boolean(terrain?.valid_mask));
      const importKey = 'importKey' in row && row.importKey ? row.importKey : row.id;
      const metadata = asRecord(imported[importKey]);
      const hasImport = Object.keys(metadata).length > 0;
      const derived = row.id === 'slope' || row.id === 'roughness' || row.id === 'coverage_mask';
      const lineage = hasImport ? displayMetadata(metadata) : row.id === 'elevation'
        ? `Elevation grid received. The current terrain response does not expose the original DEM filename or full source SHA-256. Selected-site catalogue reference: ${missionSite.dem.fileName}.`
        : derived ? row.method : isAvailable ? 'Layer is marked available; detailed import metadata is not present in the active terrain response.' : 'Unavailable — no aligned raster or layer metadata is present.';
      return <article className="provenance-layer" key={row.id}>
        <div className="provenance-layer-heading"><strong>{row.label}</strong><span className={isAvailable ? 'available' : 'unavailable'}>{isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}</span></div>
        <small>{row.field} · {row.unit}</small>
        <p>{lineage}</p>
        <p className="provenance-layer-method">{row.method}</p>
      </article>;
    })}</div>

    <div className="provenance-caveat"><b>Confidence handling</b><span>No confidence percentages are inferred from a source name. Coverage is measured from the returned valid-cell mask / coverage fraction. Imported layer units, footprints and missing-cell policies are shown only when supplied by their import metadata. Missing metadata remains unavailable.</span></div>
    <div className="provenance-section-title"><span>OFFICIAL DATA-SOURCE REGISTRY</span><b>{sources.length} SOURCES</b></div>
    <div className="provenance-source-list">{sources.map((source) => <article className="provenance-source" key={source.id}>
      <div><strong>{source.name}</strong><span>{source.organization} · {source.kind.replace(/_/g,' ').toUpperCase()}</span></div>
      <em className={source.integration === 'connected' ? 'connected' : ''}>{source.integration.replace(/_/g,' ')}</em>
      <p>{source.description}</p>
      <div className="provenance-source-meta"><span>{source.format}</span><span>{source.availability.replace(/_/g,' ')}</span></div>
      <p className="provenance-limit"><b>Coverage / limits:</b> {source.coverage} {source.limitations}</p>
      <div className="provenance-links"><a href={source.url} target="_blank" rel="noreferrer">Source endpoint ↗</a><a href={source.documentation} target="_blank" rel="noreferrer">Documentation ↗</a></div>
    </article>)}</div>
  </section>;
}
