"""Curated landing-site terrain products and import guidance.

Only the DEM products listed here are advertised as route-planning elevation
sources. A site is not considered terrain-ready until its raster is imported.
"""
from __future__ import annotations

SITES = [
    {
        "id": "jezero",
        "name": "Jezero Crater",
        "mission": "Perseverance / Mars 2020",
        "region": "Nili Planum",
        "center": {"latitude": 18.4100, "longitude_east": 77.6900},
        "dem": {
            "name": "Mars 2020 Science Investigation CTX DEM Mosaic",
            "source": "USGS Astrogeology Science Center",
            "resolution_m": 20.0,
            "format": "GeoTIFF",
            "size_mb": 87,
            "download_url": "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif",
            "documentation_url": "https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic",
            "coverage_note": "CTX stereo DEM mosaic covering Jezero crater; 20 m/pixel.",
            "import_formats": [".tif", ".tiff"],
        },
    },
    {
        "id": "gale",
        "name": "Gale Crater",
        "mission": "Curiosity / Mars Science Laboratory",
        "region": "Mount Sharp",
        "center": {"latitude": -4.6, "longitude_east": 137.4},
        "dem": {
            "name": "30-m HRSC DTM Mosaic of Gale Crater",
            "source": "University College London / Zenodo",
            "resolution_m": 30.0,
            "format": "GeoTIFF",
            "size_mb": 311.8,
            "download_url": "https://zenodo.org/records/5808354/files/hrsc_km09_h1938_h1927_h1916-dtm-mosaic.tif?download=1",
            "documentation_url": "https://zenodo.org/records/5808354",
            "coverage_note": "30 m/pixel HRSC stereo DTM mosaic. A separate USGS 1 m merged Gale DEM exists but is 3.6 GB; this smaller HRSC product is used as the practical import option.",
            "import_formats": [".tif", ".tiff"],
        },
    },
    {
        "id": "meridiani",
        "name": "Meridiani Planum",
        "mission": "Opportunity / Mars Exploration Rover",
        "region": "Victoria Crater and Opportunity traverse area",
        "center": {"latitude": -2.05, "longitude_east": 354.5},
        "dem": {
            "name": "Possible Opportunity Rover Landing Site HiRISE DTM",
            "source": "NASA/JPL / University of Arizona HiRISE",
            "resolution_m": 1.01,
            "format": "PDS3 IMG with embedded label",
            "size_mb": 9,
            "download_url": "https://hirise.lpl.arizona.edu/PDS/DTM/PSP/ORB_001400_001499/PSP_001414_1780_PSP_001612_1780/DTEEC_001414_1780_001612_1780_U01.IMG",
            "documentation_url": "https://hirise.lpl.arizona.edu/dtm/dtm.php?ID=PSP_001414_1780",
            "coverage_note": "High-resolution DTM for part of the area explored by Opportunity on Meridiani Planum; this is a local footprint, not a complete regional mosaic.",
            "import_formats": [".img"],
        },
    },
    {
        "id": "elysium",
        "name": "Elysium Planitia",
        "mission": "InSight",
        "region": "InSight landing ellipse 9",
        "center": {"latitude": 4.5, "longitude_east": 135.9},
        "dem": {
            "name": "CTX Digital Terrain Model of Mars InSight Landing Site Ellipse 9 Center",
            "source": "USGS Astrogeology Science Center",
            "resolution_m": 20.2358,
            "format": "GeoTIFF",
            "size_mb": 69,
            "download_url": "https://planetarymaps.usgs.gov/mosaic/insight_landing_site_dtm/F02_036761_1828_F04_037262_1841_20m_DTM_destripe.tif",
            "documentation_url": "https://astrogeology.usgs.gov/search/map/ctx_digital_terrain_model_of_mars_insight_landing_site_ellipse_9_center",
            "coverage_note": "CTX stereo DTM covering the InSight landing-site region, approximately 20.24 m/pixel; the source footprint includes the published landing-site centre.",
            "import_formats": [".tif", ".tiff"],
        },
    },
]

SITE_IDS = {site["id"] for site in SITES}
_SITE_BY_ID = {site["id"]: site for site in SITES}


def get_site(site_id: str) -> dict:
    try:
        return _SITE_BY_ID[site_id]
    except KeyError as exc:
        raise ValueError(f"Unknown landing site '{site_id}'. Supported sites: {', '.join(sorted(SITE_IDS))}.") from exc


def get_site_catalog(site_terrains: dict) -> list[dict]:
    result = []
    for site in SITES:
        terrain = site_terrains.get(site["id"])
        loaded = terrain is not None and terrain.status != "SIMULATED_NOT_GEOREFERENCED"
        result.append({**site, "terrain_loaded": loaded, "terrain_status": terrain.status if terrain else "NOT_IMPORTED"})
    return result
