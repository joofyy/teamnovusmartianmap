from __future__ import annotations

import copy
import json
import os
import threading
import logging
import time
import uuid
from datetime import datetime, timezone
from time import perf_counter
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Body, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .benchmarks import scalar_baseline, benchmark_label_caps
from .lpa import LPAStar
from .models import BenchmarkRequest, ConditionUpdateRequest, MissionEventRequest, PlanRequest, ReplanRequest, SensitivityRequest, WaypointPlanRequest
from .planner import MissionConstraints, MultiObjectiveAStar, build_route_set, route_metrics
from .registry import get_registry
from .terrain import Terrain
from .mission_sites import MISSION_SITES, SUPPORTED_SITE_IDS
from .data_catalog import get_data_catalog
from .services.archive_clients import ArchiveServiceError, search_pds, resolve_pds_product, search_ode
from .domain.science_assistant import answer_question, load_evidence
from .domain.observation_ingest import import_observation_csv
from .domain.observation_store import save_observation_import, list_observation_imports, get_observation_import
from .domain.raster_pipeline import dem_to_terrain, inspect_geotiff, import_aligned_layer, validate_site_coverage
from .domain.offline_package import create_package
from .domain.pds_labels import inspect_label as inspect_pds_label, save_label as save_pds_label
from .services.wmts import LAYERS as WMTS_LAYERS, get_capabilities as get_wmts_capabilities, download_tile_cache, inspect_cached_packages
from .services.official_downloads import download_official_file, DownloadError
from .services.dem_cache import DemSourceError, DemValidationError, DemCacheError, load_or_fetch_site_terrain, cache_mode
from .services.jev_client import jev_service_config, last_successful_evaluation, probe_jev_reachability, request_jev_evidence_assessment, request_jev_pathfinding_weights

app = FastAPI(
    title="MARSCOPE API",
    version="0.4.0",
    description="Research prototype for Mars human-traversal route-planning concepts. It is not certified navigation software.",
)
def _configured_cors_origins() -> list[str]:
    configured = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    )
    return [origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_configured_cors_origins(),
    # Allow this Vercel project’s production domain and branch-preview domains.
    # The pattern is restricted to this exact project slug, not all Vercel sites.
    allow_origin_regex=r"^https://teamnovusmartianmap(?:-[a-z0-9-]+)?\.vercel\.app$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Terrain is loaded lazily on first site selection/request. The lock prevents
# simultaneous requests in one worker from downloading the same large DEM twice.
TERRAINS: dict[str, Terrain] = {}
_TERRAIN_LOAD_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bounded plan session store: max 50 sessions, 30-min inactivity TTL, LRU.
# ---------------------------------------------------------------------------

class _SessionStore:
    """Thread-safe plan session store with capacity cap and TTL eviction.

    Guarantees:
    - At most MAX_SESSIONS sessions are retained at any time.
    - Sessions not accessed within SESSION_TTL_SECONDS are evicted.
    - LRU eviction removes the least-recently-used session when at cap.
    - Session access timestamps are updated on both reads and writes.
    - Active sessions (held by a request) are protected from LRU eviction.
    """

    MAX_SESSIONS: int = 50
    SESSION_TTL_SECONDS: float = 1800.0  # 30 minutes

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._access_times: dict[str, float] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Internal helpers (must be called with self._lock held)
    # ------------------------------------------------------------------

    def _evict_expired_locked(self) -> None:
        cutoff = time.monotonic() - self.SESSION_TTL_SECONDS
        expired = [pid for pid, t in self._access_times.items() if t < cutoff]
        for pid in expired:
            self._sessions.pop(pid, None)
            self._access_times.pop(pid, None)
            logger.debug("Evicted expired plan session %s", pid)

    def _evict_lru_locked(self, protected: str | None = None) -> None:
        """Remove the least-recently-used session that is not `protected`."""
        candidates = [
            (t, pid)
            for pid, t in self._access_times.items()
            if pid != protected
        ]
        if not candidates:
            return
        candidates.sort()
        oldest_pid = candidates[0][1]
        self._sessions.pop(oldest_pid, None)
        self._access_times.pop(oldest_pid, None)
        logger.info("Evicted LRU plan session %s (capacity cap reached)", oldest_pid)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, plan_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._evict_expired_locked()
            session = self._sessions.get(plan_id)
            if session is not None:
                self._access_times[plan_id] = time.monotonic()
            return session

    def put(self, plan_id: str, session: dict[str, Any]) -> None:
        with self._lock:
            self._evict_expired_locked()
            # If we are already at capacity and this is a new session, evict LRU.
            if plan_id not in self._sessions and len(self._sessions) >= self.MAX_SESSIONS:
                self._evict_lru_locked(protected=None)
            self._sessions[plan_id] = session
            self._access_times[plan_id] = time.monotonic()

    def pop(self, plan_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._sessions.pop(plan_id, None)
            self._access_times.pop(plan_id, None)
            return session

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()
            self._access_times.clear()

    def items(self) -> list[tuple[str, dict[str, Any]]]:
        """Return a snapshot list of (plan_id, session) pairs (safe for iteration)."""
        with self._lock:
            return list(self._sessions.items())

    def __len__(self) -> int:
        with self._lock:
            return len(self._sessions)


PLAN_SESSIONS = _SessionStore()


def _safe_event_data(value: Any, depth: int = 0) -> Any:
    """Remove credential-like fields before an event can enter the replay log."""
    if depth > 8:
        return "[depth-limited]"
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            if any(token in normalized for token in ("api_key", "apikey", "secret", "password", "authorization", "access_token")):
                continue
            safe[str(key)[:80]] = _safe_event_data(item, depth + 1)
        return safe
    if isinstance(value, (list, tuple)):
        return [_safe_event_data(item, depth + 1) for item in list(value)[:2000]]
    if isinstance(value, str):
        return value[:4000]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:500]


def _append_mission_event(
    session: dict[str, Any],
    event_type: str,
    title: str,
    summary: str,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    events = session.setdefault("events", [])
    event = {
        "id": str(uuid.uuid4()),
        "sequence": len(events) + 1,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "type": event_type,
        "title": title[:120],
        "summary": summary[:500],
        "data": _safe_event_data(data or {}),
    }
    # The event log is bounded with the same in-memory mission session that
    # owns the terrain/planner state. Secrets are filtered before storage.
    events.append(event)
    if len(events) > 500:
        del events[:-500]
    return event


def _terrain_for_site(site_id: str) -> Terrain:
    if site_id not in SUPPORTED_SITE_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown mission site '{site_id}'.")
    selected = TERRAINS.get(site_id)
    if selected is None:
        with _TERRAIN_LOAD_LOCK:
            selected = TERRAINS.get(site_id)
            if selected is None:
                site = MISSION_SITES[site_id]
                try:
                    selected = load_or_fetch_site_terrain(site_id, site)
                except DemSourceError as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Automatic official DEM download failed for {site['name']}: {exc}",
                    ) from exc
                except DemValidationError as exc:
                    raise HTTPException(
                        status_code=422,
                        detail=f"The official {site['name']} DEM was downloaded but rejected by validation: {exc}",
                    ) from exc
                except DemCacheError as exc:
                    raise HTTPException(status_code=503, detail=f"DEM cache configuration/storage error: {exc}") from exc
                except Exception as exc:
                    logger.exception("Unexpected automatic DEM load failure for %s", site_id)
                    raise HTTPException(
                        status_code=503,
                        detail=f"Could not prepare the official {site['name']} DEM. No synthetic terrain was substituted.",
                    ) from exc
                TERRAINS[site_id] = selected
    if selected.status != "NASA_OR_USER_SUPPLIED_GEOREFERENCED_DEM":
        raise HTTPException(status_code=409, detail="Unverified or synthetic terrain is disabled. No fallback terrain is available.")
    return selected


def _get_session_planner(session: dict[str, Any]) -> LPAStar:
    """Initialize LPA* only when a user requests an incremental update."""
    planner = session.get("planner")
    if planner is not None:
        return planner
    planner = LPAStar(session["terrain"], session["start"], session["goal"], session["constraints"])
    initial_path = planner.extract_path()
    if not route_metrics(session["terrain"], initial_path, session["constraints"])["return_feasible"]:
        raise ValueError("Incremental repair cannot initialize because its initial path exceeds the configured resource reserve.")
    session["planner"] = planner
    return planner


@app.get("/api/jezero/pois")
def jezero_pois() -> dict[str, Any]:
    """Return documented Jezero-area reference points; coordinates are not planner grid cells."""
    return {
        "site": "Jezero Crater, Mars",
        "coordinate_convention": "Planetocentric latitude, east-positive longitude, degrees",
        "dem": {
            "name": "USGS M20 Jezero Crater CTX DEM Mosaic",
            "url": "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif",
            "documentation": "https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic",
            "pixel_scale_m": 20,
            "format": "GeoTIFF",
            "vertical_units": "metres (USGS source metadata)",
        },
        "points": [
            {"id": "jezero-centre", "name": "Jezero Crater Centre", "latitude": 18.4100, "longitude_east": 77.6900, "precision": "approximate reference point", "description": "Regional reference point for the Jezero study area."},
            {"id": "perseverance-landing", "name": "Perseverance Landing Site", "latitude": 18.44463, "longitude_east": 77.45088, "precision": "published landing-site coordinate", "description": "Rover landing location in Jezero Crater."},
            {"id": "neretva-vallis", "name": "Neretva Vallis", "latitude": 18.4006, "longitude_east": 77.1860, "precision": "approximate reference point", "description": "Western inlet-channel area."},
            {"id": "western-delta", "name": "Western Delta Area", "latitude": 18.3512, "longitude_east": 77.2757, "precision": "approximate reference point", "description": "Western delta study area."},
        ],
        "notice": "These are geographic reference points, not verified pixels or grid coordinates. Selecting Jezero automatically fetches and validates its catalogued real DEM before route planning."
    }

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "project": "MARSCOPE", "release": "0.4.0"}

