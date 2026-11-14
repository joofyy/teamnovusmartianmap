import { useCallback, useEffect, useMemo, useState } from 'react';
import TerrainScene from './components/TerrainScene';
import DataExplorer from './components/DataExplorer';
import ScienceAssistant from './components/ScienceAssistant';
import { api } from './api';
import type { BenchmarkResult, MarsSite, OfficialSource, OfflineStatus, PlanResponse, Point, ReplanResponse, Route, TerrainData } from './types';

type Layer = 'elevation' | 'slope' | 'roughness' | 'regolith' | 'temperature' | 'environment' | 'radiation' | 'uncertainty' | 'science';
const INITIAL_START: Point = { x: 4, y: 5 };
const INITIAL_GOAL: Point = { x: 59, y: 56 };
const EMPTY_PATH: Point[] = [];

const layerNames: { id: Layer; name: string; unit: string }[] = [
  { id: 'elevation', name: 'Elevation', unit: 'm / fixture-relative when simulated' },
  { id: 'slope', name: 'Slope', unit: 'degrees' },
  { id: 'roughness', name: 'Roughness', unit: 'normalized local relief' },
  { id: 'regolith', name: 'Regolith mobility', unit: '0–1 user-defined index' },
  { id: 'temperature', name: 'Temperature', unit: '°C, if imported' },
  { id: 'environment', name: 'Environment', unit: '0–1 user-defined index' },
  { id: 'radiation', name: 'Radiation', unit: '0–1 user-defined index' },
  { id: 'uncertainty', name: 'Uncertainty', unit: '0–1 index' },
  { id: 'science', name: 'Science potential', unit: '0–1 user-defined index' },
];

