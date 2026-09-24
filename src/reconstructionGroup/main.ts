import { Clock, Color, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DEFAULT_THEME, resolveTheme } from '../core/theme';
import { loadArchive } from '../core/volume';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  isFlat, type ProjectionMode,
} from '../core/projection';
import { wireProjectionToggle } from '../core/projectionToggle';
import { MapOrientationControl } from '../core/mapOrientationControl';
import { wireMapOrientationDrag } from '../core/mapOrientationDrag';
import { orientationQuaternion, type Quaternion } from '../core/rotation';
import { showSamplePopup, hideSamplePopup } from '../core/samplePopup';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import { wireMultiGlobeMenu } from '../core/multiGlobeMenu';
import { ReconstructionGroupInstance, type ReconstructionGroupInstanceDeps } from './reconstructionGroupInstance';
import { RECONSTRUCTION_GROUP_CONFIG } from '../generated/reconstructionGroupConfig';

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = RECONSTRUCTION_GROUP_CONFIG.title;

// Several Reconstruction Models switched by dropdown -- see
// reconstruction/main.ts for the single-model sibling. See globe/main.ts's
// identical comment: one shared camera for every tile.
// `camera`/`controls` are reassigned wholesale by setProjection() below, not
// reconfigured in place -- see climate/main.ts's identical comment
// (docs/adr/0003).
let projectionMode: ProjectionMode = 'globe';
let camera: Camera = createProjectionCamera(projectionMode, innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Themes are not yet wired into this wrapper's UI -- it boots on the
// default Theme's page colour. See docs/adr/0038 for the intended
// always-present control, and themelab/ for the built one.
renderer.setClearColor(new Color(resolveTheme(DEFAULT_THEME).page));
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls(projectionMode, camera, renderer.domElement);

/** Switch every globe on screen to `mode` at once -- see reconstruction/
 *  main.ts's identical function (docs/adr/0003). */
function setProjection(mode: ProjectionMode): void {
  if (mode === projectionMode) return;
  projectionMode = mode;

  controls.dispose();
  camera = createProjectionCamera(mode, innerWidth / innerHeight);
  controls = createProjectionControls(mode, camera, renderer.domElement);
  // See reconstruction/main.ts's identical comment: Map Orientation is
  // dragged directly on the map, which would otherwise fight OrbitControls'
  // own pan on the same element.
  if (isFlat(mode)) controls.enablePan = false;

  for (const inst of host.instances) inst.setProjection(mode, camera);
  orientationControl.setVisible(isFlat(mode));
}

// --- Map Orientation -- see reconstruction/main.ts's identical section for
// the full reasoning (CONTEXT.md's Map Orientation entry). ------------------
const DEFAULT_ORIENTATION: Quaternion = orientationQuaternion(20, -30, 0);
let qOrient: Quaternion = DEFAULT_ORIENTATION;

function applyOrientation(q: Quaternion): void {
  qOrient = q;
  orientationControl.setOrientation(q);
  for (const inst of host.instances) inst.setOrientation(q);
}

// The compass is a read-only indicator -- the drag itself happens on the
// map, right below (see MapOrientationControl's own doc comment).
const orientationControl = new MapOrientationControl(DEFAULT_ORIENTATION, applyOrientation);
Object.assign(orientationControl.el.style, {
  position: 'fixed', left: '12px', bottom: '12px', zIndex: '15',
});
orientationControl.setVisible(isFlat(projectionMode));
document.body.appendChild(orientationControl.el);

wireMapOrientationDrag(
  renderer.domElement,
  { getCamera: () => camera, getMode: () => projectionMode, getOrientation: () => qOrient },
  applyOrientation,
);

// --- globe instances -- see globe/main.ts's identical comment ----------

const host = new MultiInstanceHost<ReconstructionGroupInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: ReconstructionGroupInstanceDeps;

function broadcastAge(source: ReconstructionGroupInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

function createInstance(): ReconstructionGroupInstance {
  return new ReconstructionGroupInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
    onSelectSample: (self, record, citation) => {
      if (record) showSamplePopup(record, citation, () => self.clearSelection());
      else hideSamplePopup();
    },
  });
}

function removeInstance(inst: ReconstructionGroupInstance): void {
  host.remove(inst);
}

async function addInstance(): Promise<void> {
  const inst = createInstance();
  host.add(inst);
  await inst.boot();
  // Reconcile to whatever Projection/Map Orientation is already ambient --
  // see reconstruction/main.ts's identical comment.
  inst.setProjection(projectionMode, camera);
  inst.setOrientation(qOrient);
  broadcastAge(host.lastEditOrFocused('age')!);
}

// --- Multi-Globe menu -- see globe/main.ts's identical section -----------

// See globe/main.ts's identical comment: kept module-level for the
// __geode test hook's setSyncAge() below.
const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;

