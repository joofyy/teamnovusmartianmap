import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Point, Route, Target, TerrainData } from '../types';

const VERTICAL_EXAGGERATION = 5;

type Layer = 'elevation' | 'slope' | 'roughness' | 'regolith' | 'temperature' | 'environment' | 'radiation' | 'uncertainty' | 'science';
type Props = {
  terrain: TerrainData;
  routes: Route[];
  selectedRoute: string;
  start: Point;
  goal: Point;
  obstacles: Point[];
  layer: Layer;
  viewMode: '3D' | '2D';
  pickMode: 'start' | 'goal' | 'waypoint' | null;
  evaPosition: Point | null;
  returnPath: Point[];
  onPick: (point: Point) => void;
  hazardOverlay?: boolean;
  maxSlopeDeg?: number;
  waypoints?: Point[];
  previewRoute?: { path: Point[]; label: string } | null;
  deviationPoint?: Point | null;
  scientificTargets?: Target[];
  selectedScientificTargetIds?: string[];
  selectedCell?: Point | null;
  onInspect?: (point: Point) => void;
};

type Latest = Omit<Props, 'terrain'>;

function layerValue(terrain: TerrainData, layer: Layer, x: number, y: number): number {
  if (layer === 'slope') return Math.min(terrain.slope_deg[y][x] / 32, 1);
  if (layer === 'roughness') return terrain.roughness[y][x];
  if (layer === 'regolith') return terrain.regolith?.[y]?.[x] ?? 0;
  if (layer === 'temperature') {
    const value = terrain.temperature_c?.[y]?.[x];
    return typeof value === 'number' ? Math.max(0, Math.min(1, (value + 150) / 200)) : 0;
  }
  if (layer === 'environment') return terrain.environment_index?.[y]?.[x] ?? 0;
  if (layer === 'radiation') return terrain.radiation_index?.[y]?.[x] ?? 0;
  if (layer === 'uncertainty') return terrain.uncertainty?.[y]?.[x] ?? 0;
  if (layer === 'science') return terrain.science_potential?.[y]?.[x] ?? 0;
  const values = terrain.elevation_m.flat();
  const min = values.reduce((a, b) => Math.min(a, b));
  const max = values.reduce((a, b) => Math.max(a, b));
  return (terrain.elevation_m[y][x] - min) / Math.max(0.001, max - min);
}

function makeColor(v: number, layer: Layer): THREE.Color {
  const stops = layer === 'science'
    ? [new THREE.Color('#222a2c'), new THREE.Color('#46695e'), new THREE.Color('#d8d19a')]
    : layer === 'radiation'
      ? [new THREE.Color('#243238'), new THREE.Color('#b88b45'), new THREE.Color('#d95e4d')]
      : layer === 'environment'
        ? [new THREE.Color('#293a3b'), new THREE.Color('#668f9a'), new THREE.Color('#d1b56f')]
        : layer === 'temperature'
          ? [new THREE.Color('#5a9eb4'), new THREE.Color('#c6a36a'), new THREE.Color('#c95c4b')]
          : layer === 'uncertainty'
      ? [new THREE.Color('#26343b'), new THREE.Color('#9b864c'), new THREE.Color('#f2d26f')]
      : layer === 'slope'
        ? [new THREE.Color('#273a3b'), new THREE.Color('#ba8956'), new THREE.Color('#d85e45')]
        : [new THREE.Color('#272b2c'), new THREE.Color('#8e6650'), new THREE.Color('#d8a36c')];
  const scaled = Math.max(0, Math.min(0.999, v)) * 2;
  const idx = Math.floor(scaled);
  return stops[idx].clone().lerp(stops[idx + 1], scaled - idx);
}

