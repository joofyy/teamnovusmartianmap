import type { Route } from '../types';

interface Props {
  routes: Route[];
  selectedRouteId: string;
  onSelectRoute: (id: string) => void;
}

export default function RouteComparisonTable({ routes, selectedRouteId, onSelectRoute }: Props) {
  if (!routes || routes.length === 0) return null;

  // Find minimums across routes for highlighting
  const minDistance = Math.min(...routes.map((r) => r.metrics.distance_m));
  const minDuration = Math.min(...routes.map((r) => r.metrics.duration_min));
  const minEnergy = Math.min(...routes.map((r) => r.metrics.energy_wh));
  const minRisk = Math.min(
    ...routes.filter((r) => r.metrics.terrain_risk_pct !== null).map((r) => r.metrics.terrain_risk_pct as number)
  );

  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? routes[0];

  return (
    <div className="comparison-table-card">
      <div className="comparison-table-head">
        <div>
          <span className="eyebrow">TRADE-OFF ANALYSIS</span>
          <h4>Multi-Route Profile Comparison</h4>
        </div>
        <small className="comparison-hint">Click a column to select that route profile</small>
      </div>

      <div className="table-responsive">
        <table className="comparison-table">
          <thead>
            <tr>
              <th className="metric-col">TRAVERSAL METRIC</th>
              {routes.map((r) => (
                <th
                  key={r.id}
                  tabIndex={0}
                  role="button"
                  aria-pressed={r.id === selectedRouteId}
                  className={`route-col ${r.id === selectedRouteId ? 'active-col' : ''}`}
                  onClick={() => onSelectRoute(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectRoute(r.id);
                    }
                  }}
                >
                  <div className="th-route-header">
                    <span className={`route-letter route-${r.id}`}>{r.id}</span>
                    <div>
                      <strong>{r.name}</strong>
                      <span className="th-sub">{r.profile}</span>
                      {r.tradeoff_summary && <small className="th-tradeoff">{r.tradeoff_summary}</small>}
                      {r.diversity && <small className="th-tradeoff">{r.diversity.label} · {r.diversity.unique_corridor_pct.toFixed(0)}% unique</small>}
                    </div>
                  </div>
                  {r.id === selectedRouteId && <span className="active-pill">SELECTED</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="metric-col">
                <b>Total Distance</b>
                <small>Surface path length (m)</small>
              </td>
              {routes.map((r) => {
                const isBest = r.metrics.distance_m === minDistance;
                const delta = r.metrics.distance_m - selectedRoute.metrics.distance_m;
                return (
                  <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                    <strong className={isBest ? 'best-val' : ''}>{r.metrics.distance_m.toFixed(0)} m</strong>
                    {r.id !== selectedRouteId && delta !== 0 && (
                      <small className={delta > 0 ? 'delta-worse' : 'delta-better'}>
                        {delta > 0 ? `+${delta.toFixed(0)}m` : `${delta.toFixed(0)}m`}
                      </small>
                    )}
                  </td>
                );
              })}
            </tr>

            <tr>
              <td className="metric-col">
                <b>One-Way Time</b>
                <small>Outbound transit duration</small>
              </td>
              {routes.map((r) => {
                const isBest = r.metrics.duration_min === minDuration;
                return (
                  <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                    <strong className={isBest ? 'best-val' : ''}>{r.metrics.duration_min.toFixed(1)} min</strong>
                    <small>Out-and-back: {r.metrics.return_time_estimate_min.toFixed(1)} min</small>
                  </td>
                );
              })}
            </tr>

            <tr>
              <td className="metric-col">
                <b>Modeled Energy</b>
                <small>Gravitational & metabolic Wh</small>
              </td>
              {routes.map((r) => {
                const isBest = r.metrics.energy_wh === minEnergy;
                return (
                  <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                    <strong className={isBest ? 'best-val' : ''}>{r.metrics.energy_wh.toFixed(1)} Wh</strong>
                    <small>Out-and-back: {r.metrics.return_energy_estimate_wh.toFixed(1)} Wh</small>
                  </td>
                );
              })}
            </tr>

            <tr>
              <td className="metric-col">
                <b>Modeled Oxygen</b>
                <small>Assumed consumption volume</small>
              </td>
              {routes.map((r) => (
                <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                  <strong>{r.metrics.oxygen_l ? `${r.metrics.oxygen_l.toFixed(1)} L` : 'N/A'}</strong>
                  <small>Out-and-back: {r.metrics.return_oxygen_l ? `${r.metrics.return_oxygen_l.toFixed(1)} L` : 'N/A'}</small>
                </td>
              ))}
            </tr>

            <tr>
              <td className="metric-col">
                <b>Average Terrain Risk</b>
                <small>Derived slope & roughness penalty</small>
              </td>
              {routes.map((r) => {
                const isBest = r.metrics.terrain_risk_pct !== null && r.metrics.terrain_risk_pct === minRisk;
                return (
                  <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                    <strong className={isBest ? 'best-val' : ''}>
                      {r.metrics.terrain_risk_pct !== null ? `${r.metrics.terrain_risk_pct.toFixed(0)}%` : 'N/A'}
                    </strong>
                    <small>{r.metrics.terrain_risk_pct !== null && r.metrics.terrain_risk_pct > 40 ? 'Moderate slope exposure' : 'Gentle slope exposure'}</small>
                  </td>
                );
              })}
            </tr>

            <tr>
              <td className="metric-col">
                <b>Return Feasibility</b>
                <small>Within 25% safety reserve</small>
              </td>
              {routes.map((r) => (
                <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                  <span className={r.metrics.return_feasible ? 'badge-pass' : 'badge-fail'}>
                    {r.metrics.return_feasible ? 'FEASIBLE' : 'LIMIT EXCEEDED'}
                  </span>
                </td>
              ))}
            </tr>

            <tr>
              <td className="metric-col">
                <b>Pareto Frontier Status</b>
                <small>Multi-objective dominance check</small>
              </td>
              {routes.map((r) => (
                <td key={r.id} className={r.id === selectedRouteId ? 'active-col' : ''} onClick={() => onSelectRoute(r.id)}>
                  <span className={r.is_pareto ? 'badge-pareto' : 'badge-alt'}>
                    {r.is_pareto ? 'NON-DOMINATED PARETO' : 'ALTERNATIVE'}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="comparison-table-foot">
        <small>Green values denote the optimal solution across the evaluated route set for each respective objective.</small>
      </div>
    </div>
  );
}
