"""Validated GeoTIFF inspection and DEM-to-route-grid conversion."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

import numpy as np


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_mars_ellipsoid(semi_major_m: float, semi_minor_m: float) -> bool:
    mars_equatorial = abs(semi_major_m - 3396190.0) <= 15000.0 or abs(semi_major_m - 3396000.0) <= 15000.0
    mars_polar = abs(semi_minor_m - 3376200.0) <= 20000.0
    mars_sphere = abs(semi_minor_m - semi_major_m) <= 15000.0
    return mars_equatorial and (mars_polar or mars_sphere)


def inspect_geotiff(path: Path) -> dict[str, Any]:
    try:
        import rasterio
    except ImportError as exc:
        raise RuntimeError("Install the optional geospatial requirements to inspect GeoTIFFs.") from exc
    try:
        from pyproj import CRS as PyprojCRS
    except ImportError as exc:
        raise RuntimeError("Install pyproj from backend/requirements-geospatial.txt to validate planetary CRS metadata.") from exc
    with rasterio.open(path) as src:
        if src.crs is None:
            raise ValueError("Raster has no CRS. Do not infer a Mars coordinate system from a filename.")
        pycrs = PyprojCRS.from_wkt(src.crs.to_wkt())
        ellipsoid = pycrs.ellipsoid
        semi_major = float(ellipsoid.semi_major_metre)
        semi_minor = float(ellipsoid.semi_minor_metre)
        mars_body = _is_mars_ellipsoid(semi_major, semi_minor)
        return {
            "path": str(path), "driver": src.driver, "width": src.width, "height": src.height,
            "band_count": src.count, "crs_wkt": src.crs.to_wkt(), "crs": src.crs.to_string(),
            "bounds": [src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top],
            "transform": list(src.transform), "resolution_native_units": list(src.res),
            "linear_units": src.crs.linear_units if src.crs.is_projected else "angular",
            "is_projected": src.crs.is_projected, "nodata": src.nodata,
            "ellipsoid": {"name": ellipsoid.name, "semi_major_m": semi_major, "semi_minor_m": semi_minor},
            "mars_reference_ellipsoid_check": mars_body,
            "mars_reference_ellipsoid_basis": "equatorial radius near 3,396 km and polar radius near 3,376 km, or accepted spherical Mars radius; still verify body and coordinate convention in the original PDS label",
            "descriptions": list(src.descriptions), "units": list(src.units),
            "tags": src.tags(), "band_tags": [src.tags(i) for i in range(1, src.count + 1)],
        }


def validate_site_coverage(path: Path, *, latitude: float, longitude_east: float) -> dict[str, Any]:
    """Require the uploaded raster footprint to contain the selected site's reference point."""
    try:
        import rasterio
        from pyproj import Transformer
    except ImportError as exc:
        raise RuntimeError("Install rasterio and pyproj before importing georeferenced Mars terrain.") from exc

    with rasterio.open(path) as src:
        if src.crs is None or not src.crs.is_projected:
            raise ValueError("The DEM must contain a projected planetary CRS. A filename or browse image is not georeferencing.")
        if str(src.crs.linear_units).lower() not in {"metre", "meter", "meters", "metres"}:
            raise ValueError("The DEM's projected CRS must use metres.")
        geographic = src.crs.geodetic_crs
        if geographic is None:
            raise ValueError("The raster CRS does not expose a geographic base CRS, so its footprint cannot be verified against the mission-site coordinate.")
        transformer = Transformer.from_crs(geographic, src.crs, always_xy=True)
        candidates = [longitude_east]
        # Planetary products use both 0–360 east-positive and -180–180
        # longitude domains. Test the equivalent coordinate in both domains.
        candidates.append(longitude_east - 360.0 if longitude_east > 180.0 else longitude_east + 360.0)
        for longitude in candidates:
            x, y = transformer.transform(longitude, latitude)
            if src.bounds.left <= x <= src.bounds.right and src.bounds.bottom <= y <= src.bounds.top:
                return {
                    "reference_latitude_planetocentric": latitude,
                    "reference_longitude_east": longitude_east,
                    "reference_longitude_transformed": longitude,
                    "projected_reference_xy_m": [float(x), float(y)],
                    "raster_bounds_m": [float(src.bounds.left), float(src.bounds.bottom), float(src.bounds.right), float(src.bounds.top)],
                    "coverage_verified": True,
                }
        raise ValueError(
            "The uploaded DEM footprint does not contain this mission site's reference coordinate. "
            "Choose a product covering the selected site; do not attach another site's raster."
        )


