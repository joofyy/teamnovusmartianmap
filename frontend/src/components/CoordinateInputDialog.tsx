import { useState, useEffect, useMemo } from 'react';
import type { Point, TerrainData } from '../types';
import type { MissionSite } from '../missionSites';
import { gridToGeo, geoToGrid, formatLatitude, formatLongitude, getSiteReference } from '../utils/coordinates';

export type CoordinateTargetType = 'start' | 'goal' | 'new-waypoint' | 'edit-waypoint';

type Props = {
  isOpen: boolean;
  targetType: CoordinateTargetType;
  waypointIndex?: number;
  initialPoint?: Point | null;
  terrain: TerrainData | null;
  missionSite: MissionSite;
  maxSlopeDeg: number;
  onConfirm: (point: Point, targetType: CoordinateTargetType, waypointIndex?: number) => void;
  onClose: () => void;
};

export default function CoordinateInputDialog({
  isOpen,
  targetType,
  waypointIndex,
  initialPoint,
  terrain,
  missionSite,
  maxSlopeDeg,
  onConfirm,
  onClose,
}: Props) {
  const [mode, setMode] = useState<'grid' | 'latlon'>('grid');

  const width = terrain?.width ?? 80;
  const height = terrain?.height ?? 80;

  // Working state in grid coords
  const [gridX, setGridX] = useState<number>(initialPoint?.x ?? Math.floor(width / 2));
  const [gridY, setGridY] = useState<number>(initialPoint?.y ?? Math.floor(height / 2));

  // Working state in lat/lon coords
  const [latInput, setLatInput] = useState<string>('');
  const [lonInput, setLonInput] = useState<string>('');

  // Sync state whenever dialog opens or initialPoint changes
  useEffect(() => {
    if (isOpen) {
      const initX = initialPoint?.x ?? Math.floor(width / 2);
      const initY = initialPoint?.y ?? Math.floor(height / 2);
      setGridX(initX);
      setGridY(initY);

      const geo = gridToGeo({ x: initX, y: initY }, terrain, missionSite);
      setLatInput(geo.latitude.toFixed(5));
      setLonInput(geo.longitude.toFixed(5));
    }
  }, [isOpen, initialPoint, terrain, missionSite, width, height]);

  // Handle grid change -> update lat/lon preview
  const handleGridChange = (newX: number, newY: number) => {
    const clampedX = Math.max(0, Math.min(width - 1, newX));
    const clampedY = Math.max(0, Math.min(height - 1, newY));
    setGridX(clampedX);
    setGridY(clampedY);
    const geo = gridToGeo({ x: clampedX, y: clampedY }, terrain, missionSite);
    setLatInput(geo.latitude.toFixed(5));
    setLonInput(geo.longitude.toFixed(5));
  };

  // Handle lat/lon change -> update grid preview
  const parsedLat = parseFloat(latInput);
  const parsedLon = parseFloat(lonInput);
  const isValidLatLon = Number.isFinite(parsedLat) && Number.isFinite(parsedLon);

  const geoConversion = useMemo(() => {
    if (!isValidLatLon) return null;
    return geoToGrid(parsedLat, parsedLon, terrain, missionSite);
  }, [parsedLat, parsedLon, isValidLatLon, terrain, missionSite]);

  // Computed point to apply
  const activePoint: Point = useMemo(() => {
    if (mode === 'grid') {
      return { x: gridX, y: gridY };
    }
    if (geoConversion) {
      return geoConversion.point;
    }
    return { x: gridX, y: gridY };
  }, [mode, gridX, gridY, geoConversion]);

  const isCurrentInBounds = mode === 'grid'
    ? (gridX >= 0 && gridX < width && gridY >= 0 && gridY < height)
    : (geoConversion?.inBounds ?? false);

  // Terrain feedback at activePoint
  const elevation = terrain?.elevation_m?.[activePoint.y]?.[activePoint.x];
  const slope = terrain?.slope_deg?.[activePoint.y]?.[activePoint.x];
  const isObstacle = terrain?.obstacle?.[activePoint.y]?.[activePoint.x] === true
    || terrain?.valid_mask?.[activePoint.y]?.[activePoint.x] === false;
  const isSteep = slope !== undefined && slope > maxSlopeDeg;

  // Derived title & badges
  const targetTitle = targetType === 'start'
    ? 'START POINT (A)'
    : targetType === 'goal'
      ? 'DESTINATION (B)'
      : waypointIndex !== undefined
        ? `WAYPOINT TARGET (W${waypointIndex + 1})`
        : 'NEW INTERMEDIATE WAYPOINT';

  const handleResetToSiteReference = () => {
    const { lat, lon } = getSiteReference(terrain, missionSite);
    setLatInput(lat.toFixed(5));
    setLonInput(lon.toFixed(5));
    const conv = geoToGrid(lat, lon, terrain, missionSite);
    setGridX(conv.clampedPoint.x);
    setGridY(conv.clampedPoint.y);
  };

  const handleSnapToClamped = () => {
    if (geoConversion) {
      setGridX(geoConversion.clampedPoint.x);
      setGridY(geoConversion.clampedPoint.y);
      const geo = gridToGeo(geoConversion.clampedPoint, terrain, missionSite);
      setLatInput(geo.latitude.toFixed(5));
      setLonInput(geo.longitude.toFixed(5));
      setMode('grid');
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isCurrentInBounds) return;
    onConfirm(activePoint, targetType, waypointIndex);
    onClose();
  };

  if (!isOpen) return null;

  const currentGeo = gridToGeo(activePoint, terrain, missionSite);

  return (
    <div className="coord-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="coord-modal-panel" role="dialog" aria-modal="true" aria-labelledby="coord-modal-title">
        <header className="coord-modal-header">
          <div>
            <span className="eyebrow">ASTRONAUT NAVIGATION FIX / MANUAL ENTRY</span>
            <h3 id="coord-modal-title">Set {targetTitle}</h3>
            <p>Enter exact digital elevation grid coordinates or planetary latitude and longitude.</p>
          </div>
          <button className="coord-modal-close" onClick={onClose} aria-label="Close dialog">×</button>
        </header>

        {/* Mode Selector Tabs */}
        <div className="coord-mode-tabs">
          <button
            type="button"
            className={`coord-tab ${mode === 'grid' ? 'active' : ''}`}
            onClick={() => setMode('grid')}
          >
            GRID COORDINATES (X, Y)
          </button>
          <button
            type="button"
            className={`coord-tab ${mode === 'latlon' ? 'active' : ''}`}
            onClick={() => setMode('latlon')}
          >
            PLANETARY LAT / LON (°N, °E)
          </button>
        </div>

        <form onSubmit={handleSubmit} className="coord-form-body">
          {mode === 'grid' ? (
            <div className="coord-input-section">
              <div className="coord-input-row">
                <label>
                  <span>GRID COLUMN (X) <i>[0–{width - 1}]</i></span>
                  <input
                    type="number"
                    min={0}
                    max={width - 1}
                    step={1}
                    value={gridX}
                    onChange={(e) => handleGridChange(parseInt(e.target.value, 10) || 0, gridY)}
                    autoFocus
                  />
                </label>
                <label>
                  <span>GRID ROW (Y) <i>[0–{height - 1}]</i></span>
                  <input
                    type="number"
                    min={0}
                    max={height - 1}
                    step={1}
                    value={gridY}
                    onChange={(e) => handleGridChange(gridX, parseInt(e.target.value, 10) || 0)}
                  />
                </label>
              </div>

              <div className="coord-slider-group">
                <div className="coord-slider-item">
                  <small>COL X: {gridX}</small>
                  <input
                    type="range"
                    min={0}
                    max={width - 1}
                    value={gridX}
                    onChange={(e) => handleGridChange(Number(e.target.value), gridY)}
                  />
                </div>
                <div className="coord-slider-item">
                  <small>ROW Y: {gridY}</small>
                  <input
                    type="range"
                    min={0}
                    max={height - 1}
                    value={gridY}
                    onChange={(e) => handleGridChange(gridX, Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="coord-input-section">
              <div className="coord-input-row">
                <label>
                  <span>PLANETOCENTRIC LATITUDE (°N/S)</span>
                  <input
                    type="number"
                    step="0.00001"
                    min="-90"
                    max="90"
                    placeholder="e.g. 18.44463"
                    value={latInput}
                    onChange={(e) => setLatInput(e.target.value)}
                    autoFocus
                  />
                  <small>Ref site: {formatLatitude(missionSite.latitude)}</small>
                </label>
                <label>
                  <span>EAST-POSITIVE LONGITUDE (°E)</span>
                  <input
                    type="number"
                    step="0.00001"
                    min="-360"
                    max="360"
                    placeholder="e.g. 77.45088"
                    value={lonInput}
                    onChange={(e) => setLonInput(e.target.value)}
                  />
                  <small>Ref site: {formatLongitude(missionSite.longitudeEast)}</small>
                </label>
              </div>
              <div className="coord-action-bar-sub">
                <button
                  type="button"
                  className="tiny-action"
                  onClick={handleResetToSiteReference}
                >
                  ↺ RESET TO MISSION LANDING SITE REFERENCE
                </button>
              </div>
            </div>
          )}

          {/* Real-time Coordinate Fix Preview */}
          <div className="coord-preview-card">
            <div className="coord-preview-header">
              <span>CALCULATED NAVIGATION FIX</span>
              <strong className={isCurrentInBounds ? 'status-ok' : 'status-err'}>
                {isCurrentInBounds ? 'WITHIN DEM COVERAGE' : 'OUTSIDE LOCAL FOOTPRINT'}
              </strong>
            </div>

            <div className="coord-preview-grid">
              <div>
                <small>GRID REFERENCE</small>
                <b>COL {String(activePoint.x).padStart(2, '0')} / ROW {String(activePoint.y).padStart(2, '0')}</b>
              </div>
              <div>
                <small>PLANETOCENTRIC COORDINATE</small>
                <b>{currentGeo.formattedLat} · {currentGeo.formattedLon}</b>
              </div>
              <div>
                <small>ESTIMATED ELEVATION</small>
                <b>{elevation !== undefined ? `${elevation.toFixed(1)} m` : 'N/A'}</b>
              </div>
              <div>
                <small>LOCAL GRADIENT / SLOPE</small>
                <b>{slope !== undefined ? `${slope.toFixed(1)}°` : 'N/A'}</b>
              </div>
            </div>

            {/* Warnings & Traversability checks */}
            {!isCurrentInBounds && (
              <div className="coord-warning-box">
                <span>⚠ Coordinate is {geoConversion?.distanceM.toFixed(0) ?? 'unknown'} m outside the active {width} × {height} grid.</span>
                <button type="button" onClick={handleSnapToClamped}>
                  Snap to nearest valid edge cell (COL {geoConversion?.clampedPoint.x}, ROW {geoConversion?.clampedPoint.y})
                </button>
              </div>
            )}

            {isCurrentInBounds && (isObstacle || isSteep) && (
              <div className="coord-terrain-warning">
                <span>
                  ⚠ Caution: Selected coordinate lands on {isObstacle ? 'an untraversable/obstacle cell' : `steep terrain (${slope?.toFixed(1)}° > max ${maxSlopeDeg}°)`}. Route planner may reject or require a detour.
                </span>
              </div>
            )}
          </div>

          <footer className="coord-modal-footer">
            <button
              type="button"
              className="ghost-button"
              onClick={onClose}
            >
              CANCEL
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={!isCurrentInBounds}
            >
              CONFIRM & SET {targetType === 'start' ? 'START' : targetType === 'goal' ? 'DESTINATION' : 'WAYPOINT'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
