"""Uncertainty-aware, multi-objective A* and route analytics.

All hazard/science fields passed to this planner are explicitly synthetic in
this release. The planner is a research demonstrator, not certified guidance.
"""
from __future__ import annotations

import heapq
import math
from time import perf_counter
from dataclasses import dataclass, field
from typing import Any

from .terrain import Terrain

OBJECTIVES = ("distance", "time", "energy", "terrain_risk", "environment_risk", "radiation", "uncertainty", "science_opportunity_cost", "oxygen")

PROFILES: dict[str, dict[str, float]] = {
    "conservative": {
        "distance": 0.1152, "time": 0.0576, "energy": 0.0672,
        "terrain_risk": 0.288, "environment_risk": 0.1152,
        "radiation": 0.0768, "uncertainty": 0.192,
        "science_opportunity_cost": 0.048, "oxygen": 0.04,
    },
    "balanced": {
        "distance": 0.2208, "time": 0.1152, "energy": 0.1248,
        "terrain_risk": 0.1728, "environment_risk": 0.1056,
        "radiation": 0.0768, "uncertainty": 0.096,
        "science_opportunity_cost": 0.048, "oxygen": 0.04,
    },
    "science_first": {
        "distance": 0.096, "time": 0.0576, "energy": 0.0576,
        "terrain_risk": 0.144, "environment_risk": 0.0768,
        "radiation": 0.0768, "uncertainty": 0.096,
        "science_opportunity_cost": 0.3552, "oxygen": 0.04,
    },
}

@dataclass
class MissionConstraints:
    max_slope_deg: float = 22.0
    max_temperature_c: float = -35.0
    eva_limit_minutes: float = 180.0
    energy_budget_wh: float = 180.0
    return_reserve_fraction: float = 0.25
    suit_mass_kg: float = 42.0
    carried_equipment_mass_kg: float = 12.5
    base_speed_mps: float = 0.65
    oxygen_budget_l: float = 1200.0
    oxygen_consumption_lpm: float = 1.0
    rest_interval_min: float = 60.0
    rest_duration_min: float = 5.0
    objective_weight_multipliers: dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, values: dict[str, Any] | None) -> "MissionConstraints":
        if not values:
            return cls()
        allowed = {k: v for k, v in values.items() if k in cls.__dataclass_fields__ and k != "objective_weight_multipliers"}
        numeric_keys = set(cls.__dataclass_fields__) - {"objective_weight_multipliers"}
        for key in numeric_keys & set(allowed):
            if isinstance(allowed[key], bool):
                raise ValueError(f"Mission constraint {key} must be a finite number, not a boolean.")
            try:
                number = float(allowed[key])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Mission constraint {key} must be numeric.") from exc
            if not math.isfinite(number):
                raise ValueError(f"Mission constraint {key} must be finite.")
            allowed[key] = number
        result = cls(**allowed)
        raw_multipliers = values.get("objective_weight_multipliers", {})
        if raw_multipliers is not None:
            if not isinstance(raw_multipliers, dict):
                raise ValueError("objective_weight_multipliers must be an object keyed by planner objective.")
            unknown = set(raw_multipliers) - set(OBJECTIVES)
            if unknown:
                raise ValueError(f"Unknown planner weight objectives: {', '.join(sorted(unknown))}")
            multipliers: dict[str, float] = {}
            for key, raw_value in raw_multipliers.items():
                try:
                    number = float(raw_value)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"Weight multiplier for {key} must be numeric.") from exc
                if not math.isfinite(number) or not 0.0 <= number <= 5.0:
                    raise ValueError(f"Weight multiplier for {key} must be between 0 and 5.")
                multipliers[key] = number
            result.objective_weight_multipliers = multipliers
        result.max_slope_deg = max(1.0, min(45.0, float(result.max_slope_deg)))
        result.max_temperature_c = min(5.0, max(-100.0, float(result.max_temperature_c)))
        result.eva_limit_minutes = max(10.0, min(600.0, float(result.eva_limit_minutes)))
        result.energy_budget_wh = max(10.0, min(2000.0, float(result.energy_budget_wh)))
        result.return_reserve_fraction = max(0.10, min(0.50, float(result.return_reserve_fraction)))
        result.suit_mass_kg = max(15.0, min(150.0, float(result.suit_mass_kg)))
        result.carried_equipment_mass_kg = max(0.0, min(60.0, float(result.carried_equipment_mass_kg)))
        result.base_speed_mps = max(0.10, min(1.5, float(result.base_speed_mps)))
        result.oxygen_budget_l = max(50.0, min(10000.0, float(result.oxygen_budget_l)))
        result.oxygen_consumption_lpm = max(0.1, min(10.0, float(result.oxygen_consumption_lpm)))
        result.rest_interval_min = max(10.0, min(240.0, float(result.rest_interval_min)))
        result.rest_duration_min = max(0.0, min(30.0, float(result.rest_duration_min)))
        numeric_fields = ("max_slope_deg", "max_temperature_c", "eva_limit_minutes", "energy_budget_wh", "return_reserve_fraction", "suit_mass_kg", "carried_equipment_mass_kg", "base_speed_mps", "oxygen_budget_l", "oxygen_consumption_lpm", "rest_interval_min", "rest_duration_min")
        for field_name in numeric_fields:
            if not math.isfinite(float(getattr(result, field_name))):
                raise ValueError(f"Mission constraint {field_name} must be finite.")
        return result

