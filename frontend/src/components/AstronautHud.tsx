import type { Point, Route, Target, TerrainData } from '../types';

type Mode = 'desktop' | 'helmet' | 'minimal';
type Props = {
  mode: Mode; onModeChange: (mode: Mode) => void; onClose: () => void;
  siteName: string; terrain: TerrainData | null; route: Route | null; start: Point; goal: Point;
  currentPosition: Point; progressIndex: number; targets: Target[]; selectedTargetIds: string[];
  maxSlope: number;
  oxygenRemainingL: number; energyRemainingWh: number; evaMinutesRemaining: number;
  evaPlaying: boolean; onEvaPlayPause: () => void; onEvaStepForward: () => void; onEvaReset: () => void;
};

function distance(a: Point, b: Point, cellSize: number) { return Math.hypot(a.x - b.x, a.y - b.y) * cellSize; }
function heading(a: Point, b: Point) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
  const compass = ['N','NE','E','SE','S','SW','W','NW'];
  return { deg: Math.round(deg), text: compass[Math.round(deg / 45) % 8] };
}
function safe(value: number | undefined, digits = 0) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'N/A'; }

function nearestConstraint(terrain: TerrainData, point: Point, maxSlope: number, radius = 12) {
  const minX = Math.max(0, Math.floor(point.x - radius));
  const maxX = Math.min(terrain.width - 1, Math.ceil(point.x + radius));
  const minY = Math.max(0, Math.floor(point.y - radius));
  const maxY = Math.min(terrain.height - 1, Math.ceil(point.y + radius));
  let nearest: { distanceM: number; label: string; point: Point } | null = null;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const isNoData = terrain.valid_mask?.[y]?.[x] === false;
      const slope = terrain.slope_deg?.[y]?.[x];
      const overSlope = (terrain.available_layers ?? []).includes('slope') && typeof slope === 'number' && slope > maxSlope;
      const blocked = terrain.obstacle?.[y]?.[x] === true;
      if (!isNoData && !overSlope && !blocked) continue;
      const distanceM = distance(point, { x, y }, terrain.cell_size_m);
      if (!nearest || distanceM < nearest.distanceM) {
        nearest = { distanceM, point: { x, y }, label: isNoData ? 'NO DATA COVERAGE' : overSlope ? 'ABOVE SLOPE LIMIT' : 'PLANNER-BLOCKED CELL' };
      }
    }
  }
  return nearest;
}