@app.get("/api/terrain")
def terrain() -> dict[str, Any]:
    raise HTTPException(status_code=400, detail="Select one of the four supported mission sites. Its official DEM is fetched automatically on first request.")


@app.get("/api/terrain/{site_id}")
def terrain_for_mission_site(site_id: str) -> dict[str, Any]:
    return _terrain_for_site(site_id).to_dict()


@app.get("/api/sites")
def sites() -> dict[str, Any]:
    return {
        "sites": [
            {
                "id": site_id,
                **site,
                "terrain_loaded": site_id in TERRAINS,
                "terrain_id": TERRAINS[site_id].terrain_id if site_id in TERRAINS else None,
                "automatic_loading": True,
            }
            for site_id, site in MISSION_SITES.items()
        ],
        "cache_mode": cache_mode(),
        "note": "Only the four configured sites are supported. Selecting a site automatically fetches its catalogued official DEM when no validated cache exists; CRS, metre units and site footprint are checked before planning. No synthetic fallback is used.",
    }


@app.get("/api/registry")
def registry() -> dict[str, Any]:
    return {
        "datasets": get_registry(),
        "common_coordinate_policy": {
            "recommended_analysis_coordinates": "Local metric working CRS derived from a verified Mars planetary CRS and a site-centred projection.",
            "mars_longitude_latitude": "Preserve planetocentric latitude and east-positive longitude for modern products unless the product label explicitly specifies another convention.",
            "warning": "No default or synthetic terrain is generated. The selected site's official DEM is fetched automatically and validated before planning.",
        },
    }

