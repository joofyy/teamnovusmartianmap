import { useEffect, useState } from 'react';
import { api } from '../api';
import type { MarsSite, JezeroPoisResponse, OfficialSource, TerrainData } from '../types';

type ArchiveResult = { archive: string; endpoint: string; query: Record<string, unknown>; record_count: number; records: Record<string, unknown>[]; raw: unknown; documentation: string; note: string };
type ObservationImport = { instrument: string; source_file: string; sha256: string; imported_utc: string; row_count: number; summary: Record<string, unknown>; provenance_note: string };

function textField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return 'Metadata field not present in this record';
}

export default function DataExplorer({ sources, planId, site, onTerrainImported }: { sources: OfficialSource[]; planId?: string; site: MarsSite; onTerrainImported: (terrain: TerrainData) => void }) {
  const [keywords, setKeywords] = useState('Curiosity boxwork Mount Sharp');
  const [instrument, setInstrument] = useState('HiRISE');
  const [pdsResult, setPdsResult] = useState<ArchiveResult | null>(null);
  const [odeResult, setOdeResult] = useState<ArchiveResult | null>(null);
  const [loading, setLoading] = useState<'pds' | 'ode' | 'dem' | 'layer' | 'observations' | 'package' | 'tiles' | 'download' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [observations, setObservations] = useState<ObservationImport[]>([]);
  const [roverInstrument, setRoverInstrument] = useState('REMS');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [mappingText, setMappingText] = useState('{\n  "sol": "sol",\n  "temperature_c": "temperature_c",\n  "pressure_pa": "pressure_pa",\n  "wind_speed_m_s": "wind_speed_m_s"\n}');
  const [layerKind, setLayerKind] = useState('temperature_c');
  const [layerMin, setLayerMin] = useState(-150);
  const [layerMax, setLayerMax] = useState(50);
  const [layerUnit, setLayerUnit] = useState('degC');
  const [wmtsLayer, setWmtsLayer] = useState('curiosity_hirise_mosaic');
  const [tileBbox, setTileBbox] = useState('137.42,-4.86,137.50,-4.78');
  const [tileSummary, setTileSummary] = useState('');
  const [officialUrl, setOfficialUrl] = useState('');
  const [downloadSummary, setDownloadSummary] = useState('');
  const [labelFile, setLabelFile] = useState<File | null>(null);
  const [labelResult, setLabelResult] = useState<Record<string, unknown> | null>(null);
  const [demVerticalUnits, setDemVerticalUnits] = useState('unspecified');
  const [jezero, setJezero] = useState<JezeroPoisResponse | null>(null);
  const [jezeroError, setJezeroError] = useState('');

  useEffect(() => {
    let alive = true;
    api.jezeroPois()
      .then((result) => { if (alive) setJezero(result); })
      .catch((err: Error) => { if (alive) setJezeroError(err.message); });
    return () => { alive = false; };
  }, []);

  const refreshObservations = async () => {
    try { const result = await api.observations(); setObservations(result.imports); }
    catch { /* archive imports are optional; do not block the data explorer */ }
  };
  useEffect(() => { void refreshObservations(); }, []);

  const runPdsSearch = async () => {
    setLoading('pds'); setError(''); setNotice('');
    try { setPdsResult(await api.pdsSearch(keywords, 20)); }
    catch (err) { setError(err instanceof Error ? err.message : 'PDS search failed'); }
    finally { setLoading(null); }
  };

  const inspectLabel = async () => {
    if (!labelFile) { setError('Select a PDS3 .LBL or PDS4 .XML product label first.'); return; }
    setLoading('pds'); setError(''); setNotice(''); setLabelResult(null);
    try {
      const result = await api.inspectPdsLabel(labelFile);
      setLabelResult(result);
      setNotice(`Inspected and preserved label ${String(result.source_filename ?? labelFile.name)} with SHA-256 ${String(result.source_sha256 ?? '').slice(0, 16)}…`);
    } catch (err) { setError(err instanceof Error ? err.message : 'PDS label inspection failed'); }
    finally { setLoading(null); }
  };

  const runOdeSearch = async () => {
    setLoading('ode'); setError(''); setNotice('');
    try { setOdeResult(await api.odeSearch(instrument, { minLat: -6.5733, maxLat: -2.8078, westLon: 135.1843, eastLon: 139.2413, limit: 40 })); }
    catch (err) { setError(err instanceof Error ? err.message : 'ODE search failed'); }
    finally { setLoading(null); }
  };

  const importDem = async (file?: File) => {
    if (!file) return;
    setLoading('dem'); setError(''); setNotice('');
    try {
      const result = await api.importDem(file, demVerticalUnits, site.id);
      onTerrainImported(result.terrain);
      setNotice(`DEM imported. Active route grid: ${result.terrain.width} × ${result.terrain.height}. ${result.notice}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'DEM import failed'); }
    finally { setLoading(null); }
  };

  const importLayer = async (file?: File) => {
    if (!file) return;
    setLoading('layer'); setError(''); setNotice('');
    try {
      const result = await api.importLayer(file, layerKind, layerMin, layerMax, layerUnit, site.id);
      onTerrainImported(result.terrain);
      setNotice(`Layer ${layerKind} aligned to the active Mars DEM. ${result.notice}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Raster layer import failed'); }
    finally { setLoading(null); }
  };

  const importObservations = async () => {
    if (!csvFile) { setError('Select a CSV export first.'); return; }
    setLoading('observations'); setError(''); setNotice('');
    try {
      const mapping = JSON.parse(mappingText) as Record<string, string>;
      const result = await api.importObservations(csvFile, roverInstrument, mapping);
      await refreshObservations();
      setNotice(`Imported ${String(result.import.row_count ?? 0)} ${roverInstrument} rows. Raw CSV, SHA-256 and explicit column mapping were retained. Values remain rover-station observations.`);
      setCsvFile(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Observation CSV import failed. Check your mapping JSON.'); }
    finally { setLoading(null); }
  };

  const downloadOfficial = async () => {
    if (!officialUrl.trim()) { setError('Paste an official PDS/mission archive product URL first.'); return; }
    setLoading('download'); setError(''); setNotice(''); setDownloadSummary('');
    try {
      const result = await api.downloadOfficialFile(officialUrl.trim());
      setDownloadSummary(`${result.stored_filename} · ${(result.size_bytes / (1024 * 1024)).toFixed(2)} MB · SHA-256 ${result.sha256.slice(0, 18)}…`);
      setNotice('Official archive bytes downloaded and preserved with URL, headers and SHA-256 provenance. Inspect the original label before importing or interpreting the file.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Official archive download failed'); }
    finally { setLoading(null); }
  };

  const cacheWmts = async () => {
    setLoading('tiles'); setError(''); setNotice(''); setTileSummary('');
    try {
      const bbox = tileBbox.split(',').map((value) => Number(value.trim()));
      if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) throw new Error('Enter west,south,east,north as four numbers.');
      const result = await api.cacheTrekTiles(wmtsLayer, bbox, 96);
      setTileSummary(`${result.tile_count} tiles · ${Math.round(result.total_bytes / 1024)} KB · ${result.matrix} · ${result.resolution_m_per_pixel.toFixed(2)} m/px`);
      setNotice(`Official NASA/JPL Mars Trek tiles cached as ${result.stored_filename}. ${result.notice}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'WMTS cache failed'); }
    finally { setLoading(null); }
  };

  const makeOfflinePackage = async () => {
    setLoading('package'); setError(''); setNotice('');
    try {
      const blob = await api.offlinePackage(planId);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl; link.download = 'marscope-offline-review-package.zip';
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(objectUrl);
      setNotice('Offline review package generated. It includes the current terrain, mission plan, data catalogue, curated evidence, imported observations, DEM/raster provenance and any cached WMTS imagery. It is not an operational EVA map.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Offline package failed'); }
    finally { setLoading(null); }
  };

  return <div className="data-content archive-explorer">
    <section className="archive-search-card">
      <div className="archive-section-head"><b>ACTIVE LANDING-SITE DEM</b><span className={site.terrain_loaded ? "connected-tag" : "manual-tag"}>{site.terrain_loaded ? "REAL DEM LOADED" : "IMPORT REQUIRED"}</span></div>
      <h3>{site.name}</h3>
      <p><b>{site.dem.name}</b> · {site.dem.resolution_m.toFixed(site.dem.resolution_m < 2 ? 2 : 1)} m/post · {site.dem.format} · {site.dem.size_mb} MB</p>
      <p>{site.dem.coverage_note}</p>
      <div className="archive-search-line">
        <a href={site.dem.download_url} target="_blank" rel="noreferrer">DOWNLOAD OFFICIAL SITE DEM ↗</a>
        <a href={site.dem.documentation_url} target="_blank" rel="noreferrer">PRODUCT DOCUMENTATION ↗</a>
      </div>
      <small>Download the selected source and import the file below. Route planning stays unavailable for a site until a valid Mars DEM is loaded and passes the CRS/body checks.</small>
    </section>
    <div className="panel-title"><span className="eyebrow">OFFICIAL ARCHIVE CONNECTORS</span><h3>NASA data access</h3><p>Discover official products, inspect their original metadata, import geospatial rasters with provenance, and preserve selected mission materials for offline review.</p></div>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>01 / NASA PDS SEARCH</b><span className="connected-tag">LIVE API</span></div>
      <p>Searches NASA's PDS product registry. Product labels remain authoritative for coordinate conventions, instrument units, calibration and processing level.</p>
      <div className="archive-search-line"><input value={keywords} onChange={(e) => setKeywords(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void runPdsSearch()} aria-label="NASA PDS search keywords"/><button onClick={() => void runPdsSearch()} disabled={loading !== null}>{loading === 'pds' ? 'SEARCHING' : 'SEARCH PDS'}</button></div>
      {pdsResult && <ArchiveResultView result={pdsResult}/>}
      <a href="https://nasa-pds.github.io/pds-api/guides/search.html" target="_blank" rel="noreferrer">PDS API DOCUMENTATION ↗</a>
    </section>


    <section className="archive-search-card">
      <div className="archive-section-head"><b>02 / INSPECT ORIGINAL PDS LABEL</b><span className="manual-tag">PDS3 / PDS4</span></div>
      <p>Upload the original .LBL or .XML label downloaded with a NASA archive product. MARSCOPE extracts product, instrument, time, projection, axis and unit metadata while retaining the raw label and SHA-256.</p>
      <label className="upload-button">{labelFile ? labelFile.name : 'SELECT PDS PRODUCT LABEL'}<input type="file" accept=".lbl,.xml,.txt,text/plain,application/xml" hidden onChange={(e) => setLabelFile(e.target.files?.[0] ?? null)}/></label>
      <button className="package-button" onClick={() => void inspectLabel()} disabled={loading !== null || !labelFile}>{loading === 'pds' ? 'INSPECTING LABEL…' : 'INSPECT / PRESERVE LABEL'}</button>
      {labelResult && <details open><summary>Parsed label metadata</summary><pre>{JSON.stringify(labelResult, null, 2).slice(0, 15000)}</pre></details>}
      <small>Parsed fields are convenience extracts, not a substitute for the complete label, instrument SIS or calibration documentation.</small>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>03 / MARS ORBITAL DATA EXPLORER</b><span className="connected-tag">ODE REST</span></div>
      <p>Searches product footprints intersecting the Gale Crater region. ODE uses east-positive longitudes in the query; verify each product's map-projection label.</p>
      <div className="archive-search-line"><select value={instrument} onChange={(e) => setInstrument(e.target.value)} aria-label="Instrument"><option>HiRISE</option><option>CTX</option><option>CRISM</option></select><button onClick={() => void runOdeSearch()} disabled={loading !== null}>{loading === 'ode' ? 'SEARCHING' : 'SEARCH ODE'}</button></div>
      {odeResult && <ArchiveResultView result={odeResult}/>}
      <a href="https://oderest.rsl.wustl.edu/ODE_REST_V2.1.6.pdf" target="_blank" rel="noreferrer">ODE REST MANUAL ↗</a>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>04 / DOWNLOAD AN OFFICIAL ARCHIVE PRODUCT</b><span className="connected-tag">PDS / MISSION ARCHIVE</span></div>
      <p>Paste a file URL copied from a NASA PDS or approved mission archive result. MARSCOPE checks the HTTPS host, follows only allow-listed archive redirects, enforces a 250 MB limit, and records SHA-256 plus retrieval metadata.</p>
      <label className="compact-field-label">OFFICIAL PRODUCT FILE URL</label>
      <input className="mapping-input" value={officialUrl} onChange={(e) => setOfficialUrl(e.target.value)} placeholder="https://pds-geosciences.wustl.edu/.../product.tif" aria-label="Official archive product URL" />
      <button className="package-button" onClick={() => void downloadOfficial()} disabled={loading !== null}>{loading === 'download' ? 'DOWNLOADING / HASHING…' : 'DOWNLOAD AND PRESERVE OFFICIAL PRODUCT'}</button>
      {downloadSummary && <small>{downloadSummary}</small>}
      <small>Downloaded files are not automatically calibrated, converted or assumed to be DEMs. Use the original PDS label and instrument SIS. Supported formats include GeoTIFF, JP2, PDS IMG/LBL/XML, tables and archives.</small>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>05 / NASA/JPL MARS TREK WMTS</b><span className="connected-tag">MAP SERVICE</span></div>
      <p>Cache a small area from the official Curiosity HiRISE roving-site mosaic or a MOLA/HRSC global context layer. Tile matrices, styles and formats are read from WMTS GetCapabilities.</p>
      <div className="archive-search-line"><select value={wmtsLayer} onChange={(e) => setWmtsLayer(e.target.value)} aria-label="Mars Trek layer"><option value="curiosity_hirise_mosaic">Curiosity HiRISE mosaic</option><option value="Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw">MOLA / HRSC color hillshade</option><option value="Mars_MGS_MOLA_ClrShade_merge_global_463m">MOLA global hillshade</option></select></div>
      <label className="compact-field-label">BOUNDS · WEST, SOUTH, EAST, NORTH (EAST-POSITIVE DEGREES)</label>
      <input className="mapping-input" value={tileBbox} onChange={(e) => setTileBbox(e.target.value)} aria-label="WMTS bounding box"/>
      <button className="package-button" onClick={() => void cacheWmts()} disabled={loading !== null}>{loading === 'tiles' ? 'READING CAPABILITIES / CACHING…' : 'CACHE WMTS TILES FOR OFFLINE REVIEW'}</button>
      {tileSummary && <small>{tileSummary}</small>}
      <a href="https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars" target="_blank" rel="noreferrer">MARS TREK WMTS DOCUMENTATION ↗</a>
      <small>Rendered imagery is not a calibrated DEM. A missing tile indicates no service coverage at that location/zoom.</small>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>06 / IMPORT A VERIFIED MARS DEM</b><span className="manual-tag">GEOSPATIAL INGESTION</span></div>
      <p>Upload the selected site's map-projected DEM. GeoTIFF and HiRISE PDS3 IMG are supported when GDAL can read their embedded projection metadata. Confirm vertical units from the original product label. The pipeline derives slope and local roughness, masks NoData, and retains a source hash and CRS.</p>
      <label className="compact-field-label">DEM VERTICAL UNITS (VERIFY IN ORIGINAL PRODUCT LABEL)
        <select className="mapping-input" value={demVerticalUnits} onChange={(e) => setDemVerticalUnits(e.target.value)} aria-label="DEM vertical units">
          <option value="unspecified">Not verified yet</option><option value="m">Metres (verified in source label)</option>
        </select>
      </label>
      <label className="upload-button">{loading === 'dem' ? 'PROCESSING DEM…' : 'SELECT SITE DEM FILE'}<input type="file" accept={site.dem.import_formats.join(',')} hidden onChange={(e) => void importDem(e.target.files?.[0])} disabled={loading !== null}/></label>
      <small>Earth UTM rasters and unknown-body coordinate systems are rejected. A browse image or CTX image is not an elevation model. Meridiani's PDS IMG must expose a compatible projection through its embedded label. Gale's selected 30 m product is 311.8 MB; the upload ceiling is 400 MB.</small>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>07 / ALIGN AN ADDITIONAL SCIENCE LAYER</b><span className="manual-tag">EXPLICIT MAPPING</span></div>
      <p>After importing a DEM, align one GeoTIFF band to its exact grid. Choose the scientific meaning and declared source scale yourself. Unknown cells receive elevated uncertainty.</p>
      <div className="archive-search-line"><select value={layerKind} onChange={(e) => { setLayerKind(e.target.value); setLayerUnit(e.target.value === 'temperature_c' ? 'degC' : 'source units'); }} aria-label="Raster layer meaning"><option value="temperature_c">Temperature (°C)</option><option value="radiation_index">Radiation relative index (0–1)</option><option value="environment_index">Environmental relative index (0–1)</option><option value="regolith">Regolith mobility index (0–1)</option><option value="science_potential">Scientific potential (0–1)</option><option value="uncertainty">Data uncertainty (0–1)</option></select></div>
      <div className="archive-search-line"><label className="compact-field-label">SOURCE MIN <input type="number" value={layerMin} onChange={(e) => setLayerMin(Number(e.target.value))}/></label><label className="compact-field-label">SOURCE MAX <input type="number" value={layerMax} onChange={(e) => setLayerMax(Number(e.target.value))}/></label></div>
      <label className="compact-field-label">SOURCE UNIT <input className="mapping-input" value={layerUnit} onChange={(e) => setLayerUnit(e.target.value)}/></label>
      <label className="upload-button">{loading === 'layer' ? 'ALIGNING RASTER…' : 'SELECT LAYER GEOTIFF'}<input type="file" accept=".tif,.tiff,image/tiff" hidden onChange={(e) => void importLayer(e.target.files?.[0])} disabled={loading !== null}/></label>
      <small>Normalized layers use a user-declared min/max scale. This is a mapping choice, not automatic scientific calibration. Temperature requires Celsius.</small>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>08 / IMPORT CURIOSITY REMS / RAD OBSERVATIONS</b><span className="manual-tag">STATION TIME SERIES</span></div>
      <p>Import a CSV table exported from an official archive product. Map columns explicitly after checking the product label/SIS. The original CSV and SHA-256 are retained.</p>
      <div className="archive-search-line"><select value={roverInstrument} onChange={(e) => setRoverInstrument(e.target.value)} aria-label="Rover instrument"><option>REMS</option><option>RAD</option></select><label className="upload-button">{csvFile ? csvFile.name : 'SELECT CSV'}<input type="file" accept=".csv,text/csv" hidden onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}/></label></div>
      <label className="compact-field-label">NORMALIZED FIELD → SOURCE CSV COLUMN</label>
      <textarea className="mapping-input mapping-area" value={mappingText} onChange={(e) => setMappingText(e.target.value)} rows={5} spellCheck={false}/>
      <small>REMS needs at least one temperature_C, pressure_pa or wind_speed_m_s field. RAD requires radiation_value and radiation_unit. Field names and units must match source metadata.</small>
      <button className="package-button" onClick={() => void importObservations()} disabled={loading !== null || !csvFile}>{loading === 'observations' ? 'IMPORTING OBSERVATIONS…' : 'IMPORT OFFICIAL OBSERVATION EXPORT'}</button>
      {observations.length > 0 && <div className="observation-list"><div className="archive-section-head"><b>IMPORTED STATION DATA</b><span>{observations.length} IMPORTS</span></div>{observations.map((record) => <div className="archive-record" key={record.sha256}><b>{record.instrument} · {record.source_file}</b><small>{record.row_count} rows · {new Date(record.imported_utc).toLocaleString()}</small><small>SHA-256 · {record.sha256.slice(0, 18)}…</small><pre>{JSON.stringify(record.summary, null, 2)}</pre></div>)}</div>}
      <small>REMS/RAD rover-station time series are never copied into the terrain grid or presented as spatial weather/radiation maps.</small>
    </section>

    <section className="archive-search-card">
      <div className="archive-section-head"><b>09 / OFFLINE REVIEW PACKAGE</b><span className="manual-tag">EXPORT</span></div>
      <p>Exports the active terrain, mission routes, provenance, imported station records, source catalog, curated science evidence, GeoTIFFs and cached Mars Trek tiles.</p>
      <button className="package-button" onClick={() => void makeOfflinePackage()} disabled={loading !== null}>{loading === 'package' ? 'PACKAGING…' : 'BUILD OFFLINE REVIEW PACKAGE'}</button>
      <small>Offline review does not imply certified offline astronaut navigation. Fresh telemetry, communications, localization and hazards are not provided.</small>
    </section>

    {(error || notice) && <div className={error ? 'error-banner' : 'success-note'}>{error || notice}</div>}


    <section className="archive-search-card">
      <div className="archive-section-head"><b>JEZERO CRATER / REFERENCE LOCATIONS</b><span className="connected-tag">BACKEND API</span></div>
      <p>Reference locations are loaded from the FastAPI Jezero endpoint. Coordinates use planetocentric latitude and east-positive longitude.</p>
      {jezero ? <>
        <div className="archive-record"><b>{jezero.site}</b><small>{jezero.coordinate_convention}</small></div>
        {jezero.points.map((point) => <div className="archive-record" key={point.id}>
          <b>{point.name}</b>
          <small>{point.latitude.toFixed(5)}° N · {point.longitude_east.toFixed(5)}° E</small>
          <small>{point.precision} · {point.description}</small>
        </div>)}
        <div className="archive-record">
          <b>{jezero.dem.name}</b>
          <small>{jezero.dem.pixel_scale_m} m/pixel · {jezero.dem.format} · {jezero.dem.vertical_units}</small>
          <a href={jezero.dem.url} target="_blank" rel="noreferrer">DOWNLOAD JEZERO DEM ↗</a>
          <a href={jezero.dem.documentation} target="_blank" rel="noreferrer">USGS PRODUCT DOCUMENTATION ↗</a>
        </div>
        <small>{jezero.notice}</small>
      </> : <div className={jezeroError ? 'error-banner' : 'archive-empty'}>{jezeroError ? `Could not load Jezero locations: ${jezeroError}` : 'Loading Jezero reference locations…'}</div>}
    </section>

    <div className="data-source-list"><div className="target-list-head"><span className="eyebrow">OFFICIAL SOURCE CATALOG</span><span className="demo-tag">{sources.length} SOURCES</span></div>
      {sources.map((source) => <div className="dataset-row" key={source.id}><div className="dataset-top"><b>{source.name}</b><span className={source.integration === 'connected' ? 'connected-tag' : 'doc-status'}>{source.integration.replace(/_/g, ' ').toUpperCase()}</span></div><small>{source.organization} · {source.kind}</small><div className="dataset-detail">{source.description}</div><div className="dataset-detail muted-copy">Coverage: {source.coverage}</div><div className="dataset-detail muted-copy">Limit: {source.limitations}</div><a href={source.url} target="_blank" rel="noreferrer">OFFICIAL SOURCE ↗</a></div>)}
    </div>
  </div>;
}

function ArchiveResultView({ result }: { result: ArchiveResult }) {
  return <div className="archive-results">
    <div className="archive-result-summary"><b>{result.record_count} metadata records</b><span>{result.archive}</span></div>
    {result.records.slice(0, 12).map((record, index) => {
      const title = textField(record, ['title', 'product_name', 'Product_name', 'pdsid', 'PDSId', 'product_id', 'name']);
      const id = textField(record, ['lid', 'product_lid', 'Product_lid', 'pdsid', 'PDSId', 'ode_id', 'ODE_ID']);
      const url = textField(record, ['label_url', 'LabelURL', 'product_url', 'ProductURL', 'url', 'URL']);
      return <div className="archive-record" key={`${id}-${index}`}><b>{title}</b><small>{id}</small>{url.startsWith('http') && <a href={url} target="_blank" rel="noreferrer">OPEN PRODUCT ↗</a>}</div>;
    })}
    {result.records.length === 0 && <div className="archive-empty">No product rows were normalized from this response. Inspect the unmodified response structure below, or use the official archive documentation to locate the product identifier.</div>}
    <details><summary>Raw archive response</summary><pre>{JSON.stringify(result.raw, null, 2).slice(0, 14000)}</pre></details>
    <small>{result.note}</small>
  </div>;
}