@dataclass
class Label:
    x: int
    y: int
    costs: tuple[float, ...]
    parent: int | None
    alive: bool = True


class MultiObjectiveAStar:
    """A* with a bounded Pareto label set at each grid cell.

    Each label stores an additive vector of normalized, non-negative costs.
    Componentwise dominance removes inferior labels. A profile-weighted scalar
    priority selects a route policy while preserving multiple nondominated
    labels at intermediate cells. The per-cell cap bounds memory and makes the
    result an explicitly approximate Pareto search rather than an exact full
    frontier enumeration.
    """
    def __init__(self, terrain: Terrain, constraints: MissionConstraints, profile: str, max_labels_per_cell: int = 3, edge_cache: dict[tuple[int, int, int, int], tuple[float, ...] | None] | None = None):
        if profile not in PROFILES:
            raise ValueError(f"Unknown route profile: {profile}")
        self.terrain = terrain
        self.constraints = constraints
        self.profile = profile
        base_weights = PROFILES[profile]
        multipliers = constraints.objective_weight_multipliers
        adjusted = {key: value * multipliers.get(key, 1.0) for key, value in base_weights.items()}
        # Never let an unavailable spatial layer influence route preference via
        # a constant placeholder. Its uncertainty remains represented separately.
        if "atmosphere" not in terrain.available_layers:
            adjusted["environment_risk"] = 0.0
        if "radiation" not in terrain.available_layers:
            adjusted["radiation"] = 0.0
        if "science" not in terrain.available_layers:
            adjusted["science_opportunity_cost"] = 0.0
        total_weight = sum(adjusted.values())
        if total_weight <= 0:
            raise ValueError("At least one objective weight multiplier must be greater than zero.")
        self.weights = {key: value / total_weight for key, value in adjusted.items()}
        self.max_labels_per_cell = max_labels_per_cell
        # Route profiles share this lazy edge cache: terrain and constraints are
        # identical between profile searches, so edge costs need only be built once.
        self.edge_cache = edge_cache if edge_cache is not None else {}
        self.edge_cache_hits = 0
        self.edge_cache_misses = 0
        self.expanded = 0
        self.generated = 0

    def _weight(self, costs: tuple[float, ...]) -> float:
        return sum(self.weights[k] * costs[i] for i, k in enumerate(OBJECTIVES))

    def _heuristic(self, x: int, y: int, goal: tuple[int, int]) -> float:
        remaining_cells = math.hypot(goal[0] - x, goal[1] - y)
        lower_bound_distance = remaining_cells * self.terrain.cell_m / self.terrain.max_path_distance_m
        return self.weights["distance"] * lower_bound_distance

    def _dominates(self, a: tuple[float, ...], b: tuple[float, ...], eps: float = 1e-10) -> bool:
        return all(x <= y + eps for x, y in zip(a, b)) and any(x < y - eps for x, y in zip(a, b))

    def _edge_vector(self, x0: int, y0: int, x1: int, y1: int) -> tuple[float, ...] | None:
        key = (x0, y0, x1, y1)
        if key in self.edge_cache:
            self.edge_cache_hits += 1
            return self.edge_cache[key]
        self.edge_cache_misses += 1
        edge = self._compute_edge_vector(x0, y0, x1, y1)
        self.edge_cache[key] = edge
        return edge

    def _compute_edge_vector(self, x0: int, y0: int, x1: int, y1: int) -> tuple[float, ...] | None:
        t = self.terrain
        c = self.constraints
        if t.is_blocked(x1, y1, c.max_slope_deg, c.max_temperature_c):
            return None
        # Prevent diagonal corner-cutting between two blocked cardinal cells.
        if x1 != x0 and y1 != y0:
            if t.is_blocked(x1, y0, c.max_slope_deg, c.max_temperature_c) or t.is_blocked(x0, y1, c.max_slope_deg, c.max_temperature_c):
                return None
        diagonal = math.hypot(x1 - x0, y1 - y0)
        distance_m = diagonal * t.cell_m
        target_slope = t.slope_deg[y1][x1]
        avg_slope = (t.slope_deg[y0][x0] + target_slope) / 2.0
        avg_rough = (t.roughness[y0][x0] + t.roughness[y1][x1]) / 2.0 if "roughness" in t.available_layers else 0.65
        avg_regolith = (t.regolith[y0][x0] + t.regolith[y1][x1]) / 2.0 if "regolith" in t.available_layers else 0.65
        avg_env = (t.environment_index[y0][x0] + t.environment_index[y1][x1]) / 2.0 if "atmosphere" in t.available_layers else 0.5
        avg_rad = (t.radiation_index[y0][x0] + t.radiation_index[y1][x1]) / 2.0 if "radiation" in t.available_layers else 0.5
        avg_uncertainty = (t.uncertainty[y0][x0] + t.uncertainty[y1][x1]) / 2.0
        science = max(t.science_potential[y0][x0], t.science_potential[y1][x1])

        # Illustrative mobility model, not a validated human-performance model.
        slope_factor = 1.0 + (avg_slope / max(c.max_slope_deg, 1.0)) * 1.8
        mobility_factor = 1.0 + 0.55 * avg_rough + 0.35 * avg_regolith
        total_carried_mass = c.suit_mass_kg + c.carried_equipment_mass_kg
        mass_factor = total_carried_mass / 54.5
        load_speed_factor = 1.0 + 0.10 * max(0.0, mass_factor - 1.0)
        speed_mps = c.base_speed_mps / (slope_factor * mobility_factor * load_speed_factor)
        walking_duration_s = distance_m / max(speed_mps, 0.05)
        rest_factor = 1.0 + c.rest_duration_min / c.rest_interval_min
        duration_s = walking_duration_s * rest_factor
        energy_wh = distance_m * 0.018 * mass_factor * slope_factor * mobility_factor
        oxygen_l = (duration_s / 60.0) * c.oxygen_consumption_lpm

        # A non-negative opportunity cost: cells close to science targets cost
        # less than passing through scientifically unremarkable cells. No
        # negative reward edge is introduced, preserving A* assumptions.
        max_range = t.max_path_distance_m
        length_fraction = distance_m / max_range
        terrain_risk = _clamp01(0.50 * target_slope / max(c.max_slope_deg, 1.0) + 0.30 * avg_rough + 0.20 * avg_regolith)
        environment_risk = _clamp01(avg_env)
        return (
            distance_m / max_range,
            duration_s / (c.eva_limit_minutes * 60.0),
            energy_wh / c.energy_budget_wh,
            terrain_risk * length_fraction,
            environment_risk * length_fraction,
            avg_rad * length_fraction,
            avg_uncertainty * length_fraction,
            (1.0 - science) * length_fraction,
            (oxygen_l / c.oxygen_budget_l),
        )

    def _within_resource_limits(self, costs: tuple[float, ...]) -> bool:
        # Reserve a configurable fraction for contingencies and return travel.
        allowed_fraction = (1.0 - self.constraints.return_reserve_fraction) / 2.0
        return costs[1] <= allowed_fraction and costs[2] <= allowed_fraction and costs[8] <= allowed_fraction

    def search(self, start: tuple[int, int], goal: tuple[int, int]) -> dict[str, Any]:
        t = self.terrain
        c = self.constraints
        if not t.in_bounds(*start) or not t.in_bounds(*goal):
            raise ValueError("Start and destination must be inside the terrain grid")
        if t.is_blocked(*start, c.max_slope_deg, c.max_temperature_c):
            raise ValueError("Starting cell violates a configured hard constraint")
        if t.is_blocked(*goal, c.max_slope_deg, c.max_temperature_c):
            raise ValueError("Destination violates a configured hard constraint")

        labels: list[Label] = [Label(start[0], start[1], (0.0,) * len(OBJECTIVES), None)]
        at_cell: dict[tuple[int, int], list[int]] = {start: [0]}
        queue: list[tuple[float, int, int]] = []
        serial = 0
        heapq.heappush(queue, (self._heuristic(*start, goal), serial, 0))
        goal_label: int | None = None
        self.expanded = 0
        self.generated = 1

        while queue:
            _, _, label_id = heapq.heappop(queue)
            label = labels[label_id]
            if not label.alive:
                continue
            cell_labels = at_cell.get((label.x, label.y), [])
            if label_id not in cell_labels:
                continue
            if (label.x, label.y) == goal:
                goal_label = label_id
                break
            self.expanded += 1

            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                nx, ny = label.x + dx, label.y + dy
                edge = self._edge_vector(label.x, label.y, nx, ny)
                if edge is None:
                    continue
                new_costs = tuple(a + b for a, b in zip(label.costs, edge))
                if not self._within_resource_limits(new_costs):
                    continue
                key = (nx, ny)
                current_ids = at_cell.setdefault(key, [])
                if any(labels[i].alive and self._dominates(labels[i].costs, new_costs) for i in current_ids):
                    continue
                for i in current_ids:
                    if labels[i].alive and self._dominates(new_costs, labels[i].costs):
                        labels[i].alive = False

                current_ids[:] = [i for i in current_ids if labels[i].alive]
                candidate_score = self._weight(new_costs)
                if len(current_ids) >= self.max_labels_per_cell:
                    worst_id = max(current_ids, key=lambda i: self._weight(labels[i].costs))
                    if candidate_score >= self._weight(labels[worst_id].costs):
                        continue
                    labels[worst_id].alive = False
                    current_ids.remove(worst_id)

                new_id = len(labels)
                labels.append(Label(nx, ny, new_costs, label_id))
                current_ids.append(new_id)
                self.generated += 1
                serial += 1
                priority = candidate_score + self._heuristic(nx, ny, goal)
                heapq.heappush(queue, (priority, serial, new_id))

        if goal_label is None:
            raise ValueError("No route satisfies the hard constraints and resource reserve")

        path: list[tuple[int, int]] = []
        cursor: int | None = goal_label
        while cursor is not None:
            lab = labels[cursor]
            path.append((lab.x, lab.y))
            cursor = lab.parent
        path.reverse()
        return {
            "path": path,
            "expanded_nodes": self.expanded,
            "generated_labels": self.generated,
            "pareto_labels_at_goal": len([i for i in at_cell.get(goal, []) if labels[i].alive]),
            "objective_vector": dict(zip(OBJECTIVES, labels[goal_label].costs)),
            "approximate_frontier": True,
        }


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def route_metrics(terrain: Terrain, path: list[tuple[int, int]], constraints: MissionConstraints) -> dict[str, Any]:
    if len(path) < 2:
        return {
            "distance_m": 0.0, "duration_min": 0.0, "energy_wh": 0.0,
            "terrain_risk_pct": 0.0, "environment_risk_pct": 0.0,
            "radiation_index_pct": 0.0, "uncertainty_pct": 0.0,
            "scientific_value_pct": 0.0, "return_feasible": True,
            "oxygen_l": 0.0, "return_oxygen_l": 0.0,
            "communication_assessment": "UNAVAILABLE_NO_VERIFIED_RELAY_COVERAGE_DATA",
        }
    total_distance = total_time = total_energy = total_oxygen = 0.0
    terrain_vals: list[float] = []
    env_vals: list[float] = []
    rad_vals: list[float] = []
    uncertainty_vals: list[float] = []
    science_vals: list[float] = []
    for (x0, y0), (x1, y1) in zip(path[:-1], path[1:]):
        d = math.hypot(x1 - x0, y1 - y0) * terrain.cell_m
        avg_slope = (terrain.slope_deg[y0][x0] + terrain.slope_deg[y1][x1]) / 2.0
        avg_rough = (terrain.roughness[y0][x0] + terrain.roughness[y1][x1]) / 2.0 if "roughness" in terrain.available_layers else 0.65
        avg_reg = (terrain.regolith[y0][x0] + terrain.regolith[y1][x1]) / 2.0 if "regolith" in terrain.available_layers else 0.65
        slope_factor = 1.0 + (avg_slope / max(constraints.max_slope_deg, 1.0)) * 1.8
        mobility_factor = 1.0 + 0.55 * avg_rough + 0.35 * avg_reg
        total_carried_mass = constraints.suit_mass_kg + constraints.carried_equipment_mass_kg
        mass_factor = total_carried_mass / 54.5
        load_speed_factor = 1.0 + 0.10 * max(0.0, mass_factor - 1.0)
        speed = constraints.base_speed_mps / (slope_factor * mobility_factor * load_speed_factor)
        total_distance += d
        edge_walk_s = d / max(speed, 0.05)
        edge_time_min = (edge_walk_s / 60.0) * (1.0 + constraints.rest_duration_min / constraints.rest_interval_min)
        total_time += edge_time_min * 60.0
        total_energy += d * 0.018 * mass_factor * slope_factor * mobility_factor
        total_oxygen += edge_time_min * constraints.oxygen_consumption_lpm
        terrain_vals.append(_clamp01(0.50 * avg_slope / max(constraints.max_slope_deg, 1.0) + 0.30 * avg_rough + 0.20 * avg_reg))
        if "atmosphere" in terrain.available_layers:
            env_vals.append((terrain.environment_index[y0][x0] + terrain.environment_index[y1][x1]) / 2.0)
        if "radiation" in terrain.available_layers:
            rad_vals.append((terrain.radiation_index[y0][x0] + terrain.radiation_index[y1][x1]) / 2.0)
        uncertainty_vals.append((terrain.uncertainty[y0][x0] + terrain.uncertainty[y1][x1]) / 2.0)
        if "science" in terrain.available_layers:
            science_vals.append(max(terrain.science_potential[y0][x0], terrain.science_potential[y1][x1]))
    duration_min = total_time / 60.0
    return_budget_min = constraints.eva_limit_minutes * (1.0 - constraints.return_reserve_fraction)
    return_budget_wh = constraints.energy_budget_wh * (1.0 - constraints.return_reserve_fraction)
    return_budget_oxygen = constraints.oxygen_budget_l * (1.0 - constraints.return_reserve_fraction)
    return_feasible = (2.0 * duration_min <= return_budget_min) and (2.0 * total_energy <= return_budget_wh) and (2.0 * total_oxygen <= return_budget_oxygen)
    avg = lambda xs: (sum(xs) / len(xs) * 100.0) if xs else 0.0
    science_score = avg(science_vals)
    nearby_targets = []
    for target in terrain.targets:
        best = min(math.hypot(target["x"] - x, target["y"] - y) for x, y in path)
        if best <= 4.5:
            nearby_targets.append({**target, "path_distance_cells": round(best, 1)})
    return {
        "distance_m": round(total_distance, 1),
        "duration_min": round(duration_min, 1),
        "energy_wh": round(total_energy, 2),
        "terrain_risk_pct": round(avg(terrain_vals), 1),
        "environment_risk_pct": round(avg(env_vals), 1) if env_vals else None,
        "radiation_index_pct": round(avg(rad_vals), 1) if rad_vals else None,
        "uncertainty_pct": round(avg(uncertainty_vals), 1),
        "scientific_value_pct": round(science_score, 1) if science_vals else None,
        "return_feasible": return_feasible,
        "nearby_targets": nearby_targets,
        "return_time_estimate_min": round(duration_min * 2.0, 1),
        "return_energy_estimate_wh": round(total_energy * 2.0, 2),
        "oxygen_l": round(total_oxygen, 2),
        "return_oxygen_l": round(total_oxygen * 2.0, 2),
        "communication_assessment": "UNAVAILABLE_NO_VERIFIED_RELAY_COVERAGE_DATA",
        "available_terrain_layers": sorted(terrain.available_layers),
        "model_note": "Illustrative mobility/oxygen model. Suit mass, equipment mass, rest allowance and oxygen consumption are configurable research assumptions, not validated EVA performance. Environment, radiation and science values are N/A unless spatially registered layers exist; unavailable objectives are removed from route weights rather than filled with invented measurements.",
        "carried_mass_kg": round(constraints.suit_mass_kg + constraints.carried_equipment_mass_kg, 1),
    }