export default function AstronautHud({
  mode, onModeChange, onClose, siteName, terrain, route, start, goal, currentPosition, progressIndex,
  targets, selectedTargetIds, maxSlope, oxygenRemainingL, energyRemainingWh, evaMinutesRemaining,
  evaPlaying, onEvaPlayPause, onEvaStepForward, onEvaReset,
}: Props) {
  const path = route?.path ?? [];
  const next = path[Math.min(path.length - 1, Math.max(0, progressIndex + 1))] ?? goal;
  const bearing = heading(currentPosition, next);
  const cell = terrain?.cell_size_m ?? 1;
  const currentX = Math.round(currentPosition.x);
  const currentY = Math.round(currentPosition.y);
  const inBounds = Boolean(terrain && currentX >= 0 && currentY >= 0 && currentX < terrain.width && currentY < terrain.height);
  const currentSlope = inBounds ? terrain?.slope_deg?.[currentY]?.[currentX] : undefined;
  const currentElevation = inBounds ? terrain?.elevation_m?.[currentY]?.[currentX] : undefined;
  const currentNoData = inBounds && terrain?.valid_mask?.[currentY]?.[currentX] === false;
  const uncertaintyAvailable = (terrain?.available_layers ?? []).includes('uncertainty') && Boolean(terrain?.uncertainty);
  const currentUncertainty = inBounds && uncertaintyAvailable ? terrain?.uncertainty?.[currentY]?.[currentX] : undefined;
  const localConstraint = terrain ? nearestConstraint(terrain, currentPosition, maxSlope) : null;
  const nearby = targets.filter((target) => selectedTargetIds.includes(target.id));
  const nearestScience = [...(nearby.length ? nearby : targets)].sort((a,b) => distance(currentPosition,a,cell)-distance(currentPosition,b,cell))[0];
  const targetDistance = nearestScience ? distance(currentPosition, nearestScience, cell) : null;
  const routePoints = path.map((point) => `${point.x},${terrain?.height ? terrain.height - point.y : point.y}`).join(' ');
  const progressPercent = path.length > 1 ? Math.round((Math.min(progressIndex, path.length - 1) / (path.length - 1)) * 100) : 0;
  const currentDataLabel = currentNoData ? 'NODATA CELL' : uncertaintyAvailable
    ? currentUncertainty === undefined ? 'UNCERTAINTY VALUE N/A' : `UNCERTAINTY ${currentUncertainty.toFixed(3)}`
    : inBounds ? 'UNCERTAINTY NOT MAPPED' : 'POSITION OUTSIDE GRID';

  return <div className={`astronaut-hud-shell hud-${mode}`}>
    <div className="hud-topbar"><div className="hud-brand"><span className="hud-brand-mark">M</span><div><b>MARSCOPE / EVA VISOR</b><small>{siteName.toUpperCase()} · MISSION INTERFACE SIMULATION</small></div></div><div className="hud-mode-switch">{(['desktop','helmet','minimal'] as Mode[]).map((value) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => onModeChange(value)}>{value.toUpperCase()}</button>)}</div><button className="hud-exit" onClick={onClose}>EXIT HUD ✕</button></div>
    <div className="hud-viewfinder">
      <div className="hud-horizon-line"/>
      <div className="hud-reticle"><i/><b/><span/></div>
      <div className="hud-heading"><small>HEADING</small><strong>{bearing.text} {bearing.deg.toString().padStart(3,'0')}°</strong><div className="hud-compass-ticks"><span>N</span><i/><span>NE</span><i/><span>E</span><i/><span>SE</span></div></div>
      <div className="hud-left-stack">
        <div className="hud-readout"><small>NEXT WAYPOINT</small><strong>WP-{String(Math.min(path.length, progressIndex + 2)).padStart(2,'0')}</strong><span>{distance(currentPosition,next,cell).toFixed(0)} m · {bearing.text}</span></div>
        <div className="hud-readout"><small>TERRAIN AT POSITION</small><strong>{currentSlope === undefined ? 'SLOPE N/A' : `${currentSlope.toFixed(1)}° SLOPE`}</strong><span>{currentElevation === undefined ? 'Elevation unavailable' : `${currentElevation.toFixed(1)} m elevation`}</span></div>
      </div>
      <div className="hud-right-stack">
        <div className="hud-readout"><small>SCIENCE OBJECTIVE</small><strong>{nearestScience?.name ?? 'NO TARGET SELECTED'}</strong><span>{targetDistance === null ? 'Select a science target' : `${targetDistance.toFixed(0)} m · operator priority`}</span></div>
        <div className="hud-readout hud-warning"><small>DATA QUALITY AT POSITION</small><strong>{currentDataLabel}</strong><span>{uncertaintyAvailable ? 'Uncertainty is an imported layer index, not a safety probability.' : 'No spatial uncertainty layer is available in this mission dataset.'}</span></div>
        <div className="hud-readout hud-warning"><small>NEAREST MAPPED CONSTRAINT · 12-CELL SEARCH</small><strong>{localConstraint?.label ?? 'NO FLAGGED CELL IN SEARCH AREA'}</strong><span>{localConstraint ? `${localConstraint.distanceM.toFixed(0)} m · grid ${localConstraint.point.x}, ${localConstraint.point.y}` : 'This does not imply terrain beyond the mapped area is hazard-free.'}</span></div>
      </div>
      <div className="hud-route-map"><div><small>TRAVERSE CORRIDOR</small><b>{route?.name ?? 'NO ROUTE'}</b></div>{terrain && <svg viewBox={`0 0 ${terrain.width} ${terrain.height}`} preserveAspectRatio="none"><polyline points={routePoints}/><circle cx={currentPosition.x} cy={terrain.height-currentPosition.y} r="1.8"/><circle className="hud-goal" cx={goal.x} cy={terrain.height-goal.y} r="1.3"/></svg>}<small>{route ? `${route.path.length} path cells · ${safe(route.metrics.distance_m)} m planned` : 'Plan a route to populate the visor'}</small></div>
      <div className="hud-bottom-left"><span>POS</span><b>{currentPosition.x.toFixed(0)} / {currentPosition.y.toFixed(0)}</b><span>START</span><b>{start.x} / {start.y}</b></div>
      <div className="hud-bottom-right"><span>PROGRESS</span><b>{progressPercent}%</b><span>LINK</span><b className="hud-link">SIMULATED</b></div>
      {mode !== 'minimal' && <div className="hud-resource-strip">
        <div><small>ENERGY RESERVE*</small><strong>{safe(energyRemainingWh)} Wh</strong></div>
        <div><small>O₂ RESERVE*</small><strong>{safe(oxygenRemainingL)} L</strong></div>
        <div><small>EVA TIME*</small><strong>{safe(evaMinutesRemaining)} min</strong></div>
        <div><small>ROUTE STATUS</small><strong>{route?.metrics.return_feasible ? 'RETURN FEASIBLE' : route ? 'CHECK RESERVE' : 'NOT PLANNED'}</strong></div>
      </div>}
    </div>
    <div className="hud-transport-controls" aria-label="Shared EVA simulation controls">
      <span><b>EVA SIMULATION</b><small>{evaPlaying ? 'PLAYING' : 'PAUSED'} · {progressPercent}% COMPLETE</small></span>
      <button onClick={onEvaReset} disabled={progressIndex === 0 && !evaPlaying}>RESET</button>
      <button onClick={onEvaStepForward} disabled={!path.length || progressIndex >= path.length - 1}>NEXT CELL</button>
      <button onClick={onEvaPlayPause} disabled={!path.length}>{evaPlaying ? 'PAUSE' : 'PLAY'}</button>
    </div>
    <div className="hud-disclaimer">* Resource values are planner estimates / simulations, not live suit telemetry. Constraint markers reflect only the loaded route grid and configured slope limit. This browser HUD is a research visualization, not connected to astronaut hardware or certified navigation sensors.</div>
  </div>;
}
