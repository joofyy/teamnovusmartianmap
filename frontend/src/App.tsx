import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TerrainScene from './components/TerrainScene';
import ScientificTerrainInspector from './components/ScientificTerrainInspector';
import DataExplorer from './components/DataExplorer';
import DecisionCenter from './components/DecisionCenter';
import RouteProfileChart from './components/RouteProfileChart';
import RouteExplainability from './components/RouteExplainability';
import RouteComparisonTable from './components/RouteComparisonTable';
import MissionReplay from './components/MissionReplay';
import SensitivityAnalysis from './components/SensitivityAnalysis';
import DataProvenancePanel from './components/DataProvenancePanel';
import ScientificTargetsPanel from './components/ScientificTargetsPanel';
import RouteRobustnessPanel from './components/RouteRobustnessPanel';
import AstronautHud from './components/AstronautHud';
import MarscopeLanding from './components/MarscopeLanding';
import GuidedTour from './components/GuidedTour';
import CoordinateInputDialog, { CoordinateTargetType } from './components/CoordinateInputDialog';
import { gridToGeo } from './utils/coordinates';
import { api } from './api';
import { DEFAULT_MISSION_SITE_ID, MISSION_SITES } from './missionSites';
import type { BenchmarkResult, JevPathfindingWeights, JevProvider, MissionEvent, MissionConstraintsPayload, OfficialSource, OfflineStatus, PlanResponse, Point, ReplanResponse, Route, Target, TerrainData } from './types';

type ActiveJevDecision = { siteId: string; result: JevPathfindingWeights };
type Layer = 'elevation' | 'slope' | 'roughness' | 'regolith' | 'temperature' | 'environment' | 'radiation' | 'uncertainty' | 'science';
const INITIAL_START: Point = { x: 34, y: 42 };
const INITIAL_GOAL: Point = { x: 55, y: 53 };
const EMPTY_PATH: Point[] = [];

const layerNames: { id: Layer; name: string; unit: string }[] = [
  { id: 'elevation', name: 'Elevation', unit: 'metres · imported planetary DEM' },
  { id: 'slope', name: 'Slope', unit: 'degrees' },
  { id: 'roughness', name: 'Roughness', unit: 'normalized local relief' },
  { id: 'regolith', name: 'Regolith mobility', unit: '0–1 user-defined index' },
  { id: 'temperature', name: 'Temperature', unit: '°C, if imported' },
  { id: 'environment', name: 'Environment', unit: '0–1 user-defined index' },
  { id: 'radiation', name: 'Radiation', unit: '0–1 user-defined index' },
  { id: 'uncertainty', name: 'Uncertainty', unit: '0–1 index' },
  { id: 'science', name: 'Science potential', unit: '0–1 user-defined index' },
];

function isVerifiedRealTerrain(terrain: TerrainData, siteId: string): boolean {
  return terrain.site_id === siteId
    && terrain.status === 'NASA_OR_USER_SUPPLIED_GEOREFERENCED_DEM'
    && terrain.coordinate_info?.site_coverage_verified === true
    && (terrain.available_layers ?? []).includes('elevation')
    && terrain.width > 1
    && terrain.height > 1;
}

