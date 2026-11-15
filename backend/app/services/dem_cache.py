"""Automatic, provenance-preserving fetch and cache for the four catalogued Mars DEMs.

Only URLs declared in mission_sites.py are downloaded. The downloaded raster is
validated against its Mars CRS, metre units, and the selected site's footprint
before a route grid is exposed. A local cache is always used; an optional
S3-compatible bucket makes both the source raster and processed grid durable
across backend restarts/deploys.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from ..domain.raster_pipeline import dem_to_terrain, validate_site_coverage
from ..terrain import Terrain

logger = logging.getLogger(__name__)

MAX_DEM_DOWNLOAD_BYTES = 400 * 1024 * 1024
CACHE_FORMAT_VERSION = 2
USER_AGENT = "MARSCOPE/0.4.0 (research prototype; catalogued Mars DEM fetcher)"
DEFAULT_CACHE_ROOT = Path(__file__).resolve().parents[1] / "data" / "automatic_dems"


class DemSourceError(RuntimeError):
    """The official source could not provide the catalogued DEM."""


class DemValidationError(RuntimeError):
    """The downloaded file did not pass the real-DEM validation pipeline."""


class DemCacheError(RuntimeError):
    """The cache could not be read or written."""


def cache_mode() -> str:
    if os.getenv("MARS_DEM_S3_BUCKET"):
        return "S3-compatible persistent object storage"
    if os.getenv("MARS_DEM_CACHE_DIR"):
        return "configured filesystem cache (persistence depends on the host mount)"
    return "instance-local cache"


def _cache_root() -> Path:
    root = Path(os.getenv("MARS_DEM_CACHE_DIR", str(DEFAULT_CACHE_ROOT))).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _s3_configuration() -> tuple[Any, str, str] | None:
    bucket = os.getenv("MARS_DEM_S3_BUCKET", "").strip()
    if not bucket:
        return None
    try:
        import boto3
    except ImportError as exc:
        raise DemCacheError("MARS_DEM_S3_BUCKET is set but boto3 is missing. Install backend requirements.") from exc

    endpoint = os.getenv("MARS_DEM_S3_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT_URL")
    region = (
        os.getenv("MARS_DEM_S3_REGION")
        or os.getenv("AWS_REGION")
        or os.getenv("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    kwargs: dict[str, Any] = {"region_name": region}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    client = boto3.client("s3", **kwargs)
    prefix = os.getenv("MARS_DEM_S3_PREFIX", "marscope").strip("/")
    return client, bucket, prefix


def _s3_keys(site_id: str, filename: str, prefix: str) -> tuple[str, str]:
    root = f"{prefix}/mars-dem-cache/v{CACHE_FORMAT_VERSION}".strip("/")
    return f"{root}/processed/{site_id}.json.gz", f"{root}/source/{site_id}/{filename}"


def _is_allowed_download_host(host: str | None) -> bool:
    if not host:
        return False
    value = host.lower().rstrip(".")
    exact = {
        "planetarymaps.usgs.gov",
        # astrogeology.usgs.gov is the USGS Astrogeology Science Center server.
        # The USGS CTX DEM for Jezero and the Elysium CTX DEM both redirect
        # through this host before reaching their final download URL.
        # Verified as an official USGS planetary-data host.
        "astrogeology.usgs.gov",
        "hirise.lpl.arizona.edu",
        "s3.amazonaws.com",
        "s3.us-west-2.amazonaws.com",
    }
    return (
        value in exact
        or value == "zenodo.org"
        or value.endswith(".zenodo.org")
        or value.endswith(".s3.amazonaws.com")
        or value.endswith(".s3.us-west-2.amazonaws.com")
    )


def _download_catalogued_dem(site_id: str, site: dict[str, Any], destination: Path) -> dict[str, Any]:
    dem = site["dem"]
    source_url = str(dem["url"])
    parsed = urlparse(source_url)
    if parsed.scheme != "https" or not _is_allowed_download_host(parsed.hostname):
        raise DemSourceError("The catalogued DEM URL is not an approved official HTTPS source.")

    temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(8)}.part")
    current_url = source_url
    total_bytes = 0
    digest = hashlib.sha256()
    md5_digest = hashlib.md5()
    headers: dict[str, str] = {}
    final_url = source_url

    try:
        timeout = httpx.Timeout(connect=30.0, read=300.0, write=60.0, pool=30.0)
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}, follow_redirects=False) as client:
            for redirect_index in range(7):
                current = urlparse(current_url)
                if current.scheme != "https" or not _is_allowed_download_host(current.hostname):
                    raise DemSourceError("The official archive redirected outside the approved planetary-data hosts.")
                with client.stream("GET", current_url) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise DemSourceError("The official archive returned a redirect without a Location header.")
                        current_url = urljoin(current_url, location)
                        continue
                    if response.status_code != 200:
                        raise DemSourceError(f"The official DEM source returned HTTP {response.status_code}.")
                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > MAX_DEM_DOWNLOAD_BYTES:
                        raise DemSourceError(
                            f"The catalogued DEM exceeds the {MAX_DEM_DOWNLOAD_BYTES // (1024 * 1024)} MB automatic-download limit."
                        )
                    final_url = str(response.url)
                    final = urlparse(final_url)
                    if final.scheme != "https" or not _is_allowed_download_host(final.hostname):
                        raise DemSourceError("The final DEM response URL is outside the approved official hosts.")
                    headers = {
                        key: value
                        for key, value in response.headers.items()
                        if key.lower() in {"content-type", "content-length", "last-modified", "etag", "content-disposition"}
                    }
                    with temporary.open("wb") as output:
                        for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                            if not chunk:
                                continue
                            total_bytes += len(chunk)
                            if total_bytes > MAX_DEM_DOWNLOAD_BYTES:
                                raise DemSourceError(
                                    f"The catalogued DEM exceeded the {MAX_DEM_DOWNLOAD_BYTES // (1024 * 1024)} MB automatic-download limit."
                                )
                            digest.update(chunk)
                            md5_digest.update(chunk)
                            output.write(chunk)
                    break
            else:
                raise DemSourceError("The official archive exceeded the redirect limit.")

        if total_bytes == 0:
            raise DemSourceError("The official archive returned an empty DEM file.")
        expected_md5 = str(dem.get("expected_md5") or "").lower()
        actual_md5 = md5_digest.hexdigest()
        if expected_md5 and actual_md5 != expected_md5:
            raise DemSourceError(f"Downloaded file checksum mismatch: expected MD5 {expected_md5}, received {actual_md5}.")
        temporary.replace(destination)
        return {
            "official_url": source_url,
            "final_url": final_url,
            "retrieved_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            "source_filename": dem["filename"],
            "source_sha256": digest.hexdigest(),
            "source_md5": actual_md5,
            "size_bytes": total_bytes,
            "response_headers": headers,
            "product": dem["product"],
            "source": dem["source"],
            "source_resolution_m": dem["resolution_m"],
        }
    except (httpx.HTTPError, OSError, ValueError) as exc:
        temporary.unlink(missing_ok=True)
        raise DemSourceError(f"Could not download the official {site['name']} DEM: {exc}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def _missing_s3_object(error: Exception) -> bool:
    response = getattr(error, "response", {}) or {}
    code = str((response.get("Error") or {}).get("Code", ""))
    status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return code in {"404", "NoSuchKey", "NotFound"} or status == 404


def _read_s3_processed(config: tuple[Any, str, str], key: str) -> dict[str, Any] | None:
    client, bucket, _ = config
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        compressed = response["Body"].read()
        return json.loads(gzip.decompress(compressed).decode("utf-8"))
    except Exception as exc:
        if _missing_s3_object(exc):
            return None
        logger.warning("Could not read persistent DEM cache object %s: %s", key, exc)
        return None


def _write_s3_object(config: tuple[Any, str, str], key: str, body: bytes, content_type: str) -> None:
    client, bucket, _ = config
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)


def _download_s3_source(config: tuple[Any, str, str], key: str, destination: Path) -> bool:
    client, bucket, _ = config
    try:
        client.head_object(Bucket=bucket, Key=key)
        client.download_file(bucket, key, str(destination))
        return destination.is_file() and destination.stat().st_size > 0
    except Exception as exc:
        if _missing_s3_object(exc):
            return False
        logger.warning("Could not read persistent source DEM object %s: %s", key, exc)
        return False


def _upload_s3_source(config: tuple[Any, str, str], key: str, source: Path) -> None:
    client, bucket, _ = config
    client.upload_file(str(source), bucket, key, ExtraArgs={"ContentType": "application/octet-stream"})


def _terrain_from_dict(data: dict[str, Any], site_id: str) -> Terrain:
    available = set(data.get("available_layers") or [])
    terrain = Terrain(
        width=int(data["width"]),
        height=int(data["height"]),
        cell_m=float(data["cell_size_m"]),
        elevation_m=data["elevation_m"],
        slope_deg=data["slope_deg"],
        roughness=data["roughness"],
        regolith=data.get("regolith"),
        temperature_c=data.get("temperature_c"),
        environment_index=data.get("environment_index"),
        radiation_index=data.get("radiation_index"),
        uncertainty=data.get("uncertainty"),
        science_potential=data.get("science_potential"),
        obstacle=data["obstacle"],
        targets=data.get("targets") or [],
        valid_mask=data.get("valid_mask"),
        seed=0,
        available_layers=available,
        terrain_id=str(data.get("id") or f"mars-dem-{site_id}"),
        status=str(data.get("status") or ""),
        warning=str(data.get("warning") or ""),
        cell_units=str(data.get("cell_units") or "metres"),
        layer_provenance=str(data.get("layer_provenance") or ""),
        coordinate_info=data.get("coordinate_info") or {},
        site_id=str(data.get("site_id") or site_id),
        site_name=str(data.get("site_name") or site_id),
    )
    if (
        terrain.site_id != site_id
        or terrain.status != "NASA_OR_USER_SUPPLIED_GEOREFERENCED_DEM"
        or "elevation" not in terrain.available_layers
        or not (terrain.coordinate_info or {}).get("site_coverage_verified")
    ):
        raise DemCacheError("Cached terrain failed the real-DEM/site-coverage integrity check.")
    return terrain


def _serialize_cache(terrain: Terrain, provenance: dict[str, Any]) -> bytes:
    payload = {
        "cache_format_version": CACHE_FORMAT_VERSION,
        "terrain": terrain.to_dict(),
        "provenance": provenance,
    }
    return gzip.compress(json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8"), compresslevel=6)


def _read_local_processed(path: Path, site_id: str) -> tuple[Terrain, dict[str, Any]] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
        if payload.get("cache_format_version") != CACHE_FORMAT_VERSION:
            return None
        terrain = _terrain_from_dict(payload["terrain"], site_id)
        return terrain, payload.get("provenance") or {}
    except Exception as exc:
        logger.warning("Ignoring invalid local DEM cache %s: %s", path, exc)
        path.unlink(missing_ok=True)
        return None


def _write_local_processed(path: Path, payload: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.part")
    try:
        temporary.write_bytes(payload)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _decorate_terrain(terrain: Terrain, site_id: str, site: dict[str, Any], coverage: dict[str, Any], provenance: dict[str, Any]) -> None:
    terrain.site_id = site_id
    terrain.site_name = site["name"]
    download = provenance.get("automatic_download") if isinstance(provenance.get("automatic_download"), dict) else {}
    source_hash = str(download.get("source_sha256") or provenance.get("source_sha256") or "verified")
    terrain.terrain_id = f"mars-dem-{site_id}-{source_hash[:12]}"
    response_headers = download.get("response_headers") if isinstance(download.get("response_headers"), dict) else {}
    terrain.coordinate_info = {
        **(terrain.coordinate_info or {}),
        "selected_site_id": site_id,
        "selected_site_name": site["name"],
        "site_reference_latitude": site["latitude"],
        "site_reference_longitude_east": site["longitude_east"],
        "site_coverage_verified": True,
        "site_coverage_check": coverage,
        "official_dem_product": site["dem"]["product"],
        "official_dem_source": site["dem"]["source"],
        "dem_provenance": {
            "official_url": download.get("official_url") or site["dem"]["url"],
            "final_url": download.get("final_url"),
            "source_filename": download.get("source_filename") or site["dem"]["filename"],
            "source_sha256": download.get("source_sha256"),
            "source_md5": download.get("source_md5"),
            "size_bytes": download.get("size_bytes"),
            "retrieved_utc": download.get("retrieved_utc"),
            "source_last_modified": response_headers.get("last-modified"),
            "source_etag": response_headers.get("etag"),
            "product": site["dem"]["product"],
            "source": site["dem"]["source"],
            "source_resolution_m": site["dem"]["resolution_m"],
            "format": site["dem"]["format"],
            "cache_mode": cache_mode(),
            "restored_from_persistent_cache": bool(download.get("restored_from_persistent_cache")),
        },
    }
    provenance["selected_site_id"] = site_id
    provenance["site_coverage_check"] = coverage
    provenance["official_dem_product"] = site["dem"]["product"]
    provenance["official_dem_source"] = site["dem"]["source"]
    provenance["automatic_retrieval"] = True


def load_or_fetch_site_terrain(site_id: str, site: dict[str, Any]) -> Terrain:
    """Return a verified cached grid or fetch, validate and cache its official DEM."""
    root = _cache_root()
    filename = str(site["dem"]["filename"])
    processed_path = root / f"{site_id}.terrain-v{CACHE_FORMAT_VERSION}.json.gz"
    source_path = root / filename
    config = _s3_configuration()
    processed_key = source_key = ""
    if config:
        _, _, prefix = config
        processed_key, source_key = _s3_keys(site_id, filename, prefix)

    local_cached = _read_local_processed(processed_path, site_id)
    if local_cached:
        terrain, provenance = local_cached
        coverage = provenance.get("site_coverage_check") or (terrain.coordinate_info or {}).get("site_coverage_check") or {}
        _decorate_terrain(terrain, site_id, site, coverage, provenance)
        _write_local_processed(processed_path, _serialize_cache(terrain, provenance))
        return terrain

    if config:
        remote_payload = _read_s3_processed(config, processed_key)
        if remote_payload and remote_payload.get("cache_format_version") == CACHE_FORMAT_VERSION:
            try:
                terrain = _terrain_from_dict(remote_payload["terrain"], site_id)
                provenance = remote_payload.get("provenance") or {}
                coverage = provenance.get("site_coverage_check") or (terrain.coordinate_info or {}).get("site_coverage_check") or {}
                _decorate_terrain(terrain, site_id, site, coverage, provenance)
                _write_local_processed(processed_path, _serialize_cache(terrain, provenance))
                return terrain
            except Exception as exc:
                logger.warning("Ignoring invalid persistent DEM cache for %s: %s", site_id, exc)

    download_record: dict[str, Any] | None = None
    was_freshly_downloaded: bool = False
    was_restored_from_s3: bool = False

    if not source_path.is_file() or source_path.stat().st_size == 0:
        restored = bool(config and _download_s3_source(config, source_key, source_path))
        if restored:
            was_restored_from_s3 = True
        else:
            download_record = _download_catalogued_dem(site_id, site, source_path)
            was_freshly_downloaded = True

    try:
        coverage = validate_site_coverage(
            source_path,
            latitude=float(site["latitude"]),
            longitude_east=float(site["longitude_east"]),
        )
        terrain, provenance = dem_to_terrain(
            source_path,
            width=96,
            height=96,
            vertical_units=str(site["dem"].get("vertical_units", "m")),
            window_center_xy_m=tuple(coverage["projected_reference_xy_m"]),
            window_size_m=2400.0,
        )
    except (ValueError, RuntimeError, OSError) as exc:
        # Remove the source file only when it was freshly downloaded this
        # request. An S3-restored or pre-existing file is left in place so
        # the next request can retry validation without re-downloading; it
        # may also be needed for manual inspection. Never delete S3 objects.
        if was_freshly_downloaded and source_path.is_file():
            try:
                source_path.unlink()
                logger.info(
                    "Removed freshly downloaded but invalid DEM for %s: %s",
                    site_id,
                    source_path.name,
                )
            except OSError as unlink_exc:
                logger.warning(
                    "Could not remove invalid downloaded DEM %s: %s",
                    source_path,
                    unlink_exc,
                )
        elif was_restored_from_s3 and source_path.is_file():
            logger.warning(
                "S3-restored DEM for %s failed validation; leaving file for manual inspection: %s",
                site_id,
                source_path.name,
            )
        raise DemValidationError(
            f"The downloaded {site['dem']['product']} did not pass Mars CRS, metre-unit, or site-footprint validation: {exc}"
        ) from exc

    if download_record is None:
        digest = hashlib.sha256()
        md5_digest = hashlib.md5()
        with source_path.open("rb") as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                digest.update(chunk)
                md5_digest.update(chunk)
        expected_md5 = str(site["dem"].get("expected_md5") or "").lower()
        actual_md5 = md5_digest.hexdigest()
        if expected_md5 and actual_md5 != expected_md5:
            raise DemValidationError(f"Persistent source file checksum mismatch: expected MD5 {expected_md5}, received {actual_md5}.")
        download_record = {
            "official_url": site["dem"]["url"],
            "source_filename": filename,
            "source_sha256": digest.hexdigest(),
            "source_md5": actual_md5,
            "size_bytes": source_path.stat().st_size,
            "product": site["dem"]["product"],
            "source": site["dem"]["source"],
            "source_resolution_m": site["dem"]["resolution_m"],
            "retrieved_utc": None,
            "restored_from_persistent_cache": bool(config),
        }

    provenance["automatic_download"] = download_record
    _decorate_terrain(terrain, site_id, site, coverage, provenance)
    compressed = _serialize_cache(terrain, provenance)
    _write_local_processed(processed_path, compressed)

    if config:
        try:
            _write_s3_object(config, processed_key, compressed, "application/gzip")
            # Preserve original source bytes for auditability and future reprocessing.
            _upload_s3_source(config, source_key, source_path)
        except Exception as exc:
            # The current request can still use the validated local cache. The
            # deployment should configure S3 correctly for restart-safe caching.
            logger.exception("Validated %s DEM but persistent cache write failed: %s", site_id, exc)

    return terrain