wireMultiGlobeMenu(
  RECONSTRUCTION_GROUP_CONFIG.multiGlobe,
  () => { void addInstance(); },
  (enabled) => { host.setSync('age', enabled); },
  (enabled) => {
    host.setSync('age', enabled);
    broadcastAge(host.lastEditOrFocused('age')!);
  },
);

wireProjectionToggle(
  document.getElementById('projection-toggle'),
  () => projectionMode,
  (mode) => setProjection(mode),
);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  host.relayout();
});

/** See reconstruction/main.ts's identical function. */
function hitTestTile(clientX: number, clientY: number):
{ inst: ReconstructionGroupInstance; localX: number; localY: number } | null {
  for (let i = 0; i < host.instances.length; i++) {
    const r = host.layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return { inst: host.instances[i], localX: clientX - r.x, localY: clientY - r.y };
    }
  }
  return null;
}

// See reconstruction/main.ts's identical section for the full click-vs-drag
// reasoning.
let pointerDownAt: { x: number; y: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (ev) => {
  pointerDownAt = { x: ev.clientX, y: ev.clientY };
  const hit = hitTestTile(ev.clientX, ev.clientY);
  if (hit) host.focused = hit.inst;
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  const moved = pointerDownAt
    ? Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y)
    : Infinity;
  pointerDownAt = null;
  if (moved > 5) return;
  const hit = hitTestTile(ev.clientX, ev.clientY);
  hit?.inst.selectSampleAt(hit.localX, hit.localY);
});

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const all = archive.reconstruction_models ?? [];
  const entries = RECONSTRUCTION_GROUP_CONFIG.reconstructionIds.map((id) => {
    const e = all.find((r) => r.id === id);
    if (!e) {
      throw new Error(`archive.json has no reconstruction_models entry '${id}' -- `
        + 'check generated/reconstructionGroupConfig.ts against the current catalog');
    }
    return e;
  });

  deps = {
    archiveBase: ARCHIVE, archive, entries, title: RECONSTRUCTION_GROUP_CONFIG.title,
    anchorPlates: RECONSTRUCTION_GROUP_CONFIG.anchorPlates,
  };

  const first = createInstance();
  host.add(first);
  await first.boot();
  first.setProjection(projectionMode, camera);
  first.setOrientation(qOrient);

  if (window.__reconstructionGroup) window.__reconstructionGroup.ready = true;
}

// --- test hook ---------------------------------------------------------
declare global {
  interface Window { __reconstructionGroup?: Record<string, unknown> }
}

function primary(): ReconstructionGroupInstance { return host.instances[0]; }

window.__reconstructionGroup = {
  ready: false,
  setAge: (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setReconstruction: async (id: string) => {
    await primary().setReconstruction(id);
  },
  addGlobe: () => addInstance(),
  removeGlobe: (index = host.instances.length - 1) => {
    const inst = host.instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => host.instances.length,
  setSyncAge: (on: boolean) => {
    host.setSync('age', on);
    if (syncAgeCheckbox) syncAgeCheckbox.checked = on;
    broadcastAge(host.lastEditOrFocused('age')!);
  },
  getSyncState: () => ({ syncAge: host.isSynced('age') }),
  setAgeOn: (index: number, age: number) => {
    const inst = host.instances[index];
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setReconstructionOn: async (index: number, id: string) => {
    const inst = host.instances[index];
    await inst.setReconstruction(id);
  },
  instanceState: (index: number) => {
    const inst = host.instances[index];
    return { age: inst.view.age, reconstruction: inst.manifest?.id };
  },
  stats: () => ({
    reconstruction: primary().manifest?.id,
    age: primary().view.age,
    hasBoundaries: primary().manifest?.has_boundaries,
    globeCount: host.instances.length,
  }),
  setProjection: (mode: ProjectionMode) => setProjection(mode),
  getProjection: () => projectionMode,
  setOrientation: (centerLon: number, centerLat: number, rollDeg = 0) => {
    applyOrientation(orientationQuaternion(centerLon, centerLat, rollDeg));
  },
  resetOrientation: () => applyOrientation(DEFAULT_ORIENTATION),
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  clock.getDelta();

  renderer.setScissorTest(host.instances.length > 1);
  for (let i = 0; i < host.instances.length; i++) {
    const rect = host.layoutRects[i];
    if (!rect) continue;
    updateProjectionCameraAspect(camera, rect.width / rect.height);
    const glY = innerHeight - rect.y - rect.height;
    renderer.setViewport(rect.x, glY, rect.width, rect.height);
    renderer.setScissor(rect.x, glY, rect.width, rect.height);
    host.instances[i].render(renderer);
  }
  renderer.setScissorTest(false);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="error">${String(e)}</pre>`);
});
animate();