function pointText(p: Point) { return `X ${String(p.x).padStart(2, '0')} / Y ${String(p.y).padStart(2, '0')}`; }
function formatLatitude(value: number) { return `${Math.abs(value).toFixed(5)}° ${value < 0 ? 'S' : 'N'}`; }
function formatLongitude(value: number) { return `${value.toFixed(5)}° E`; }
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
  const [selectedMissionSiteId, setSelectedMissionSiteId] = useState(DEFAULT_MISSION_SITE_ID);
  const activeMissionSiteIdRef = useRef(DEFAULT_MISSION_SITE_ID);
  const [datasets, setDatasets] = useState<OfficialSource[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [missionEvents, setMissionEvents] = useState<MissionEvent[]>([]);
  const [customScienceTargets, setCustomScienceTargets] = useState<Target[]>([]);
  const [selectedScienceTargetIds, setSelectedScienceTargetIds] = useState<string[]>([]);
  const [scienceTargetScores, setScienceTargetScores] = useState<Record<string, number>>({});
  const [hudOpen, setHudOpen] = useState(false);
  const [hudMode, setHudMode] = useState<'desktop' | 'helmet' | 'minimal'>('helmet');
  const [selectedRoute, setSelectedRoute] = useState('B');
  const [start, setStart] = useState<Point>(INITIAL_START);
  const [goal, setGoal] = useState<Point>(INITIAL_GOAL);
  const [waypoints, setWaypoints] = useState<Point[]>([]);
  const [layer, setLayer] = useState<Layer>('elevation');
  const [viewMode, setViewMode] = useState<'3D' | '2D'>('3D');
  const [pickMode, setPickMode] = useState<'start' | 'goal' | 'waypoint' | null>(null);
  const [inspectedCell, setInspectedCell] = useState<Point | null>(null);
  const [evaMode, setEvaMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'planner' | 'jev' | 'science' | 'inspect'>('planner');
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const [workspaceEntered, setWorkspaceEntered] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [evaRunning, setEvaRunning] = useState(false);
  const dataModalCloseRef = useRef<HTMLButtonElement>(null);
  const [maxSlope, setMaxSlope] = useState(22);
  const [evaMinutes, setEvaMinutes] = useState(180);
  const [energyBudgetWh, setEnergyBudgetWh] = useState(180);
  const [oxygenBudget, setOxygenBudget] = useState(1200);
  const [oxygenRate, setOxygenRate] = useState(1.0);
  const [equipmentMass, setEquipmentMass] = useState(12.5);
  const [restInterval, setRestInterval] = useState(60);
  const [sciencePriority, setSciencePriority] = useState(1.0);
  const [riskAversion, setRiskAversion] = useState(1.0);
  const [uncertaintyAversion, setUncertaintyAversion] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [terrainLoading, setTerrainLoading] = useState(true);
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

  // High-value scientific visualization & UX states
  const [hazardOverlay, setHazardOverlay] = useState(false);
  const [showSensitivity, setShowSensitivity] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [previewRoute, setPreviewRoute] = useState<{ path: Point[]; label: string } | null>(null);
  const [deviationPoint, setDeviationPoint] = useState<Point | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  // Provider credentials stay in React memory only; never persist them to storage or a URL.
  const [jevProvider, setJevProvider] = useState<JevProvider>('typesafe');
  const [jevApiKey, setJevApiKey] = useState('');
  const [jevMissionPrompt, setJevMissionPrompt] = useState('Balance traverse efficiency, terrain risk, resource reserves and access to scientifically useful areas.');
  const [activeJevDecision, setActiveJevDecision] = useState<ActiveJevDecision | null>(null);
  const [jevLoading, setJevLoading] = useState(false);
  const [jevError, setJevError] = useState('');
  const [jevNotice, setJevNotice] = useState('');

  // Coordinate Input Dialog state for Astronaut manual entry
  const [coordDialogOpen, setCoordDialogOpen] = useState<boolean>(false);
  const [coordDialogTarget, setCoordDialogTarget] = useState<CoordinateTargetType>('start');
  const [coordDialogWpIdx, setCoordDialogWpIdx] = useState<number | undefined>(undefined);

  const selectedMissionSite = MISSION_SITES.find((site) => site.id === selectedMissionSiteId) ?? MISSION_SITES[0];
  const hasAtmosphere = (terrain?.available_layers ?? []).includes('atmosphere');
  const scienceTargets = useMemo(() => {
    const unique = new Map<string, Target>();
    [...(terrain?.targets ?? []), ...customScienceTargets].forEach((target) => unique.set(target.id, target));
    return [...unique.values()];
  }, [terrain?.targets, customScienceTargets]);
  const selectedScienceTargets = useMemo(
    () => scienceTargets.filter((target) => selectedScienceTargetIds.includes(target.id)),
    [scienceTargets, selectedScienceTargetIds],
  );
  const robustnessConstraints = useMemo<MissionConstraintsPayload>(() => ({
    max_slope_deg: maxSlope,
    eva_limit_minutes: evaMinutes,
    energy_budget_wh: energyBudgetWh,
    oxygen_budget_l: oxygenBudget,
    oxygen_consumption_lpm: oxygenRate,
    carried_equipment_mass_kg: equipmentMass,
    rest_interval_min: restInterval,
  }), [maxSlope, evaMinutes, energyBudgetWh, oxygenBudget, oxygenRate, equipmentMass, restInterval]);

  useEffect(() => {
    if (tourStep === null) return;
    setDataMenuOpen(tourStep === 1);
    setHudOpen(tourStep === 6);
    if (tourStep === 4) setActiveTab('jev');
    else if (tourStep === 5) setActiveTab('science');
    else if (tourStep === 2 || tourStep === 3) setActiveTab('planner');
  }, [tourStep]);

  useEffect(() => {
    if (!dataMenuOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusTimer = window.setTimeout(() => dataModalCloseRef.current?.focus(), 0);
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDataMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = document.getElementById('data-catalogue-dialog');
      const focusable = dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((element) => element.offsetParent !== null)
        : [];
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeys);
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleDialogKeys);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [dataMenuOpen]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.dataCatalog(), api.health()])
      .then(([catalog, health]) => {
        if (!alive) return;
        setDatasets(catalog.sources);
        setStatus(health.status.toUpperCase());
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(`Backend connection problem: ${err.message}`);
        setStatus('OFFLINE');
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const siteId = selectedMissionSiteId;
    activeMissionSiteIdRef.current = siteId;
    setTerrainLoading(true);
    setTerrain(null);
    setInspectedCell(null);
    setActiveTab('planner');
    setPlan(null);
    setRoutes([]);
    setWaypoints([]);
    setPlanning(false);
    setReplanning(false);
    setBenchmarking(false);
    setBenchmarkResults([]);
    setAddedObstacles([]);
    setReplanResult(null);
    setMissionEvents([]);
    setCustomScienceTargets([]);
    setSelectedScienceTargetIds([]);
    setScienceTargetScores({});
    setHudOpen(false);
    setDataMenuOpen(false);
    setConditionNotice('');
    setEvaProgressIndex(0);
    setEvaRunning(false);
    setStart(INITIAL_START);
    setGoal(INITIAL_GOAL);
    setSelectedRoute('B');
    setLayer('elevation');
    setPickMode(null);
    setEvaMode(false);
    setHazardOverlay(false);
    setShowSensitivity(false);
    setShowComparison(false);
    setPreviewRoute(null);
    setDeviationPoint(null);
    setError('');

    api.terrain(siteId)
      .then((terrainData) => {
        if (!alive) return;
        if (!isVerifiedRealTerrain(terrainData, siteId)) {
          throw new Error('The backend did not return a real Mars DEM with a verified site footprint. Synthetic or unverified terrain is blocked.');
        }
        setTerrain(terrainData);
        setStatus('OK');
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(`No route-ready terrain for ${siteId}: ${err.message}`);
      })
      .finally(() => alive && setTerrainLoading(false));

    return () => { alive = false; };
  }, [selectedMissionSiteId]);

  const runPlan = useCallback(async (newStart = start, newGoal = goal, currentWaypoints = waypoints, decisionOverride: ActiveJevDecision | null = activeJevDecision) => {
    const siteId = selectedMissionSiteId;
    const validJevDecision = decisionOverride
      && decisionOverride.siteId === siteId
      && decisionOverride.result.missionPrompt === jevMissionPrompt
      ? decisionOverride
      : null;
    if (!terrain || !isVerifiedRealTerrain(terrain, siteId) || activeMissionSiteIdRef.current !== siteId) return;
    setPlanning(true);
    setError('');
    setReplanResult(null);
    setAddedObstacles([]);
    setPreviewRoute(null);
    try {
      const constraints = {
        max_slope_deg: maxSlope,
        max_temperature_c: -35,
        eva_limit_minutes: evaMinutes,
        energy_budget_wh: energyBudgetWh,
        return_reserve_fraction: 0.25,
        suit_mass_kg: 42,
        carried_equipment_mass_kg: equipmentMass,
        base_speed_mps: 0.65,
        oxygen_budget_l: oxygenBudget,
        oxygen_consumption_lpm: oxygenRate,
        rest_interval_min: restInterval,
        rest_duration_min: 5,
        objective_weights: validJevDecision?.result.weights,
        objective_weight_multipliers: {
          science_opportunity_cost: sciencePriority,
          terrain_risk: riskAversion,
          environment_risk: riskAversion,
          radiation: riskAversion,
          uncertainty: uncertaintyAversion,
        },
      };

      let result: PlanResponse;
      if (currentWaypoints.length > 0) {
        result = await api.planWaypoints(siteId, newStart, currentWaypoints, newGoal, constraints);
      } else {
        result = await api.plan(siteId, newStart, newGoal, constraints);
      }

      if (activeMissionSiteIdRef.current !== siteId) return;
      setPlan(result);
      setRoutes(result.routes);
      setSelectedRoute(validJevDecision ? 'B' : result.routes[0]?.id ?? 'B');
      setEvaProgressIndex(0);
      try {
        if (validJevDecision) {
          await api.recordMissionEvent(result.plan_id, {
            event_type: 'JEV_DECISION',
            title: 'JEV pathfinding decision recorded',
            summary: `JEV selected the ${validJevDecision.result.strategy} strategy for Route B.`,
            data: {
              provider: validJevDecision.result.provider,
              model: validJevDecision.result.model,
              strategy: validJevDecision.result.strategy,
              evaluatedAt: validJevDecision.result.evaluatedAt,
              missionPrompt: validJevDecision.result.missionPrompt,
              weights: validJevDecision.result.weights,
              judgements: validJevDecision.result.judgements,
              jevInfluenceShare: validJevDecision.result.jevInfluenceShare,
              strategyPriorShare: validJevDecision.result.strategyPriorShare,
              policyVersion: validJevDecision.result.policyVersion,
              notice: validJevDecision.result.notice,
            },
          });
        }
        const eventSnapshot = await api.missionEvents(result.plan_id);
        if (activeMissionSiteIdRef.current === siteId) setMissionEvents(eventSnapshot.events);
      } catch {
        setMissionEvents([]);
      }
    } catch (err) {
      if (activeMissionSiteIdRef.current === siteId) {
        setError(err instanceof Error ? err.message : 'Route planning failed');
      }
    } finally {
      setPlanning(false);
    }
  }, [selectedMissionSiteId, terrain, start, goal, waypoints, maxSlope, evaMinutes, oxygenBudget, oxygenRate, restInterval, equipmentMass, energyBudgetWh, sciencePriority, riskAversion, uncertaintyAversion, activeJevDecision, jevMissionPrompt]);

  const generateJevWeights = useCallback(async () => {
    const siteId = selectedMissionSiteId;
    if (!terrain || !isVerifiedRealTerrain(terrain, siteId) || activeMissionSiteIdRef.current !== siteId) return;
    setJevLoading(true);
    setJevError('');
    setJevNotice('');
    try {
      const result = await api.jevPathfindingWeights({
        provider: jevProvider,
        apiKey: jevApiKey,
        missionPrompt: jevMissionPrompt,
        site_id: siteId,
      });
      if (activeMissionSiteIdRef.current !== siteId) return;
      const decision = { siteId, result };
      setActiveJevDecision(decision);
      setJevNotice('JEV returned a validated preference vector. Replanning with adaptive Route B; Routes A and C remain static baselines.');
      await runPlan(start, goal, waypoints, decision);
    } catch (err) {
      if (activeMissionSiteIdRef.current !== siteId) return;
      setActiveJevDecision(null);
      setJevError(err instanceof Error ? err.message : 'JEV evaluation failed.');
      setJevNotice('Adaptive weights were discarded. MARSCOPE is using the static balanced route instead.');
      await runPlan(start, goal, waypoints, null);
    } finally {
      setJevLoading(false);
    }
  }, [selectedMissionSiteId, terrain, jevProvider, jevApiKey, jevMissionPrompt, start, goal, waypoints, runPlan]);

  const clearJevDecision = useCallback(() => {
    if (!activeJevDecision) return;
    setActiveJevDecision(null);
    setJevNotice('The previous adaptive vector was cleared. Replanning with the static balanced profile.');
    void runPlan(start, goal, waypoints, null);
  }, [activeJevDecision, start, goal, waypoints, runPlan]);

  useEffect(() => {
    if (terrain && terrain.site_id === selectedMissionSiteId && !terrainLoading && !plan && !planning && !error) void runPlan();
  }, [terrain, selectedMissionSiteId, terrainLoading, plan, planning, error, runPlan]);

  const handleMissionSiteChange = (siteId: string) => {
    activeMissionSiteIdRef.current = siteId;
    setActiveJevDecision(null);
    setJevNotice('Site changed. The previous site-specific JEV vector was cleared.');
    setMissionEvents([]);
    setSelectedMissionSiteId(siteId);
  };

  const handleInspect = useCallback((point: Point) => {
    if (!terrain || !isVerifiedRealTerrain(terrain, selectedMissionSiteId)) return;
    setInspectedCell(point);
    setActiveTab('inspect');
  }, [terrain, selectedMissionSiteId]);

  const handlePick = useCallback((point: Point) => {
    if (!terrain) return;
    if (pickMode === 'start') setStart(point);
    else if (pickMode === 'goal') setGoal(point);
    else if (pickMode === 'waypoint') {
      if (waypoints.length < 5) {
        const nextWp = [...waypoints, point];
        setWaypoints(nextWp);
        void runPlan(start, goal, nextWp);
      }
    }
    setPickMode(null);
  }, [pickMode, terrain, waypoints, start, goal, runPlan]);

  const openCoordinateDialog = useCallback((targetType: CoordinateTargetType, wpIndex?: number) => {
    setCoordDialogTarget(targetType);
    setCoordDialogWpIdx(wpIndex);
    setCoordDialogOpen(true);
    setPickMode(null);
  }, []);

  const handleCoordinateConfirm = useCallback((point: Point, targetType: CoordinateTargetType, wpIndex?: number) => {
    if (targetType === 'start') {
      setStart(point);
      void runPlan(point, goal, waypoints);
    } else if (targetType === 'goal') {
      setGoal(point);
      void runPlan(start, point, waypoints);
    } else if (targetType === 'new-waypoint') {
      if (waypoints.length < 5) {
        const nextWp = [...waypoints, point];
        setWaypoints(nextWp);
        void runPlan(start, goal, nextWp);
      }
    } else if (targetType === 'edit-waypoint' && wpIndex !== undefined) {
      const nextWp = waypoints.map((w, idx) => (idx === wpIndex ? point : w));
      setWaypoints(nextWp);
      void runPlan(start, goal, nextWp);
    }
  }, [goal, start, waypoints, runPlan]);

  const coordDialogInitialPoint = useMemo(() => {
    if (coordDialogTarget === 'start') return start;
    if (coordDialogTarget === 'goal') return goal;
    if (coordDialogTarget === 'edit-waypoint' && coordDialogWpIdx !== undefined) {
      return waypoints[coordDialogWpIdx] ?? null;
    }
    const prev = waypoints.length ? waypoints[waypoints.length - 1] : start;
    return {
      x: Math.round((prev.x + goal.x) / 2),
      y: Math.round((prev.y + goal.y) / 2),
    };
  }, [coordDialogTarget, coordDialogWpIdx, start, goal, waypoints]);

  // Start and Goal traversability validation
  const startSlope = terrain && terrain.slope_deg[start.y]?.[start.x];
  const startBlocked = terrain && (terrain.obstacle[start.y]?.[start.x] || terrain.valid_mask?.[start.y]?.[start.x] === false);
  const startSteep = startSlope != null && startSlope > maxSlope;

  const goalSlope = terrain && terrain.slope_deg[goal.y]?.[goal.x];
  const goalBlocked = terrain && (terrain.obstacle[goal.y]?.[goal.x] || terrain.valid_mask?.[goal.y]?.[goal.x] === false);
  const goalSteep = goalSlope != null && goalSlope > maxSlope;

  const nudgeToTraversable = (pointType: 'start' | 'goal') => {
    if (!terrain) return;
    const target = pointType === 'start' ? start : goal;
    let bestDist = Infinity;
    let bestPt: Point | null = null;
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = target.x + dx;
          const ny = target.y + dy;
          if (nx >= 0 && nx < terrain.width && ny >= 0 && ny < terrain.height) {
            const isBlocked = terrain.obstacle[ny][nx] || terrain.valid_mask?.[ny]?.[nx] === false;
            const slope = terrain.slope_deg[ny][nx];
            if (!isBlocked && slope <= maxSlope) {
              const d = Math.hypot(dx, dy);
              if (d < bestDist) {
                bestDist = d;
                bestPt = { x: nx, y: ny };
              }
            }
          }
        }
      }
      if (bestPt) break;
    }
    if (bestPt) {
      if (pointType === 'start') {
        setStart(bestPt);
        void runPlan(bestPt, goal, waypoints);
      } else {
        setGoal(bestPt);
        void runPlan(start, bestPt, waypoints);
      }
    }
  };

  const runBenchmark = async () => {
    setBenchmarking(true);
    setError('');
    try {
      const result = await api.benchmark(selectedMissionSiteId, start, goal, {
        max_slope_deg: maxSlope, max_temperature_c: -35, eva_limit_minutes: evaMinutes,
        energy_budget_wh: energyBudgetWh, return_reserve_fraction: 0.25, suit_mass_kg: 42, carried_equipment_mass_kg: equipmentMass, base_speed_mps: 0.65,
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
      if (activeMissionSiteIdRef.current === selectedMissionSiteId) setBenchmarkResults(result.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Benchmark failed');
    } finally { setBenchmarking(false); }
  };

  const injectConditionUpdate = async () => {
    if (!plan) return;
    if (!hasAtmosphere) {
      setError('Cannot simulate environmental condition update: no spatial atmospheric/environment layer is loaded for this mission site. Import a georeferenced raster via DATA panel.');
      return;
    }
    const selected = routes.find((route) => route.profile === 'balanced') ?? routes[1] ?? routes[0];
    if (!selected || selected.path.length < 5) return;
    const point = selected.path[Math.floor(selected.path.length * 0.58)];
    setReplanning(true); setError(''); setConditionNotice('');
    try {
      const result = await api.updateCondition(plan.plan_id, point, 'environment_index', 0.98);
      setRoutes((previous) => previous.map((route) => route.profile === 'balanced' ? { ...route, path: result.path, metrics: result.metrics } : route));
      setEvaProgressIndex(0);
      setConditionNotice(`${result.notice} Repaired ${result.expanded_during_repair} search nodes.`);
      const eventSnapshot = await api.missionEvents(plan.plan_id);
      setMissionEvents(eventSnapshot.events);
    } catch (err) { setError(err instanceof Error ? err.message : 'Condition update failed'); }
    finally { setReplanning(false); }
  };

  const injectObstacle = async () => {
    if (!plan) return;
    const selected = routes.find((route) => route.id === selectedRoute) ?? routes[1] ?? routes[0];
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
      const eventSnapshot = await api.missionEvents(plan.plan_id);
      setMissionEvents(eventSnapshot.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Adaptive replanning failed');
    } finally {
      setReplanning(false);
    }
  };

  const handleRouteSelect = (routeId: string) => {
    if (routeId === selectedRoute) return;
    setSelectedRoute(routeId);
    if (!plan) return;
    void api.recordMissionEvent(plan.plan_id, {
      event_type: 'ROUTE_SELECTED',
      title: `Route ${routeId} selected`,
      summary: 'The operator changed the route used for review and mission replay.',
      data: { route_id: routeId },
    }).then((snapshot) => setMissionEvents(snapshot.events)).catch(() => undefined);
  };

  const downloadReport = async (format: 'markdown' | 'json') => {
    if (!plan) return;
    setReportLoading(true);
    try {
      const res = await api.getRouteReport(plan.plan_id);
      const content = format === 'markdown' ? res.report_markdown : JSON.stringify(res.report_json, null, 2);
      const mime = format === 'markdown' ? 'text/markdown' : 'application/json';
      const ext = format === 'markdown' ? 'md' : 'json';
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `marscope-${selectedMissionSiteId}-report-${plan.plan_id.slice(0, 8)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate report');
    } finally {
      setReportLoading(false);
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
  const upcomingMaxUncertainty = hasUncertainty && upcomingCells.length ? Math.max(...upcomingCells.map((point) => (terrain!.uncertainty?.[point.y]?.[point.x] ?? 0))) : null;
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
    setEvaRunning(false);
  }, [plan?.plan_id, selectedRoute]);

  useEffect(() => {
    if (!evaRunning || !evaMode || selectedPath.length < 2) return;
    const timer = window.setInterval(() => {
      setEvaProgressIndex((value) => Math.min(value + 1, selectedPath.length - 1));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [evaRunning, evaMode, selectedPath.length]);

  useEffect(() => {
    if (evaRunning && selectedPath.length > 1 && evaIndex >= selectedPath.length - 1) setEvaRunning(false);
  }, [evaRunning, evaIndex, selectedPath.length]);

  useEffect(() => {
    if (!evaMode) return;
    let alive = true;
    api.offlineStatus()
      .then((result) => { if (alive) setOfflineStatus(result); })
      .catch(() => { if (alive) setOfflineStatus(null); });
    return () => { alive = false; };
  }, [evaMode]);

  if (loading) return <div className="boot-screen"><div className="boot-mark">M</div><div className="boot-title">MARSCOPE</div><div className="boot-sub">INITIALIZING PLANETARY SYSTEMS</div><div className="boot-bar"><span /></div></div>;

  if (!workspaceEntered) return <MarscopeLanding apiStatus={status} terrainAvailable={Boolean(terrain && isVerifiedRealTerrain(terrain, selectedMissionSiteId))} onEnterWorkspace={() => setWorkspaceEntered(true)} onStartTour={() => { setWorkspaceEntered(true); setTourStep(0); }} />;

  return (
    <div className="app-shell min-h-screen bg-[#0b0d10] text-stone-100 antialiased">
      <header className="topbar sticky top-0 z-30 backdrop-blur-xl">
        <div className="brand-block" data-tour-active={tourStep === 0 || undefined}>
          <div className="brand-mark">M</div>
          <div><div className="brand-name">MARSCOPE</div><div className="brand-tag">FROM ORBIT TO BOOTPRINT</div></div>
        </div>
        <div className="mission-crumb"><span className="crumb-dot" /> {selectedMissionSite.region.toUpperCase()} <span>/</span> {selectedMissionSite.mission.toUpperCase()} <span>/</span> {selectedMissionSite.focusLabel.toUpperCase()}</div>
        <div className="top-status"><span className={`status-dot ${status === 'OK' ? 'online' : 'offline'}`} /> API {status === 'OK' ? 'CONNECTED' : 'OFFLINE'} <span className="top-divider" /> <span className="mono">BUILD 0.4.0</span></div>
      </header>

      <main className="workspace grid min-h-0 gap-3 p-3 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
        {!plan && (
          <section className="workspace-guide" aria-label="Quick start">
            <div className="workspace-guide-copy">
              <span className="workspace-guide-kicker">QUICK START</span>
              <strong>Build your first Mars traverse</strong>
              <p>Choose a mission site, set points A and B, then generate route alternatives. For scientific use, load a georeferenced Mars DEM first; without one, treat terrain and route metrics as illustrative. Use Data Sources for provenance and JEV Advisor to review Route B preferences.</p>
            </div>
            <ol className="workspace-guide-steps">
              <li><span>01</span> Choose a site</li>
              <li><span>02</span> Set start and destination</li>
              <li><span>03</span> Generate routes</li>
            </ol>
          </section>
        )}
        <section className="left-rail min-w-0" data-tour-active={tourStep === 3 || undefined}>
          <div className="rail-head"><span className="eyebrow">MISSION AREA</span><span className="live-chip">{terrainLoading ? 'LOADING TERRAIN' : terrain && isVerifiedRealTerrain(terrain, selectedMissionSiteId) ? 'VERIFIED DEM' : terrain ? 'ILLUSTRATIVE GRID' : 'NO TERRAIN'}</span></div>
          <div className="location-card mission-site-card">
            <div className="planet-glyph">♂</div>
            <div className="location-copy mission-site-copy">
              <label className="mission-site-label" htmlFor="mission-site-select">SELECT MISSION SITE</label>
              <select
                id="mission-site-select"
                className="mission-site-select"
                value={selectedMissionSiteId}
                onChange={(event) => handleMissionSiteChange(event.target.value)}
                aria-label="Select a historic Mars mission site"
              >
                {MISSION_SITES.map((site) => <option key={site.id} value={site.id}>{site.region} — {site.mission}</option>)}
              </select>
              <span>{selectedMissionSite.vehicle} · {selectedMissionSite.agency}</span>
            </div>
          </div>
          <div className="mission-site-meta">
            <div className="mission-site-coordinate">
              <span>LANDING-SITE REFERENCE</span>
              <strong>{formatLatitude(selectedMissionSite.latitude)} · {formatLongitude(selectedMissionSite.longitudeEast)}</strong>
              <small>{selectedMissionSite.coordinateNote} · planetocentric latitude, east-positive longitude</small>
            </div>
            <div className="mission-site-focus"><b>{selectedMissionSite.focusLabel}</b><span>{selectedMissionSite.focus}</span></div>
            <a href={selectedMissionSite.coordinateSourceUrl} target="_blank" rel="noreferrer">{selectedMissionSite.coordinateSource} ↗</a>
          </div>
          <p className="mission-site-warning">{terrain?.site_id === selectedMissionSiteId ? terrain.warning : terrainLoading ? `Fetching or loading the official ${selectedMissionSite.region} DEM…` : error || 'Terrain data is unavailable for this mission site.'}</p>

          <div className="section-kicker">MISSION PLANNING</div>
          <div className="field-stack">
            <div className="field-label">
              <span>01 / START POINT</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="tiny-action"
                  onClick={() => openCoordinateDialog('start')}
                  title="Enter grid or latitude/longitude coordinates"
                >
                  ENTER COORD
                </button>
                <button
                  type="button"
                  className={`tiny-action ${pickMode === 'start' ? 'active' : ''}`}
                  onClick={() => setPickMode(pickMode === 'start' ? null : 'start')}
                >
                  PICK ON MAP
                </button>
              </div>
            </div>
            <div
              className="coord-card coord-card-interactive"
              onClick={() => openCoordinateDialog('start')}
              title="Click to edit start coordinates (Grid or Lat/Lon)"
            >
              <span className="point-symbol start-symbol">A</span>
              <div>
                <b>{pointText(start)}</b>
                <small>{gridToGeo(start, terrain, selectedMissionSite).formattedLat} · {gridToGeo(start, terrain, selectedMissionSite).formattedLon}</small>
              </div>
            </div>
            {(startBlocked || startSteep) && (
              <div className="start-goal-alert">
                <span>⚠ Start point is on {startBlocked ? 'an untraversable/obstacle cell' : `steep terrain (${startSlope?.toFixed(1)}° > ${maxSlope}°)`}.</span>
                <button onClick={() => nudgeToTraversable('start')}>Nudge to nearest traversable cell</button>
              </div>
            )}

            {/* Waypoints Section */}
            <div className="waypoint-box">
              <div className="field-label">
                <span>INTERMEDIATE TARGETS ({waypoints.length}/5)</span>
                {waypoints.length < 5 && (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className="tiny-action"
                      onClick={() => openCoordinateDialog('new-waypoint')}
                      title="Add waypoint by coordinates or latitude/longitude"
                    >
                      + COORD
                    </button>
                    <button
                      type="button"
                      className={`tiny-action ${pickMode === 'waypoint' ? 'active' : ''}`}
                      onClick={() => setPickMode(pickMode === 'waypoint' ? null : 'waypoint')}
                    >
                      {pickMode === 'waypoint' ? 'CLICK TERRAIN' : '+ PICK'}
                    </button>
                  </div>
                )}
              </div>
              {waypoints.length > 0 && (
                <div className="waypoint-list">
                  {waypoints.map((wp, idx) => {
                    const wpGeo = gridToGeo(wp, terrain, selectedMissionSite);
                    return (
                      <div key={`wp-${idx}`} className="waypoint-item">
                        <div
                          className="waypoint-info"
                          style={{ cursor: 'pointer' }}
                          onClick={() => openCoordinateDialog('edit-waypoint', idx)}
                          title="Click to edit coordinates"
                        >
                          <span>W{idx + 1}: {pointText(wp)}</span>
                          <small>{wpGeo.formattedLat} · {wpGeo.formattedLon}</small>
                        </div>
                        <div className="waypoint-actions">
                          <button
                            type="button"
                            className="btn-edit"
                            onClick={() => openCoordinateDialog('edit-waypoint', idx)}
                            title="Edit coordinates"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="btn-remove"
                            onClick={() => {
                              const nextWp = waypoints.filter((_, i) => i !== idx);
                              setWaypoints(nextWp);
                              void runPlan(start, goal, nextWp);
                            }}
                            title="Remove waypoint"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="tiny-action"
                    style={{ alignSelf: 'flex-start', marginTop: 4 }}
                    onClick={() => { setWaypoints([]); void runPlan(start, goal, []); }}
                  >
                    CLEAR ALL WAYPOINTS
                  </button>
                </div>
              )}
            </div>

            <div className="field-label">
              <span>02 / DESTINATION</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="tiny-action"
                  onClick={() => openCoordinateDialog('goal')}
                  title="Enter grid or latitude/longitude coordinates"
                >
                  ENTER COORD
                </button>
                <button
                  type="button"
                  className={`tiny-action ${pickMode === 'goal' ? 'active' : ''}`}
                  onClick={() => setPickMode(pickMode === 'goal' ? null : 'goal')}
                >
                  PICK ON MAP
                </button>
              </div>
            </div>
            <div
              className="coord-card coord-card-interactive"
              onClick={() => openCoordinateDialog('goal')}
              title="Click to edit destination coordinates (Grid or Lat/Lon)"
            >
              <span className="point-symbol goal-symbol">B</span>
              <div>
                <b>{pointText(goal)}</b>
                <small>{gridToGeo(goal, terrain, selectedMissionSite).formattedLat} · {gridToGeo(goal, terrain, selectedMissionSite).formattedLon}</small>
              </div>
            </div>
            {(goalBlocked || goalSteep) && (
              <div className="start-goal-alert">
                <span>⚠ Destination is on {goalBlocked ? 'an untraversable/obstacle cell' : `steep terrain (${goalSlope?.toFixed(1)}° > ${maxSlope}°)`}.</span>
                <button onClick={() => nudgeToTraversable('goal')}>Nudge to nearest traversable cell</button>
              </div>
            )}

            {pickMode && <div className="pick-hint">Click a location on the terrain to set the {pickMode === 'start' ? 'start point' : pickMode === 'goal' ? 'destination' : 'waypoint target'}.</div>}
          </div>

          <div className="field-stack mission-params">
            <div className="section-kicker">OPERATIONAL CONSTRAINTS</div>
            <div className="slider-row"><div><label>Maximum slope</label><b>{maxSlope}°</b></div><input type="range" min="10" max="35" value={maxSlope} onChange={(e) => setMaxSlope(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>EVA time budget</label><b>{evaMinutes} min</b></div><input type="range" min="60" max="300" step="15" value={evaMinutes} onChange={(e) => setEvaMinutes(Number(e.target.value))} /></div>
            <div className="slider-row"><div><label>Energy budget</label><b>{energyBudgetWh} Wh</b></div><input type="range" min="100" max="1000" step="25" value={energyBudgetWh} onChange={(e) => setEnergyBudgetWh(Number(e.target.value))} /></div>
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
          <button className="primary-button" onClick={() => void runPlan()} disabled={planning || terrainLoading || !terrain || terrain.site_id !== selectedMissionSiteId}>
            {planning ? <><span className="spinner" /> COMPUTING ROUTES</> : <><span>⌁</span> GENERATE ROUTE OPTIONS</>}
          </button>
          <button className="ghost-button" onClick={() => { const a = INITIAL_START; const b = INITIAL_GOAL; setStart(a); setGoal(b); setWaypoints([]); void runPlan(a, b, []); }}>RESET MISSION GEOMETRY</button>

          <div className="rail-footnote"><span className="warning-icon">!</span><p>Research prototype only. Never use these paths as operational astronaut guidance.</p></div>
        </section>

        <section className="center-column min-w-0">
          <div className="view-header">
            <div><div className="eyebrow">SURFACE RECONNAISSANCE</div><h1>{selectedMissionSite.region} <span>/</span> {selectedMissionSite.feature}</h1></div>
            <div className="view-actions">
              <div className="segmented">
                <button className={viewMode === '3D' ? 'selected' : ''} onClick={() => setViewMode('3D')}>3D TERRAIN</button>
                <button className={viewMode === '2D' ? 'selected' : ''} onClick={() => setViewMode('2D')}>2D MAP</button>
              </div>
              <button
                className={`hazard-toggle ${hazardOverlay ? 'on' : ''}`}
                onClick={() => setHazardOverlay(!hazardOverlay)}
                title="Overlay slope hazard: Red = Exceeds Slope Limit, Amber = Near Limit, Dark = Blocked/NoData"
              >
                ⚠ HAZARD OVERLAY {hazardOverlay ? `(> ${maxSlope}°)` : ''}
              </button>
              <button className={`eva-toggle ${evaMode ? 'on' : ''}`} onClick={() => setEvaMode(!evaMode)}>
                <span className="eva-dot" /> EVA MODE
              </button>
              <button className="hud-launch-button" data-tour-active={tourStep === 6 || undefined} onClick={() => setHudOpen(true)} disabled={!terrain}>
                ⌖ OPEN ASTRONAUT HUD
              </button>
            </div>
          </div>

          <div className="terrain-frame" data-tour-active={tourStep === 2 || undefined}>
            {terrain && terrain.site_id === selectedMissionSiteId && (
              <TerrainScene
                key={terrain.id}
                terrain={terrain}
                routes={routes}
                selectedRoute={selectedRoute}
                start={start}
                goal={goal}
                obstacles={addedObstacles}
                layer={layer}
                viewMode={viewMode}
                pickMode={pickMode}
                evaPosition={evaMode ? evaPosition : null}
                returnPath={evaMode ? returnPath : EMPTY_PATH}
                onPick={handlePick}
                onInspect={handleInspect}
                selectedCell={inspectedCell}
                hazardOverlay={hazardOverlay}
                maxSlopeDeg={maxSlope}
                waypoints={waypoints}
                previewRoute={previewRoute}
                deviationPoint={deviationPoint}
                scientificTargets={scienceTargets}
                selectedScientificTargetIds={selectedScienceTargetIds}
              />
            )}
            {terrain && <div className="inspector-map-hint"><span className="inspector-crosshair">⌖</span> CLICK TERRAIN TO INSPECT</div>}
            {terrainLoading && <div className="terrain-loading-state"><span className="spinner" /> LOADING {selectedMissionSite.region.toUpperCase()} TERRAIN</div>}
            {!terrain && !terrainLoading && <div className="terrain-loading-state terrain-error-state"><b>TERRAIN UNAVAILABLE</b><span>{error || `Could not load a terrain grid for ${selectedMissionSite.region}.`}</span></div>}
            <div className="scene-top-left"><span className="scene-tag"><i /> TERRAIN MODEL</span><span className="scene-tag muted">{terrain ? (isVerifiedRealTerrain(terrain, selectedMissionSiteId) ? 'VERIFIED / GEOREFERENCED DEM' : 'ILLUSTRATIVE GRID / NOT VERIFIED') : 'AWAITING TERRAIN DATA'}</span></div>
            <div className="scene-top-right"><span className="compass">N</span><span className="compass-line" /></div>
            <div className="scene-bottom-left"><span>GRID CELL <b>{terrain?.cell_size_m?.toFixed(1) ?? '8.0'} m</b></span><span className="scene-vertical-note">VERTICAL EXAGGERATION <b>5×</b></span></div>
            <div className="scene-bottom-right"><span className="view-caption">{viewMode === '3D' ? 'OBLIQUE VIEW' : 'PLAN VIEW'}</span><span className="zoom-hint">DRAG TO ORBIT · SCROLL TO ZOOM</span></div>
            {pickMode && <div className="map-pick-overlay">SELECT {pickMode === 'start' ? 'START POINT' : pickMode === 'goal' ? 'DESTINATION' : 'WAYPOINT TARGET'} ON THE TERRAIN</div>}
          </div>

          {hazardOverlay && (
            <div className="hazard-banner-active">
              <span>⚠ HAZARD OVERLAY ACTIVE: RED = SLOPE &gt; {maxSlope}°, AMBER = SLOPE &ge; {(maxSlope * 0.8).toFixed(1)}°, DARK = OBSTACLE / NODATA</span>
              <button className="tiny-action" onClick={() => setHazardOverlay(false)}>DISMISS</button>
            </div>
          )}

          {/* Layer strip with full explanations for unavailable layers */}
          <div className="layer-strip">
            <div className="layer-title"><span className="eyebrow">MAP LAYERS</span><span className="layer-count">{layerNames.filter((entry) => { const key: Record<Layer, string> = { elevation: 'elevation', slope: 'slope', roughness: 'roughness', regolith: 'regolith', temperature: 'temperature', environment: 'atmosphere', radiation: 'radiation', uncertainty: 'uncertainty', science: 'science' }; return (terrain?.available_layers ?? []).includes(key[entry.id]); }).length} / {layerNames.length} AVAILABLE</span></div>
            <div className="layer-buttons">
              {layerNames.map((entry) => {
                const key: Record<Layer, string> = {
                  elevation: 'elevation', slope: 'slope', roughness: 'roughness',
                  regolith: 'regolith', temperature: 'temperature', environment: 'atmosphere',
                  radiation: 'radiation', uncertainty: 'uncertainty', science: 'science',
                };
                const isAvailable = (terrain?.available_layers ?? []).includes(key[entry.id]);
                const tooltipText = isAvailable
                  ? `${entry.name} (${entry.unit})`
                  : `${entry.name} is unavailable. No continuous georeferenced raster is published for this site. Import via DATA panel.`;

                return (
                  <button
                    key={entry.id}
                    className={!isAvailable ? 'layer-button disabled' : layer === entry.id ? 'layer-button active' : 'layer-button'}
                    onClick={() => isAvailable && setLayer(entry.id)}
                    disabled={!isAvailable}
                    title={tooltipText}
                  >
                    <span className={`layer-swatch swatch-${entry.id}`} />
                    {entry.name} {!isAvailable ? '(NO DATA)' : ''}
                  </button>
                );
              })}
            </div>
            <div className="layer-metadata">
              <span>SOURCE <b>{terrain && isVerifiedRealTerrain(terrain, selectedMissionSiteId) ? 'Verified NASA / user DEM' : 'Not verified as measured terrain'}</b></span>
              <span>GRID SPACING <b>{terrain?.cell_size_m?.toFixed(1) ?? 8} m</b></span>
              <span>AVAILABLE LAYERS <b>{(terrain?.available_layers ?? []).join(', ') || 'Unspecified'}</b></span>
            </div>
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
                {/* Visual Gauges */}
                <div className="eva-stat">
                  <div className="eva-gauge-container">
                    <div className="eva-gauge-header"><span>EVA TIME CONSUMPTION</span><b>{elapsedOutboundMin.toFixed(1)} / {evaMinutes} min</b></div>
                    <div className="eva-gauge-track">
                      <div className="eva-reserve-line" title="25% Reserve Threshold" />
                      <div className={`eva-gauge-fill ${progressFraction > 0.85 ? 'red' : progressFraction > 0.65 ? 'amber' : 'green'}`} style={{ width: `${Math.min(100, (elapsedOutboundMin / Math.max(1, evaMinutes)) * 100)}%` }} />
                    </div>
                    <small>{remainingEVAClockMin.toFixed(1)} min modeled clock before reserve</small>
                  </div>
                </div>

                <div className="eva-stat">
                  <div className="eva-gauge-container">
                    <div className="eva-gauge-header"><span>ENERGY CONSUMPTION</span><b>{elapsedEnergyWh.toFixed(1)} / {energyBudgetWh} Wh</b></div>
                    <div className="eva-gauge-track">
                      <div className="eva-reserve-line" title="25% Reserve Threshold" />
                      <div className={`eva-gauge-fill ${elapsedEnergyWh / energyBudgetWh > 0.85 ? 'red' : elapsedEnergyWh / energyBudgetWh > 0.65 ? 'amber' : 'green'}`} style={{ width: `${Math.min(100, (elapsedEnergyWh / Math.max(1, energyBudgetWh)) * 100)}%` }} />
                    </div>
                    <small>{Math.max(0, energyBudgetWh - elapsedEnergyWh).toFixed(1)} Wh remaining</small>
                  </div>
                </div>

                <div className="eva-stat">
                  <div className="eva-gauge-container">
                    <div className="eva-gauge-header"><span>OXYGEN RESERVES</span><b>{elapsedOxygenL.toFixed(1)} / {oxygenBudget} L</b></div>
                    <div className="eva-gauge-track">
                      <div className="eva-reserve-line" title="25% Reserve Threshold" />
                      <div className={`eva-gauge-fill ${elapsedOxygenL / oxygenBudget > 0.85 ? 'red' : elapsedOxygenL / oxygenBudget > 0.65 ? 'amber' : 'green'}`} style={{ width: `${Math.min(100, (elapsedOxygenL / Math.max(1, oxygenBudget)) * 100)}%` }} />
                    </div>
                    <small>{Math.max(0, oxygenBudget - elapsedOxygenL).toFixed(1)} L remaining</small>
                  </div>
                </div>

                <div className="eva-stat"><span>RETURN TRACE TO BASE</span><strong>{returnDistanceM.toFixed(1)} m</strong><small>{pointText(evaPosition)} → {pointText(start)} · dashed on map</small></div>
                <div className="eva-stat"><span>CURRENT POSITION</span><strong>{pointText(evaPosition)}</strong><small>{'Imported DEM grid coordinate'}</small></div>
                <div className="eva-stat"><span>NEXT ROUTE WAYPOINT</span><strong>{nextWaypoint ? pointText(nextWaypoint) : 'DESTINATION REACHED'}</strong><small>{nextWaypoint ? `${(Math.hypot(nextWaypoint.x - evaPosition.x, nextWaypoint.y - evaPosition.y) * cellSizeM).toFixed(1)} m · ${gridHeading(evaPosition, nextWaypoint)}` : 'No forward waypoint remains'}</small></div>
                <div className="eva-stat"><span>REMAINING OUTBOUND</span><strong>{remainingDistanceM.toFixed(1)} m</strong><small>{remainingOutboundMin.toFixed(1)} min model estimate</small></div>
                <div className="eva-stat"><span>TIME TO DESTINATION + RETURN</span><strong>{remainingPlanMin.toFixed(1)} min</strong><small>Remaining outbound + full return leg estimate</small></div>
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
              <div className="section-heading">
                <div>
                  <span className="eyebrow">PATHFINDING ENGINE</span>
                  <h2>Route alternatives <span className="count-pill">{routes.length}</span></h2>
                  {plan?.planning_runtime_ms !== undefined && <small>Planner compute: {plan.planning_runtime_ms.toFixed(1)} ms</small>}
                </div>
                <div className="route-actions">
                  <button className={`text-action ${showComparison ? 'active' : ''}`} onClick={() => setShowComparison(!showComparison)}>
                    {showComparison ? 'HIDE COMPARISON' : 'COMPARE PROFILES'}
                  </button>
                  <button className={`text-action ${showSensitivity ? 'active' : ''}`} onClick={() => setShowSensitivity(!showSensitivity)}>
                    {showSensitivity ? 'CLOSE SENSITIVITY' : 'SENSITIVITY ANALYSIS'}
                  </button>
                  <button className="text-action" onClick={() => void injectObstacle()} disabled={!plan || replanning || planning} title="Inject an obstacle on the route and trigger LPA* incremental replan">
                    {replanning ? 'REPLANNING…' : '+ SIMULATE OBSTACLE'}
                  </button>
                  <button
                    className="text-action"
                    onClick={() => void injectConditionUpdate()}
                    disabled={!plan || !hasAtmosphere || replanning || planning}
                    title={!hasAtmosphere ? 'Atmospheric layer unavailable for this site. Import georeferenced raster via DATA panel.' : 'Simulate an environmental condition update and trigger LPA* repair'}
                  >
                    ~ SIMULATE CONDITION {!hasAtmosphere ? '(NO DATA)' : ''}
                  </button>
                  <button className="text-action" onClick={() => void runBenchmark()} disabled={!terrain || benchmarking || planning}>
                    {benchmarking ? 'COMPARING…' : 'COMPARE BASELINES'}
                  </button>
                </div>
              </div>

              {conditionNotice && (
                <div className="repair-banner">
                  <span className="repair-icon">✓</span>
                  <div><b>ADAPTIVE REPLANNING</b><small>{conditionNotice}</small></div>
                  <button onClick={() => setConditionNotice('')}>×</button>
                </div>
              )}
              {replanResult && (
                <div className="repair-banner">
                  <span className="repair-icon">⚠</span>
                  <div><b>OBSTACLE INJECTED & REPAIRED</b><small>{replanResult.notice} Repaired {replanResult.expanded_during_repair} nodes via LPA*.</small></div>
                  <button onClick={() => setReplanResult(null)}>×</button>
                </div>
              )}

              {/* Sensitivity Analysis Drawer / Modal */}
              {showSensitivity && (
                <SensitivityAnalysis
                  siteId={selectedMissionSiteId}
                  start={start}
                  goal={goal}
                  currentMaxSlope={maxSlope}
                  constraints={{
                    max_slope_deg: maxSlope,
                    eva_limit_minutes: evaMinutes,
                    energy_budget_wh: energyBudgetWh,
                    oxygen_budget_l: oxygenBudget,
                    oxygen_consumption_lpm: oxygenRate,
                  }}
                  onPreviewPath={(path, label) => setPreviewRoute({ path, label })}
                  onClose={() => { setShowSensitivity(false); setPreviewRoute(null); }}
                />
              )}

              {/* Multi-Route Comparison Table */}
              {showComparison && (
                <RouteComparisonTable
                  routes={routes}
                  selectedRouteId={selectedRoute}
                  onSelectRoute={handleRouteSelect}
                />
              )}

              <div className="route-cards">
                {routes.map((route) => <button key={route.id} className={`route-card ${selectedRoute === route.id ? 'selected' : ''}`} onClick={() => handleRouteSelect(route.id)}>
                  <div className="route-card-top"><span className={`route-letter route-${route.id}`}>{route.id}</span><span className="route-status">{route.is_pareto ? 'PARETO' : 'ALTERNATIVE'}</span></div>
                  <strong>{route.name}</strong><p>{route.summary}</p>
                  {route.tradeoff_summary && <small className="route-tradeoff">{route.tradeoff_summary}</small>}
                  {route.diversity && <small className="route-diversity">{route.diversity.label} · {route.diversity.unique_corridor_pct.toFixed(0)}% unique corridor</small>}
                  <div className="route-metrics-mini"><span><b>{route.metrics.distance_m.toFixed(0)}</b> m</span><span><b>{route.metrics.duration_min.toFixed(1)}</b> min</span><span><b>{route.metrics.terrain_risk_pct?.toFixed(0) ?? 'N/A'}</b> risk</span></div>
                </button>)}
              </div>

              {/* Elevation & Slope Profile Chart */}
              {terrain && selected && (
                <RouteProfileChart
                  terrain={terrain}
                  route={selected}
                  maxSlopeDeg={maxSlope}
                />
              )}

              {/* Route Decision Explainability Panel */}
              {terrain && selected && (
                <RouteExplainability
                  terrain={terrain}
                  route={selected}
                  start={start}
                  goal={goal}
                  maxSlopeDeg={maxSlope}
                  onSelectDeviation={setDeviationPoint}
                />
              )}

              {terrain && selected && (
                <RouteRobustnessPanel
                  siteId={selectedMissionSiteId}
                  terrain={terrain}
                  start={start}
                  goal={goal}
                  maxSlope={maxSlope}
                  constraints={robustnessConstraints}
                  selectedRoute={selected}
                />
              )}

              {plan && (
                <MissionReplay
                  events={missionEvents}
                  terrainWidth={terrain?.width ?? 64}
                  terrainHeight={terrain?.height ?? 64}
                  siteName={selectedMissionSite.region}
                  terrain={terrain}
                  missionSite={selectedMissionSite}
                  selectedRouteId={selectedRoute}
                  selectedRoute={selected ?? null}
                  onExportReplay={() => void downloadReport('json')}
                  exporting={reportLoading}
                  scienceTargets={selectedScienceTargets}
                  cellSizeM={terrain?.cell_size_m ?? 1}
                  onExportSummary={() => void downloadReport('markdown')}
                />
              )}

              {benchmarkResults.length > 0 && <div className="benchmark-strip">
                <div className="benchmark-head"><b>BASELINE COMPARISON</b><small>Same imported DEM · balanced scalar cost for A* and Dijkstra</small></div>
                {benchmarkResults.map((result) => <div className="benchmark-row" key={result.algorithm}><span>{result.algorithm.replace('_', ' ').toUpperCase()}</span><b>{result.distance_m.toFixed(0)} m</b><b>{result.runtime_ms.toFixed(2)} ms</b><small>{result.expanded_nodes.toLocaleString()} expanded</small></div>)}
                <small className="benchmark-warning">Runtime comparison on the imported DEM; not field-navigation validation.</small>
              </div>}
              {error && <div className="error-banner"><span>!</span>{error}</div>}
            </div>
          )}
        </section>

        <aside className="right-rail min-w-0">
          <div className="right-tabs" aria-label="Workspace tools">
            <button className={activeTab === 'planner' ? 'active' : ''} onClick={() => setActiveTab('planner')}>ROUTE SUMMARY</button>
            <button className={activeTab === 'inspect' ? 'active' : ''} onClick={() => setActiveTab('inspect')} title="Inspect a selected terrain cell">CELL DETAILS</button>
            <button className={activeTab === 'science' ? 'active' : ''} data-tour-active={tourStep === 5 || undefined} onClick={() => setActiveTab('science')}>SCIENCE TARGETS</button>
            <button className={activeTab === 'jev' ? 'active' : ''} data-tour-active={tourStep === 4 || undefined} onClick={() => setActiveTab('jev')}>JEV ADVISOR</button>
            <button className={`data-launch ${dataMenuOpen ? 'active' : ''}`} onClick={() => setDataMenuOpen(true)} aria-haspopup="dialog" aria-expanded={dataMenuOpen}>DATA SOURCES <span className="data-launch-glyph">↗</span></button>
          </div>
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
            <div className="resource-block">
              <div className="resource-heading">
                <span className="eyebrow">RESOURCE MODEL</span>
                <span className={`feasibility ${selected.metrics.return_feasible ? 'pass' : 'fail'}`}>
                  {selected.metrics.return_feasible ? 'RETURN FEASIBLE' : 'LIMIT EXCEEDED'}
                </span>
              </div>
              <div className="resource-row"><span>Estimated energy</span><b>{selected.metrics.energy_wh.toFixed(1)} Wh</b></div>
              <div className="resource-row"><span>Out-and-back time</span><b>{selected.metrics.return_time_estimate_min.toFixed(1)} min</b></div>
              <div className="resource-row"><span>Out-and-back energy</span><b>{selected.metrics.return_energy_estimate_wh.toFixed(1)} Wh</b></div>
              <div className="resource-row"><span>Outbound oxygen estimate</span><b>{selected.metrics.oxygen_l?.toFixed(1) ?? 'N/A'} L</b></div>
              <div className="resource-row"><span>Out-and-back oxygen estimate</span><b>{selected.metrics.return_oxygen_l?.toFixed(1) ?? 'N/A'} L</b></div>
            </div>
            <div className="algorithm-card">
              <div className="algorithm-head"><span className="algorithm-icon">ƒ</span><div><b>HYBRID MULTI-OBJECTIVE A*</b><small>Bounded Pareto label search</small></div></div>
              <div className="algorithm-stats"><div><b>{selected.search?.expanded_nodes?.toLocaleString() ?? 'N/A'}</b><small>Expanded</small></div><div><b>{selected.search?.generated_labels?.toLocaleString() ?? 'N/A'}</b><small>Labels</small></div><div><b>{selected.search?.pareto_labels_at_goal ?? 'N/A'}</b><small>Goal labels</small></div></div>
              {selected.search?.runtime_ms !== undefined && <small className="algorithm-runtime">Profile: {selected.search.runtime_ms.toFixed(1)} ms · edge-cache hits: {(selected.search.edge_cache_hits ?? 0).toLocaleString()}</small>}
            </div>

            {/* Downloadable Route Report */}
            {plan && (
              <div className="report-download-box">
                <span className="eyebrow">OFFICIAL FLIGHT LOG</span>
                <h4>Download Mission Report</h4>
                <p>Exports complete mission parameters, DEM CRS & provenance, constraints, and route metrics.</p>
                <div className="report-btn-group">
                  <button className="report-btn" onClick={() => void downloadReport('markdown')} disabled={reportLoading}>
                    {reportLoading ? 'GENERATING…' : 'MARKDOWN (.MD)'}
                  </button>
                  <button className="report-btn" onClick={() => void downloadReport('json')} disabled={reportLoading}>
                    {reportLoading ? 'GENERATING…' : 'JSON (.JSON)'}
                  </button>
                </div>
              </div>
            )}

            <p className="metric-foot">{selected.metrics.model_note}</p>
          </div>}

          {activeTab === 'inspect' && (
            inspectedCell && terrain ? (
              <ScientificTerrainInspector
                terrain={terrain}
                point={inspectedCell}
                siteName={selectedMissionSite.region}
                missionName={selectedMissionSite.mission}
                maxSlopeDeg={maxSlope}
                onDismiss={() => setActiveTab('planner')}
                onClear={() => { setInspectedCell(null); setActiveTab('planner'); }}
                onSetStart={(point) => {
                  setStart(point);
                  setActiveTab('planner');
                  void runPlan(point, goal, waypoints);
                }}
                onSetDestination={(point) => {
                  setGoal(point);
                  setActiveTab('planner');
                  void runPlan(start, point, waypoints);
                }}
                onAddWaypoint={(point) => {
                  if (waypoints.length < 5) {
                    const nextWp = [...waypoints, point];
                    setWaypoints(nextWp);
                    setActiveTab('planner');
                    void runPlan(start, goal, nextWp);
                  }
                }}
              />
            ) : (
              <div className="inspector-empty"><span className="eyebrow">CELL INSPECTION / IDLE</span><strong>No terrain cell selected</strong><p>Click any visible point on the 2D or 3D terrain surface to load its scientific readout.</p></div>
            )
          )}

          {activeTab === 'science' && (
            <ScientificTargetsPanel
              terrain={terrain}
              customTargets={customScienceTargets}
              selectedIds={selectedScienceTargetIds}
              scores={scienceTargetScores}
              start={start}
              onTargetsChange={setCustomScienceTargets}
              onSelectedChange={(ids) => {
                const boundedIds = ids.slice(0, 5);
                setSelectedScienceTargetIds(boundedIds);
                const selectedTargets = scienceTargets.filter((target) => boundedIds.includes(target.id));
                const seen = new Set<string>();
                const nextWaypoints = selectedTargets
                  .map((target) => ({ x: Math.round(target.x), y: Math.round(target.y) }))
                  .filter((point) => {
                    const key = `${point.x},${point.y}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  })
                  .slice(0, 5);
                setWaypoints(nextWaypoints);
                void runPlan(start, goal, nextWaypoints);
              }}
              onScoresChange={setScienceTargetScores}
              onSetDestination={(point) => {
                setGoal(point);
                setWaypoints([]);
                setPickMode(null);
                setActiveTab('planner');
                void runPlan(start, point, []);
              }}
            />
          )}

          {activeTab === 'jev' && (
            <DecisionCenter
              siteName={`${selectedMissionSite.region} · ${selectedMissionSite.mission}`}
              siteId={selectedMissionSiteId}
              hasTerrain={Boolean(terrain && isVerifiedRealTerrain(terrain, selectedMissionSiteId))}
              availableLayers={terrain?.available_layers ?? []}
              provider={jevProvider}
              apiKey={jevApiKey}
              missionPrompt={jevMissionPrompt}
              decision={activeJevDecision?.result ?? null}
              applied={Boolean(activeJevDecision && activeJevDecision.siteId === selectedMissionSiteId && activeJevDecision.result.missionPrompt === jevMissionPrompt)}
              loading={jevLoading}
              error={jevError}
              notice={jevNotice}
              onProviderChange={(value) => { setJevProvider(value); clearJevDecision(); }}
              onApiKeyChange={setJevApiKey}
              onMissionPromptChange={(value) => { setJevMissionPrompt(value); if (activeJevDecision) clearJevDecision(); }}
              onGenerate={() => void generateJevWeights()}
              onForgetKey={() => { setJevApiKey(''); setJevNotice('Provider key cleared from page memory. Any previously generated vector remains a non-secret planner preference.'); }}
            />
          )}

        </aside>
      </main>
      {dataMenuOpen && (
        <div className="data-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDataMenuOpen(false); }}>
          <section id="data-catalogue-dialog" className="data-modal-panel" role="dialog" aria-modal="true" aria-labelledby="data-modal-title" aria-describedby="data-modal-description" tabIndex={-1} data-tour-active={tourStep === 1 || undefined}>
            <header className="data-modal-header">
              <div><span className="eyebrow">MISSION DATA SYSTEMS / 03</span><h2 id="data-modal-title">Data catalogue & provenance</h2><p id="data-modal-description">Source discovery, terrain ingestion, layer lineage and offline map packages.</p></div>
              <button ref={dataModalCloseRef} className="data-modal-close" onClick={() => setDataMenuOpen(false)} aria-label="Close data catalogue">×</button>
            </header>
            <div className="data-modal-meta"><span><i /> LIVE DATA INTERFACE</span><span>{datasets.length} CATALOGUED SOURCES</span><span>{terrain ? 'TERRAIN LOADED' : 'AWAITING TERRAIN'}</span></div>
            <div className="data-modal-body">
              <DataProvenancePanel missionSite={selectedMissionSite} terrain={terrain} sources={datasets} />
              <DataExplorer
                missionSite={selectedMissionSite}
                terrainLoaded={Boolean(terrain && isVerifiedRealTerrain(terrain, selectedMissionSiteId))}
                terrain={terrain}
                sources={datasets}
                planId={plan?.plan_id}
                onTerrainImported={(nextTerrain) => {
                  if (!isVerifiedRealTerrain(nextTerrain, selectedMissionSiteId)) {
                    setError('Import rejected: the backend did not verify a real Mars DEM covering this selected site.');
                    return;
                  }
                  setTerrain(nextTerrain);
                  setInspectedCell(null);
                  setActiveTab('planner');
                  setActiveJevDecision(null);
                  setPlan(null);
                  setRoutes([]);
                  setWaypoints([]);
                  setBenchmarkResults([]);
                  setError('');
                  setConditionNotice('');
                  setLayer('elevation');
                  const nextStart = INITIAL_START;
                  const nextGoal = INITIAL_GOAL;
                  setStart(nextStart);
                  setGoal(nextGoal);
                }}
              />
            </div>
          </section>
        </div>
      )}

      {hudOpen && (
        <AstronautHud
          mode={hudMode}
          onModeChange={setHudMode}
          onClose={() => { setEvaRunning(false); setHudOpen(false); }}
          onStart={() => {
            if (selectedPath.length < 2) return;
            setEvaMode(true);
            setEvaProgressIndex((value) => value >= selectedPath.length - 1 ? 0 : value);
            setEvaRunning(true);
          }}
          onPause={() => setEvaRunning(false)}
          onResume={() => {
            if (selectedPath.length > 1 && evaIndex < selectedPath.length - 1) {
              setEvaMode(true);
              setEvaRunning(true);
            }
          }}
          onAdvance={() => {
            if (selectedPath.length > 1) {
              setEvaMode(true);
              setEvaRunning(false);
              setEvaProgressIndex((value) => Math.min(value + 1, selectedPath.length - 1));
            }
          }}
          onReset={() => { setEvaRunning(false); setEvaMode(true); setEvaProgressIndex(0); }}
          isRunning={evaRunning}
          canRun={Boolean(terrain && isVerifiedRealTerrain(terrain, selectedMissionSiteId) && selectedPath.length > 1)}
          canAdvance={selectedPath.length > 1 && evaIndex < selectedPath.length - 1}
          tourActive={tourStep === 6}
          siteName={selectedMissionSite.region}
          terrain={terrain}
          route={selected ?? null}
          start={start}
          goal={goal}
          currentPosition={evaPosition}
          progressIndex={evaIndex}
          targets={scienceTargets}
          selectedTargetIds={selectedScienceTargetIds}
          maxSlope={maxSlope}
          oxygenRemainingL={selected ? Math.max(0, oxygenBudget - elapsedOxygenL) : Number.NaN}
          energyRemainingWh={selected ? Math.max(0, energyBudgetWh - elapsedEnergyWh) : Number.NaN}
          evaMinutesRemaining={selected ? remainingEVAClockMin : Number.NaN}
          warnings={terrainWarnings}
        />
      )}
      <CoordinateInputDialog
        isOpen={coordDialogOpen}
        targetType={coordDialogTarget}
        waypointIndex={coordDialogWpIdx}
        initialPoint={coordDialogInitialPoint}
        terrain={terrain}
        missionSite={selectedMissionSite}
        maxSlopeDeg={maxSlope}
        onConfirm={handleCoordinateConfirm}
        onClose={() => setCoordDialogOpen(false)}
      />
      {tourStep !== null && <GuidedTour step={tourStep} onChange={setTourStep} onClose={() => { setTourStep(null); setHudOpen(false); setDataMenuOpen(false); setEvaRunning(false); }} />}
      <footer className="app-footer flex items-center justify-between"><span>© MARSCOPE RESEARCH PROTOTYPE</span><span>DATA STATUS: {terrain ? 'IMPORTED MARS DEM · SOURCE HASHED' : 'NO REAL DEM LOADED'}</span><span>NOT FOR OPERATIONAL USE</span></footer>
    </div>
  );
}

function MetricBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  const display = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return <div className="metric-bar-row"><div className="metric-bar-label"><span>{label}</span><b>{display !== null ? `${display.toFixed(0)}%` : 'N/A'}</b></div><div className="bar-track"><div className={`bar-fill ${color}`} style={{ width: display !== null ? `${Math.max(0, Math.min(100, display))}%` : '0%' }} /></div></div>;
}