export default function TerrainScene(props: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const overlayRef = useRef<THREE.Group | null>(null);
  const latestRef = useRef<Latest>({
    routes: props.routes, selectedRoute: props.selectedRoute, start: props.start,
    goal: props.goal, obstacles: props.obstacles, layer: props.layer,
    viewMode: props.viewMode, pickMode: props.pickMode, evaPosition: props.evaPosition,
    returnPath: props.returnPath, onPick: props.onPick,
    selectedCell: props.selectedCell, onInspect: props.onInspect,
  });
  latestRef.current = {
    routes: props.routes, selectedRoute: props.selectedRoute, start: props.start,
    goal: props.goal, obstacles: props.obstacles, layer: props.layer,
    viewMode: props.viewMode, pickMode: props.pickMode, evaPosition: props.evaPosition,
    returnPath: props.returnPath, onPick: props.onPick,
    selectedCell: props.selectedCell, onInspect: props.onInspect,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const { width, height } = props.terrain;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#14191b');
    scene.fog = new THREE.Fog('#14191b', 105, 230);
    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(width * 0.85, -height * 1.05, 75);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight('#b7c2c0', 1.35));
    const sun = new THREE.DirectionalLight('#fff0d4', 2.2);
    sun.position.set(-40, -35, 85);
    sun.castShadow = true;
    scene.add(sun);

    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const values = props.terrain.elevation_m.flat();
    const min = values.reduce((a, b) => Math.min(a, b));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const z = ((props.terrain.elevation_m[y][x] - min) / Math.max(props.terrain.cell_size_m, 1e-6)) * VERTICAL_EXAGGERATION;
        positions.push(x - width / 2, y - height / 2, z);
        const v = layerValue(props.terrain, 'elevation', x, y);
        const color = makeColor(v, 'elevation');
        colors.push(color.r, color.g, color.b);
      }
    }
    const validMask = props.terrain.valid_mask;
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const a = y * width + x;
        const b = a + 1;
        const c = a + width;
        const d = c + 1;
        const aValid = validMask?.[y]?.[x] !== false;
        const bValid = validMask?.[y]?.[x + 1] !== false;
        const cValid = validMask?.[y + 1]?.[x] !== false;
        const dValid = validMask?.[y + 1]?.[x + 1] !== false;
        if (aValid && cValid && bValid) indices.push(a, c, b);
        if (bValid && cValid && dValid) indices.push(b, c, d);
      }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);

    const grid = new THREE.GridHelper(80, 20, '#526063', '#343f41');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -3;
    scene.add(grid);

    const overlay = new THREE.Group();
    scene.add(overlay);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 2);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 30;
    controls.maxDistance = 190;
    controls.maxPolarAngle = Math.PI * 0.48;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerStart: { x: number; y: number; id: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const startPoint = pointerStart;
      pointerStart = null;
      if (!startPoint || startPoint.id !== event.pointerId) return;
      // OrbitControls owns drags. Only a short, stationary press is a cell pick.
      if (Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 6) return;
      const state = latestRef.current;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      // Prefer the actual DEM surface. If a NoData hole has no triangles, fall
      // back to the map's XY footprint so the invalid grid sample remains inspectable.
      const surfaceHit = raycaster.intersectObject(mesh, false)[0]?.point.clone();
      const mapHit = surfaceHit ?? raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        new THREE.Vector3(),
      );
      if (!mapHit) return;
      const localHit = mesh.worldToLocal(mapHit.clone());
      const gx = Math.round(localHit.x + width / 2);
      const gy = Math.round(localHit.y + height / 2);
      if (gx < 0 || gx >= width || gy < 0 || gy >= height) return;
      const selected = { x: gx, y: gy };
      if (state.pickMode) state.onPick(selected);
      else state.onInspect?.(selected);
    };
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    meshRef.current = mesh;
    overlayRef.current = overlay;

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    const resize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      meshRef.current = null;
      overlayRef.current = null;
    };
  }, [props.terrain]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const colors = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const limit = props.maxSlopeDeg ?? 22;

    for (let y = 0; y < props.terrain.height; y++) {
      for (let x = 0; x < props.terrain.width; x++) {
        let color: THREE.Color;
        if (props.hazardOverlay) {
          const isBlocked = props.terrain.obstacle[y][x] || props.terrain.valid_mask?.[y]?.[x] === false;
          const slope = props.terrain.slope_deg[y][x];
          if (isBlocked) {
            color = new THREE.Color('#191f21');
          } else if (slope > limit) {
            color = new THREE.Color('#d85e45'); // hazard steep slope
          } else if (slope >= limit * 0.8) {
            color = new THREE.Color('#d8a35c'); // warning caution slope
          } else {
            color = new THREE.Color('#2e4a42'); // safe traversable slope
          }
        } else {
          color = makeColor(layerValue(props.terrain, props.layer, x, y), props.layer);
        }
        colors.setXYZ(y * props.terrain.width + x, color.r, color.g, color.b);
      }
    }
    colors.needsUpdate = true;
    // computeVertexNormals() is intentionally NOT called here.
    // Normals depend only on vertex positions (geometry), not on vertex colours.
    // Positions are set once at terrain load; calling this on every layer change
    // wastes ~1 ms per frame and produces no visible difference.
  }, [props.terrain, props.layer, props.hazardOverlay, props.maxSlopeDeg]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    while (overlay.children.length) {
      const child = overlay.children.pop();
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    }
    const { width, height } = props.terrain;
    const values = props.terrain.elevation_m.flat();
    const min = values.reduce((a, b) => Math.min(a, b));
    const zAt = (p: Point) => ((props.terrain.elevation_m[p.y][p.x] - min) / Math.max(props.terrain.cell_size_m, 1e-6)) * VERTICAL_EXAGGERATION + 1.2;
    const world = (p: Point) => new THREE.Vector3(p.x - width / 2, p.y - height / 2, zAt(p));

    for (const route of props.routes) {
      const selected = route.id === props.selectedRoute;
      const points = route.path.map((p) => world(p));
      if (points.length > 1) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: route.id === 'A' ? '#7eaaa3' : route.id === 'B' ? '#55c6d5' : '#e4b65e', linewidth: selected ? 3 : 1, transparent: true, opacity: selected ? 1 : 0.38 });
        const line = new THREE.Line(geometry, material);
        line.position.z += selected ? 0.75 : 0.25;
        overlay.add(line);
      }
    }

    if (props.returnPath.length > 1) {
      const returnPoints = props.returnPath.map((point) => world(point));
      const returnGeometry = new THREE.BufferGeometry().setFromPoints(returnPoints);
      const returnMaterial = new THREE.LineDashedMaterial({ color: '#e5c878', dashSize: 1.25, gapSize: 0.8, transparent: true, opacity: 0.95 });
      const returnLine = new THREE.Line(returnGeometry, returnMaterial);
      returnLine.computeLineDistances();
      overlay.add(returnLine);
    }

    const addSphere = (p: Point, color: string, radius: number, heightOffset = 2.8) => {
      const geometry = new THREE.SphereGeometry(radius, 18, 14);
      const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, roughness: 0.35 });
      const sphere = new THREE.Mesh(geometry, material);
      const pos = world(p);
      pos.z += heightOffset;
      sphere.position.copy(pos);
      overlay.add(sphere);
    };
    addSphere(props.start, '#f4eee3', 1.3);
    addSphere(props.goal, '#f2a45b', 1.6);
    const scienceTargets = props.scientificTargets ?? props.terrain.targets;
    for (const target of scienceTargets) {
      const isSelected = (props.selectedScientificTargetIds ?? []).includes(target.id);
      addSphere(target, isSelected ? '#f4e6a1' : '#71d2c5', isSelected ? 1.55 : 1.05, 3.8);
    }
    for (const obstacle of props.obstacles) addSphere(obstacle, '#e25f4e', 1.05, 2.6);
    if (props.evaPosition) addSphere(props.evaPosition, '#70e0c0', 1.45, 4.0);

    // Waypoints
    if (props.waypoints) {
      props.waypoints.forEach((wp) => {
        addSphere(wp, '#45caf0', 1.35, 3.2);
      });
    }

    // Sensitivity preview route
    if (props.previewRoute && props.previewRoute.path.length > 1) {
      const previewPoints = props.previewRoute.path.map((p) => world(p));
      const previewGeom = new THREE.BufferGeometry().setFromPoints(previewPoints);
      const previewMat = new THREE.LineDashedMaterial({
        color: '#ffffff',
        dashSize: 1.5,
        gapSize: 0.8,
        transparent: true,
        opacity: 0.9,
      });
      const previewLine = new THREE.Line(previewGeom, previewMat);
      previewLine.computeLineDistances();
      previewLine.position.z += 1.0;
      overlay.add(previewLine);
    }

    // Deviation point locator from RouteExplainability
    if (props.deviationPoint) {
      addSphere(props.deviationPoint, '#f7df72', 1.7, 4.5);
    }

    // Persistent selected-cell reticle. The marker is tied to the same DEM
    // vertex/grid coordinate used by the inspector readout.
    if (props.selectedCell
      && props.selectedCell.x >= 0 && props.selectedCell.x < width
      && props.selectedCell.y >= 0 && props.selectedCell.y < height) {
      const selectedPosition = world(props.selectedCell);
      const ringGeometry = new THREE.RingGeometry(0.42, 0.55, 40);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: '#8fe8e6', transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthTest: false,
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.copy(selectedPosition);
      ring.position.z += 2.6;
      ring.renderOrder = 20;
      overlay.add(ring);

      const stemGeometry = new THREE.BufferGeometry().setFromPoints([
        selectedPosition.clone().setZ(selectedPosition.z + 2.8),
        selectedPosition.clone().setZ(selectedPosition.z + 7.2),
      ]);
      const stemMaterial = new THREE.LineBasicMaterial({
        color: '#b7f5e9', transparent: true, opacity: 0.82, depthTest: false,
      });
      const stem = new THREE.Line(stemGeometry, stemMaterial);
      stem.renderOrder = 21;
      overlay.add(stem);
    }

    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (camera && controls) {
      if (props.viewMode === '2D') {
        camera.position.set(0, 0, 135);
        camera.up.set(0, 1, 0);
        controls.maxPolarAngle = Math.PI / 2;
      } else {
        camera.position.set(width * 0.85, -height * 1.05, 75);
        camera.up.set(0, 0, 1);
        controls.maxPolarAngle = Math.PI * 0.48;
      }
      controls.target.set(0, 0, 2);
      controls.update();
    }
  }, [
    props.routes,
    props.selectedRoute,
    props.start,
    props.goal,
    props.obstacles,
    props.viewMode,
    props.terrain,
    props.evaPosition,
    props.returnPath,
    props.waypoints,
    props.previewRoute,
    props.deviationPoint,
    props.scientificTargets,
    props.selectedScientificTargetIds,
    props.selectedCell,
  ]);

  return <div className="terrain-canvas" ref={mountRef} aria-label="Interactive 3D terrain model derived from an imported Mars DEM. Drag to orbit, scroll to zoom, click to set route points." />;
}
