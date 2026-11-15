import { useEffect, useMemo, useState } from 'react';
import type { MissionEvent, Point, Route, Target, TerrainData } from '../types';
import type { MissionSite } from '../missionSites';
import { gridToGeo } from '../utils/coordinates';
import MarsEnvironmentTelemetry from './MarsEnvironmentTelemetry';

type Props = {
  events: MissionEvent[];
  terrainWidth: number;
  terrainHeight: number;
  cellSizeM: number;
  siteName: string;
  terrain: TerrainData | null;
  missionSite: MissionSite;
  selectedRouteId: string;
  selectedRoute: Route | null;
  onExportReplay: () => void;
  onExportSummary: () => void;
  exporting: boolean;
  scienceTargets?: Target[];
};

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}
function asPath(value: unknown): Point[] {
  return Array.isArray(value) ? value.filter(isPoint).map((point) => ({ x: Number(point.x), y: Number(point.y) })) : [];
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function formatMetric(value: unknown, unit: string): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)} ${unit}` : 'N/A';
}
function humanize(value: string): string { return value.replace(/_/g, ' '); }
function pathDistance(path: Point[], cellSizeM: number): number {
  let metres = 0;
  for (let index = 1; index < path.length; index += 1) {
    metres += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y) * cellSizeM;
  }
  return metres;
}

export default function MissionReplay({
  events, terrainWidth, terrainHeight, cellSizeM, siteName, terrain, missionSite, selectedRouteId, selectedRoute, onExportReplay, onExportSummary, exporting, scienceTargets = [],
}: Props) {
  const [eventIndex, setEventIndex] = useState(Math.max(0, events.length - 1));
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setEventIndex(Math.max(0, events.length - 1));
    setFrame(0);
    setPlaying(false);
  }, [events.length]);

  const currentEvent = events[eventIndex] ?? events[0] ?? null;
  const planEvent = events.find((event) => event.type === 'PLAN_CREATED');
  const storedRoutes = Array.isArray(planEvent?.data.routes) ? planEvent.data.routes : [];
  const initialRoute = storedRoutes.map(asRecord).find((route) => route.id === selectedRouteId);
  const startingPath = asPath(initialRoute?.path ?? selectedRoute?.path);

  const replayPath = useMemo(() => {
    let path = startingPath;
    for (const event of events.slice(0, eventIndex + 1)) {
      if (event.type !== 'REPLAN_COMPLETED') continue;
      const routeId = typeof event.data.route_id === 'string' ? event.data.route_id : 'B';
      if (routeId !== selectedRouteId) continue;
      const nextPath = asPath(event.data.path_after);
      if (nextPath.length > 1) path = nextPath;
    }
    return path;
  }, [events, eventIndex, selectedRouteId, startingPath]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setFrame((current) => {
        if (current >= replayPath.length - 1) {
          setPlaying(false);
          return Math.max(0, replayPath.length - 1);
        }
        return current + 1;
      });
    }, 95);
    return () => window.clearInterval(timer);
  }, [playing, replayPath.length]);

  const eventData = asRecord(currentEvent?.data);
  const isReplan = currentEvent?.type === 'REPLAN_COMPLETED';
  const eventInsightTitle = currentEvent?.type === 'JEV_DECISION' ? 'Adaptive decision captured' : isReplan ? 'Route corridor updated' : currentEvent?.type === 'PLAN_CREATED' ? 'Baseline plan recorded' : 'Mission event recorded';
  const eventInsightBody = currentEvent?.type === 'JEV_DECISION'
    ? `${String(eventData.provider ?? 'Provider not recorded')} · ${String(eventData.model ?? 'Model not recorded')} · ${String(eventData.strategy ?? 'strategy not recorded').replace(/_/g, ' ')}`
    : isReplan
      ? `${String(eventData.algorithm ?? 'Incremental repair')} updated the selected route after a recorded scenario change.`
      : currentEvent?.type === 'PLAN_CREATED'
        ? 'The initial route alternatives and planning context were saved to this mission session.'
        : 'Review the event summary and recorded metadata to understand this mission step.';
  const beforePath = isReplan ? asPath(eventData.path_before) : [];
  const metricsBefore = asRecord(eventData.metrics_before);
  const metricsAfter = asRecord(eventData.metrics_after);
  const visibleProgress = replayPath.slice(0, Math.min(frame + 1, replayPath.length));
  const replayPosition = replayPath.length ? replayPath[Math.min(frame, replayPath.length - 1)] : null;
  const replayGeo = replayPosition ? gridToGeo(replayPosition, terrain, missionSite) : null;
  const replayDistanceM = pathDistance(replayPath, cellSizeM);
  const replayTravelledM = pathDistance(visibleProgress, cellSizeM);
  const replayRemainingM = pathDistance(replayPath.slice(Math.min(frame, replayPath.length)), cellSizeM);
  const replayProgress = replayPath.length > 1 ? Math.round((Math.min(frame, replayPath.length - 1) / (replayPath.length - 1)) * 100) : 0;
  const jevDecisionCount = events.filter((event) => event.type.includes('JEV')).length;
  const planCount = events.filter((event) => event.type === 'PLAN_CREATED').length;
  const routeChangeCount = events.filter((event) => event.type === 'REPLAN_COMPLETED').length;
  const routePoints = (path: Point[]) => path.map((point) => `${point.x},${terrainHeight - point.y}`).join(' ');
  const replanCount = events.filter((event) => event.type === 'REPLAN_COMPLETED').length;
  const hasJev = events.some((event) => event.type === 'JEV_DECISION');
  const status = replanCount > 0 ? 'REPLANNED' : 'PLANNED';
  const currentDate = currentEvent ? new Date(currentEvent.timestamp_utc).toLocaleString() : 'No events';

  if (events.length === 0) {
    return <section className="mission-replay-card">
      <div className="mission-replay-head"><div><span className="eyebrow">MISSION RECORD</span><h3>Mission Replay & Summary</h3></div></div>
      <div className="replay-empty">The mission event stream is not available yet. Generate a route plan to create its initial record.</div>
    </section>;
  }

  return <section className="mission-replay-card">
    <div className="mission-replay-head">
      <div>
        <span className="eyebrow">MISSION RECORD · {siteName.toUpperCase()}</span>
        <h3>Mission Replay & Summary</h3>
        <p>Scrub decisions and replanning events, then inspect before-and-after route geometry.</p>
      </div>
      <div className="replay-action-group">
        <button className="replay-export-button" onClick={onExportReplay} disabled={exporting}>
          {exporting ? 'PREPARING…' : 'EXPORT MISSION JSON'}
        </button>
        <button className="replay-markdown-button" onClick={onExportSummary} disabled={exporting}>
          {exporting ? 'PREPARING…' : 'EXPORT DEBRIEF .MD'}
        </button>
        <button className="replay-print-button" onClick={() => window.print()}>PRINT / SAVE PDF</button>
      </div>
    </div>
    <div className="mission-summary-grid">
      <div className="mission-summary-stat"><span>MISSION STATE</span><strong>{status}</strong><small>{events.length} recorded events</small></div>
      <div className="mission-summary-stat"><span>SELECTED ROUTE</span><strong>{selectedRouteId}</strong><small>{selectedRoute?.name ?? 'No route selected'}</small></div>
      <div className="mission-summary-stat"><span>FINAL DISTANCE</span><strong>{formatMetric(selectedRoute?.metrics.distance_m, 'm')}</strong><small>Current selected-route estimate</small></div>
      <div className="mission-summary-stat"><span>DECISION / REPLAN LOG</span><strong>{hasJev ? 'JEV + ' : ''}{replanCount} REPLANS</strong><small>{hasJev ? 'Adaptive decision captured' : 'Static route priorities'}</small></div>
    </div>
    <div className="replay-progress-overview">
      <div className="replay-progress-heading"><div><span className="eyebrow">ROUTE RECONSTRUCTION</span><strong>Playback progress</strong></div><b>{replayProgress}%</b></div>
      <div className="replay-progress-track"><i style={{ width: `${replayProgress}%` }}/></div>
      <div className="replay-progress-stats">
        <div><span>PLAYED DISTANCE</span><strong>{replayTravelledM.toFixed(0)} m</strong></div>
        <div><span>REMAINING IN REPLAY</span><strong>{replayRemainingM.toFixed(0)} m</strong></div>
        <div><span>RECONSTRUCTED PATH</span><strong>{replayDistanceM.toFixed(0)} m</strong></div>
        <div><span>EVENT TRACE</span><strong>{planCount} plans · {jevDecisionCount} JEV · {routeChangeCount} replans</strong></div>
      </div>
    </div>
    <div className="mission-debrief-metrics">
      <div><span>PLANNED DURATION</span><strong>{formatMetric(selectedRoute?.metrics.duration_min, 'min')}</strong></div>
      <div><span>MODELLED ENERGY</span><strong>{formatMetric(selectedRoute?.metrics.energy_wh, 'Wh')}</strong></div>
      <div><span>TERRAIN RISK INDEX</span><strong>{formatMetric(selectedRoute?.metrics.terrain_risk_pct, '%')}</strong></div>
      <div><span>UNCERTAINTY INDEX</span><strong>{formatMetric(selectedRoute?.metrics.uncertainty_pct, '%')}</strong></div>
      <div><span>RETURN CONSTRAINT</span><strong>{selectedRoute ? (selectedRoute.metrics.return_feasible ? 'FEASIBLE' : 'LIMIT EXCEEDED') : 'N/A'}</strong></div>
      <div><span>SCIENCE VALUE INDEX</span><strong>{formatMetric(selectedRoute?.metrics.scientific_value_pct, '%')}</strong></div>
    </div>
    <div className="mission-objective-summary">
      <div><span className="eyebrow">MISSION OBJECTIVES</span><strong>{scienceTargets.length ? `${scienceTargets.length} selected science target(s)` : 'No scientific target selected'}</strong></div>
      <div className="mission-objective-chips">{scienceTargets.map((target) => <span key={target.id}>{target.name} <small>({target.evidence_status.replace(/_/g, ' ')})</small></span>)}</div>
    </div>
    <div className="mission-replay-body">
      <div className="replay-visual">
        <div className="replay-visual-title"><span>ROUTE RECONSTRUCTION</span><span>{replayPath.length} GRID CELLS</span></div>
        <svg className="replay-map" viewBox={`0 0 ${terrainWidth} ${terrainHeight}`} role="img" aria-label="Animated replay of selected mission route">
          {isReplan && beforePath.length > 1 && <polyline className="replay-before" points={routePoints(beforePath)} />}
          {replayPath.length > 1 && <polyline className="replay-after" points={routePoints(replayPath)} />}
          {visibleProgress.length > 1 && <polyline className="replay-progress" points={routePoints(visibleProgress)} />}
          {replayPosition && <circle className="replay-position-marker" cx={replayPosition.x} cy={terrainHeight - replayPosition.y} r="1.7" />}
        </svg>
        <div className="replay-legend"><span><i className="before-key" /> Previous path</span><span><i /> Replanned path</span><span><i className="progress-key" /> Playback</span></div>
        <div className="replay-controls">
          <button onClick={() => { setPlaying(false); setFrame(0); }}>RESET</button>
          <button onClick={() => { setPlaying(false); setFrame((value) => Math.max(0, value - 1)); }}>STEP BACK</button>
          <button onClick={() => { if (frame >= replayPath.length - 1) setFrame(0); setPlaying((value) => !value); }}>{playing ? 'PAUSE' : 'PLAY'}</button>
          <button onClick={() => { setPlaying(false); setFrame((value) => Math.min(Math.max(0, replayPath.length - 1), value + 1)); }}>STEP FORWARD</button>
        </div>
        <input className="replay-range" type="range" min={0} max={Math.max(0, replayPath.length - 1)} value={Math.min(frame, Math.max(0, replayPath.length - 1))} onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} aria-label="Route animation progress" />
        <div className="replay-visual-title"><span>ANIMATION POSITION</span><span>{replayPath.length ? `${Math.min(frame + 1, replayPath.length)} / ${replayPath.length}` : 'N/A'}</span></div>
      </div>
      <div className="replay-side">
        <div className="replay-event-current">
          <small>EVENT {currentEvent?.sequence ?? 0} · {humanize(currentEvent?.type ?? 'MISSION_EVENT').toUpperCase()}</small>
          <strong>{currentEvent?.title ?? 'Mission event'}</strong>
          <p>{currentEvent?.summary ?? 'No event summary available.'}</p>
          <p>{currentDate}</p>
        </div>
        <div className="replay-event-insight"><small>MISSION INSIGHT</small><strong>{eventInsightTitle}</strong><p>{eventInsightBody}</p></div>
        {isReplan ? <>
          <div className="replay-delta-grid">
            <div className="replay-delta"><span>BEFORE DISTANCE</span><b>{formatMetric(metricsBefore.distance_m, 'm')}</b></div>
            <div className="replay-delta"><span>AFTER DISTANCE</span><b>{formatMetric(metricsAfter.distance_m, 'm')}</b></div>
            <div className="replay-delta"><span>BEFORE TIME</span><b>{formatMetric(metricsBefore.duration_min, 'min')}</b></div>
            <div className="replay-delta"><span>AFTER TIME</span><b>{formatMetric(metricsAfter.duration_min, 'min')}</b></div>
          </div>
          <div className="replay-event-current"><small>REPLANNING METHOD</small><strong>{String(eventData.algorithm ?? 'Incremental repair')}</strong><p>Scenario: {JSON.stringify(eventData.obstacle ?? eventData.change ?? 'Recorded terrain update')}</p></div>
        </> : <div className="replay-event-current"><small>BEFORE / AFTER</small><strong>No route geometry change in this event</strong><p>Planning decisions appear in the timeline; geometry changes appear as replanning events.</p></div>}
      </div>
    </div>
    <MarsEnvironmentTelemetry missionSiteName={siteName} missionSite={missionSite} terrain={terrain} position={replayPosition} progress={replayProgress} eventSequence={currentEvent?.sequence ?? 0} />
    <input className="replay-range" type="range" min={0} max={Math.max(0, events.length - 1)} value={eventIndex} onChange={(event) => { setPlaying(false); setEventIndex(Number(event.target.value)); setFrame(0); }} aria-label="Mission event timeline" />
    <div className="replay-timeline">
      {events.map((event, index) => <button key={event.id} className={index === eventIndex ? 'active' : ''} onClick={() => { setPlaying(false); setEventIndex(index); setFrame(0); }}>
        <span>#{event.sequence} · {humanize(event.type)}</span><strong>{event.title}</strong><small>{new Date(event.timestamp_utc).toLocaleTimeString()}</small>
      </button>)}
    </div>
    <p className="replay-footnote">Events remain available only while the backend's in-memory mission session exists. A backend restart or session expiry clears this replay record. Scenario changes are user-entered what-if data, not measured Mars hazards.</p>
  </section>;
}
