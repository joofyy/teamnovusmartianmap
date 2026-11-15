import type { Point, TerrainData } from '../types';
import { gridToGeo } from '../utils/coordinates';

type Props = {
  terrain: TerrainData;
  point: Point;
  siteName: string;
  missionName: string;
  maxSlopeDeg: number;
  onDismiss: () => void;
  onClear: () => void;
  onSetStart?: (point: Point) => void;
  onSetDestination?: (point: Point) => void;
  onAddWaypoint?: (point: Point) => void;
};

type MetricStatus = 'IMPORTED' | 'DERIVED' | 'SIMULATED' | 'NOT AVAILABLE';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function MetricCard({
  label, value, unit, status, detail,
}: {
  label: string;
  value: string;
  unit?: string;
  status: MetricStatus;
  detail: string;
}) {
  return (
    <div className="inspector-metric">
      <div className="inspector-metric-top">
        <span>{label}</span>
        <em className={`inspector-status status-${status.toLowerCase().replace(' ', '-')}`}>{status}</em>
      </div>
      <strong>{value}{unit && <small>{unit}</small>}</strong>
      <p>{detail}</p>
    </div>
  );
}

function StatusLine({ label, value, state }: { label: string; value: string; state?: 'good' | 'warn' | 'bad' | 'muted' }) {
  return (
    <div className="inspector-status-line">
      <span>{label}</span>
      <b className={state ? `state-${state}` : ''}>{value}</b>
    </div>
  );
}

