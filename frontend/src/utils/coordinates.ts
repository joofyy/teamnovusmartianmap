import type { Point, TerrainData } from '../types';
import type { MissionSite } from '../missionSites';

export const MARS_MEAN_RADIUS_M = 3389500;

export interface GeoCoordinate {
  latitude: number;
  longitude: number;
  formattedLat: string;
  formattedLon: string;
}

export function formatLatitude(value: number): string {
  const hemi = value < 0 ? 'S' : 'N';
  return `${Math.abs(value).toFixed(5)}° ${hemi}`;
}

export function formatLongitude(value: number): string {
  const norm = ((value % 360) + 360) % 360;
  return `${norm.toFixed(5)}° E`;
}

export function getSiteReference(terrain?: TerrainData | null, site?: MissionSite | null) {
  const lat = (terrain?.coordinate_info?.site_reference_latitude as number | undefined)
    ?? site?.latitude
    ?? 18.44463;
  const lon = (terrain?.coordinate_info?.site_reference_longitude_east as number | undefined)
    ?? site?.longitudeEast
    ?? 77.45088;
  return { lat, lon };
}

/**
 * Converts discrete grid cell (x, y) to planetocentric Latitude and East-positive Longitude.
 * Grid (x, y) is centered at (width / 2, height / 2) on the landing-site reference coordinates.
 */
export function gridToGeo(
  point: Point,
  terrain?: TerrainData | null,
  site?: MissionSite | null,
): GeoCoordinate {
  const width = terrain?.width ?? 80;
  const height = terrain?.height ?? 80;
  const cellSizeM = (terrain?.cell_size_m && Number.isFinite(terrain.cell_size_m) && terrain.cell_size_m > 0)
    ? terrain.cell_size_m
    : 20;

  const { lat: refLat, lon: refLon } = getSiteReference(terrain, site);
  const x0 = width / 2;
  const y0 = height / 2;

  const dx = (point.x - x0) * cellSizeM;
  const dy = (y0 - point.y) * cellSizeM;

  const latRad = (refLat * Math.PI) / 180;
  const lat = refLat + (dy / MARS_MEAN_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.cos(latRad);
  const lon = refLon + (dx / (MARS_MEAN_RADIUS_M * (Math.abs(cosLat) > 1e-6 ? cosLat : 1e-6))) * (180 / Math.PI);
  const normLon = ((lon % 360) + 360) % 360;

  return {
    latitude: lat,
    longitude: normLon,
    formattedLat: formatLatitude(lat),
    formattedLon: formatLongitude(normLon),
  };
}

/**
 * Converts planetocentric Latitude and East-positive Longitude to nearest grid cell (x, y).
 */
export function geoToGrid(
  latitude: number,
  longitude: number,
  terrain?: TerrainData | null,
  site?: MissionSite | null,
): { point: Point; inBounds: boolean; clampedPoint: Point; distanceM: number } {
  const width = terrain?.width ?? 80;
  const height = terrain?.height ?? 80;
  const cellSizeM = (terrain?.cell_size_m && Number.isFinite(terrain.cell_size_m) && terrain.cell_size_m > 0)
    ? terrain.cell_size_m
    : 20;

  const { lat: refLat, lon: refLon } = getSiteReference(terrain, site);
  const x0 = width / 2;
  const y0 = height / 2;

  let dLon = longitude - refLon;
  while (dLon > 180) dLon -= 360;
  while (dLon < -180) dLon += 360;

  const dLat = latitude - refLat;

  const latRad = (refLat * Math.PI) / 180;
  const dy = (dLat * Math.PI * MARS_MEAN_RADIUS_M) / 180;
  const dx = (dLon * Math.PI * MARS_MEAN_RADIUS_M * Math.cos(latRad)) / 180;

  const rawX = x0 + dx / cellSizeM;
  const rawY = y0 - dy / cellSizeM;

  const x = Math.round(rawX);
  const y = Math.round(rawY);

  const inBounds = x >= 0 && x < width && y >= 0 && y < height;
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));

  const distanceM = Math.hypot((rawX - clampedX) * cellSizeM, (rawY - clampedY) * cellSizeM);

  return {
    point: { x, y },
    inBounds,
    clampedPoint: { x: clampedX, y: clampedY },
    distanceM,
  };
}

/**
 * Format a point into a concise combined grid and geographical label
 */
export function formatPointFull(
  point: Point,
  terrain?: TerrainData | null,
  site?: MissionSite | null,
): string {
  const geo = gridToGeo(point, terrain, site);
  return `X ${String(point.x).padStart(2, '0')} / Y ${String(point.y).padStart(2, '0')} (${geo.formattedLat}, ${geo.formattedLon})`;
}