def _local_std(array: np.ndarray) -> np.ndarray:
    padded = np.pad(array, 1, mode="edge")
    windows = [padded[dy:dy + array.shape[0], dx:dx + array.shape[1]] for dy in range(3) for dx in range(3)]
    stack = np.stack(windows, axis=0)
    return np.nanstd(stack, axis=0)


def dem_to_terrain(
    path: Path,
    *,
    width: int = 96,
    height: int = 96,
    vertical_units: str = "m",
    window_center_xy_m: tuple[float, float] | None = None,
    window_size_m: float = 2400.0,
) -> tuple[Any, dict[str, Any]]:
    """Convert a verified Mars DEM to a local, site-centred route grid.

    A large site mosaic must not be stretched across the entire 96 x 96 planner
    grid: doing so can make each cell hundreds or thousands of metres wide and
    make the default EVA route exceed every resource budget. When a projected
    site reference is supplied, read a bounded square around it instead.
    """
    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.windows import Window, from_bounds
    except ImportError as exc:
        raise RuntimeError("Install backend/requirements-geospatial.txt before importing Mars terrain.") from exc
    from ..terrain import Terrain

    info = inspect_geotiff(path)
    if not info["is_projected"] or str(info["linear_units"]).lower() not in {"metre", "meter", "meters", "metres"}:
        raise ValueError("DEM must already be in a projected Mars CRS with metre units. Reproject from the original planetary label before import.")
    if not info["mars_reference_ellipsoid_check"]:
        raise ValueError("DEM CRS ellipsoid does not match the Mars reference ellipsoid range. Earth or unknown-body rasters are rejected.")
    if vertical_units != "m":
        raise ValueError("This import path accepts DEM vertical units in metres only. Verify the original product label before import.")
    if info["band_count"] < 1:
        raise ValueError("DEM has no raster bands.")
    if not math.isfinite(window_size_m) or not 500.0 <= window_size_m <= 20000.0:
        raise ValueError("Local route-grid window_size_m must be between 500 and 20,000 metres.")

    with rasterio.open(path) as src:
        if src.units and src.units[0]:
            band_unit = str(src.units[0]).strip().lower()
            if band_unit not in {"m", "meter", "meters", "metre", "metres"}:
                raise ValueError(f"DEM band metadata declares unit {src.units[0]!r}, not metres. Convert explicitly using the source label.")
        if abs(src.transform.b) > 1e-9 or abs(src.transform.d) > 1e-9:
            raise ValueError("Rotated raster grids are not supported. Warp the verified source raster to a north-up projected grid first.")

        if window_center_xy_m is None:
            # Legacy/import compatibility only. Production automatic loading
            # supplies the projected mission-site reference coordinate.
            source_window = Window(0, 0, src.width, src.height)
            route_bounds = (src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top)
        else:
            half = window_size_m / 2.0
            requested_bounds = (
                float(window_center_xy_m[0]) - half,
                float(window_center_xy_m[1]) - half,
                float(window_center_xy_m[0]) + half,
                float(window_center_xy_m[1]) + half,
            )
            requested_window = from_bounds(*requested_bounds, transform=src.transform)
            raster_window = Window(0, 0, src.width, src.height)
            try:
                source_window = requested_window.intersection(raster_window).round_offsets().round_lengths()
            except Exception as exc:
                raise ValueError("The selected site's local DEM window does not intersect the source raster.") from exc
            if source_window.width < 2 or source_window.height < 2:
                raise ValueError("The selected site's DEM footprint is too small for a local route grid.")
            local_bounds = rasterio.windows.bounds(source_window, src.transform)
            route_bounds = (
                float(local_bounds[0]), float(local_bounds[1]),
                float(local_bounds[2]), float(local_bounds[3]),
            )

        if route_bounds[2] <= route_bounds[0] or route_bounds[3] <= route_bounds[1]:
            raise ValueError("The selected site's local DEM window has invalid bounds.")
        masked = src.read(
            1,
            window=source_window,
            out_shape=(height, width),
            masked=True,
            resampling=Resampling.bilinear,
        )
        z = np.asarray(masked.filled(np.nan), dtype=np.float64)
        mask = np.ma.getmaskarray(masked) | ~np.isfinite(z)
        if np.all(mask):
            raise ValueError("The selected site's local DEM window contains no valid elevation cells.")
        x_res = (route_bounds[2] - route_bounds[0]) / width
        y_res = (route_bounds[3] - route_bounds[1]) / height
        cell_m = float((x_res + y_res) / 2.0)
        if not math.isfinite(cell_m) or cell_m <= 0:
            raise ValueError("DEM has invalid metric pixel spacing.")
        route_transform = list(rasterio.transform.from_bounds(*route_bounds, width, height))

    # Compute derivatives from valid source elevations only. NaNs near a
    # coverage edge are marked no-go rather than replaced with invented heights.
    gy, gx = np.gradient(z, cell_m, cell_m)
    slope_raw = np.degrees(np.arctan(np.hypot(gx, gy)))
    roughness_raw = _local_std(z)
    valid = ~mask & np.isfinite(slope_raw) & np.isfinite(roughness_raw)
    if not valid.any():
        raise ValueError("The DEM has no valid cells with computable slope and roughness.")
    valid_ratio = float(valid.sum() / valid.size)
    roughness_scale = max(float(np.nanpercentile(roughness_raw[valid], 95)), 1e-6)
    roughness_norm = np.clip(roughness_raw / roughness_scale, 0, 1)
    obstacle = (~valid) | (slope_raw > 50.0)

    # A display-only fill is applied only to cells already marked blocked.
    # Such cells are excluded from route search and never treated as measured DEM.
    display_fill = float(np.nanmedian(z[valid]))
    elevation_display = np.where(valid, z, display_fill)
    slope_display = np.where(np.isfinite(slope_raw), slope_raw, 0.0)
    roughness_display = np.where(np.isfinite(roughness_norm), roughness_norm, 0.0)
    file_hash = _sha256_file(path)

    grid = Terrain(
        width=width,
        height=height,
        cell_m=cell_m,
        elevation_m=elevation_display.tolist(),
        slope_deg=slope_display.tolist(),
        roughness=roughness_display.tolist(),
        regolith=None,
        temperature_c=None,
        environment_index=None,
        radiation_index=None,
        uncertainty=None,
        science_potential=None,
        obstacle=obstacle.tolist(),
        targets=[],
        valid_mask=valid.tolist(),
        seed=0,
        available_layers={"elevation", "slope", "roughness", "coverage_mask"},
        terrain_id=f"imported-dem-{file_hash[:12]}",
        status="NASA_OR_USER_SUPPLIED_GEOREFERENCED_DEM",
        warning=(
            "Real source DEM imported. The planner grid is a site-centred local crop of the source raster. "
            "Elevation is from the raster; slope and relative roughness are derived from it. "
            "Regolith, temperature, atmosphere, radiation, uncertainty and science-target layers are unavailable and are not fabricated."
        ),
        cell_units="metres",
        layer_provenance=(
            "Source raster CRS and metadata retained; planner grid is a site-centred local crop; "
            "slope derived from the imported elevation raster; roughness is a 3x3 local standard deviation "
            "normalized to the valid-data 95th percentile. NoData and derivative-invalid cells are blocked."
        ),
        coordinate_info={
            "crs": info["crs"],
            "crs_wkt": info["crs_wkt"],
            "bounds": list(route_bounds),
            "source_raster_bounds": info["bounds"],
            "transform": route_transform,
            "pixel_spacing_m": [x_res, y_res],
            "route_grid_window_size_m": [route_bounds[2] - route_bounds[0], route_bounds[3] - route_bounds[1]],
            "coverage_valid_fraction": round(valid_ratio, 6),
        },
    )
    provenance = {
        "source": {key: value for key, value in info.items() if key != "path"},
        "source_sha256": file_hash,
        "source_file_name": path.name,
        "processing": {
            "resampling": "bilinear to site-centred local route grid",
            "route_grid": [width, height],
            "route_grid_bounds_m": list(route_bounds),
            "route_grid_cell_size_m": cell_m,
            "declared_vertical_units": vertical_units,
            "source_band_unit": info.get("units", [None])[0],
            "slope": "atan(sqrt(dz/dx^2 + dz/dy^2)) on valid raster data",
            "roughness": "3x3 local standard deviation",
            "nodata": "blocked; display-only fill is never used for route-cost calculations",
        },
        "coverage_valid_fraction": round(valid_ratio, 6),
        "layers_created": ["elevation", "slope", "roughness", "coverage_mask"],
        "layers_unavailable": ["regolith", "temperature", "atmosphere", "radiation", "uncertainty", "mineralogy", "science_targets"],
        "warning": (
            "Confirm the source product label, datum, planetary CRS, vertical units, processing level and footprint. "
            "Rendered elevation is not a certified hazard map or astronaut navigation product."
        ),
    }
    return grid, provenance