export default function ScientificTerrainInspector({
  terrain, point, siteName, missionName, maxSlopeDeg, onDismiss, onClear,
  onSetStart, onSetDestination, onAddWaypoint,
}: Props) {
  const { x, y } = point;
  const inBounds = x >= 0 && x < terrain.width && y >= 0 && y < terrain.height;
  const geo = gridToGeo(point, terrain);
  const available = new Set(terrain.available_layers ?? []);
  const maskValue = inBounds ? terrain.valid_mask?.[y]?.[x] : undefined;
  const hasMaskCell = typeof maskValue === 'boolean';
  const isNoData = hasMaskCell ? maskValue === false : null;
  const isValidSample = hasMaskCell && maskValue === true;
  const elevationRaw = inBounds ? terrain.elevation_m?.[y]?.[x] : undefined;
  const slopeRaw = inBounds ? terrain.slope_deg?.[y]?.[x] : undefined;
  const roughnessRaw = inBounds ? terrain.roughness?.[y]?.[x] : undefined;
  const elevation = isValidSample && available.has('elevation') && isFiniteNumber(elevationRaw) ? elevationRaw : null;
  const slope = isValidSample && available.has('slope') && isFiniteNumber(slopeRaw) ? slopeRaw : null;
  const roughness = isValidSample && available.has('roughness') && isFiniteNumber(roughnessRaw) ? roughnessRaw : null;
  const temperatureRaw = inBounds ? terrain.temperature_c?.[y]?.[x] : undefined;
  const temperature = inBounds && isValidSample && available.has('temperature') && isFiniteNumber(temperatureRaw) ? temperatureRaw : null;
  const obstacleFlag = inBounds ? terrain.obstacle?.[y]?.[x] : undefined;
  const blockedBySlope = slope !== null && slope > maxSlopeDeg;
  const blockedByTemperature = temperature !== null && temperature > -35;
  const blocked = obstacleFlag === true || blockedBySlope || blockedByTemperature || isNoData === true;
  const plannerStatus = !inBounds ? 'OUT OF GRID'
    : isNoData === true ? 'BLOCKED · NO DATA'
      : blocked ? 'BLOCKED UNDER CURRENT FILTERS'
        : !hasMaskCell ? 'NOT ASSESSED · MASK MISSING' : 'TRAVERSABLE UNDER CURRENT FILTERS';

  const cellSize = isFiniteNumber(terrain.cell_size_m) && terrain.cell_size_m > 0 ? terrain.cell_size_m : null;
  const targetMatches = (terrain.targets ?? [])
    .map((target) => ({
      target,
      distanceCells: Math.hypot(target.x - x, target.y - y),
    }))
    .filter((entry) => entry.distanceCells <= 2.5)
    .sort((a, b) => a.distanceCells - b.distanceCells)
    .slice(0, 3);
  const scienceRaw = inBounds ? terrain.science_potential?.[y]?.[x] : undefined;
  const scienceValue = isValidSample && available.has('science') && isFiniteNumber(scienceRaw) ? scienceRaw : null;
  const isSimulated = terrain.status === 'SIMULATED_NOT_GEOREFERENCED';
  const sourceStatus: MetricStatus = isSimulated ? 'SIMULATED' : 'IMPORTED';
  const crs = typeof terrain.coordinate_info?.crs === 'string' ? terrain.coordinate_info.crs : 'Not supplied';
  const layerProvenance = terrain.layer_provenance?.trim();

  return (
    <div className="terrain-inspector-content">
      <header className="inspector-header">
        <div>
          <span className="eyebrow">MARSCOPE / SCIENTIFIC READOUT</span>
          <h2>Terrain inspector</h2>
          <p>Cell-level measurements from the active mission DEM</p>
        </div>
        <button type="button" className="inspector-icon-button" onClick={onDismiss} aria-label="Dismiss terrain inspector">×</button>
      </header>

      <div className="inspector-selected-card">
        <div className="inspector-reticle-icon">⌖</div>
        <div className="inspector-selected-copy">
          <span>SELECTED GRID SAMPLE</span>
          <strong>COL {String(x).padStart(2, '0')} <i>/</i> ROW {String(y).padStart(2, '0')}</strong>
          <small>{siteName} · {terrain.width} × {terrain.height} grid</small>
        </div>
        <span className="inspector-live-tag">ACTIVE</span>
      </div>

      <section className="inspector-section">
        <div className="inspector-section-heading"><span>01 / LOCATION</span><span>GRID REFERENCE</span></div>
        <div className="inspector-location-grid">
          <div><small>GRID COLUMN</small><b>{x}</b></div>
          <div><small>GRID ROW</small><b>{y}</b></div>
          <div><small>GRID SPACING</small><b>{cellSize !== null ? `${cellSize.toFixed(1)} m` : 'N/A'}</b></div>
          <div><small>REGION</small><b>{siteName}</b></div>
        </div>
        <div className="inspector-coordinate-note">
          <span>PLANETOCENTRIC COORDINATES</span>
          <b>{geo.formattedLat} · {geo.formattedLon}</b>
          <p>Local tangent conversion from {siteName} landing datum. Grid indices (Col {x}, Row {y}) mapped at {cellSize !== null ? `${cellSize.toFixed(1)} m` : '20 m'}/cell spacing.</p>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading"><span>02 / TERRAIN CHARACTERISTICS</span><span>LOCAL SAMPLE</span></div>
        <div className="inspector-metric-grid">
          <MetricCard
            label="ELEVATION"
            value={elevation !== null ? elevation.toFixed(2) : 'N/A'}
            unit={elevation !== null ? 'm' : undefined}
            status={elevation !== null ? sourceStatus : 'NOT AVAILABLE'}
            detail={elevation !== null ? 'Imported source-raster elevation' : isNoData ? 'Cell is outside valid DEM coverage' : 'No verified valid elevation sample'}
          />
          <MetricCard
            label="SLOPE"
            value={slope !== null ? slope.toFixed(2) : 'N/A'}
            unit={slope !== null ? '°' : undefined}
            status={slope !== null ? 'DERIVED' : 'NOT AVAILABLE'}
            detail={slope !== null ? 'Gradient-derived from the imported DEM' : 'No valid slope sample at this cell'}
          />
          <MetricCard
            label="ROUGHNESS"
            value={roughness !== null ? roughness.toFixed(3) : 'N/A'}
            unit={roughness !== null ? 'index' : undefined}
            status={roughness !== null ? 'DERIVED' : 'NOT AVAILABLE'}
            detail={roughness !== null ? '3 × 3 local standard deviation, normalized 0–1' : 'No valid roughness sample at this cell'}
          />
          <MetricCard
            label="SCIENCE POTENTIAL"
            value={scienceValue !== null ? scienceValue.toFixed(3) : 'N/A'}
            unit={scienceValue !== null ? 'index' : undefined}
            status={scienceValue !== null ? (isSimulated ? 'SIMULATED' : 'IMPORTED') : 'NOT AVAILABLE'}
            detail={scienceValue !== null ? 'Spatial science-priority layer value' : 'No science-priority raster registered for this DEM'}
          />
        </div>
        <div className="inspector-classification">
          <StatusLine
            label="PLANNER OBSTACLE STATUS"
            value={plannerStatus}
            state={isNoData === true || blocked ? 'bad' : hasMaskCell ? 'good' : 'muted'}
          />
          <StatusLine
            label="NODATA / VALIDITY MASK"
            value={isNoData === true ? 'INVALID / NO DATA' : isNoData === false ? 'VALID SAMPLE' : 'MASK NOT PROVIDED'}
            state={isNoData === true ? 'bad' : isNoData === false ? 'good' : 'muted'}
          />
          <StatusLine
            label="ACTIVE SLOPE FILTER"
            value={`>${maxSlopeDeg.toFixed(0)}° = BLOCKED`}
            state="muted"
          />
          <p className="inspector-caveat">“Traversable” reflects the planner’s current mask and configured filters only. It is not a certification of astronaut or rover safety.</p>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading"><span>03 / SCIENTIFIC EXPLORATION</span><span>REGISTERED METADATA</span></div>
        {targetMatches.length > 0 ? (
          <div className="inspector-target-list">
            {targetMatches.map(({ target, distanceCells }) => (
              <article className="inspector-target" key={target.id}>
                <div className="inspector-target-top">
                  <strong>{target.name}</strong>
                  <span>{cellSize !== null ? `${(distanceCells * cellSize).toFixed(0)} m` : `${distanceCells.toFixed(1)} cells`}</span>
                </div>
                <small>{target.science_category || 'Unclassified target'} · {distanceCells < 0.75 ? 'AT SELECTED SAMPLE' : 'NEARBY MAPPED TARGET'}</small>
                <p>{target.description || 'No description supplied.'}</p>
                <div className="inspector-evidence">EVIDENCE STATUS <b>{target.evidence_status || 'NOT SPECIFIED'}</b></div>
              </article>
            ))}
          </div>
        ) : (
          <div className="inspector-unavailable">
            <b>NO REGISTERED TARGET NEAR THIS CELL</b>
            <p>No mapped science target is linked within 2.5 grid cells. No observation or local scientific significance is inferred from proximity to the mission site.</p>
          </div>
        )}
        <p className="inspector-small-note">Target entries are mapped metadata, not proof that an instrument observed the exact selected pixel.</p>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading"><span>04 / DATA PROVENANCE</span><span>MEASUREMENT LINEAGE</span></div>
        <div className="inspector-provenance-list">
          <div className="inspector-provenance-row">
            <em className={`inspector-status status-${sourceStatus.toLowerCase()}`}>{sourceStatus}</em>
            <div><b>Elevation raster</b><p>Imported DEM sample · metres. The terrain API does not expose an instrument-specific citation for this raster.</p></div>
          </div>
          <div className="inspector-provenance-row">
            <em className="inspector-status status-derived">DERIVED</em>
            <div><b>Slope</b><p>Computed from the elevation gradient using atan(√(dz/dx² + dz/dy²)); reported in degrees.</p></div>
          </div>
          <div className="inspector-provenance-row">
            <em className="inspector-status status-derived">DERIVED</em>
            <div><b>Roughness</b><p>3 × 3 local elevation standard deviation, normalized against the valid-data 95th percentile; unitless 0–1 index.</p></div>
          </div>
          <div className="inspector-provenance-row">
            <em className="inspector-status status-derived">DERIVED</em>
            <div><b>Obstacle classification</b><p>Source obstacle/validity mask plus current planner slope and temperature thresholds. Not a safety assessment.</p></div>
          </div>
        </div>
        <div className="inspector-source-meta">
          <StatusLine label="SITE MISSION CONTEXT" value={missionName} />
          <StatusLine label="ACTIVE TERRAIN DATASET" value={terrain.name || 'Unnamed imported terrain'} />
          <StatusLine label="TERRAIN DATASET ID" value={terrain.id || 'Not supplied'} />
          <StatusLine label="RASTER CRS" value={crs} />
          <StatusLine label="CELL SPACING" value={cellSize !== null ? `${cellSize.toFixed(2)} m` : 'Not available'} />
          <StatusLine label="INSTRUMENT ATTRIBUTION" value="Not supplied in terrain payload" state="muted" />
        </div>
        {layerProvenance && <details className="inspector-lineage"><summary>Processing notes from terrain service</summary><p>{layerProvenance}</p></details>}
      </section>

      <footer className="inspector-footer">
        <span>ASTRONAUT MISSION PLANNING</span>
        {(onSetStart || onSetDestination || onAddWaypoint) && (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '3px' }}>
            {onSetStart && <button type="button" onClick={() => onSetStart(point)}>SET AS START (A)</button>}
            {onSetDestination && <button type="button" onClick={() => onSetDestination(point)}>SET AS DEST (B)</button>}
            {onAddWaypoint && <button type="button" onClick={() => onAddWaypoint(point)}>+ WAYPOINT</button>}
          </div>
        )}
        <div>
          <button type="button" onClick={onDismiss}>CLOSE PANEL</button>
          <button type="button" onClick={onClear}>CLEAR SELECTION</button>
        </div>
      </footer>
    </div>
  );
}