def build_route_set(terrain: Terrain, start: tuple[int, int], goal: tuple[int, int], constraints: MissionConstraints) -> list[dict[str, Any]]:
    labels = {
        "conservative": ("A", "CONSERVATIVE", "Risk-and-uncertainty weighted alternative"),
        "balanced": ("B", "BALANCED", "Compromise across movement, risk and science"),
        "science_first": ("C", "SCIENCE-FIRST", "Seek available science targets without relaxing hard constraints"),
    }
    routes: list[dict[str, Any]] = []
    # The three searches differ only in their scalarized profile weights. Cache
    # expensive terrain/constraint edge evaluations across all three searches.
    shared_edge_cache: dict[tuple[int, int, int, int], tuple[float, ...] | None] = {}
    for profile, (route_id, title, summary) in labels.items():
        model = MultiObjectiveAStar(terrain, constraints, profile, max_labels_per_cell=3, edge_cache=shared_edge_cache)
        search_started = perf_counter()
        search = model.search(start, goal)
        search["runtime_ms"] = round((perf_counter() - search_started) * 1000.0, 2)
        search["edge_cache_hits"] = model.edge_cache_hits
        search["edge_cache_misses"] = model.edge_cache_misses
        search["max_labels_per_cell"] = model.max_labels_per_cell
        metrics = route_metrics(terrain, search["path"], constraints)
        science_available = "science" in terrain.available_layers
        display_title = title if science_available or profile != "science_first" else "SCIENCE-FIRST (NO SCIENCE LAYER)"
        display_summary = summary if science_available or profile != "science_first" else "No georeferenced science-potential layer is loaded. Scientific discovery is not optimized; this is a baseline alternative only."
        routes.append({
            "id": route_id, "profile": profile, "name": display_title, "summary": display_summary,
            "path": [{"x": x, "y": y} for x, y in search["path"]],
            "metrics": metrics,
            "search": {k: v for k, v in search.items() if k != "path"},
            "weights": model.weights,
        })
    for route in routes:
        route["is_pareto"] = not any(
            _route_dominates(other["metrics"], route["metrics"])
            for other in routes if other is not route
        )
    return routes


def _route_dominates(a: dict[str, Any], b: dict[str, Any]) -> bool:
    lower = ("distance_m", "duration_min", "energy_wh", "terrain_risk_pct", "environment_risk_pct", "radiation_index_pct", "uncertainty_pct")
    comparable_lower = [key for key in lower if a.get(key) is not None and b.get(key) is not None]
    better_or_equal = all(float(a[k]) <= float(b[k]) for k in comparable_lower)
    strictly_better = any(float(a[k]) < float(b[k]) for k in comparable_lower)
    science_available = a.get("scientific_value_pct") is not None and b.get("scientific_value_pct") is not None
    if science_available:
        better_or_equal = better_or_equal and float(a["scientific_value_pct"]) >= float(b["scientific_value_pct"])
        strictly_better = strictly_better or float(a["scientific_value_pct"]) > float(b["scientific_value_pct"])
    return better_or_equal and strictly_better