NORMALIZED_LAYER_FIELDS = {
    "regolith": "regolith",
    "environment_index": "environment_index",
    "radiation_index": "radiation_index",
    "science_potential": "science_potential",
    "uncertainty": "uncertainty",
}


def import_aligned_layer(path: Path, terrain: Any, *, layer: str, value_min: float, value_max: float, band: int = 1, source_unit: str = "unspecified") -> dict[str, Any]:
    """Align a user-selected, explicitly interpreted raster band to an active DEM grid.

    The user must state the field mapping and normalization range. This function
    never infers that arbitrary spectral/thermal values represent risk.
    """
    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.warp import reproject
        from rasterio.transform import from_bounds
    except ImportError as exc:
        raise RuntimeError("Install backend/requirements-geospatial.txt before importing aligned layers.") from exc
    allowed_layers = set(NORMALIZED_LAYER_FIELDS) | {"temperature_c"}
    if layer not in allowed_layers:
        raise ValueError(f"Layer must be one of: {', '.join(sorted(allowed_layers))}.")
    if not (math.isfinite(value_min) and math.isfinite(value_max) and value_min < value_max):
        raise ValueError("Source bounds must be finite and value_min must be less than value_max.")
    celsius_units = {"c", "degc", "celsius", "degreecelsius", "degreescelsius"}
    normalized_source_unit = source_unit.strip().lower().replace("°", "deg").replace("_", "").replace(" ", "")
    if layer == "temperature_c" and normalized_source_unit not in celsius_units:
        raise ValueError("temperature_c requires a source unit of C, degC or Celsius. Convert Kelvin/Fahrenheit explicitly before import.")
    target_info = terrain.coordinate_info or {}
    target_crs = target_info.get("crs_wkt") or target_info.get("crs")
    bounds = target_info.get("bounds")
    if not target_crs or not isinstance(bounds, list) or len(bounds) != 4:
        raise ValueError("The active terrain has no verified geospatial transform/bounds. Import a Mars DEM first.")
    try:
        from pyproj import CRS as PyprojCRS
    except ImportError as exc:
        raise RuntimeError("Install pyproj from backend/requirements-geospatial.txt before importing aligned layers.") from exc
    with rasterio.open(path) as src:
        if src.crs is None or not src.crs.is_projected:
            raise ValueError("The input layer must use a projected CRS.")
        if str(src.crs.linear_units).lower() not in {"metre", "meter", "meters", "metres"}:
            raise ValueError("The input layer must use projected metre units.")
        ellipsoid = PyprojCRS.from_wkt(src.crs.to_wkt()).ellipsoid
        if not _is_mars_ellipsoid(float(ellipsoid.semi_major_metre), float(ellipsoid.semi_minor_metre)):
            raise ValueError("Input layer ellipsoid does not match the Mars reference ellipsoid range. Both equatorial and polar radii must be compatible.")
        if not (1 <= band <= src.count):
            raise ValueError("Requested raster band does not exist.")
        band_unit = str(src.units[band - 1]).strip() if src.units and src.units[band - 1] else None
        normalized_band_unit = band_unit.lower().replace("°", "deg").replace("_", "").replace(" ", "") if band_unit else None
        if layer == "temperature_c" and normalized_band_unit and normalized_band_unit not in celsius_units:
            raise ValueError(f"The raster band declares unit {band_unit!r}, which is not Celsius. Convert the values and update the band unit metadata before importing as temperature_c.")
        target = np.full((terrain.height, terrain.width), np.nan, dtype=np.float32)
        target_transform = from_bounds(bounds[0], bounds[1], bounds[2], bounds[3], terrain.width, terrain.height)
        source = src.read(band, masked=True)
        source_values = source.filled(np.nan).astype(np.float32)
        reproject(
            source=source_values, destination=target,
            src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
            dst_transform=target_transform, dst_crs=target_crs, dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        metadata = {
            "source_filename": path.name, "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "source_crs": src.crs.to_string(), "source_band": band,
            "band_description": src.descriptions[band - 1] if src.descriptions else None,
            "band_unit": band_unit,
            "user_declared_unit": source_unit, "normalization": {"min": value_min, "max": value_max, "clip": True},
            "resampling": "bilinear", "aligned_to_terrain_id": terrain.terrain_id,
        }
    valid = np.isfinite(target)
    valid_fraction = float(valid.sum() / valid.size)
    if valid_fraction < 0.05:
        raise ValueError("Less than 5% of the active terrain grid is covered by this raster. Check the footprints and CRS.")
    if layer == "temperature_c":
        physically_valid = valid & (target >= -150.0) & (target <= 50.0)
        if physically_valid.sum() < max(1, int(valid.size * 0.05)):
            raise ValueError("Fewer than 5% of aligned temperature cells fall in the allowed -150 to 50 °C range.")
        values = np.full_like(target, -100.0, dtype=np.float32)
        values[physically_valid] = target[physically_valid]
        # Temperature is a hard exclusion field when enabled. A cell without
        # valid temperature coverage must not inherit a plausible cold value.
        missing_temperature = ~physically_valid
        terrain.obstacle = (np.asarray(terrain.obstacle, dtype=bool) | missing_temperature).tolist()
        field = "temperature_c"
        valid = physically_valid
    else:
        # Missing cells are made no-go rather than filled with a plausible
        # score. Their placeholder storage value is never available to search.
        values = np.zeros_like(target, dtype=np.float32)
        values[valid] = np.clip((target[valid] - value_min) / (value_max - value_min), 0.0, 1.0)
        terrain.obstacle = (np.asarray(terrain.obstacle, dtype=bool) | ~valid).tolist()
        field = NORMALIZED_LAYER_FIELDS[layer]
    setattr(terrain, field, values.tolist())
    # Do not synthesize an uncertainty layer when the source DEM had none.
    # If uncertainty was already loaded, preserve it; if this import is the
    # uncertainty layer itself, the newly imported values are now available.
    if layer == "temperature_c":
        terrain.available_layers.add("temperature")
    elif layer == "environment_index":
        terrain.available_layers.add("atmosphere")
    elif layer == "radiation_index":
        terrain.available_layers.add("radiation")
    elif layer == "science_potential":
        terrain.available_layers.add("science")
    elif layer == "uncertainty":
        terrain.available_layers.add("uncertainty")
    elif layer == "regolith":
        terrain.available_layers.add("regolith")
    metadata["coverage_valid_fraction"] = round(valid_fraction, 6)
    metadata["missing_cells_policy"] = "NoData/out-of-range cells are marked as no-go; no guessed hazard, science or uncertainty values are introduced"
    layer_meta = terrain.coordinate_info.setdefault("imported_layer_provenance", {})
    layer_meta[layer] = metadata
    terrain.layer_provenance += f" Additional layer {layer} imported from {path.name}; see coordinate_info.imported_layer_provenance.{layer}."
    return metadata