function pointText(p: Point) { return `X ${String(p.x).padStart(2, '0')} / Y ${String(p.y).padStart(2, '0')}`; }
function pathDistanceM(path: Point[], cellSizeM: number) {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y) * cellSizeM;
  }
  return total;
}
function gridHeading(from: Point, to: Point) {
  const east = to.x - from.x;
  const north = from.y - to.y;
  const degrees = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${directions[Math.round(degrees / 45) % 8]} ${Math.round(degrees).toString().padStart(3, '0')}° GRID`;
}
export default function App() {
  const [terrain, setTerrain] = useState<TerrainData | null>(null);
  const [sites, setSites] = useState<MarsSite[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState('gale');
  const [datasets, setDatasets] = useState<OfficialSource[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRoute, setSelectedRoute] = useState('B');
  const [start, setStart] = useState<Point>(INITIAL_START);
  const [goal, setGoal] = useState<Point>(INITIAL_GOAL);
  const [layer, setLayer] = useState<Layer>('elevation');
  const [viewMode, setViewMode] = useState<'3D' | '2D'>('3D');
  const [pickMode, setPickMode] = useState<'start' | 'goal' | null>(null);
  const [evaMode, setEvaMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'planner' | 'science' | 'data'>('planner');
  const [maxSlope, setMaxSlope] = useState(22);
  const [evaMinutes, setEvaMinutes] = useState(180);
  const [oxygenBudget, setOxygenBudget] = useState(1200);
  const [oxygenRate, setOxygenRate] = useState(1.0);
  const [equipmentMass, setEquipmentMass] = useState(12.5);
  const [restInterval, setRestInterval] = useState(60);
  const [sciencePriority, setSciencePriority] = useState(1.0);
  const [riskAversion, setRiskAversion] = useState(1.0);
  const [uncertaintyAversion, setUncertaintyAversion] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState('');
  const [replanResult, setReplanResult] = useState<ReplanResponse | null>(null);
  const [conditionNotice, setConditionNotice] = useState('');
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([]);
  const [benchmarking, setBenchmarking] = useState(false);
  const [addedObstacles, setAddedObstacles] = useState<Point[]>([]);
  const [status, setStatus] = useState('CONNECTING');
  const [evaProgressIndex, setEvaProgressIndex] = useState(0);
  const [offlineStatus, setOfflineStatus] = useState<OfflineStatus | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.terrain('gale'), api.dataCatalog(), api.health(), api.sites()])
      .then(([terrainData, catalog, health, siteCatalog]) => {
        if (!alive) return;
        setTerrain(terrainData);
        setSites(siteCatalog.sites);
        setDatasets(catalog.sources);
        setStatus(health.status.toUpperCase());
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(`Backend unavailable: ${err.message}. Start the FastAPI server and refresh.`);
        setStatus('OFFLINE');
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const handleSiteChange = useCallback(async (nextSiteId: string) => {
    const nextSite = sites.find((site) => site.id === nextSiteId);
    if (!nextSite || nextSiteId === selectedSiteId) return;
    setSelectedSiteId(nextSiteId);
    setLoading(true);
    setTerrain(null);
    setPlan(null);
    setRoutes([]);
    setBenchmarkResults([]);
    setReplanResult(null);
    setError('');
    setConditionNotice('');
    setAddedObstacles([]);
    setLayer('elevation');
    setStart(INITIAL_START);
    setGoal(INITIAL_GOAL);
    try {
      const nextTerrain = await api.terrain(nextSiteId);
      setTerrain(nextTerrain);
      setStart({ x: Math.min(4, nextTerrain.width - 2), y: Math.min(5, nextTerrain.height - 2) });
      setGoal({ x: Math.max(1, nextTerrain.width - 5), y: Math.max(1, nextTerrain.height - 8) });
      setSites((current) => current.map((site) => site.id === nextSiteId
        ? { ...site, terrain_loaded: nextTerrain.status !== 'SIMULATED_NOT_GEOREFERENCED', terrain_status: nextTerrain.status }
        : site));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No terrain DEM is loaded for ' + nextSite.name + '.');
    } finally {
      setLoading(false);
    }
  }, [sites, selectedSiteId]);
  const runPlan = useCallback(async (newStart = start, newGoal = goal) => {
    setPlanning(true);
    setError('');
    setReplanResult(null);
    setAddedObstacles([]);
    try {
      const result = await api.plan(selectedSiteId, newStart, newGoal, {
        max_slope_deg: maxSlope,
        max_temperature_c: -35,
        eva_limit_minutes: evaMinutes,
        energy_budget_wh: 180,
        return_reserve_fraction: 0.25,
        suit_mass_kg: 42,
        carried_equipment_mass_kg: equipmentMass,
        base_speed_mps: 0.65,
        oxygen_budget_l: oxygenBudget,
        oxygen_consumption_lpm: oxygenRate,
        rest_interval_min: restInterval,
        rest_duration_min: 5,
        objective_weight_multipliers: {
          science_opportunity_cost: sciencePriority,
          terrain_risk: riskAversion,
          environment_risk: riskAversion,
          radiation: riskAversion,
          uncertainty: uncertaintyAversion,
        },
      });
      setPlan(result);
      setRoutes(result.routes);
      setSelectedRoute('B');
      setEvaProgressIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Route planning failed');
    } finally {
      setPlanning(false);
    }
  }, [selectedSiteId, start, goal, maxSlope, evaMinutes, oxygenBudget, oxygenRate, restInterval, equipmentMass, sciencePriority, riskAversion, uncertaintyAversion]);

  useEffect(() => {
    if (terrain && !plan && !planning && !error) void runPlan();
  }, [terrain, plan, planning, error, runPlan]);

  const handlePick = useCallback((point: Point) => {
    if (!terrain) return;
    if (pickMode === 'start') setStart(point);
    if (pickMode === 'goal') setGoal(point);
    setPickMode(null);
  }, [pickMode, terrain]);

  const runBenchmark = async () => {
    setBenchmarking(true);
    setError('');
    try {
      const result = await api.benchmark(selectedSiteId, start, goal, {
        max_slope_deg: maxSlope, max_temperature_c: -35, eva_limit_minutes: evaMinutes,
        energy_budget_wh: 180, return_reserve_fraction: 0.25, suit_mass_kg: 42, carried_equipment_mass_kg: equipmentMass, base_speed_mps: 0.65,
        oxygen_budget_l: oxygenBudget, oxygen_consumption_lpm: oxygenRate,
        rest_interval_min: restInterval, rest_duration_min: 5,
        objective_weight_multipliers: {
          science_opportunity_cost: sciencePriority,
          terrain_risk: riskAversion,
          environment_risk: riskAversion,
          radiation: riskAversion,
          uncertainty: uncertaintyAversion,
        },
      });
      setBenchmarkResults(result.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Benchmark failed');
    } finally { setBenchmarking(false); }
  };

  const injectConditionUpdate = async () => {
    if (!plan) return;
    const selected = routes.find((route) => route.profile === 'balanced') ?? routes[1];
    if (!selected || selected.path.length < 5) return;
    const point = selected.path[Math.floor(selected.path.length * 0.58)];
    setReplanning(true); setError(''); setConditionNotice('');
    try {
      const result = await api.updateCondition(plan.plan_id, point, 'environment_index', 0.98);
      setRoutes((previous) => previous.map((route) => route.profile === 'balanced' ? { ...route, path: result.path, metrics: result.metrics } : route));
      setEvaProgressIndex(0);
      setConditionNotice(`${result.notice} Repaired ${result.expanded_during_repair} search nodes.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Condition update failed'); }
    finally { setReplanning(false); }
  };

  const injectObstacle = async () => {
    if (!plan) return;
    const selected = routes.find((route) => route.id === selectedRoute) ?? routes[1];
    if (!selected || selected.path.length < 5) return;
    const middle = selected.path[Math.floor(selected.path.length * 0.52)];
    const candidates = [middle, ...selected.path.slice(Math.max(1, Math.floor(selected.path.length * 0.52) - 3), Math.floor(selected.path.length * 0.52) + 4)];
    const obstacle = candidates.find((p) =>
      Math.hypot(p.x - start.x, p.y - start.y) > 3 &&
      Math.hypot(p.x - goal.x, p.y - goal.y) > 3 &&
      !addedObstacles.some((q) => q.x === p.x && q.y === p.y) &&
      !terrain?.obstacle[p.y][p.x]
    );
    if (!obstacle) {
      setError('Could not find a suitable cell on the route for the simulated obstacle.');
      return;
    }
    setReplanning(true);
    setError('');
    try {
      const result = await api.replan(plan.plan_id, obstacle);
      setReplanResult(result);
      setAddedObstacles(result.obstacles_added);
      setRoutes((previous) => previous.map((route) => route.profile === 'balanced'
        ? { ...route, path: result.path, metrics: result.metrics }
        : route));
      setSelectedRoute('B');
      setEvaProgressIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Adaptive replanning failed');
    } finally {
      setReplanning(false);
    }
  };

  const selected = routes.find((route) => route.id === selectedRoute) ?? routes[1] ?? routes[0];
  const totalTime = selected?.metrics.duration_min ?? 0;
  const selectedPath = selected?.path ?? [];
  const evaIndex = Math.min(evaProgressIndex, Math.max(0, selectedPath.length - 1));
  const evaPosition = selectedPath[evaIndex] ?? start;
  const nextWaypoint = selectedPath[evaIndex + 1] ?? null;
  const returnPath = useMemo(() => selectedPath.slice(0, evaIndex + 1).reverse(), [selectedPath, evaIndex]);
  const cellSizeM = terrain?.cell_size_m ?? 8;
  const travelledDistanceM = pathDistanceM(selectedPath.slice(0, evaIndex + 1), cellSizeM);
  const remainingDistanceM = pathDistanceM(selectedPath.slice(evaIndex), cellSizeM);
  const returnDistanceM = pathDistanceM(returnPath, cellSizeM);
  const progressFraction = selected?.metrics.distance_m ? Math.min(1, travelledDistanceM / selected.metrics.distance_m) : 0;
  const elapsedOutboundMin = totalTime * progressFraction;
  const remainingOutboundMin = totalTime * (1 - progressFraction);
  const remainingPlanMin = remainingOutboundMin + totalTime;
  const remainingEVAClockMin = Math.max(0, evaMinutes - elapsedOutboundMin);
  const elapsedEnergyWh = (selected?.metrics.energy_wh ?? 0) * progressFraction;
  const remainingPlanEnergyWh = (selected?.metrics.energy_wh ?? 0) * (1 - progressFraction) + (selected?.metrics.energy_wh ?? 0);
  const elapsedOxygenL = (selected?.metrics.oxygen_l ?? 0) * progressFraction;
  const remainingPlanOxygenL = (selected?.metrics.oxygen_l ?? 0) * (1 - progressFraction) + (selected?.metrics.oxygen_l ?? 0);
  const upcomingCells = selectedPath.slice(evaIndex, Math.min(selectedPath.length, evaIndex + 9));
  const hasSlope = (terrain?.available_layers ?? []).includes('slope');
  const hasUncertainty = (terrain?.available_layers ?? []).includes('uncertainty');
  const upcomingMaxSlope = hasSlope && upcomingCells.length ? Math.max(...upcomingCells.map((point) => terrain!.slope_deg[point.y][point.x])) : null;
  const upcomingMaxUncertainty = hasUncertainty && upcomingCells.length ? Math.max(...upcomingCells.map((point) => terrain!.uncertainty[point.y][point.x])) : null;
  const terrainWarnings = [
    !hasSlope ? 'Slope layer unavailable. Upcoming terrain inclination cannot be assessed.' : null,
    upcomingMaxSlope !== null && upcomingMaxSlope >= maxSlope * 0.8 ? `Upcoming slope approaches the configured limit (${upcomingMaxSlope.toFixed(1)}° / ${maxSlope.toFixed(1)}°).` : null,
    upcomingMaxUncertainty !== null && upcomingMaxUncertainty >= 0.75 ? `High data uncertainty ahead (${Math.round(upcomingMaxUncertainty * 100)}%).` : null,
    !(terrain?.available_layers ?? []).includes('atmosphere') ? 'No spatial atmospheric layer is loaded.' : null,
    !(terrain?.available_layers ?? []).includes('radiation') ? 'No spatial radiation layer is loaded.' : null,
  ].filter((warning): warning is string => Boolean(warning));
  const nearbyTargets = terrain?.targets
    ? [...terrain.targets].sort((a, b) => Math.hypot(a.x - evaPosition.x, a.y - evaPosition.y) - Math.hypot(b.x - evaPosition.x, b.y - evaPosition.y)).slice(0, 3)
    : [];

  useEffect(() => {
    setEvaProgressIndex(0);
  }, [plan?.plan_id, selectedRoute]);

  useEffect(() => {
    if (!evaMode) return;
    let alive = true;
    api.offlineStatus()
      .then((result) => { if (alive) setOfflineStatus(result); })
      .catch(() => { if (alive) setOfflineStatus(null); });
    return () => { alive = false; };
  }, [evaMode]);

  if (loading) return <div className="boot-screen"><div className="boot-mark">M</div><div className="boot-title">MARSCOPE</div><div className="boot-sub">INITIALIZING PLANETARY SYSTEMS</div><div className="boot-bar"><span /></div></div>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">M</div>
          <div><div className="brand-name">MARSCOPE</div><div className="brand-tag">FROM ORBIT TO BOOTPRINT</div></div>
        </div>
        <div className="mission-crumb"><span className="crumb-dot" /> {sites.find((site) => site.id === selectedSiteId)?.name ?? "MARS SITE"} <span>/</span> {sites.find((site) => site.id === selectedSiteId)?.region ?? "SURFACE RECONNAISSANCE"}</div>
        <div className="top-status"><span className={`status-dot ${status === 'OK' ? 'online' : 'offline'}`} /> API {status} <span className="top-divider" /> <span className="mono">BUILD 0.3.1</span></div>
      </header>

      <main className="workspace">
        <section className="left-rail">
          <div className="rail-head"><span className="eyebrow">MISSION AREA</span><span className="live-chip">{terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'SIMULATION' : 'IMPORTED DEM'}</span></div>
          <div className="location-card">
            <div className="planet-glyph">♂</div>
            <div className="location-copy"><strong>{sites.find((site) => site.id === selectedSiteId)?.name ?? "Mars site"}</strong><span>{sites.find((site) => site.id === selectedSiteId)?.mission ?? "Select a mission"} · Mars</span></div>
            <div className="location-chevron">⌄</div>
          </div>
          <select
            value={selectedSiteId}
            onChange={(event) => void handleSiteChange(event.target.value)}
            aria-label="Select Mars landing site"
            style={{ width: "100%", margin: "8px 0 12px", padding: "10px 12px", borderRadius: 8, background: "var(--panel, #15191e)", color: "inherit", border: "1px solid var(--line, #343a42)" }}
          >
            {sites.map((site) => <option key={site.id} value={site.id}>{site.name}{site.terrain_loaded ? " · DEM loaded" : " · DEM needed"}</option>)}
          </select>
          <div className="site-data-caption">
            {sites.find((site) => site.id === selectedSiteId)?.dem.name ?? "Official terrain product"} · {sites.find((site) => site.id === selectedSiteId)?.dem.resolution_m ?? "—"} m/post
          </div>
          <div className="section-kicker">MISSION PLANNING</div>
          <div className="field-stack">
            <div className="field-label"><span>01 / START POINT</span><button className={`tiny-action ${pickMode === 'start' ? 'active' : ''}`} onClick={() => setPickMode(pickMode === 'start' ? null : 'start')}>PICK ON MAP</button></div>
            <div className="coord-card"><span className="point-symbol start-symbol">A</span><div><b>{pointText(start)}</b><small>{terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'Grid reference · synthetic demo' : 'Grid cell · imported DEM'}</small></div></div>
            <div className="field-label"><span>02 / DESTINATION</span><button className={`tiny-action ${pickMode === 'goal' ? 'active' : ''}`} onClick={() => setPickMode(pickMode === 'goal' ? null : 'goal')}>PICK ON MAP</button></div>
            <div className="coord-card"><span className="point-symbol goal-symbol">B</span><div><b>{pointText(goal)}</b><small>Grid reference · synthetic tile</small></div></div>
            {pickMode && <div className="pick-hint">Click a location on the terrain to set the {pickMode === 'start' ? 'start point' : 'destination'}.</div>}
          </div>

          <div className="field-stack mission-params">
            <div className="section-kicker">OPERATIONAL CONSTRAINTS</div>
            <div className="slider-row"><div><label>Maximum slope</label><b>{maxSlope}°</b></div><input type="range" min="10" max="35" value={maxSlope} onChange={(e) => setMaxSlope(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>EVA time budget</label><b>{evaMinutes} min</b></div><input type="range" min="60" max="300" step="15" value={evaMinutes} onChange={(e) => setEvaMinutes(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Oxygen budget</label><b>{oxygenBudget} L</b></div><input type="range" min="400" max="3000" step="100" value={oxygenBudget} onChange={(e) => setOxygenBudget(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Oxygen consumption assumption</label><b>{oxygenRate.toFixed(1)} L/min</b></div><input type="range" min="0.3" max="3" step="0.1" value={oxygenRate} onChange={(e) => setOxygenRate(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Rest interval</label><b>{restInterval} min</b></div><input type="range" min="30" max="120" step="15" value={restInterval} onChange={(e) => setRestInterval(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Equipment mass</label><b>{equipmentMass.toFixed(1)} kg</b></div><input type="range" min="0" max="40" step="2.5" value={equipmentMass} onChange={(e) => setEquipmentMass(Number(e.target.value))} /></div>
            <div className="section-kicker preference-kicker">OBJECTIVE WEIGHT MULTIPLIERS</div>
            <div className="slider-row"><div><label>Scientific opportunity</label><b>{sciencePriority.toFixed(1)}×</b></div><input type="range" min="0" max="3" step="0.1" value={sciencePriority} onChange={(e) => setSciencePriority(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Terrain / environment risk aversion</label><b>{riskAversion.toFixed(1)}×</b></div><input type="range" min="0" max="3" step="0.1" value={riskAversion} onChange={(e) => setRiskAversion(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Data uncertainty aversion</label><b>{uncertaintyAversion.toFixed(1)}×</b></div><input type="range" min="0" max="3" step="0.1" value={uncertaintyAversion} onChange={(e) => setUncertaintyAversion(Number(e.target.value))} /></div>
            <div className="constraint-note"><span className="lock-icon">⌑</span> Multipliers reweight profile preferences and normalize weights to sum to 1. Hard constraints and return reserve are not relaxed. All mobility/resource values remain unvalidated research assumptions.</div>
          </div>
          <button className="primary-button" onClick={() => void runPlan()} disabled={planning || !terrain}>
            {planning ? <><span className="spinner" /> COMPUTING ROUTES</> : <><span>⌁</span> GENERATE ROUTE OPTIONS</>}
          </button>
          <button className="ghost-button" onClick={() => { const a = { x: Math.max(1, Math.floor((terrain?.width ?? 64) * 0.07)), y: Math.max(1, Math.floor((terrain?.height ?? 64) * 0.08)) }; const b = { x: Math.max(2, Math.floor((terrain?.width ?? 64) * 0.92)), y: Math.max(2, Math.floor((terrain?.height ?? 64) * 0.90)) }; setStart(a); setGoal(b); void runPlan(a, b); }}>RESET MISSION GEOMETRY</button>

          <div className="rail-footnote"><span className="warning-icon">!</span><p>Research prototype only. Never use these paths as operational astronaut guidance.</p></div>
        </section>

        <section className="center-column">
          <div className="view-header">
            <div><div className="eyebrow">SURFACE RECONNAISSANCE</div><h1>{sites.find((site) => site.id === selectedSiteId)?.name ?? "Mars site"} <span>/</span> {sites.find((site) => site.id === selectedSiteId)?.region ?? "Surface reconnaissance"}</h1></div>
            <div className="view-actions"><div className="segmented"><button className={viewMode === '3D' ? 'selected' : ''} onClick={() => setViewMode('3D')}>3D TERRAIN</button><button className={viewMode === '2D' ? 'selected' : ''} onClick={() => setViewMode('2D')}>2D MAP</button></div><button className={`eva-toggle ${evaMode ? 'on' : ''}`} onClick={() => setEvaMode(!evaMode)}><span className="eva-dot" /> EVA MODE</button></div>
          </div>

          <div className="terrain-frame">
            {terrain && <TerrainScene terrain={terrain} routes={routes} selectedRoute={selectedRoute} start={start} goal={goal} obstacles={addedObstacles} layer={layer} viewMode={viewMode} pickMode={pickMode} evaPosition={evaMode ? evaPosition : null} returnPath={evaMode ? returnPath : EMPTY_PATH} onPick={handlePick} />}
            <div className="scene-top-left"><span className="scene-tag"><i /> TERRAIN MODEL</span><span className="scene-tag muted">{terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'SYNTHETIC / NOT GEOREFERENCED' : 'IMPORTED GEOTIFF / VERIFY PROVENANCE'}</span></div>
            <div className="scene-top-right"><span className="compass">N</span><span className="compass-line" /></div>
            <div className="scene-bottom-left"><span>GRID CELL <b>{terrain?.cell_size_m?.toFixed(1) ?? '8.0'} m</b></span><span className="scene-vertical-note">VERTICAL EXAGGERATION <b>5×</b></span></div>
            <div className="scene-bottom-right"><span className="view-caption">{viewMode === '3D' ? 'OBLIQUE VIEW' : 'PLAN VIEW'}</span><span className="zoom-hint">DRAG TO ORBIT · SCROLL TO ZOOM</span></div>
            {pickMode && <div className="map-pick-overlay">SELECT {pickMode === 'start' ? 'START POINT' : 'DESTINATION'} ON THE TERRAIN</div>}
          </div>

          <div className="layer-strip">
            <div className="layer-title"><span className="eyebrow">MAP LAYERS</span><span className="layer-count">{layerNames.filter((entry) => { const key: Record<Layer, string> = { elevation: 'elevation', slope: 'slope', roughness: 'roughness', regolith: 'regolith', temperature: 'temperature', environment: 'atmosphere', radiation: 'radiation', uncertainty: 'uncertainty', science: 'science' }; return (terrain?.available_layers ?? []).includes(key[entry.id]); }).length} AVAILABLE</span></div>
            <div className="layer-buttons">{layerNames.filter((entry) => { const key: Record<Layer, string> = { elevation: 'elevation', slope: 'slope', roughness: 'roughness', regolith: 'regolith', temperature: 'temperature', environment: 'atmosphere', radiation: 'radiation', uncertainty: 'uncertainty', science: 'science' }; return (terrain?.available_layers ?? []).includes(key[entry.id]); }).map((entry) => <button key={entry.id} className={layer === entry.id ? 'layer-button active' : 'layer-button'} onClick={() => setLayer(entry.id)}><span className={`layer-swatch swatch-${entry.id}`} />{entry.name}</button>)}</div>
            <div className="layer-metadata"><span>SOURCE <b>{terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'Synthetic fixture' : 'Imported DEM'}</b></span><span>DATE <b>{terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'Not an observation' : 'See provenance'}</b></span><span>GRID SPACING <b>{terrain?.cell_size_m ?? 8} m</b></span><span>LAYERS <b>{(terrain?.available_layers ?? []).join(', ') || 'Unspecified'}</b></span></div>
          </div>

          {evaMode ? (
            <div className="eva-panel">
              <div className="eva-panel-head"><div><span className="eyebrow">FIELD NAVIGATION INTERFACE</span><h2>EXTRAVEHICULAR ACTIVITY</h2></div><span className="eva-badge">SIMULATED POSITION</span></div>
              <div className="eva-progress"><div><span>ROUTE PROGRESS</span><b>{selectedPath.length ? `${Math.round(progressFraction * 100)}%` : 'N/A'}</b></div><div className="eva-progress-track"><span style={{ width: `${progressFraction * 100}%` }} /></div><small>Grid-cell stepping for demonstration. No live localization is connected.</small></div>
              <div className="eva-controls">
                <button onClick={() => setEvaProgressIndex((value) => Math.min(value + 1, Math.max(0, selectedPath.length - 1)))} disabled={!nextWaypoint}>ADVANCE ONE ROUTE CELL</button>
                <button onClick={() => setEvaProgressIndex(0)} disabled={evaIndex === 0}>RESET TO START</button>
              </div>
              <div className="eva-grid">
                <div className="eva-stat"><span>CURRENT POSITION</span><strong>{pointText(evaPosition)}</strong><small>{terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'Synthetic grid position' : 'Imported DEM grid coordinate'}</small></div>
                <div className="eva-stat"><span>NEXT ROUTE WAYPOINT</span><strong>{nextWaypoint ? pointText(nextWaypoint) : 'DESTINATION REACHED'}</strong><small>{nextWaypoint ? `${(Math.hypot(nextWaypoint.x - evaPosition.x, nextWaypoint.y - evaPosition.y) * cellSizeM).toFixed(1)} m · ${gridHeading(evaPosition, nextWaypoint)}` : 'No forward waypoint remains'}</small></div>
                <div className="eva-stat"><span>REMAINING OUTBOUND</span><strong>{remainingDistanceM.toFixed(1)} m</strong><small>{remainingOutboundMin.toFixed(1)} min model estimate</small></div>
                <div className="eva-stat"><span>RETURN TRACE TO BASE</span><strong>{returnDistanceM.toFixed(1)} m</strong><small>{pointText(evaPosition)} → {pointText(start)} · dashed on map</small></div>
                <div className="eva-stat"><span>ESTIMATED EVA CLOCK AVAILABLE</span><strong>{remainingEVAClockMin.toFixed(1)} min</strong><small>{elapsedOutboundMin.toFixed(1)} min modeled outbound elapsed</small></div>
                <div className="eva-stat"><span>TIME TO DESTINATION + RETURN</span><strong>{remainingPlanMin.toFixed(1)} min</strong><small>Remaining outbound + full return leg estimate</small></div>
                <div className="eva-stat"><span>ENERGY REMAINING FOR PLAN</span><strong>{Math.max(0, 180 - elapsedEnergyWh).toFixed(1)} Wh</strong><small>{remainingPlanEnergyWh.toFixed(1)} Wh estimated to destination + return</small></div>
                <div className="eva-stat"><span>OXYGEN REMAINING FOR PLAN</span><strong>{Math.max(0, oxygenBudget - elapsedOxygenL).toFixed(1)} L</strong><small>{remainingPlanOxygenL.toFixed(1)} L estimated to destination + return</small></div>
                <div className="eva-stat"><span>PLAN RETURN RESERVE CHECK</span><strong className={selected?.metrics.return_feasible ? 'good' : 'bad'}>{selected?.metrics.return_feasible ? 'WITHIN MODEL BUDGET' : 'REVIEW MODEL LIMITS'}</strong><small>Computed at route-planning time; not a live safety certification</small></div>
                <div className="eva-stat"><span>OFFLINE REVIEW CACHE</span><strong>{offlineStatus ? `${offlineStatus.package_count} PACKAGES` : 'STATUS UNAVAILABLE'}</strong><small>{offlineStatus ? `${offlineStatus.tile_count} rendered tiles cached` : 'Open the DATA panel to inspect cache status'}</small></div>
              </div>
              <div className="eva-detail-grid">
                <section className="eva-detail"><div className="eyebrow">UPCOMING TERRAIN WARNINGS</div>{terrainWarnings.length ? <ul>{terrainWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>No warnings from the currently loaded route layers.</p>}<small>Checks use the next eight route cells and only the layers currently loaded.</small></section>
                <section className="eva-detail"><div className="eyebrow">NEARBY SCIENCE TARGETS</div>{nearbyTargets.length ? nearbyTargets.map((target) => <p key={target.id}><b>{target.name}</b><small>{(Math.hypot(target.x - evaPosition.x, target.y - evaPosition.y) * cellSizeM).toFixed(1)} m · {target.evidence_status}</small></p>) : <p>No geolocated science targets are attached to this terrain grid.<small>Rover observations are not assigned to map coordinates without localization metadata.</small></p>}</section>
                <section className="eva-detail"><div className="eyebrow">OFFLINE MAP AVAILABILITY</div>{offlineStatus?.package_count ? offlineStatus.packages.map((item) => <p key={item.filename}><b>{item.title ?? item.layer_id ?? item.filename}</b><small>{item.tile_count} tiles · {item.resolution_m_per_pixel ? `${item.resolution_m_per_pixel} m/px` : 'resolution in archive metadata'}</small></p>) : <p>No cached WMTS review package is available on this backend.<small>Use DATA → NASA/JPL Mars Trek WMTS to cache a bounded area.</small></p>}<small>Cached tiles are not yet draped onto this 3D terrain and do not constitute an offline EVA map.</small></section>
              </div>
              <div className="eva-notice">The green marker shows a simulated position advanced along the selected route. The amber dashed line traces the already-traversed path back to the start. Grid headings are not a certified compass bearing. Suit performance, energy, oxygen and time are illustrative estimates; no live communications, localization or hazard updates are connected.</div>
            </div>
          ) : (
            <div className="route-section">
              <div className="section-heading"><div><span className="eyebrow">PATHFINDING ENGINE</span><h2>Route alternatives <span className="count-pill">{routes.length}</span></h2>{plan?.planning_runtime_ms !== undefined && <small>Planner runtime: {(plan.planning_runtime_ms / 1000).toFixed(2)} s · 3 approximate Pareto profiles</small>}</div><div className="route-actions"><button className="text-action" onClick={() => void runBenchmark()} disabled={benchmarking || planning}>{benchmarking ? 'COMPARING…' : 'COMPARE BASELINES'}</button><button className="text-action" onClick={() => void injectObstacle()} disabled={!plan || replanning || !routes.length}>{replanning ? 'REPAIRING GRAPH…' : '＋ SIMULATE OBSTACLE'}</button><button className="text-action" onClick={() => void injectConditionUpdate()} disabled={!plan || replanning || !routes.length}>{replanning ? 'REPAIRING GRAPH…' : 'SIMULATE CONDITION UPDATE'}</button></div></div>
              <div className="route-cards">
                {routes.map((route) => <button key={route.id} className={`route-card ${selectedRoute === route.id ? 'selected' : ''}`} onClick={() => setSelectedRoute(route.id)}>
                  <div className="route-card-top"><span className={`route-letter route-${route.id}`}>{route.id}</span><span className="route-status">{route.is_pareto ? 'PARETO' : 'ALTERNATIVE'}</span></div>
                  <strong>{route.name}</strong><p>{route.summary}</p>
                  <div className="route-metrics-mini"><span><b>{route.metrics.distance_m.toFixed(0)}</b> m</span><span><b>{route.metrics.duration_min.toFixed(1)}</b> min</span><span><b>{route.metrics.terrain_risk_pct.toFixed(0)}</b> risk</span></div>
                </button>)}
              </div>
              {benchmarkResults.length > 0 && <div className="benchmark-strip">
                <div className="benchmark-head"><b>BASELINE COMPARISON</b><small>Same synthetic grid · balanced scalar cost for A* and Dijkstra</small></div>
                {benchmarkResults.map((result) => <div className="benchmark-row" key={result.algorithm}><span>{result.algorithm.replace('_', ' ').toUpperCase()}</span><b>{result.distance_m.toFixed(0)} m</b><b>{result.runtime_ms.toFixed(2)} ms</b><small>{result.expanded_nodes.toLocaleString()} expanded</small></div>)}
                <small className="benchmark-warning">Synthetic-fixture timings only; not a claim of field or orbital-data performance.</small>
              </div>}
              {replanResult && <div className="repair-banner"><span className="repair-icon">↻</span><div><b>Incremental route repair complete</b><small>LPA* updated the selected route after a simulated obstacle. {replanResult.expanded_during_repair} nodes expanded during repair.</small></div><button onClick={() => setReplanResult(null)}>×</button></div>}
              {conditionNotice && <div className="repair-banner"><span className="repair-icon">↻</span><div><b>Condition update processed</b><small>{conditionNotice}</small></div><button onClick={() => setConditionNotice('')}>×</button></div>}
              {error && <div className="error-banner"><span>!</span>{error}</div>}
            </div>
          )}
        </section>

        <aside className="right-rail">
          <div className="right-tabs"><button className={activeTab === 'planner' ? 'active' : ''} onClick={() => setActiveTab('planner')}>ANALYTICS</button><button className={activeTab === 'science' ? 'active' : ''} onClick={() => setActiveTab('science')}>SCIENCE</button><button className={activeTab === 'data' ? 'active' : ''} onClick={() => setActiveTab('data')}>DATA</button></div>
          {activeTab === 'planner' && selected && <div className="analytics-content">
            <div className="analytics-head"><span className="eyebrow">SELECTED PROFILE</span><div className="selected-title"><span className={`route-letter route-${selected.id}`}>{selected.id}</span><h3>{selected.name}</h3></div></div>
            <div className="metric-hero"><div><span>TOTAL DISTANCE</span><strong>{selected.metrics.distance_m.toFixed(0)}<small>m</small></strong></div><div><span>TRAVEL TIME</span><strong>{selected.metrics.duration_min.toFixed(1)}<small>min</small></strong></div></div>
            <div className="metric-list">
              <MetricBar label="Terrain risk" value={selected.metrics.terrain_risk_pct} color="sand" />
              <MetricBar label="Environmental index" value={selected.metrics.environment_risk_pct} color="cyan" />
              <MetricBar label="Radiation index" value={selected.metrics.radiation_index_pct} color="gold" />
              <MetricBar label="Data uncertainty" value={selected.metrics.uncertainty_pct} color="yellow" />
              <MetricBar label="Scientific value" value={selected.metrics.scientific_value_pct} color="green" />
            </div>
            <div className="resource-block"><div className="resource-heading"><span className="eyebrow">RESOURCE MODEL</span><span className={`feasibility ${selected.metrics.return_feasible ? 'pass' : 'fail'}`}>{selected.metrics.return_feasible ? 'RETURN FEASIBLE' : 'LIMIT EXCEEDED'}</span></div><div className="resource-row"><span>Estimated energy</span><b>{selected.metrics.energy_wh.toFixed(1)} Wh</b></div><div className="resource-row"><span>Out-and-back time</span><b>{selected.metrics.return_time_estimate_min.toFixed(1)} min</b></div><div className="resource-row"><span>Out-and-back energy</span><b>{selected.metrics.return_energy_estimate_wh.toFixed(1)} Wh</b></div><div className="resource-row"><span>Outbound oxygen estimate</span><b>{selected.metrics.oxygen_l?.toFixed(1) ?? 'N/A'} L</b></div><div className="resource-row"><span>Out-and-back oxygen estimate</span><b>{selected.metrics.return_oxygen_l?.toFixed(1) ?? 'N/A'} L</b></div></div>
            <div className="algorithm-card"><div className="algorithm-head"><span className="algorithm-icon">ƒ</span><div><b>HYBRID MULTI-OBJECTIVE A*</b><small>Bounded Pareto label search</small></div></div><div className="algorithm-stats"><div><b>{selected.search.expanded_nodes.toLocaleString()}</b><small>Expanded</small></div><div><b>{selected.search.generated_labels.toLocaleString()}</b><small>Labels</small></div><div><b>{selected.search.pareto_labels_at_goal}</b><small>Goal labels</small></div></div></div>
            <p className="metric-foot">{selected.metrics.model_note}</p>
          </div>}

          {activeTab === 'science' && <ScienceAssistant />}

          {activeTab === 'data' && sites.find((site) => site.id === selectedSiteId) && <DataExplorer sources={datasets} planId={plan?.plan_id} site={sites.find((site) => site.id === selectedSiteId)!} onTerrainImported={(nextTerrain) => { setTerrain(nextTerrain); setSites((current) => current.map((site) => site.id === selectedSiteId ? { ...site, terrain_loaded: true, terrain_status: nextTerrain.status } : site)); setPlan(null); setRoutes([]); setBenchmarkResults([]); setError(''); setConditionNotice(''); setLayer('elevation'); const nextStart = { x: 4, y: 5 }; const nextGoal = { x: nextTerrain.width - 5, y: nextTerrain.height - 8 }; setStart(nextStart); setGoal(nextGoal); }} />}
        </aside>
      </main>
      <footer className="app-footer"><span>© MARSCOPE RESEARCH PROTOTYPE</span><span>DATA STATUS: {terrain?.status === 'SIMULATED_NOT_GEOREFERENCED' ? 'SYNTHETIC DEMONSTRATION TILE' : terrain ? 'IMPORTED MARS DEM + UNKNOWN AUXILIARY LAYERS' : 'SITE DEM NOT LOADED'}</span><span>NOT FOR OPERATIONAL USE</span></footer>
    </div>
  );
}

function MetricBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  const display = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return <div className="metric-bar-row"><div className="metric-bar-label"><span>{label}</span><b>{display !== null ? `${display.toFixed(0)}%` : 'N/A'}</b></div><div className="bar-track"><div className={`bar-fill ${color}`} style={{ width: display !== null ? `${Math.max(0, Math.min(100, display))}%` : '0%' }} /></div></div>;
}
