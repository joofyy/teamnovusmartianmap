import type { MissionSite } from '../missionSites';

type Props = {
  onEnterWorkspace: () => void;
  onStartTour: () => void;
  apiStatus: string;
  terrainAvailable: boolean;
  missionSite: MissionSite;
};

const capabilities = [
  { number: "01", title: "Planetary data", copy: "Discover, inspect and import source-aware Mars datasets with provenance carried into the workspace." },
  { number: "02", title: "Mission planning", copy: "Compare multi-objective traverses against the currently loaded, verified terrain grid." },
  { number: "03", title: "Surface operations", copy: "Explore terrain in 2D and 3D, review science targets and step through a simulated EVA." },
];

export default function MarscopeLanding({ onEnterWorkspace, onStartTour, apiStatus, terrainAvailable, missionSite }: Props) {
  return (
    <main className="marscope-landing">
      <div className="landing-atmosphere" aria-hidden="true" />
      <header className="landing-nav">
        <a className="landing-brand" href="#top" aria-label="MARSCOPE home">
          <span className="landing-mark">M</span>
          <span><b>MARSCOPE</b><small>PLANETARY EXPLORATION SYSTEMS</small></span>
        </a>
        <div className="landing-nav-meta">
          <span className="landing-status"><i className={apiStatus === "OK" ? "online" : "offline"} /> API {apiStatus}</span>
          <span className="landing-nav-divider" />
          <span className="landing-status"><i className={terrainAvailable ? "online" : "pending"} /> {terrainAvailable ? "TERRAIN READY" : "TERRAIN NOT LOADED"}</span>
          <button className="landing-tour-link" onClick={onStartTour}>TAKE THE TOUR <span>↗</span></button>
        </div>
      </header>

      <section className="landing-hero" id="top">
        <div className="landing-copy">
          <div className="landing-eyebrow"><span /> MARS SURFACE RESEARCH / MISSION SYSTEMS <span className="landing-index">FIELD INTERFACE 01—07</span></div>
          <p className="landing-overline">FROM ORBIT TO BOOTPRINT</p>
          <h1>Read the terrain.<br /><em>Plan the unknown.</em></h1>
          <p className="landing-description">
            MARSCOPE brings planetary datasets, multi-objective route analysis and simulated surface navigation into one research workspace — built to make every decision traceable to its source.
          </p>
          <div className="landing-selected-site" aria-label={`Selected study area: ${missionSite.region}, ${missionSite.mission}`}>
            <span className="landing-selected-kicker">ACTIVE STUDY AREA</span>
            <div className="landing-selected-main"><strong>{missionSite.region}</strong><span>{missionSite.mission} · {missionSite.focusLabel}</span></div>
            <div className="landing-selected-reference"><span>REFERENCE DEM</span><b>{missionSite.dem.resolutionM < 10 ? missionSite.dem.resolutionM.toFixed(2) : missionSite.dem.resolutionM.toFixed(0)} m/px · {missionSite.dem.source}</b></div>
          </div>
          <div className="landing-actions">
            <button className="landing-primary" onClick={onEnterWorkspace}>ENTER THE WORKSPACE <span>↗</span></button>
            <button className="landing-secondary" onClick={onStartTour}>EXPLORE THE SYSTEM <span>→</span></button>
          </div>
          <div className="landing-proof">
            <div><b>02D / 03D</b><span>TERRAIN EXPLORATION</span></div>
            <div><b>MOO*</b><span>ROUTE COMPARISON</span></div>
            <div><b>EVA</b><span>SIMULATED NAVIGATION</span></div>
          </div>
        </div>

        <div className="landing-visual" aria-label={`Abstract terrain rendering for ${missionSite.region}, Mars`}>
          <div className="landing-orbit orbit-one" />
          <div className="landing-orbit orbit-two" />
          <div className="landing-planet">
            <div className="landing-planet-shade" />
            <div className="landing-contours" />
            <div className="landing-surface-grid" />
            <div className="landing-site-pin"><i /><span>{missionSite.mission.toUpperCase()} / STUDY AREA</span></div>
          </div>
          <div className="landing-coordinate landing-coordinate-top"><span>MISSION REGION</span><b>{missionSite.region.toUpperCase()}</b></div>
          <div className="landing-coordinate landing-coordinate-bottom"><span>REFERENCE PRODUCT</span><b>{missionSite.dem.resolutionM < 10 ? missionSite.dem.resolutionM.toFixed(2) : missionSite.dem.resolutionM.toFixed(0)} M/PIXEL · {missionSite.dem.source.toUpperCase()}</b></div>
          <div className="landing-visual-crosshair">N <span>↑</span></div>
        </div>
        <div className="landing-hero-foot"><span>01 / 03</span><span>AN INTEGRATED WORKSPACE FOR PLANETARY RESEARCH</span><span>SCROLL TO EXPLORE ↓</span></div>
      </section>

      <section className="landing-capabilities">
        <div className="landing-section-heading">
          <div><span className="landing-kicker">THE MISSION STACK</span><h2>One surface. <em>Multiple perspectives.</em></h2></div>
          <p>From source discovery to route review, each system is designed to keep the underlying evidence visible.</p>
        </div>
        <div className="landing-capability-grid">
          {capabilities.map((item) => (
            <article className="landing-capability" key={item.number}>
              <span className="landing-capability-number">{item.number}</span>
              <div className="landing-capability-mark" aria-hidden="true">{item.number === "01" ? "⌁" : item.number === "02" ? "⌖" : "◉"}</div>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
              <span className="landing-card-rule" />
            </article>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        <span>© MARSCOPE / RESEARCH PROTOTYPE</span>
        <span>* Multi-objective optimisation · Research use only</span>
        <span>NOT FOR OPERATIONAL NAVIGATION</span>
      </footer>
    </main>
  );
}
