import pytest
from app.planner import MissionConstraints, MultiObjectiveAStar, build_route_set, route_metrics
from app.terrain import generate_terrain


def test_route_stays_inside_grid_and_avoids_hard_blocked_cells():
    terrain = generate_terrain(seed=11)
    constraints = MissionConstraints(max_slope_deg=35, max_temperature_c=0)
    result = MultiObjectiveAStar(terrain, constraints, "balanced").search((3, 3), (58, 58))
    assert result["path"][0] == (3, 3)
    assert result["path"][-1] == (58, 58)
    for x, y in result["path"]:
        assert not terrain.is_blocked(x, y, constraints.max_slope_deg, constraints.max_temperature_c)


def test_three_policy_routes_are_returned_with_comparable_metrics():
    terrain = generate_terrain(seed=12)
    routes = build_route_set(terrain, (3, 3), (58, 58), MissionConstraints(max_slope_deg=35, max_temperature_c=0))
    assert {r["profile"] for r in routes} == {"conservative", "balanced", "science_first"}
    for route in routes:
        assert route["metrics"]["distance_m"] > 0
        assert 0 <= route["metrics"]["uncertainty_pct"] <= 100
        assert "return_feasible" in route["metrics"]


def test_resource_limited_mission_can_be_rejected():
    terrain = generate_terrain(seed=12)
    c = MissionConstraints(eva_limit_minutes=10, energy_budget_wh=10, max_slope_deg=35, max_temperature_c=0)
    try:
        MultiObjectiveAStar(terrain, c, "balanced").search((3, 3), (58, 58))
    except ValueError as exc:
        assert "terrain-valid path exists" in str(exc)
        assert "energy budget" in str(exc)
    else:
        raise AssertionError("Expected a route rejection under restrictive resources")


def test_objective_weight_multipliers_are_normalized_and_configurable():
    from app.planner import MissionConstraints, MultiObjectiveAStar
    from app.terrain import generate_terrain

    terrain = generate_terrain(width=24, height=24)
    constraints = MissionConstraints.from_dict({
        "objective_weight_multipliers": {
            "science_opportunity_cost": 2.5,
            "terrain_risk": 1.8,
            "uncertainty": 1.5,
        }
    })
    model = MultiObjectiveAStar(terrain, constraints, "balanced")
    assert sum(model.weights.values()) == pytest.approx(1.0)
    assert model.weights["science_opportunity_cost"] > 0.048
    with pytest.raises(ValueError, match="between 0 and 5"):
        MissionConstraints.from_dict({"objective_weight_multipliers": {"distance": 6}})
    with pytest.raises(ValueError, match="At least one objective"):
        no_objectives = MissionConstraints.from_dict({"objective_weight_multipliers": {key: 0 for key in model.weights}})
        MultiObjectiveAStar(terrain, no_objectives, "balanced")


def test_unavailable_science_environment_and_radiation_are_n_a_not_fake_zeroes():
    from app.planner import MissionConstraints, MultiObjectiveAStar, route_metrics
    from app.terrain import generate_terrain

    terrain = generate_terrain(seed=42)
    terrain.available_layers.discard("science")
    terrain.available_layers.discard("atmosphere")
    terrain.available_layers.discard("radiation")
    constraints = MissionConstraints(max_slope_deg=35, max_temperature_c=0)
    search = MultiObjectiveAStar(terrain, constraints, "balanced").search((3, 3), (58, 58))
    metrics = route_metrics(terrain, search["path"], constraints)
    assert metrics["scientific_value_pct"] is None
    assert metrics["environment_risk_pct"] is None
    assert metrics["radiation_index_pct"] is None
    weights = MultiObjectiveAStar(terrain, constraints, "balanced").weights
    assert weights["science_opportunity_cost"] == 0
    assert weights["environment_risk"] == 0
    assert weights["radiation"] == 0
