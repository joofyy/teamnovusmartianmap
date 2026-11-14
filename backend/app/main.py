from __future__ import annotations

import copy
import json
import os
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .benchmarks import scalar_baseline
from .lpa import LPAStar
from .models import BenchmarkRequest, ConditionUpdateRequest, PlanRequest, ReplanRequest
from .planner import MissionConstraints, build_route_set, route_metrics
from .registry import get_registry
from .terrain import Terrain, generate_terrain
from .sites import SITE_IDS, get_site, get_site_catalog
from .data_catalog import get_data_catalog
from .services.archive_clients import ArchiveServiceError, search_pds, resolve_pds_product, search_ode
from .domain.science_assistant import answer_question, load_evidence
from .domain.observation_ingest import import_observation_csv
from .domain.observation_store import save_observation_import, list_observation_imports, get_observation_import
from .domain.raster_pipeline import dem_to_terrain, inspect_geotiff, import_aligned_layer
from .domain.offline_package import create_package
from .domain.pds_labels import inspect_label as inspect_pds_label, save_label as save_pds_label
from .services.wmts import LAYERS as WMTS_LAYERS, get_capabilities as get_wmts_capabilities, download_tile_cache, inspect_cached_packages
from .services.official_downloads import download_official_file, DownloadError

app = FastAPI(
    title="MARSCOPE API",
    version="0.3.1",
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TERRAIN: Terrain = generate_terrain()
SITE_TERRAINS: dict[str, Terrain] = {"gale": TERRAIN}
PLAN_SESSIONS: dict[str, dict[str, Any]] = {}


def _get_session_planner(session: dict[str, Any]) -> LPAStar:
    """Create and retain LPA* only when a session needs incremental repair."""
    planner = session.get("planner")
    if planner is None:
        planner = LPAStar(
            session["terrain"],
            session["start"],
            session["goal"],
            session["constraints"],
        )
        # Fail before mutating the session terrain if no route can be established.
        planner.extract_path()
        session["planner"] = planner
    return planner



def _terrain_for_site(site_id: str) -> Terrain:
    if site_id not in SITE_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown landing site '{site_id}'.")
    selected = SITE_TERRAINS.get(site_id)
    if selected is None:
        site = get_site(site_id)
        dem = site["dem"]
        raise HTTPException(
            status_code=409,
            detail=(
                f"No terrain DEM is loaded for {site['name']}. Download "
                f"{dem['name']} ({dem['format']}, {dem['size_mb']} MB) from "
                f"{dem['download_url']} and import it in DATA → Import a verified Mars DEM."
            ),
        )
    return selected


@app.get("/api/sites")
def sites() -> dict[str, Any]:
    return {"sites": get_site_catalog(SITE_TERRAINS), "note": "A site is route-ready only after its source DEM has been imported and passed CRS/body checks. Downloading a product does not itself load it into the planner."}

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
            "vertical_units": "metres (verify source label before import)",
        },
        "points": [
            {"id": "jezero-centre", "name": "Jezero Crater Centre", "latitude": 18.4100, "longitude_east": 77.6900, "precision": "approximate reference point", "description": "Regional reference point for the Jezero study area."},
            {"id": "perseverance-landing", "name": "Perseverance Landing Site", "latitude": 18.44463, "longitude_east": 77.45088, "precision": "published landing-site coordinate", "description": "Rover landing location in Jezero Crater."},
            {"id": "neretva-vallis", "name": "Neretva Vallis", "latitude": 18.4006, "longitude_east": 77.1860, "precision": "approximate reference point", "description": "Western inlet-channel area."},
            {"id": "western-delta", "name": "Western Delta Area", "latitude": 18.3512, "longitude_east": 77.2757, "precision": "approximate reference point", "description": "Western delta study area."},
        ],
        "notice": "These are geographic reference points, not verified pixels or grid coordinates. Route planning remains on the currently active terrain grid until a CRS-checked Jezero DEM is imported and mapped to the planner grid.",
    }

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "project": "MARSCOPE", "release": "0.3.1"}

@app.get("/api/terrain")
def terrain(site_id: str = Query(default="gale", min_length=1, max_length=32)) -> dict[str, Any]:
    return _terrain_for_site(site_id).to_dict()

