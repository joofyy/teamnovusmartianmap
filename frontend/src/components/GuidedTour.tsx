import { useEffect, useRef } from "react";

type Props = {
  step: number;
  onChange: (step: number) => void;
  onClose: () => void;
};

const steps = [
  { section: "ORIENTATION / 01", title: "Welcome to MARSCOPE", copy: "A source-aware planetary research workspace. Start with the terrain, inspect the evidence behind it, then compare candidate traverses and review a simulated EVA.", note: "The workspace keeps imported measurements, derived metrics and simulated estimates distinct." },
  { section: "DATA SYSTEMS / 02", title: "Discover the data", copy: "The Data Catalogue combines source discovery, provenance, terrain ingestion and offline-package review. Inspect source metadata before importing a dataset.", note: "Only a site-matched, georeferenced DEM that passes the application validation guard is accepted as route-ready terrain." },
  { section: "TERRAIN LAB / 03", title: "Read the surface", copy: "Switch between 2D and 3D terrain views, inspect available map layers and review the mapped coverage before interpreting the surface.", note: "Unavailable layers remain unavailable. A teaching grid or cached image is not relabelled as a verified elevation model." },
  { section: "MISSION PLANNER / 04", title: "Define a traverse", copy: "Choose a mission site, set the start and destination, add intermediate waypoints and adjust the planning constraints. Generate and compare candidate route profiles.", note: "Generated paths are research outputs, not astronaut-safe or operationally validated routes." },
  { section: "SCIENCE TARGETS / 05", title: "Connect science objectives", copy: "Review targets associated with the loaded terrain, select objectives and use supported target coordinates to influence waypoint planning.", note: "A target without defensible spatial metadata is not assigned an invented map location." },
  { section: "EVA VISOR / 06", title: "Step through a simulated EVA", copy: "The Astronaut HUD presents route position, heading, nearby mapped constraints, science targets and planner-derived resource estimates. Start, pause, resume, advance or reset the route-cell simulation.", note: "This is a browser simulation. It is not connected to astronaut hardware, live localization, suit telemetry or certified navigation sensors." },
];

export default function GuidedTour({ step, onChange, onClose }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const current = steps[step];

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight" && step < steps.length - 1) {
        event.preventDefault();
        onChange(step + 1);
      } else if (event.key === "ArrowLeft" && step > 0) {
        event.preventDefault();
        onChange(step - 1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [step, onChange, onClose]);

  if (!current) return null;

  return (
    <div className="guided-tour-layer">
      <section className="guided-tour-card" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-description">
        <div className="guided-tour-head">
          <span className="guided-tour-kicker">MARSCOPE / FIELD GUIDE</span>
          <button className="guided-tour-close" type="button" onClick={onClose} aria-label="Exit guided tour">×</button>
        </div>
        <div className="guided-tour-progress" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((item, index) => <span key={item.section} className={index <= step ? "complete" : ""} />)}
        </div>
        <div className="guided-tour-section">{current.section}<span>STEP {String(step + 1).padStart(2, "0")} / 06</span></div>
        <h2 id="tour-title" ref={titleRef} tabIndex={-1}>{current.title}</h2>
        <p id="tour-description">{current.copy}</p>
        <div className="guided-tour-note"><span>FIELD NOTE</span>{current.note}</div>
        <div className="guided-tour-actions">
          <button className="guided-tour-skip" type="button" onClick={onClose}>SKIP TOUR</button>
          <div>
            <button className="guided-tour-back" type="button" onClick={() => onChange(step - 1)} disabled={step === 0}>BACK</button>
            {step === steps.length - 1
              ? <button className="guided-tour-next" type="button" onClick={onClose}>FINISH TOUR <span>✓</span></button>
              : <button className="guided-tour-next" type="button" onClick={() => onChange(step + 1)}>NEXT <span>→</span></button>}
          </div>
        </div>
        <div className="guided-tour-key-hint">KEYBOARD · ESC TO EXIT · ← / → TO NAVIGATE</div>
      </section>
    </div>
  );
}