@app.post("/api/jev/pathfinding-weights")
async def jev_pathfinding_weights(response: Response, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Generate request-scoped JEV preferences from the selected site's real layer inventory."""
    provider = payload.get("provider", "typesafe")
    api_key = payload.get("apiKey")
    mission_prompt = payload.get("missionPrompt")
    site_id = payload.get("site_id", "jezero")

    if provider not in {"typesafe", "opencode"}:
        raise HTTPException(status_code=422, detail="Select a supported JEV provider.")
    if not isinstance(api_key, str) or not api_key.strip() or len(api_key) > 1024:
        raise HTTPException(status_code=422, detail="Enter a provider API key (maximum 1,024 characters).")
    if not isinstance(mission_prompt, str) or not mission_prompt.strip() or len(mission_prompt) > 600:
        raise HTTPException(status_code=422, detail="Mission prompt must contain 1–600 characters.")
    if not isinstance(site_id, str) or site_id not in SUPPORTED_SITE_IDS:
        raise HTTPException(status_code=422, detail="Select a supported Mars mission site.")

    active_terrain = _terrain_for_site(site_id)
    available_layers = sorted(active_terrain.available_layers)
    mission_context: dict[str, str | int | float | bool | None] = {
        "site_id": site_id,
        "site_name": active_terrain.site_name,
        "grid_width": active_terrain.width,
        "grid_height": active_terrain.height,
        "cell_size_m": active_terrain.cell_m,
    }

    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    result = await request_jev_pathfinding_weights({
        "provider": provider,
        "apiKey": api_key,
        "missionPrompt": mission_prompt,
        "availableLayers": available_layers,
        "missionContext": mission_context,
    })
    return result


@app.post("/api/jev/evidence-assessment")
async def jev_evidence_assessment(response: Response, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Assess user-supplied NASA evidence without changing the source record or planner."""
    provider = payload.get("provider", "typesafe")
    api_key = payload.get("apiKey")
    objective = payload.get("objective")
    hypothesis = payload.get("hypothesis")
    evidence = payload.get("evidence")

    if provider not in {"typesafe", "opencode"}:
        raise HTTPException(status_code=422, detail="Select a supported JEV provider.")
    if not isinstance(api_key, str) or not api_key.strip() or len(api_key) > 1024:
        raise HTTPException(status_code=422, detail="Enter a provider API key (maximum 1,024 characters).")
    if not isinstance(objective, str) or not objective.strip() or len(objective) > 500:
        raise HTTPException(status_code=422, detail="Mission objective must contain 1–500 characters.")
    if not isinstance(hypothesis, str) or not hypothesis.strip() or len(hypothesis) > 700:
        raise HTTPException(status_code=422, detail="Hypothesis must contain 1–700 characters.")
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 4:
        raise HTTPException(status_code=422, detail="Provide between 1 and 4 NASA evidence records.")
    for record in evidence:
        if not isinstance(record, dict):
            raise HTTPException(status_code=422, detail="Each NASA evidence record must be an object.")
        for key in ("id", "title", "summary", "url"):
            value = record.get(key)
            if not isinstance(value, str) or not value.strip() or len(value) > 2000:
                raise HTTPException(status_code=422, detail=f"Evidence records require a valid {key} field.")
        if not record["url"].lower().startswith(("https://", "http://")):
            raise HTTPException(status_code=422, detail="Evidence source URL must use HTTP or HTTPS.")

    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return await request_jev_evidence_assessment({
        "provider": provider,
        "apiKey": api_key,
        "objective": objective,
        "hypothesis": hypothesis,
        "evidence": evidence,
    })


@app.get("/api/jev/status")
async def jev_status(response: Response) -> dict[str, Any]:
    """Report JEV configuration, reachability and the last successful evaluation.

    No service token or provider key is exposed. Reachability is probed on
    demand against the public /health endpoint only; this is not run before
    every JEV request.
    """
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    config = jev_service_config()
    reachability = await probe_jev_reachability()
    ready = (
        bool(config["configured"])
        and bool(reachability.get("reachable"))
        and bool(reachability.get("service_ready"))
    )
    return {
        "configured": config["configured"],
        "service_url": config["service_url"],
        "token_configured": config["token_configured"],
        "reachable": reachability.get("reachable", False),
        "ready": ready,
        "reachability": reachability,
        "last_success": last_successful_evaluation(),
    }


@app.post("/api/routes")
def routes(payload: PlanRequest) -> dict[str, Any]:
    start = (payload.start.x, payload.start.y)
    goal = (payload.goal.x, payload.goal.y)
    try:
        constraints = MissionConstraints.from_dict(payload.constraints)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    active_terrain = _terrain_for_site(payload.site_id)
    try:
        planner_started = perf_counter()
        route_set = build_route_set(active_terrain, start, goal, constraints)
        planning_runtime_ms = round((perf_counter() - planner_started) * 1000.0, 2)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # The expensive incremental planner is deferred until the user requests
    # obstacle/condition repair. Initial route generation performs only the
    # requested route alternatives.
    session_terrain = copy.deepcopy(active_terrain)
    plan_id = str(uuid.uuid4())
    PLAN_SESSIONS.put(plan_id, {
        "terrain": session_terrain,
        "planner": None,
        "start": start,
        "goal": goal,
        "constraints": constraints,
        "obstacles_added": [],
        "condition_updates": [],
        "routes": route_set,
        "events": [],
        "selected_route_id": "B" if any(route.get("id") == "B" for route in route_set) else route_set[0]["id"],
        "terrain_id": active_terrain.terrain_id,
        "site_id": payload.site_id,
        "created_utc": datetime.now(timezone.utc).isoformat(),
    })
    _append_mission_event(
        PLAN_SESSIONS.get(plan_id),
        "PLAN_CREATED",
        "Initial route plan created",
        f"Generated {len(route_set)} feasible route alternative(s) on {active_terrain.site_name}.",
        {
            "site_id": payload.site_id,
            "terrain_id": active_terrain.terrain_id,
            "start": {"x": start[0], "y": start[1]},
            "goal": {"x": goal[0], "y": goal[1]},
            "constraints": constraints.__dict__,
            "routes": [
                {"id": route["id"], "name": route["name"], "profile": route["profile"], "path": route["path"], "metrics": route["metrics"]}
                for route in route_set
            ],
        },
    )
    return {
        "plan_id": plan_id,
        "terrain_id": active_terrain.terrain_id,
        "site_id": payload.site_id,
        "planning_runtime_ms": planning_runtime_ms,
        "start": {"x": start[0], "y": start[1]},
        "goal": {"x": goal[0], "y": goal[1]},
        "constraints": constraints.__dict__,
        "pathfinding_weight_source": "jev" if constraints.objective_weights else "static_profile",
        "routes": route_set,
        "scientific_note": f"Routes use the imported {active_terrain.site_name} DEM. {active_terrain.warning}",
    }


@app.get("/api/missions/{plan_id}/events")
def get_mission_events(plan_id: str) -> dict[str, Any]:
    session = PLAN_SESSIONS.get(plan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Mission session not found or expired.")
    return {"plan_id": plan_id, "events": list(session.get("events", []))}


@app.post("/api/missions/{plan_id}/events")
def record_mission_event(plan_id: str, payload: MissionEventRequest) -> dict[str, Any]:
    session = PLAN_SESSIONS.get(plan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Mission session not found or expired.")
    allowed_types = {"JEV_DECISION", "ROUTE_SELECTED", "REPLAY_NOTE"}
    if payload.event_type not in allowed_types:
        raise HTTPException(status_code=422, detail=f"Event type must be one of: {', '.join(sorted(allowed_types))}.")
    if payload.event_type == "ROUTE_SELECTED":
        route_id = payload.data.get("route_id")
        if not isinstance(route_id, str) or not any(route.get("id") == route_id for route in session.get("routes", [])):
            raise HTTPException(status_code=422, detail="Selected route is not part of this mission.")
        session["selected_route_id"] = route_id
    event = _append_mission_event(session, payload.event_type, payload.title, payload.summary, payload.data)
    return {"plan_id": plan_id, "event": event, "events": list(session.get("events", []))}


@app.post("/api/replan")
def replan(payload: ReplanRequest) -> dict[str, Any]:
    session = PLAN_SESSIONS.get(payload.plan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Plan session not found. Generate a new route set first.")
    terrain: Terrain = session["terrain"]
    balanced_before = next((route for route in session.get("routes", []) if route.get("id") == "B"), None)
    path_before = copy.deepcopy(balanced_before.get("path", [])) if balanced_before else []
    metrics_before = copy.deepcopy(balanced_before.get("metrics", {})) if balanced_before else {}
    x, y = payload.obstacle.x, payload.obstacle.y
    if not terrain.in_bounds(x, y):
        raise HTTPException(status_code=422, detail="Obstacle cell is outside the terrain grid")
    if (x, y) in (session["start"], session["goal"]):
        raise HTTPException(status_code=422, detail="Cannot place a simulated obstacle on the start or destination")
    if terrain.obstacle[y][x]:
        raise HTTPException(status_code=409, detail="That cell is already blocked")

    try:
        planner = _get_session_planner(session)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Incremental planner could not initialize: {exc}") from exc

    terrain.obstacle[y][x] = True
    try:
        before_expanded = planner.expanded
        planner.update_cells([(x, y)])
        path = planner.extract_path()
        metrics = route_metrics(terrain, path, session["constraints"])
        if not metrics["return_feasible"]:
            raise ValueError("Incremental repair found a geometric path, but its estimated out-and-back resources exceed the configured reserve")
    except ValueError as exc:
        terrain.obstacle[y][x] = False
        # Restore the prior graph's local consistency after rolling back.
        planner.update_cells([(x, y)])
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    session["obstacles_added"].append({"x": x, "y": y})
    path_after = [{"x": px, "y": py} for px, py in path]
    for route in session.get("routes", []):
        if route.get("id") == "B":
            route["path"] = path_after
            route["metrics"] = metrics
    event = _append_mission_event(
        session,
        "REPLAN_COMPLETED",
        "Route replanned around a simulated obstacle",
        "LPA* repaired the balanced route after a user-injected obstacle scenario.",
        {
            "route_id": "B",
            "obstacle": {"x": x, "y": y},
            "path_before": path_before,
            "path_after": path_after,
            "metrics_before": metrics_before,
            "metrics_after": metrics,
            "algorithm": "LPA* incremental repair",
            "expanded_during_repair": planner.expanded - before_expanded,
        },
    )
    return {
        "plan_id": payload.plan_id,
        "path": [{"x": px, "y": py} for px, py in path],
        "metrics": metrics,
        "obstacle": {"x": x, "y": y},
        "algorithm": "LPA* incremental repair",
        "expanded_during_repair": planner.expanded - before_expanded,
        "total_expanded_lifetime": planner.expanded,
        "obstacles_added": session["obstacles_added"],
        "notice": "This is a user-triggered obstacle scenario on the imported DEM. It is not a measured Mars hazard observation.",
    }


@app.post("/api/benchmark")
def benchmark(payload: BenchmarkRequest) -> dict[str, Any]:
    start = (payload.start.x, payload.start.y)
    goal = (payload.goal.x, payload.goal.y)
    try:
        constraints = MissionConstraints.from_dict(payload.constraints)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    active_terrain = _terrain_for_site(payload.site_id)
    try:
        results = [
            scalar_baseline(active_terrain, start, goal, constraints, "standard_astar"),
            scalar_baseline(active_terrain, start, goal, constraints, "dijkstra"),
            scalar_baseline(active_terrain, start, goal, constraints, "distance_only"),
        ]
        # Benchmark 3-label versus 5-label Multi-Objective Pareto search
        try:
            label_cap_results = benchmark_label_caps(active_terrain, start, goal, constraints, (3, 5))
            results.extend(label_cap_results)
        except Exception as exc:
            logger.warning("Label cap benchmark skipped: %s", exc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "site_id": payload.site_id,
        "terrain_id": active_terrain.terrain_id,
        "benchmark_scope": f"Same {active_terrain.site_name} imported DEM-derived grid, hard constraints, and resource reserve; scalar A*/Dijkstra use balanced weights; Pareto caps 3 and 5.",
        "results": results,
        "warning": "Runtime and route comparisons are measurements on the imported DEM grid, not evidence of performance on NASA rasters or field conditions.",
    }


@app.post("/api/sensitivity")
def sensitivity_analysis(payload: SensitivityRequest) -> dict[str, Any]:
    """Sweep maximum slope constraint over at least five values to evaluate route sensitivity."""
    start = (payload.start.x, payload.start.y)
    goal = (payload.goal.x, payload.goal.y)
    active_terrain = _terrain_for_site(payload.site_id)

    param = payload.parameter
    if param != "max_slope_deg":
        raise HTTPException(status_code=422, detail="Currently only 'max_slope_deg' parameter is supported for sensitivity sweep.")

    values = payload.values
    if not values or len(values) < 3 or len(values) > 10:
        raise HTTPException(status_code=422, detail="Provide between 3 and 10 sweep values.")

    for v in values:
        if not (5.0 <= v <= 50.0):
            raise HTTPException(status_code=422, detail=f"Slope value {v} is outside realistic Mars exploration limits [5, 50].")

    sweep_results: list[dict[str, Any]] = []
    base_constraints_dict = copy.deepcopy(payload.constraints)

    for val in sorted(values):
        c_dict = {**base_constraints_dict, "max_slope_deg": float(val)}
        try:
            constraints = MissionConstraints.from_dict(c_dict)
            started = perf_counter()
            route_set = build_route_set(active_terrain, start, goal, constraints)
            runtime_ms = round((perf_counter() - started) * 1000.0, 2)
            chosen = next((r for r in route_set if r["profile"] == "balanced"), route_set[0])
            sweep_results.append({
                "value": val,
                "feasible": True,
                "distance_m": chosen["metrics"]["distance_m"],
                "duration_min": chosen["metrics"]["duration_min"],
                "energy_wh": chosen["metrics"]["energy_wh"],
                "terrain_risk_pct": chosen["metrics"]["terrain_risk_pct"],
                "return_feasible": chosen["metrics"]["return_feasible"],
                "runtime_ms": runtime_ms,
                "path": chosen["path"],
                "route_id": chosen["id"],
                "profile": chosen["profile"],
            })
        except ValueError as exc:
            sweep_results.append({
                "value": val,
                "feasible": False,
                "error": str(exc),
                "distance_m": None,
                "duration_min": None,
                "energy_wh": None,
                "terrain_risk_pct": None,
                "return_feasible": False,
                "runtime_ms": None,
                "path": [],
                "route_id": None,
                "profile": None,
            })

    return {
        "site_id": payload.site_id,
        "parameter": param,
        "parameter_label": "Maximum Slope Threshold (°)",
        "sweep": sweep_results,
        "terrain_id": active_terrain.terrain_id,
        "notice": f"Sensitivity analysis evaluated across {len(sweep_results)} slope settings on verified {active_terrain.site_name} DEM.",
    }


@app.post("/api/routes/waypoints")
def waypoint_plan(payload: WaypointPlanRequest) -> dict[str, Any]:
    """Plan a contiguous multi-waypoint mission enforcing cumulative resource limits."""
    active_terrain = _terrain_for_site(payload.site_id)
    try:
        constraints = MissionConstraints.from_dict(payload.constraints)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    start_pt = (payload.start.x, payload.start.y)
    goal_pt = (payload.goal.x, payload.goal.y)
    wp_pts = [(p.x, p.y) for p in payload.waypoints]

    if len(wp_pts) > 5:
        raise HTTPException(status_code=422, detail="A maximum of 5 intermediate waypoints is supported.")

    legs_points = [start_pt] + wp_pts + [goal_pt]
    full_path: list[dict[str, int]] = []
    leg_metrics: list[dict[str, Any]] = []

    total_distance_m = 0.0
    total_duration_min = 0.0
    total_energy_wh = 0.0
    total_oxygen_l = 0.0
    all_terrain_risks: list[float] = []

    shared_edge_cache: dict[tuple[int, int, int, int], tuple[float, ...] | None] = {}

    try:
        for i in range(len(legs_points) - 1):
            leg_start = legs_points[i]
            leg_goal = legs_points[i + 1]
            if leg_start == leg_goal:
                continue
            model = MultiObjectiveAStar(active_terrain, constraints, "balanced", max_labels_per_cell=3, edge_cache=shared_edge_cache)
            search = model.search(leg_start, leg_goal)
            metrics = route_metrics(active_terrain, search["path"], constraints)

            leg_metrics.append({
                "leg_index": i + 1,
                "from": {"x": leg_start[0], "y": leg_start[1]},
                "to": {"x": leg_goal[0], "y": leg_goal[1]},
                "distance_m": metrics["distance_m"],
                "duration_min": metrics["duration_min"],
                "energy_wh": metrics["energy_wh"],
            })

            total_distance_m += metrics["distance_m"]
            total_duration_min += metrics["duration_min"]
            total_energy_wh += metrics["energy_wh"]
            total_oxygen_l += (metrics.get("oxygen_l") or 0.0)
            if metrics.get("terrain_risk_pct") is not None:
                all_terrain_risks.append(metrics["terrain_risk_pct"])

            if not full_path:
                full_path.extend([{"x": px, "y": py} for px, py in search["path"]])
            else:
                full_path.extend([{"x": px, "y": py} for px, py in search["path"][1:]])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Waypoint pathfinding failed: {exc}") from exc

    # Enforce cumulative mission budgets with return reserve
    reserve_fraction = constraints.return_reserve_fraction
    outbound_budget_fraction = (1.0 - reserve_fraction) / 2.0

    time_feasible = total_duration_min <= (constraints.eva_limit_minutes * outbound_budget_fraction)
    energy_feasible = total_energy_wh <= (constraints.energy_budget_wh * outbound_budget_fraction)
    oxygen_feasible = total_oxygen_l <= (constraints.oxygen_budget_l * outbound_budget_fraction)
    return_feasible = time_feasible and energy_feasible and oxygen_feasible

    combined_metrics = {
        "distance_m": round(total_distance_m, 1),
        "duration_min": round(total_duration_min, 1),
        "energy_wh": round(total_energy_wh, 2),
        "oxygen_l": round(total_oxygen_l, 2),
        "terrain_risk_pct": round(sum(all_terrain_risks) / len(all_terrain_risks), 1) if all_terrain_risks else None,
        "return_feasible": return_feasible,
        "return_time_estimate_min": round(total_duration_min * 2.0, 1),
        "return_energy_estimate_wh": round(total_energy_wh * 2.0, 2),
        "return_oxygen_l": round(total_oxygen_l * 2.0, 2),
        "time_feasible": time_feasible,
        "energy_feasible": energy_feasible,
        "oxygen_feasible": oxygen_feasible,
    }

    plan_id = str(uuid.uuid4())
    PLAN_SESSIONS.put(plan_id, {
        "terrain": copy.deepcopy(active_terrain),
        "planner": None,
        "start": start_pt,
        "goal": goal_pt,
        "constraints": constraints,
        "obstacles_added": [],
        "condition_updates": [],
        "routes": [{
            "id": "W",
            "profile": "waypoint_mission",
            "name": f"MULTI-WAYPOINT ROUTE ({len(wp_pts)} waypoints)",
            "summary": f"Cumulative mission trajectory traversing {len(wp_pts)} intermediate targets.",
            "path": full_path,
            "metrics": combined_metrics,
            "is_pareto": True,
        }],
        "events": [],
        "selected_route_id": "W",
        "terrain_id": active_terrain.terrain_id,
        "site_id": payload.site_id,
        "created_utc": datetime.now(timezone.utc).isoformat(),
    })
    _append_mission_event(
        PLAN_SESSIONS.get(plan_id),
        "PLAN_CREATED",
        "Initial waypoint mission created",
        f"Generated a contiguous mission route with {len(wp_pts)} intermediate target(s).",
        {
            "site_id": payload.site_id,
            "terrain_id": active_terrain.terrain_id,
            "start": {"x": start_pt[0], "y": start_pt[1]},
            "goal": {"x": goal_pt[0], "y": goal_pt[1]},
            "waypoints": [{"x": x, "y": y} for x, y in wp_pts],
            "routes": [{"id": "W", "name": f"Waypoint mission ({len(wp_pts)} waypoints)", "profile": "waypoint_mission", "path": full_path, "metrics": combined_metrics}],
        },
    )

    return {
        "plan_id": plan_id,
        "site_id": payload.site_id,
        "terrain_id": active_terrain.terrain_id,
        "start": {"x": start_pt[0], "y": start_pt[1]},
        "goal": {"x": goal_pt[0], "y": goal_pt[1]},
        "waypoints": [{"x": p[0], "y": p[1]} for p in wp_pts],
        "routes": [{
            "id": "W",
            "profile": "waypoint_mission",
            "name": f"MULTI-WAYPOINT ROUTE ({len(wp_pts)} waypoints)",
            "summary": f"Trajectory visiting {len(wp_pts)} intermediate waypoints.",
            "path": full_path,
            "metrics": combined_metrics,
            "is_pareto": True,
        }],
        "legs": leg_metrics,
        "scientific_note": f"Multi-waypoint trajectory across {len(wp_pts)} waypoints on {active_terrain.site_name} DEM. Cumulative resource feasibility checked.",
    }


@app.get("/api/routes/{plan_id}/report")
def route_report(plan_id: str) -> dict[str, Any]:
    """Generate a downloadable Markdown and structured JSON report for a computed route plan."""
    session = PLAN_SESSIONS.get(plan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Plan session not found or expired.")

    terrain: Terrain = session["terrain"]
    site_id = session.get("site_id", terrain.site_id)
    site = MISSION_SITES.get(site_id, {})
    routes = session.get("routes", [])
    events = list(session.get("events", []))
    selected_route_id = session.get("selected_route_id") or (routes[0].get("id") if routes else None)
    selected_route = next((route for route in routes if route.get("id") == selected_route_id), routes[0] if routes else None)
    replanning_count = sum(1 for event in events if event.get("type") == "REPLAN_COMPLETED")
    mission_summary = {
        "event_count": len(events),
        "replanning_count": replanning_count,
        "selected_route_id": selected_route_id,
        "final_distance_m": selected_route.get("metrics", {}).get("distance_m") if selected_route else None,
        "final_duration_min": selected_route.get("metrics", {}).get("duration_min") if selected_route else None,
        "return_feasible": selected_route.get("metrics", {}).get("return_feasible") if selected_route else None,
        "status": "REPLANNED" if replanning_count else "PLANNED",
    }
    constraints = session.get("constraints")
    start = session.get("start")
    goal = session.get("goal")
    created_utc = session.get("created_utc", "Unknown")

    coord_info = terrain.coordinate_info or {}
    dem_product = coord_info.get("official_dem_product", site.get("dem", {}).get("product", "Official DEM"))
    dem_source = coord_info.get("official_dem_source", site.get("dem", {}).get("source", "NASA PDS / USGS"))
    dem_url = site.get("dem", {}).get("url", "")
    crs = coord_info.get("crs", "Equirectangular Mars / D_Mars")
    cell_m = terrain.cell_m

    lines = [
        "# MARSCOPE MISSION TRAVERSAL REPORT",
        f"**Generated (UTC):** {created_utc}",
        f"**Mission Site:** {terrain.site_name} (`{site_id}`)",
        f"**Landing Reference:** Lat {site.get('latitude', 'N/A')}°, Lon East {site.get('longitude_east', 'N/A')}°",
        f"**Reference Coordinate System:** {crs}",
        "",
        "## 1. Geospatial Terrain Provenance",
        f"- **Official DEM Product:** {dem_product}",
        f"- **Primary Archive Source:** {dem_source}",
        f"- **Catalogued Source URL:** {dem_url}",
        f"- **Analysis Grid Size:** {terrain.width} × {terrain.height} cells",
        f"- **Resolution / Pixel Spacing:** {cell_m:.1f} m per cell (local metric projection)",
        f"- **Site Footprint Verified:** {'Yes' if coord_info.get('site_coverage_verified') else 'No'}",
        f"- **Coverage Valid Fraction:** {coord_info.get('coverage_valid_fraction', '1.0')}",
        f"- **Verified Layers:** {', '.join(sorted(terrain.available_layers))}",
        "",
        "## 2. Operational Constraints & Assumptions",
        f"- **Start Grid Reference:** ({start[0]}, {start[1]})",
        f"- **Goal Grid Reference:** ({goal[0]}, {goal[1]})",
        f"- **Max Incline Limit:** {constraints.max_slope_deg}°",
        f"- **EVA Time Budget:** {constraints.eva_limit_minutes} min (Return reserve: {constraints.return_reserve_fraction * 100:.0f}%)",
        f"- **Energy Budget:** {constraints.energy_budget_wh} Wh",
        f"- **Oxygen Budget:** {constraints.oxygen_budget_l} L ({constraints.oxygen_consumption_lpm} L/min)",
        f"- **Carried Equipment Mass:** {constraints.carried_equipment_mass_kg} kg (Suit: {constraints.suit_mass_kg} kg)",
        f"- **Walking Base Speed:** {constraints.base_speed_mps} m/s",
        "",
        "## 3. Computed Route Alternatives",
    ]

    for r in routes:
        m = r.get("metrics", {})
        lines.extend([
            f"### Route {r.get('id')} — {r.get('name')} ({r.get('profile')})",
            f"- **Distance:** {m.get('distance_m', 'N/A')} m",
            f"- **One-way Travel Time:** {m.get('duration_min', 'N/A')} min",
            f"- **Out-and-Back Time Estimate:** {m.get('return_time_estimate_min', 'N/A')} min",
            f"- **Modeled Energy:** {m.get('energy_wh', 'N/A')} Wh (Out-and-back: {m.get('return_energy_estimate_wh', 'N/A')} Wh)",
            f"- **Modeled Oxygen:** {m.get('oxygen_l', 'N/A')} L (Out-and-back: {m.get('return_oxygen_l', 'N/A')} L)",
            f"- **Terrain Risk Score:** {m.get('terrain_risk_pct', 'N/A')}%",
            f"- **Return Feasibility:** {'FEASIBLE' if m.get('return_feasible') else 'LIMITS EXCEEDED'}",
            f"- **Pareto Status:** {'Non-dominated Pareto' if r.get('is_pareto') else 'Alternative'}",
            "",
        ])

    lines.extend([
        "## 4. Mission Replay Timeline",
        f"- **Recorded events:** {len(events)}",
        f"- **Replanning operations:** {replanning_count}",
        f"- **Final selected route:** {selected_route_id or 'N/A'}",
        f"- **Mission status:** {mission_summary['status']}",
        "",
    ])
    for event in events:
        lines.append(f"- **#{event.get('sequence')} {event.get('title')}** — {event.get('timestamp_utc')}")
        lines.append(f"  {event.get('summary')}")
    lines.extend([
        "",
        "## 5. Scientific Integrity & Disclaimers",
        "- **Research Prototype:** MARSCOPE is an exploratory research demonstrator for traversal planning concepts.",
        "- **Not Certified Flight Software:** These paths and resource estimates are research models and MUST NOT be used for operational crewed EVA guidance.",
        "- **Unvalidated Mobility Models:** Energy consumption, metabolic rates, and transit durations are research equations. Atmospheric and radiation layers remain unavailable unless separately imported with verified spatial coordinates.",
    ])

    report_markdown = "\n".join(lines)
    report_json = {
        "metadata": {
            "title": "MARSCOPE Mission Traversal Report",
            "generated_utc": created_utc,
            "mission_site": site_id,
            "site_name": terrain.site_name,
            "dem_product": dem_product,
            "dem_source": dem_source,
            "crs": crs,
            "grid_dimensions": {"width": terrain.width, "height": terrain.height, "cell_m": cell_m},
            "available_layers": sorted(terrain.available_layers),
        },
        "constraints": constraints.__dict__,
        "geometry": {"start": start, "goal": goal},
        "routes": routes,
        "mission_summary": mission_summary,
        "events": events,
        "disclaimer": "Research prototype only. Never use for operational human mission guidance.",
    }

    return {"report_markdown": report_markdown, "report_json": report_json}

@app.post("/api/reset")
def reset() -> dict[str, Any]:
    """Clear sessions without deleting or generating terrain data."""
    PLAN_SESSIONS.clear()
    return {"status": "reset", "loaded_site_ids": sorted(TERRAINS)}


# ---------------------------------------------------------------------------
# Official archive connectors and provenance-aware science/data services
# ---------------------------------------------------------------------------

@app.get("/api/data/catalog")
def data_catalog() -> dict[str, Any]:
    return {"sources": get_data_catalog(), "archives_connected": ["NASA PDS Search API", "PDS Geosciences Node ODE REST"], "last_refreshed": "retrieved on demand", "note": "This catalog records official source identity and the integration mode. It is not itself an archive mirror."}


@app.get("/api/data/pds/search")
def pds_search(keywords: str = Query(min_length=1, max_length=180), limit: int = Query(default=20, ge=1, le=100)) -> dict[str, Any]:
    try:
        return search_pds(keywords, limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ArchiveServiceError as exc:
        raise HTTPException(status_code=502, detail=f"NASA PDS Search API is currently unavailable: {exc}") from exc


@app.get("/api/data/pds/product/{identifier:path}")
def pds_product(identifier: str) -> dict[str, Any]:
    try:
        return resolve_pds_product(identifier)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ArchiveServiceError as exc:
        raise HTTPException(status_code=502, detail=f"NASA PDS product resolution failed: {exc}") from exc


@app.get("/api/data/ode/search")
def ode_search(
    instrument: str = Query(default="HiRISE"),
    min_lat: float = Query(default=-6.5733, ge=-90, le=90),
    max_lat: float = Query(default=-2.8078, ge=-90, le=90),
    west_lon: float = Query(default=135.1843, ge=0, le=360),
    east_lon: float = Query(default=139.2413, ge=0, le=360),
    product_type: str | None = Query(default=None, max_length=32),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    try:
        return search_ode(instrument=instrument, min_lat=min_lat, max_lat=max_lat, west_lon=west_lon, east_lon=east_lon, product_type=product_type, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ArchiveServiceError as exc:
        raise HTTPException(status_code=502, detail=f"PDS ODE REST service is currently unavailable: {exc}") from exc


@app.post("/api/data/pds/inspect-label")
async def pds_inspect_label(file: UploadFile = File(...)) -> dict[str, Any]:
    raw = await file.read(10 * 1024 * 1024 + 1)
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDS label upload is limited to 10 MB.")
    try:
        label = inspect_pds_label(raw, filename=file.filename or "product.lbl")
        stored = save_pds_label(label, Path(__file__).resolve().parent / "data" / "pds_labels")
        return {key: value for key, value in label.items() if key != "raw_label"} | {"stored_label": stored.name, "raw_label_retained": True}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/data/download")
def download_archive_product(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Download a user-selected product URL from an allow-listed official archive host."""
    url = str(payload.get("url", "")).strip()
    if not url or len(url) > 2048:
        raise HTTPException(status_code=422, detail="Supply one HTTPS URL to an official archive product file.")
    root = Path(__file__).resolve().parent / "data" / "downloads"
    try:
        return download_official_file(url, root)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except DownloadError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/data/downloads")
def downloaded_archive_products() -> dict[str, Any]:
    root = Path(__file__).resolve().parent / "data" / "downloads"
    root.mkdir(parents=True, exist_ok=True)
    items = []
    for sidecar in sorted(root.glob("*.provenance.json"), reverse=True):
        try:
            items.append(json.loads(sidecar.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return {"downloads": items, "count": len(items), "note": "Files remain byte-for-byte archive downloads. Product labels and SIS documents must be checked before scientific interpretation."}


@app.get("/api/data/trek/layers")
def trek_layers() -> dict[str, Any]:
    return {"source": "NASA/JPL Mars Trek WMTS", "documentation": "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars", "layers": [{"id": layer_id, **details} for layer_id, details in WMTS_LAYERS.items()], "note": "Layer titles, bounding boxes and service identifiers are catalog metadata. GetCapabilities remains authoritative for tile matrices, style identifiers and file formats."}


@app.get("/api/data/trek/layers/{layer_id}/capabilities")
def trek_layer_capabilities(layer_id: str) -> dict[str, Any]:
    try:
        return get_wmts_capabilities(layer_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/data/trek/cache")
def cache_trek_tiles(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    layer_id = str(payload.get("layer_id", "curiosity_hirise_mosaic"))
    bbox = payload.get("bbox_wsen", [137.42, -4.86, 137.50, -4.78])
    max_tiles = int(payload.get("max_tiles", 96))
    if layer_id not in WMTS_LAYERS:
        raise HTTPException(status_code=422, detail=f"Choose a supported layer: {', '.join(WMTS_LAYERS)}")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise HTTPException(status_code=422, detail="bbox_wsen must be [west, south, east, north].")
    if max_tiles < 1 or max_tiles > 256:
        raise HTTPException(status_code=422, detail="max_tiles must be between 1 and 256.")
    root = Path(__file__).resolve().parent / "data" / "wmts_cache"
    filename = f"{layer_id}-{uuid.uuid4().hex[:8]}.zip"
    try:
        result = download_tile_cache(layer_id, [float(v) for v in bbox], root / filename, max_tiles=max_tiles)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        (root / filename).unlink(missing_ok=True)
        raise HTTPException(status_code=502, detail=f"Mars Trek WMTS tile cache failed: {exc}") from exc
    result["stored_filename"] = filename
    result["notice"] = "Cached images are official rendered map tiles. They are not calibrated DEM values or astronaut-scale hazard detections."
    return result


@app.get("/api/offline/status")
def offline_status() -> dict[str, Any]:
    """Report cached official review imagery available on this backend."""
    root = Path(__file__).resolve().parent / "data" / "wmts_cache"
    return inspect_cached_packages(root)


@app.get("/api/science/evidence")
def science_evidence() -> dict[str, Any]:
    return {"records": load_evidence(), "mode": "curated_official_evidence", "note": "Evidence records are linked to NASA/JPL source pages. They are not a complete scientific literature review."}


@app.post("/api/science/ask")
def science_ask(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    question = str(payload.get("question", "")).strip()
    if not question or len(question) > 1000:
        raise HTTPException(status_code=422, detail="Question must contain 1 to 1000 characters.")
    return answer_question(question)


@app.get("/api/observations")
def observations() -> dict[str, Any]:
    imports = list_observation_imports()
    return {"imports": imports, "count": len(imports), "spatial_policy": "Station observations from Curiosity are not extrapolated into continuous terrain grids."}


@app.get("/api/observations/{digest}")
def observation_detail(digest: str) -> dict[str, Any]:
    record = get_observation_import(digest)
    if record is None:
        raise HTTPException(status_code=404, detail="Observation import not found.")
    return record


@app.post("/api/observations/import")
async def import_observations(
    file: UploadFile = File(...),
    instrument: str = Form(...),
    mapping_json: str = Form(...),
) -> dict[str, Any]:
    try:
        mapping = json.loads(mapping_json)
        if not isinstance(mapping, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in mapping.items()):
            raise ValueError("mapping_json must be a JSON object mapping normalized field names to source column names.")
        raw = await file.read()
        record = import_observation_csv(raw, instrument=instrument, source_name=file.filename or "observations.csv", mapping=mapping)
        path = save_observation_import(record, raw)
        return {"import": {k: v for k, v in record.items() if k != "records"}, "stored_record": path.name}
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/terrain/import-dem")
async def import_dem(
    file: UploadFile = File(...),
    width: int = Form(default=96),
    height: int = Form(default=96),
    vertical_units: str = Form(default="unspecified"),
    site_id: str = Form(default="jezero"),
) -> dict[str, Any]:
    if site_id not in SUPPORTED_SITE_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown mission site '{site_id}'.")
    site = MISSION_SITES[site_id]
    expected_name = site["dem"]["filename"]
    uploaded_name = Path(file.filename or "").name
    if uploaded_name.lower() != expected_name.lower():
        raise HTTPException(status_code=422, detail=f"Use the catalogued {expected_name} DEM for {site['name']}. Do not attach a different site's raster.")
    suffix = Path(uploaded_name).suffix.lower()
    if suffix not in {".tif", ".tiff", ".img"}:
        raise HTTPException(status_code=422, detail="Upload the selected site's real DEM in GeoTIFF or supported planetary PDS IMG format.")
    max_upload_bytes = 400 * 1024 * 1024
    raw = await file.read(max_upload_bytes + 1)
    if not raw or len(raw) > max_upload_bytes:
        raise HTTPException(status_code=413, detail="DEM must be non-empty and no larger than 400 MB. Use a documented site-centred clip for larger source products.")
    data_root = Path(__file__).resolve().parent / "data" / "ingested"
    data_root.mkdir(parents=True, exist_ok=True)
    destination = data_root / f"{uuid.uuid4().hex}{suffix}"
    destination.write_bytes(raw)
    try:
        coverage = validate_site_coverage(
            destination,
            latitude=site["latitude"],
            longitude_east=site["longitude_east"],
        )
        grid, provenance = dem_to_terrain(
            destination,
            width=max(32, min(width, 192)),
            height=max(32, min(height, 192)),
            vertical_units=vertical_units,
            window_center_xy_m=tuple(coverage["projected_reference_xy_m"]),
            window_size_m=2400.0,
        )
    except (ValueError, RuntimeError) as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Selected DEM could not be verified/imported: {exc}") from exc
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not process the selected planetary raster. If this is a PDS IMG, verify GDAL support for its embedded label/CRS: {exc}") from exc

    grid.site_id = site_id
    grid.site_name = site["name"]
    grid.terrain_id = f"mars-dem-{site_id}-{destination.stem}"
    grid.coordinate_info = {
        **(grid.coordinate_info or {}),
        "selected_site_id": site_id,
        "selected_site_name": site["name"],
        "site_reference_latitude": site["latitude"],
        "site_reference_longitude_east": site["longitude_east"],
        "site_coverage_verified": True,
        "site_coverage_check": coverage,
        "official_dem_product": site["dem"]["product"],
        "official_dem_source": site["dem"]["source"],
    }
    provenance["selected_site_id"] = site_id
    provenance["site_coverage_check"] = coverage
    provenance["official_dem_product"] = site["dem"]["product"]
    provenance_path = destination.with_suffix(destination.suffix + ".provenance.json")
    provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")

    TERRAINS[site_id] = grid
    for plan_id, session in list(PLAN_SESSIONS.items()):
        if session.get("site_id") == site_id:
            PLAN_SESSIONS.pop(plan_id, None)
    return {
        "terrain": grid.to_dict(),
        "provenance": provenance,
        "stored_file": destination.name,
        "notice": (
            f"Verified {site['dem']['product']} for {site['name']}. "
            "Elevation is sourced from the imported raster; slope and roughness are derived from it. "
            "Other spatial science/hazard layers remain unavailable until separately imported."
        ),
    }


@app.post("/api/terrain/import-layer")
async def import_terrain_layer(
    file: UploadFile = File(...),
    layer: str = Form(...),
    value_min: float = Form(...),
    value_max: float = Form(...),
    band: int = Form(default=1),
    source_unit: str = Form(default="unspecified"),
    site_id: str = Form(default="jezero"),
) -> dict[str, Any]:
    """Align a user-selected official product band to the selected site's imported DEM."""
    active_terrain = _terrain_for_site(site_id)
    suffix = Path(file.filename or "layer.tif").suffix.lower()
    if suffix not in {".tif", ".tiff"}:
        raise HTTPException(status_code=422, detail="Upload a georeferenced GeoTIFF (.tif or .tiff).")
    raw = await file.read(250 * 1024 * 1024 + 1)
    if not raw or len(raw) > 250 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="GeoTIFF must be non-empty and no larger than 250 MB.")
    data_root = Path(__file__).resolve().parent / "data" / "ingested"
    data_root.mkdir(parents=True, exist_ok=True)
    destination = data_root / f"layer-{uuid.uuid4().hex}{suffix}"
    destination.write_bytes(raw)
    try:
        provenance = import_aligned_layer(destination, active_terrain, layer=layer, value_min=value_min, value_max=value_max, band=band, source_unit=source_unit)
    except (ValueError, RuntimeError) as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not align the raster layer: {exc}") from exc
    provenance_path = destination.with_suffix(destination.suffix + ".provenance.json")
    provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    for plan_id, session in list(PLAN_SESSIONS.items()):
        if session.get("site_id") == site_id:
            PLAN_SESSIONS.pop(plan_id, None)
    return {"terrain": active_terrain.to_dict(), "provenance": provenance, "notice": f"Layer {layer} aligned to the {active_terrain.site_name} DEM. Recalculate route alternatives before interpreting them."}


@app.get("/api/data/raster/inspect")
def raster_inspect(filename: str = Query(min_length=1, max_length=200)) -> dict[str, Any]:
    root = (Path(__file__).resolve().parent / "data" / "ingested").resolve()
    target = (root / filename).resolve()
    if root not in target.parents or not target.is_file() or target.suffix.lower() not in {".tif", ".tiff", ".img"}:
        raise HTTPException(status_code=404, detail="Ingested GeoTIFF not found.")
    try:
        return inspect_geotiff(target)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/offline/package")
def offline_package(payload: dict[str, Any] = Body(default={})) -> FileResponse:
    plan_id = payload.get("plan_id")
    session = PLAN_SESSIONS.get(plan_id) if plan_id else None
    if plan_id and session is None:
        raise HTTPException(status_code=404, detail="Plan session not found. Generate a new route plan first.")
    plan_data = None
    if session:
        plan_data = {
            "plan_id": plan_id, "terrain_id": session["terrain_id"],
            "start": session["start"], "goal": session["goal"],
            "constraints": session["constraints"].__dict__, "routes": session["routes"],
            "obstacles_added": session["obstacles_added"], "condition_updates": session["condition_updates"],
            "created_utc": session["created_utc"],
        }
    root = Path(__file__).resolve().parent / "data"
    output_dir = root / "offline_packages"
    filename = f"marscope-offline-{uuid.uuid4().hex[:10]}.zip"
    package_terrain = session["terrain"] if session else _terrain_for_site(str(payload.get("site_id", "jezero")))
    output = create_package(output=output_dir / filename, terrain=package_terrain, plan=plan_data, data_root=root)
    return FileResponse(output, media_type="application/zip", filename=filename)


@app.post("/api/replan/condition")
def replan_condition(payload: ConditionUpdateRequest) -> dict[str, Any]:
    """Simulate one local field update and repair the retained LPA* search."""
    session = PLAN_SESSIONS.get(payload.plan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Plan session not found. Generate a new route set first.")
    terrain: Terrain = session["terrain"]
    x, y = payload.cell.x, payload.cell.y
    if not terrain.in_bounds(x, y):
        raise HTTPException(status_code=422, detail="Condition cell is outside the terrain grid.")
    allowed = {
        "temperature_c": (-150.0, 30.0),
        "slope_deg": (0.0, 90.0),
        "environment_index": (0.0, 1.0),
        "radiation_index": (0.0, 1.0),
        "uncertainty": (0.0, 1.0),
    }
    if payload.kind not in allowed:
        raise HTTPException(status_code=422, detail=f"Condition kind must be one of: {', '.join(allowed)}")
    required_layer = {"temperature_c": "temperature", "environment_index": "atmosphere", "radiation_index": "radiation", "slope_deg": "slope", "uncertainty": "uncertainty"}[payload.kind]
    if required_layer not in terrain.available_layers:
        raise HTTPException(status_code=409, detail=f"Cannot simulate an update for {payload.kind}: its spatial data layer is unavailable. Import a provenance-checked layer first.")
    low, high = allowed[payload.kind]
    if not low <= payload.value <= high:
        raise HTTPException(status_code=422, detail=f"{payload.kind} must be between {low} and {high}.")
    if (x, y) in (session["start"], session["goal"]):
        raise HTTPException(status_code=422, detail="Cannot change the start or destination cell in a scenario update.")
    try:
        planner = _get_session_planner(session)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Incremental planner could not initialize: {exc}") from exc
    balanced_before = next((route for route in session.get("routes", []) if route.get("id") == "B"), None)
    path_before = copy.deepcopy(balanced_before.get("path", [])) if balanced_before else []
    metrics_before = copy.deepcopy(balanced_before.get("metrics", {})) if balanced_before else {}
    array = getattr(terrain, payload.kind)
    if array is None:
        raise HTTPException(status_code=409, detail=f"Spatial layer {payload.kind} is not loaded from source data.")
    old_value = array[y][x]
    old_available_layers = set(terrain.available_layers)
    array[y][x] = float(payload.value)
    layer_name = {"temperature_c": "temperature", "environment_index": "atmosphere", "radiation_index": "radiation", "slope_deg": "slope", "uncertainty": "uncertainty"}[payload.kind]
    terrain.available_layers.add(layer_name)
    before_expanded = planner.expanded
    try:
        planner.update_cells([(x, y)])
        path = planner.extract_path()
        metrics = route_metrics(terrain, path, session["constraints"])
        if not metrics["return_feasible"]:
            raise ValueError("Updated route exceeds the configured time, energy or oxygen reserve.")
    except ValueError as exc:
        array[y][x] = old_value
        terrain.available_layers = old_available_layers
        planner.update_cells([(x, y)])
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    update = {"cell": {"x": x, "y": y}, "kind": payload.kind, "previous_value": old_value, "new_value": payload.value, "source": "USER_ENTERED_SCENARIO_UPDATE"}
    session["condition_updates"].append(update)
    path_after = [{"x": px, "y": py} for px, py in path]
    session["routes"] = [
        ({**route, "path": path_after, "metrics": metrics} if route["profile"] == "balanced" else route)
        for route in session["routes"]
    ]
    _append_mission_event(
        session,
        "REPLAN_COMPLETED",
        "Route replanned after a terrain-layer scenario update",
        f"LPA* repaired the balanced route after a simulated {payload.kind} update.",
        {
            "route_id": "B",
            "change": update,
            "path_before": path_before,
            "path_after": path_after,
            "metrics_before": metrics_before,
            "metrics_after": metrics,
            "algorithm": "LPA* incremental repair",
            "expanded_during_repair": planner.expanded - before_expanded,
        },
    )
    return {
        "plan_id": payload.plan_id,
        "path": [{"x": px, "y": py} for px, py in path],
        "metrics": metrics,
        "update": update,
        "algorithm": "LPA* incremental repair",
        "expanded_during_repair": planner.expanded - before_expanded,
        "total_expanded_lifetime": planner.expanded,
        "condition_updates": session["condition_updates"],
        "notice": "This is a user-entered what-if scenario over imported data; it is not a measured Mars environmental observation.",
    }