@app.get("/api/registry")
def registry() -> dict[str, Any]:
    return {
        "datasets": get_registry(),
        "common_coordinate_policy": {
            "recommended_analysis_coordinates": "Local metric working CRS derived from a verified Mars planetary CRS and a site-centred projection.",
            "mars_longitude_latitude": "Preserve planetocentric latitude and east-positive longitude for modern products unless the product label explicitly specifies another convention.",
            "warning": "The synthetic demo tile has no latitude/longitude and cannot be overlaid on orbital imagery.",
        },
    }

@app.post("/api/routes")
def routes(payload: PlanRequest) -> dict[str, Any]:
    start = (payload.start.x, payload.start.y)
    goal = (payload.goal.x, payload.goal.y)
    selected_terrain = _terrain_for_site(payload.site_id)
    try:
        constraints = MissionConstraints.from_dict(payload.constraints)
        route_set = build_route_set(selected_terrain, start, goal, constraints)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Copy only the selected site's terrain and defer LPA* construction until
    # a replanning action is requested.
    session_terrain = copy.deepcopy(selected_terrain)
    plan_id = str(uuid.uuid4())
    PLAN_SESSIONS[plan_id] = {
        "terrain": session_terrain,
        "planner": None,
        "start": start,
        "goal": goal,
        "constraints": constraints,
        "obstacles_added": [],
        "condition_updates": [],
        "routes": route_set,
        "site_id": payload.site_id,
        "terrain_id": selected_terrain.terrain_id,
        "created_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }

    return {
        "plan_id": plan_id,
        "site_id": payload.site_id,
        "terrain_id": selected_terrain.terrain_id,
        "start": {"x": start[0], "y": start[1]},
        "goal": {"x": goal[0], "y": goal[1]},
        "constraints": constraints.__dict__,
        "routes": route_set,
        "scientific_note": ("All route results use the selected site terrain. " + session_terrain.warning),
    }

@app.post("/api/replan")
def replan(payload: ReplanRequest) -> dict[str, Any]:
    session = PLAN_SESSIONS.get(payload.plan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Plan session not found. Generate a new route set first.")
    terrain: Terrain = session["terrain"]
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
        raise HTTPException(status_code=422, detail=f"Incremental planner could not establish a route: {exc}") from exc

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
    return {
        "plan_id": payload.plan_id,
        "path": [{"x": px, "y": py} for px, py in path],
        "metrics": metrics,
        "obstacle": {"x": x, "y": y},
        "algorithm": "LPA* incremental repair",
        "expanded_during_repair": planner.expanded - before_expanded,
        "total_expanded_lifetime": planner.expanded,
        "obstacles_added": session["obstacles_added"],
        "notice": "This is a simulated obstacle injection on synthetic terrain. It is not a real hazard report.",
    }


@app.post("/api/benchmark")
def benchmark(payload: BenchmarkRequest) -> dict[str, Any]:
    start = (payload.start.x, payload.start.y)
    goal = (payload.goal.x, payload.goal.y)
    selected_terrain = _terrain_for_site(payload.site_id)
    try:
        constraints = MissionConstraints.from_dict(payload.constraints)
        results = [
            scalar_baseline(selected_terrain, start, goal, constraints, "standard_astar"),
            scalar_baseline(selected_terrain, start, goal, constraints, "dijkstra"),
            scalar_baseline(selected_terrain, start, goal, constraints, "distance_only"),
        ]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "benchmark_scope": f"Selected site {payload.site_id}; same terrain, hard constraints, and resource reserve; scalar A*/Dijkstra use balanced weights.",
        "results": results,
        "warning": "Runtime and route comparisons apply only to this imported terrain grid and the illustrative planner model; they are not field-navigation validation.",
    }

@app.post("/api/reset")
def reset() -> dict[str, str]:
    global TERRAIN, SITE_TERRAINS
    TERRAIN = generate_terrain()
    SITE_TERRAINS = {"gale": TERRAIN}
    PLAN_SESSIONS.clear()
    return {"status": "reset", "terrain_id": "gale-demo-synthetic-01"}


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
    site_id: str = Form(default="gale"),
) -> dict[str, Any]:
    global TERRAIN
    if site_id not in SITE_IDS:
        raise HTTPException(status_code=422, detail=f"Choose one of the supported sites: {', '.join(sorted(SITE_IDS))}.")
    suffix = Path(file.filename or "terrain.tif").suffix.lower()
    if suffix not in {".tif", ".tiff", ".img"}:
        raise HTTPException(status_code=422, detail="Upload the selected site's GeoTIFF (.tif/.tiff) or HiRISE PDS DTM (.img).")
    max_upload_bytes = 400 * 1024 * 1024
    raw = await file.read(max_upload_bytes + 1)
    if not raw or len(raw) > max_upload_bytes:
        raise HTTPException(status_code=413, detail="DEM must be non-empty and no larger than 400 MB. For larger products, use a smaller regional DEM or prepare a documented clip locally.")
    data_root = Path(__file__).resolve().parent / "data" / "ingested"
    data_root.mkdir(parents=True, exist_ok=True)
    destination = data_root / f"{uuid.uuid4().hex}{suffix}"
    destination.write_bytes(raw)
    try:
        grid, provenance = dem_to_terrain(destination, width=max(32, min(width, 192)), height=max(32, min(height, 192)), vertical_units=vertical_units)
    except (ValueError, RuntimeError) as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not process the GeoTIFF: {exc}") from exc
    provenance_path = destination.with_suffix(destination.suffix + ".provenance.json")
    provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    grid.coordinate_info["site_id"] = site_id
    grid.coordinate_info["official_dem_product"] = get_site(site_id)["dem"]["name"]
    provenance["selected_site_id"] = site_id
    SITE_TERRAINS[site_id] = grid
    TERRAIN = grid
    PLAN_SESSIONS.clear()
    return {"terrain": grid.to_dict(), "provenance": provenance, "stored_file": destination.name, "notice": f"Real elevation grid imported for {get_site(site_id)['name']}. Slope and roughness are derived from the DEM; other spatial science/hazard layers remain unavailable unless separately imported."}


