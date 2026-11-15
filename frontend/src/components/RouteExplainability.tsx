import { useMemo } from 'react';
import type { Point, Route, TerrainData } from '../types';

interface Props {
  terrain: TerrainData;
  route: Route | null;
  start: Point;
  goal: Point;
  maxSlopeDeg: number;
  onSelectDeviation?: (point: Point | null) => void;
}

interface AvoidanceEvent {
  id: string;
  routePoint: Point;
  reason: 'slope_exceeded' | 'obstacle_avoidance' | 'contour_following' | 'roughness';
  title: string;
  description: string;
  severity: 'high' | 'medium' | 'info';
  observedValue?: string;
  limitValue?: string;
}

export default function RouteExplainability({
  terrain,
  route,
  start,
  goal,
  maxSlopeDeg,
  onSelectDeviation,
}: Props) {
  const analysis = useMemo(() => {
    if (!route || !route.path || route.path.length < 2) return null;

    const cellSize = terrain.cell_size_m || 25.0;
    const directDx = goal.x - start.x;
    const directDy = goal.y - start.y;
    const directDistCells = Math.hypot(directDx, directDy);
    const directDistM = directDistCells * cellSize;
    const actualDistM = route.metrics.distance_m;
    const tortuosity = directDistM > 0 ? actualDistM / directDistM : 1.0;

    // Sample along the direct line between start and goal
    const numDirectSamples = Math.max(2, Math.round(directDistCells * 2));
    let directMaxSlope = 0;
    let directSteepCells = 0;
    let directObstacleCells = 0;

    for (let i = 0; i <= numDirectSamples; i++) {
      const frac = i / numDirectSamples;
      const x = Math.round(start.x + frac * directDx);
      const y = Math.round(start.y + frac * directDy);
      if (x >= 0 && x < terrain.width && y >= 0 && y < terrain.height) {
        const slope = terrain.slope_deg[y]?.[x] ?? 0;
        const isObs = terrain.obstacle[y]?.[x] ?? false;
        if (slope > directMaxSlope) directMaxSlope = slope;
        if (slope > maxSlopeDeg) directSteepCells++;
        if (isObs) directObstacleCells++;
      }
    }

    // Inspect route path to find major deviations and why the planner chose them
    const events: AvoidanceEvent[] = [];
    const directNorm = directDistCells > 0 ? directDistCells : 1.0;

    // Perpendicular distance of point p from direct line segment (start -> goal)
    const perpDist = (p: Point) => {
      return (
        Math.abs(directDy * p.x - directDx * p.y + goal.x * start.y - goal.y * start.x) /
        directNorm
      );
    };

    let maxPerp = 0;
    let maxPerpPoint: Point = route.path[0];
    for (const p of route.path) {
      const d = perpDist(p);
      if (d > maxPerp) {
        maxPerp = d;
        maxPerpPoint = p;
      }
    }

    // Scan for high slopes nearby or along route that dictated the heading
    for (let i = 1; i < route.path.length - 1; i += Math.max(1, Math.floor(route.path.length / 8))) {
      const p: Point = route.path[i];
      const pSlope = terrain.slope_deg[p.y]?.[p.x] ?? 0;
      const pDistFromLine = perpDist(p);

      // Check adjacent 8-neighbors to see if steep terrain was avoided
      let neighborMaxSlope = 0;
      let blockedNeighbor = false;
      for (const [dx, dy] of [[1,0], [-1,0], [0,1], [0,-1], [1,1], [-1,-1], [1,-1], [-1,1]]) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx >= 0 && nx < terrain.width && ny >= 0 && ny < terrain.height) {
          const ns = terrain.slope_deg[ny]?.[nx] ?? 0;
          if (ns > neighborMaxSlope) neighborMaxSlope = ns;
          if (terrain.obstacle[ny]?.[nx]) blockedNeighbor = true;
        }
      }

      if (neighborMaxSlope > maxSlopeDeg + 2) {
        events.push({
          id: `steep-bypass-${i}`,
          routePoint: p,
          reason: 'slope_exceeded',
          title: `Steep Incline Bypass near (${p.x}, ${p.y})`,
          description: `Direct advancement blocked by local slope up to ${neighborMaxSlope.toFixed(1)}°, exceeding the ${maxSlopeDeg}° limit. Route skirts the slope along a gentler ${pSlope.toFixed(1)}° contour.`,
          severity: 'high',
          observedValue: `${neighborMaxSlope.toFixed(1)}°`,
          limitValue: `${maxSlopeDeg}°`,
        });
      } else if (blockedNeighbor) {
        events.push({
          id: `obstacle-bypass-${i}`,
          routePoint: p,
          reason: 'obstacle_avoidance',
          title: `NoData / Obstacle Boundary at (${p.x}, ${p.y})`,
          description: `Traversed around an untraversable DEM cell or simulated obstacle boundary.`,
          severity: 'medium',
        });
      } else if (pDistFromLine > 3.0 && events.length < 4) {
        events.push({
          id: `contour-${i}`,
          routePoint: p,
          reason: 'contour_following',
          title: `Topographic Elevation Contour at (${p.x}, ${p.y})`,
          description: `Route diverged ${((pDistFromLine * cellSize)).toFixed(0)}m from the straight line to minimize cumulative gravitational work and avoid localized steep relief.`,
          severity: 'info',
        });
      }
    }

    // Deduplicate / cap to top 3 events
    const uniqueEvents = events.slice(0, 3);

    return {
      directDistM,
      actualDistM,
      tortuosity,
      directMaxSlope,
      directSteepCells,
      directObstacleCells,
      maxPerpDistM: maxPerp * cellSize,
      maxPerpPoint,
      events: uniqueEvents,
    };
  }, [route, start, goal, terrain, maxSlopeDeg]);

  if (!analysis) {
    return (
      <div className="explainability-empty">
        <small>Compute routes to view path decision explainability.</small>
      </div>
    );
  }

  const {
    directDistM,
    actualDistM,
    tortuosity,
    directMaxSlope,
    directSteepCells,
    maxPerpDistM,
    events,
  } = analysis;

  const tortuosityRating =
    tortuosity < 1.08
      ? 'DIRECT PATH'
      : tortuosity < 1.3
      ? 'MODERATE CONTOURING'
      : 'SIGNIFICANT TOPOGRAPHIC BYPASS';

  return (
    <div className="explainability-card">
      <div className="explainability-head">
        <div>
          <span className="eyebrow">DECISION ANALYSIS</span>
          <h4>Route Explainability</h4>
        </div>
        <span className={`tortuosity-badge ${tortuosity > 1.25 ? 'alert' : ''}`}>
          {tortuosityRating} · {(tortuosity).toFixed(2)}×
        </span>
      </div>

      <div className="explainability-comparison">
        <div className="comp-col">
          <span className="comp-label">DIRECT (STRAIGHT LINE)</span>
          <div className="comp-value">{directDistM.toFixed(0)} m</div>
          <small className={directMaxSlope > maxSlopeDeg ? 'bad' : 'good'}>
            Peak slope: {directMaxSlope.toFixed(1)}°
          </small>
          {directSteepCells > 0 && (
            <small className="bad">{directSteepCells} cells exceed {maxSlopeDeg}° limit</small>
          )}
        </div>
        <div className="comp-divider">VS</div>
        <div className="comp-col">
          <span className="comp-label">OPTIMIZED PATH ({route?.id})</span>
          <div className="comp-value good">{actualDistM.toFixed(0)} m</div>
          <small className="good">
            +{((tortuosity - 1) * 100).toFixed(0)}% detour for safety
          </small>
          <small>Max departure: {maxPerpDistM.toFixed(0)} m</small>
        </div>
      </div>

      <div className="avoidance-list">
        <div className="avoidance-kicker">KEY CONSTRAINTS AVOIDED BY PLANNER</div>
        {events.length > 0 ? (
          events.map((ev) => (
            <div
              key={ev.id}
              tabIndex={0}
              role="button"
              className={`avoidance-item ${ev.severity}`}
              onClick={() => onSelectDeviation?.(ev.routePoint)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectDeviation?.(ev.routePoint);
                }
              }}
              title="Click to locate on map"
            >
              <div className="avoidance-item-top">
                <span className={`avoidance-indicator ${ev.severity}`} />
                <strong>{ev.title}</strong>
                <button
                  type="button"
                  className="tiny-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectDeviation?.(ev.routePoint);
                  }}
                >
                  LOCATE
                </button>
              </div>
              <p>{ev.description}</p>
            </div>
          ))
        ) : (
          <p className="avoidance-none">
            Route closely tracks the Euclidean vector without encountering slopes exceeding {maxSlopeDeg}°.
          </p>
        )}
      </div>

      <div className="explainability-foot">
        <small>
          Analysis contrasts the multi-objective Pareto solution with the direct Euclidean chord. Avoidance
          reasons are inferred from neighboring DEM elevation and slope gradients.
        </small>
      </div>
    </div>
  );
}

