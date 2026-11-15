from __future__ import annotations

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
from rasterio.transform import from_origin
from rasterio.crs import CRS

from app.domain.raster_pipeline import dem_to_terrain, import_aligned_layer, inspect_geotiff

MARS_CRS = CRS.from_proj4("+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +a=3396190 +b=3376200 +units=m +no_defs +type=crs")


def _write(path, values, crs=MARS_CRS, transform=None, unit="m"):
    arr = np.asarray(values, dtype=np.float32)
    with rasterio.open(
        path, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1], count=1,
        dtype="float32", crs=crs, transform=transform or from_origin(0, arr.shape[0] * 10, 10, 10), nodata=-9999,
    ) as dst:
        dst.write(arr, 1)
        dst.set_band_description(1, "test band")
        dst.set_band_unit(1, unit)


def test_mars_dem_ingest_derives_slope_and_roughness_and_keeps_unknowns(tmp_path):
    y, x = np.indices((32, 32))
    dem = (100 + x * 0.4 + y * 0.2).astype(np.float32)
    path = tmp_path / "mars_dem.tif"
    _write(path, dem)
    info = inspect_geotiff(path)
    assert info["mars_reference_ellipsoid_check"] is True
    terrain, provenance = dem_to_terrain(path, width=32, height=32)
    assert terrain.status == "NASA_OR_USER_SUPPLIED_GEOREFERENCED_DEM"
    assert "elevation" in terrain.available_layers
    assert "atmosphere" not in terrain.available_layers
    assert terrain.slope_deg[10][10] > 0
    assert provenance["source_sha256"]
    assert provenance["layers_unavailable"]


def test_site_centred_route_grid_uses_local_dem_window(tmp_path):
    y, x = np.indices((1024, 1024))
    dem = (100 + x * 0.01 + y * 0.02).astype(np.float32)
    path = tmp_path / "large_mars_mosaic.tif"
    _write(path, dem, transform=from_origin(-5120, 5120, 10, 10))

    terrain, provenance = dem_to_terrain(
        path,
        width=96,
        height=96,
        window_center_xy_m=(0.0, 0.0),
        window_size_m=2400.0,
    )

    assert terrain.cell_m == pytest.approx(25.0, abs=0.2)
    assert terrain.coordinate_info["bounds"] == pytest.approx([-1200.0, -1200.0, 1200.0, 1200.0], abs=10.0)
    assert provenance["processing"]["route_grid"] == [96, 96]
    assert provenance["processing"]["route_grid_window_size_m"] == pytest.approx([2400.0, 2400.0], abs=10.0)


def test_earth_metre_crs_is_not_accepted_as_mars(tmp_path):
    path = tmp_path / "earth_utm.tif"
    _write(path, np.ones((32, 32)), crs=CRS.from_epsg(32631))
    with pytest.raises(ValueError, match="Mars reference ellipsoid"):
        dem_to_terrain(path, width=32, height=32)


def test_aligned_layer_requires_mars_crs_and_correct_temperature_units(tmp_path):
    base = tmp_path / "base.tif"
    _write(base, np.ones((32, 32)))
    terrain, _ = dem_to_terrain(base, width=32, height=32)

    temperature = tmp_path / "temperature.tif"
    _write(temperature, np.full((32, 32), -55.0), unit="degC")
    with pytest.raises(ValueError, match="requires a source unit"):
        import_aligned_layer(temperature, terrain, layer="temperature_c", value_min=-80, value_max=0, source_unit="K")
    provenance = import_aligned_layer(temperature, terrain, layer="temperature_c", value_min=-80, value_max=0, source_unit="degC")
    assert "temperature" in terrain.available_layers
    assert terrain.temperature_c[5][5] == pytest.approx(-55.0)
    assert provenance["coverage_valid_fraction"] == pytest.approx(1.0)


def test_temperature_import_rejects_band_unit_metadata_that_conflicts_with_user_declaration(tmp_path):
    base = tmp_path / "base.tif"
    _write(base, np.ones((32, 32)))
    terrain, _ = dem_to_terrain(base, width=32, height=32)
    kelvin = tmp_path / "temperature_kelvin.tif"
    _write(kelvin, np.full((32, 32), 218.15, dtype=np.float32), unit="K")
    with pytest.raises(ValueError, match="which is not Celsius"):
        import_aligned_layer(kelvin, terrain, layer="temperature_c", value_min=-80, value_max=0, source_unit="degC")


def test_aligned_layer_rejects_non_mars_source(tmp_path):
    base = tmp_path / "base.tif"
    _write(base, np.ones((32, 32)))
    terrain, _ = dem_to_terrain(base, width=32, height=32)
    earth = tmp_path / "earth_layer.tif"
    _write(earth, np.ones((32, 32)), crs=CRS.from_epsg(32631))
    with pytest.raises(ValueError, match="Mars reference ellipsoid"):
        import_aligned_layer(earth, terrain, layer="science_potential", value_min=0, value_max=1)


def test_temperature_layer_blocks_cells_without_valid_coverage(tmp_path):
    base = tmp_path / "base.tif"
    _write(base, np.ones((32, 32)))
    terrain, _ = dem_to_terrain(base, width=32, height=32)

    temperature_values = np.full((32, 32), -55.0, dtype=np.float32)
    temperature_values[:12, :12] = -9999.0
    temperature = tmp_path / "partial_temperature.tif"
    _write(temperature, temperature_values, unit="degC")
    import_aligned_layer(temperature, terrain, layer="temperature_c", value_min=-80, value_max=0, source_unit="degC")

    assert terrain.obstacle[4][4] is True
    assert terrain.obstacle[25][25] is False