@app.post("/api/terrain/import-layer")
async def import_terrain_layer(
    file: UploadFile = File(...),
    layer: str = Form(...),
    value_min: float = Form(...),
    value_max: float = Form(...),
    band: int = Form(default=1),
    source_unit: str = Form(default="unspecified"),
    site_id: str = Form(default="gale"),
) -> dict[str, Any]:
    """Align a user-selected official product band to the selected site's DEM."""
    global TERRAIN
    selected_terrain = _terrain_for_site(site_id)
    if selected_terrain.status == "SIMULATED_NOT_GEOREFERENCED":
        raise HTTPException(status_code=409, detail="Import a verified Mars DEM before adding aligned raster layers.")
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
        provenance = import_aligned_layer(destination, selected_terrain, layer=layer, value_min=value_min, value_max=value_max, band=band, source_unit=source_unit)
    except (ValueError, RuntimeError) as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not align the raster layer: {exc}") from exc
    provenance_path = destination.with_suffix(destination.suffix + ".provenance.json")
    provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    if site_id == "gale":
        TERRAIN = selected_terrain
    PLAN_SESSIONS.clear()
    return {"terrain": selected_terrain.to_dict(), "provenance": provenance, "notice": f"Layer {layer} aligned to the active DEM. Recalculate route alternatives before interpreting them."}


@app.get("/api/data/raster/inspect")
def raster_inspect(filename: str = Query(min_length=1, max_length=200)) -> dict[str, Any]:
    root = (Path(__file__).resolve().parent / "data" / "ingested").resolve()
    target = (root / filename).resolve()
    if root not in target.parents or not target.is_file() or target.suffix.lower() not in {".tif", ".tiff"}:
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
    package_terrain = session["terrain"] if session else TERRAIN
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
        raise HTTPException(status_code=422, detail=f"Incremental planner could not establish a route: {exc}") from exc
    array = getattr(terrain, payload.kind)
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
    update = {"cell": {"x": x, "y": y}, "kind": payload.kind, "previous_value": old_value, "new_value": payload.value, "source": "SIMULATED_SCENARIO_UPDATE"}
    session["condition_updates"].append(update)
    session["routes"] = [
        ({**route, "path": [{"x": px, "y": py} for px, py in path], "metrics": metrics} if route["profile"] == "balanced" else route)
        for route in session["routes"]
    ]
    return {
        "plan_id": payload.plan_id,
        "path": [{"x": px, "y": py} for px, py in path],
        "metrics": metrics,
        "update": update,
        "algorithm": "LPA* incremental repair",
        "expanded_during_repair": planner.expanded - before_expanded,
        "total_expanded_lifetime": planner.expanded,
        "condition_updates": session["condition_updates"],
        "notice": "This is a simulated local condition update, not a live Mars weather or hazard observation.",
    }
