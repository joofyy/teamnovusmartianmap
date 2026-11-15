import { useState } from 'react';
import type { Point, TerrainData } from '../types';
import type { MissionSite } from '../missionSites';
import { gridToGeo } from '../utils/coordinates';

type Scenario = 'baseline' | 'dust' | 'solar';
type Props = {
  missionSiteName: string;
  missionSite: MissionSite;
  terrain: TerrainData | null;
  position: Point | null;
  progress: number;
  eventSequence: number;
};

const scenarios: Record<Scenario, { label: string; wind: number; opticalDepth: number; sepIndex: number; description: string }> = {
  baseline: { label: 'BASELINE', wind: 8.2, opticalDepth: 0.38, sepIndex: 12, description: 'Relatively quiet reference scenario' },
  dust: { label: 'DUST FRONT', wind: 21.6, opticalDepth: 1.32, sepIndex: 17, description: 'Elevated wind and atmospheric dust scenario' },
  solar: { label: 'SOLAR EVENT', wind: 8.8, opticalDepth: 0.34, sepIndex: 88, description: 'Elevated solar energetic particle scenario' },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export default function MarsEnvironmentTelemetry({
  missionSiteName, missionSite, terrain, position, progress, eventSequence,
}: Props) {
  const [scenario, setScenario] = useState<Scenario>('baseline');
  const base = scenarios[scenario];
  const phase = (clamp(progress, 0, 100) / 100) * Math.PI * 2 + eventSequence * 0.31;
  const wind = Math.max(0, base.wind + Math.sin(phase) * (scenario === 'dust' ? 1.6 : 0.7));
  const opticalDepth = Math.max(0.05, base.opticalDepth + Math.cos(phase * 0.7) * (scenario === 'dust' ? 0.08 : 0.035));
  const sepIndex = Math.round(clamp(base.sepIndex + Math.sin(phase * 0.45) * (scenario === 'solar' ? 4 : 2), 0, 100));
  const dustStatus = opticalDepth >= 1.2 ? 'DUST FRONT' : opticalDepth >= 0.8 ? 'ELEVATED DUST' : 'LOWER DUST LOAD';
  const hazardLevel = sepIndex >= 70 || opticalDepth >= 1.2 || wind >= 20
    ? 'SHELTER SCENARIO'
    : sepIndex >= 35 || opticalDepth >= 0.8 || wind >= 14
      ? 'EVA REVIEW'
      : 'LOW MODELLED HAZARD';
  const hazardClass = hazardLevel === 'SHELTER SCENARIO' ? 'high' : hazardLevel === 'EVA REVIEW' ? 'caution' : 'low';
  const geo = position ? gridToGeo(position, terrain, missionSite) : null;

  return (
    <section className="mars-environment-card" aria-label="Environmental and space weather telemetry simulation">
      <header className="mars-environment-head">
        <div>
          <span className="eyebrow">MISSION ENVIRONMENT / REPLAY LINK</span>
          <h3>Environmental &amp; Space Weather</h3>
          <p>Atmospheric conditions, radiation context and rover position for {missionSiteName}.</p>
        </div>
        <span className="mars-sim-chip">SIMULATED · REPLAY-SYNCED</span>
      </header>

      <div className="mars-telemetry-layout">
        <div className="mars-telemetry-main">
          <div className="mars-scenario-row" role="group" aria-label="Choose telemetry simulation scenario">
            <span>SCENARIO</span>
            {(Object.keys(scenarios) as Scenario[]).map((key) => (
              <button key={key} type="button" className={scenario === key ? 'active' : ''} aria-pressed={scenario === key} onClick={() => setScenario(key)}>
                {scenarios[key].label}
              </button>
            ))}
          </div>

          <div className="mars-telemetry-grid">
            <article className="mars-telemetry-metric">
              <div className="mars-telemetry-label"><span>ATMOSPHERIC WIND</span><b>{wind.toFixed(1)} m/s</b></div>
              <div className="mars-telemetry-meter"><i style={{ width: `${clamp(wind / 30 * 100, 0, 100)}%` }} /></div>
              <small>Scenario wind estimate · not a live REMS/MEDA feed</small>
            </article>
            <article className="mars-telemetry-metric">
              <div className="mars-telemetry-label"><span>DUST OPTICAL DEPTH · τ</span><b>{opticalDepth.toFixed(2)}</b></div>
              <div className="mars-telemetry-meter"><i style={{ width: `${clamp(opticalDepth / 1.8 * 100, 0, 100)}%` }} /></div>
              <small>{dustStatus} · MCS-informed display concept</small>
            </article>
            <article className="mars-telemetry-metric">
              <div className="mars-telemetry-label"><span>GCR SURFACE REFERENCE</span><b>~210 µGy/day</b></div>
              <div className="mars-telemetry-meter"><i style={{ width: '42%' }} /></div>
              <small>Historical Curiosity RAD reference; not a current site reading</small>
            </article>
            <article className="mars-telemetry-metric">
              <div className="mars-telemetry-label"><span>SEP ACTIVITY INDEX</span><b>{sepIndex} / 100</b></div>
              <div className="mars-telemetry-meter"><i style={{ width: `${sepIndex}%` }} /></div>
              <small>Illustrative event index · not a measured radiation dose</small>
            </article>
          </div>

          <div className={`mars-eva-advisory ${hazardClass}`}>
            <div><span>SIMULATED EVA ADVISORY</span><strong>{hazardLevel}</strong></div>
            <p>{hazardLevel === 'SHELTER SCENARIO'
              ? 'This training scenario crosses a configured dust or solar-alert threshold. The simulation flags an EVA pause and shelter-review state.'
              : hazardLevel === 'EVA REVIEW'
                ? 'The scenario is elevated. Review mission constraints and source data before continuing the replay.'
                : 'The selected demo scenario is below this widget’s alert thresholds. This is not an operational safety clearance.'}</p>
          </div>
          <p className="mars-telemetry-caveat">All wind, optical-depth and SEP values are synthetic scenario values that vary with replay progress. Thresholds are illustrative UI logic, not validated Mars weather or astronaut radiation limits.</p>
        </div>

        <aside className="mars-nav-panel">
          <span className="eyebrow">ROVER NAVIGATION / MAP-REFERENCED</span>
          <div className="mars-nav-status">POSITION {position ? 'TRACKING REPLAY' : 'NOT AVAILABLE'}</div>
          {position && geo ? (
            <>
              <div className="mars-nav-grid"><small>GRID CELL</small><strong>X {position.x.toFixed(1)} / Y {position.y.toFixed(1)}</strong></div>
              <div className="mars-nav-coordinates"><div><small>PLANETOCENTRIC LATITUDE</small><strong>{geo.formattedLat}</strong></div><div><small>EAST-POSITIVE LONGITUDE</small><strong>{geo.formattedLon}</strong></div></div>
              <div className="mars-nav-progress"><span>REPLAY POSITION</span><b>{Math.round(progress)}%</b></div>
              <div className="mars-telemetry-meter"><i style={{ width: `${clamp(progress, 0, 100)}%` }} /></div>
            </>
          ) : <p className="mars-nav-empty">Generate a route and start the replay to populate the map-referenced position.</p>}
          <div className="mars-nav-method"><b>LOCALISATION CONCEPT</b><span>Visual odometry + terrain-map matching</span><small>Inspired by NASA’s Mars Global Localization work; this panel computes coordinates from the loaded DEM grid and landing-site reference only.</small></div>
          <div className="mars-nav-caveat">No Mars GPS network or live rover navigation feed is connected. The marker follows this mission replay, not a spacecraft in real time.</div>
        </aside>
      </div>

      <footer className="mars-telemetry-sources">
        <span>REFERENCE SOURCES</span>
        <a href="https://science.nasa.gov/mission/mars-reconnaissance-orbiter/science-instruments/" target="_blank" rel="noreferrer">NASA Mars Climate Sounder (MCS)</a>
        <a href="https://science.nasa.gov/mission/msl-curiosity/science-instruments/" target="_blank" rel="noreferrer">NASA Curiosity RAD / REMS</a>
        <a href="https://www.nasa.gov/missions/mars-2020-perseverance/perseverance-rover/nasas-perseverance-now-autonomously-pinpoints-its-location-on-mars/" target="_blank" rel="noreferrer">NASA Mars Global Localization</a>
      </footer>
    </section>
  );
}
