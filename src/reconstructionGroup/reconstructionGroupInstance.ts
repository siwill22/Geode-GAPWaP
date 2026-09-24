import { type Camera, type PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { Coastlines, fetchCoastlineData } from '../core/coastlines';
import { OceanSurface } from '../core/oceanSurface';
import { Graticule } from '../core/graticule';
import { resolveTheme } from '../core/theme';
import { createMaskTexture } from '../core/mask';
import { BoundaryOverlay } from '../core/boundaries';
import { PointOverlay, resolvePaleomagPoleSetFor } from '../core/pointOverlay';
import {
  GAPWAP_PATH_COLOR, GAPWAP_PATH_WIDTH, poleStyle, siteStyle,
} from '../core/paleomagPalette';
import { loadReconstructionManifest, reconstructionAssetPath, reconstructionAssetUrl } from '../core/reconstructions';
import { isFlat, type ProjectionMode } from '../core/projection';
import {
  composeQuaternions, referenceRotationAt, type Quaternion,
} from '../core/rotation';
import type {
  ArchiveIndex, ReconstructionEntry, ReconstructionManifest, RotationTable,
} from '../core/types';
import type { Rect } from '../core/layout';
import type { LandColorMode } from '../core/coastlines';
import type { PaleomagSampleRecord } from '../core/paleomagPalette';
import { ReconstructionGroupUI, type ReconstructionGroupViewState } from './reconstructionGroupUi';


export interface ReconstructionGroupInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  entries: ReconstructionEntry[];
  title: string;
  /** Reconstruction Model id -> the plate this viewer anchors it on (see
   *  ReconstructionGroupConfig.anchorPlates). Absent ids anchor on 0. */
  anchorPlates?: Record<string, number>;
}

/** See globe/globeInstance.ts's GlobeInstanceHooks -- identical reasoning
 *  (no onFocus, Reconstruction Age is the only Synced Field this wrapper
 *  type offers). */
export interface ReconstructionGroupInstanceHooks {
  onRemove(self: ReconstructionGroupInstance): void;
  onAgeChange?(self: ReconstructionGroupInstance, age: number): void;
  /** See reconstruction/reconstructionInstance.ts's identical hook. */
  onSelectSample?(
    self: ReconstructionGroupInstance, record: PaleomagSampleRecord | null, citation: string,
  ): void;
}

/**
 * One globe comparing several Reconstruction Models' own geometry, switched
 * via one dropdown -- coastlines always, Boundary Frames when the currently
 * -selected model has them (docs/adr/0019). Never a numerical field
 * (docs/adr/0020): the comparison is ONE axis (which Reconstruction Model),
 * never a 2-D grid like `model-group-globe`'s reconstruction x role. See
 * reconstruction/reconstructionInstance.ts for the single-model sibling
 * this generalizes by adding reconstruction-switching, the same
 * relationship globe/groupGlobe already have.
 */
export class ReconstructionGroupInstance {
  readonly scene = new Scene();
  readonly ui: ReconstructionGroupUI;
  readonly boundaries: BoundaryOverlay;
  /** Paleomagnetic poles (VGPs) + the modelled GAPWaP path -- see
   *  reconstruction/reconstructionInstance.ts's identical fields for the
   *  full reasoning. Reloaded on every setReconstruction() switch, same as
   *  coastlines/boundaries, since the export is per Reconstruction Model. */
  readonly poles: PointOverlay;
  readonly gapwapPath: PointOverlay;
  /** Sample Site markers -- see reconstruction/reconstructionInstance.ts's
   *  identical field for the full reasoning (same records as `poles`, same
   *  array index, repositioned to sample_lon/sample_lat). Reloaded on every
   *  setReconstruction() switch alongside `poles`/`gapwapPath`. */
  readonly sites: PointOverlay;
  /** See reconstruction/reconstructionInstance.ts's identical field. */
  private poleSetCitation = '';
  /** See reconstruction/reconstructionInstance.ts's identical field. */
  private platesWithData: Set<number> = new Set();
  /** A solid ocean, always present: continents previously sat straight on
   *  the page colour, so the globe read as a cut-out and the far
   *  hemisphere's coastlines showed through. */
  readonly ocean = new OceanSurface('globe');
  /** A fixed lon/lat reference grid, in the same world frame as coastlines
   *  and the paleomagnetic overlay -- see core/graticule.ts and
   *  reconstruction/reconstructionInstance.ts's identical field. Persists
   *  across setReconstruction() switches exactly like `ocean`: it has no
   *  per-model geometry to reload. */
  readonly graticule = new Graticule();
  coastlines: Coastlines | null = null;
  private readonly maskTexture = createMaskTexture();

  /** See reconstruction/reconstructionInstance.ts's identical fields --
   *  Projection/Map Orientation are global (main.ts is the source of
   *  truth), these are only this instance's own record so a freshly-built
   *  Coastlines/etc. (every setReconstruction() switch rebuilds them from
   *  scratch, always starting at THEIR OWN default of globe/identity) can be
   *  reconciled to the current ambient state at the end of that method. */
  private projectionMode: ProjectionMode = 'globe';
  private qOrient: Quaternion = [0, 0, 0, 1];

  /** The current model's anchor plate (deps.anchorPlates, default 0) and the
   *  rotation table to reanchor with. Every layer's data is exported at
   *  anchor 0; anchoring on plate A instead is the same thing as composing
   *  the inverse of A's own rotation on top (referenceRotationAt), so this
   *  is the Reference Plate mechanism, fixed per model rather than chosen. */
  private anchorPlateId = 0;
  private rotationTable: RotationTable | null = null;

  readonly view: ReconstructionGroupViewState = {
    reconstruction: '', age: 0, showBoundaries: true, showPaleomagPoles: true, landColorMode: 'theme',
  };

  /** Guards setReconstruction() against a no-op re-entry -- deliberately NOT
   *  `this.view.reconstruction`: lil-gui's OptionController writes the new
   *  value into the shared `view` object BEFORE firing onChange, so a real
   *  dropdown click has already made this comparison true by the time this
   *  callback runs. Same bug, same fix, as GroupGlobeInstance's
   *  `activeAxisA`/`activeAxisB`. */
  private activeReconstruction = '';

  get manifest(): ReconstructionManifest | null { return this.currentManifest; }
  private currentManifest: ReconstructionManifest | null = null;

  constructor(
    private camera: Camera,
    private readonly deps: ReconstructionGroupInstanceDeps,
    private readonly hooks: ReconstructionGroupInstanceHooks,
  ) {
    this.boundaries = new BoundaryOverlay(camera as PerspectiveCamera);
    this.poles = new PointOverlay(camera);
    this.gapwapPath = new PointOverlay(camera);
    this.sites = new PointOverlay(camera);

    this.ui = new ReconstructionGroupUI(this.view, {
      onReconstruction: (id) => void this.setReconstruction(id),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onShowBoundaries: (show) => { this.boundaries.visible = show; },
      onShowPaleomagPoles: (show) => {
        this.poles.visible = show;
        this.gapwapPath.visible = show;
        this.sites.visible = show;
      },
      onLandColorMode: (mode) => this.setLandColorMode(mode),
    }, deps.title, () => this.hooks.onRemove(this));
    this.ui.setReconstructionOptions(deps.entries);
  }

  async boot(): Promise<void> {
    const first = this.deps.entries[0];
    if (!first) throw new Error('reconstruction-group-globe needs at least 1 reconstruction_models entry');
    this.view.reconstruction = first.id;
    await this.setReconstruction(first.id);
  }

  async setReconstruction(id: string): Promise<void> {
    if (id === this.activeReconstruction) return;
    this.activeReconstruction = id;
    this.view.reconstruction = id;

    const entry = this.deps.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`reconstruction_models has no entry '${id}'`);

    this.ui.setStatus('loading...');
    const manifest = await loadReconstructionManifest(this.deps.archiveBase, entry.path);
    this.currentManifest = manifest;

    if (this.coastlines) {
      this.scene.remove(this.coastlines.lines, this.coastlines.land);
      this.coastlines.dispose();
      this.coastlines = null;
    }

    const data = await fetchCoastlineData(
      this.deps.archiveBase,
      reconstructionAssetPath(manifest, manifest.coastlines.geometry),
      reconstructionAssetPath(manifest, manifest.coastlines.rotations),
    );
    // Default land radius, not LAND_R_UNDER_SURFACE: there is an opaque
    // ocean at R_SURFACE now, and land beneath it would be inside the
    // sphere. Land colour comes from the Theme rather than a local grey.
    this.coastlines = new Coastlines(data.lines, data.table, this.maskTexture);
    this.rotationTable = data.table;
    this.anchorPlateId = this.deps.anchorPlates?.[id] ?? 0;
    this.coastlines.setReferencePlate(this.anchorPlateId);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.landVisible = true;
    this.scene.add(
      this.ocean.mesh, this.coastlines.lines, this.coastlines.land, this.graticule.lines,
    );
    // No Theme control in this wrapper yet (docs/adr/0038 wants one). Fixed
    // to 'graphite', not the family DEFAULT_THEME -- see
    // reconstruction/reconstructionInstance.ts's identical comment: this
    // page's own point is the paleomagnetic overlay, so linework stays
    // neutral and out of the way of it.
    const theme = resolveTheme('graphite');
    this.graticule.applyTheme(theme);
    this.ocean.applyTheme(theme);
    this.coastlines.applyTheme(theme);
    // Boundaries too, or they keep the pre-Theme black subduction stroke --
    // which was already weak on a black page and is invisible against a solid
    // ocean. Safe to call before load(): BoundaryOverlay holds it as
    // pendingTheme and applies it when the frames arrive.
    this.boundaries.applyTheme(theme);

    if (manifest.has_boundaries && manifest.boundaries) {
      await this.boundaries.load(reconstructionAssetUrl(this.deps.archiveBase, manifest, manifest.boundaries));
    }
    this.ui.setBoundariesAvailable(manifest.has_boundaries);
    this.boundaries.visible = manifest.has_boundaries;

    // Paleomagnetic poles (VGPs) + the modelled GAPWaP path -- see
    // reconstruction/reconstructionInstance.ts's identical block. Re-resolved
    // on every switch: which Reconstruction Model this is changes, and not
    // every model has an export (ADR-0025's static-polygon limitation).
    const poleSet = resolvePaleomagPoleSetFor(this.deps.archive, manifest);
    // Reset regardless of outcome -- a model switch to one with no pole
    // export must not leave the PREVIOUS model's plate_ids/citation behind
    // (plate_id numbering is shared across Reconstruction Models, so a
    // stale set would silently colour plates on a model with no data at
    // all -- see platesWithData's own field doc comment).
    this.poleSetCitation = '';
    this.platesWithData = new Set();
    if (poleSet) {
      await this.poles.load(`${this.deps.archiveBase}/${poleSet.points}`, {
        lifespan: 'window',
        ageWindow: 5,
        style: poleStyle,
      });
      this.poleSetCitation = poleSet.dataset.citation;
      // Sample Site markers -- see reconstruction/reconstructionInstance.ts's
      // identical block for the full reasoning.
      const payload = this.poles.payload();
      if (payload) {
        this.platesWithData = new Set(payload.points.map((p) => p.plate_id as number));
        const sitePoints = payload.points.map((p) => ({
          ...p, lon: p.sample_lon, lat: p.sample_lat,
        }));
        this.sites.loadData({ ...payload, points: sitePoints }, {
          lifespan: 'window',
          ageWindow: 5,
          style: siteStyle,
        });
      }
      if (poleSet.path) {
        await this.gapwapPath.load(`${this.deps.archiveBase}/${poleSet.path}`, {
          lifespan: 'since',
          connectLive: true,
          connectWidth: GAPWAP_PATH_WIDTH,
          style: () => ({ fill: GAPWAP_PATH_COLOR }),
        });
      }
    }
    this.ui.setPaleomagPolesAvailable(poleSet != null);
    this.poles.visible = poleSet != null;
    this.gapwapPath.visible = poleSet?.path != null;
    this.sites.visible = poleSet != null;

    this.view.age = manifest.age_min;
    this.ui.setAgeRange(manifest.age_min, manifest.age_max);
    this.coastlines.setAge(this.view.age);
    await this.boundaries.setAge(this.view.age);
    this.poles.setTime(this.view.age);
    this.gapwapPath.setTime(this.view.age);
    this.sites.setTime(this.view.age);
    // The VGPs come from one dataset whichever model draws them, so credit
    // it alongside the model's own citation.
    this.ui.setCredit(`${manifest.name} -- ${manifest.citation}`
      + (poleSet ? `\nVGPs: ${poleSet.dataset.citation}` : ''));
    // refreshDisplay() moves the age slider to this.view.age too, not just
    // lil-gui's own controllers -- no separate setAge() call needed here.
    this.ui.refreshDisplay();
    this.ui.setStatus('');

    // Reconcile the layers just (re)built -- at their own default of globe/
    // identity -- to whatever Projection/Map Orientation is already ambient.
    // Every switch rebuilds Coastlines/BoundaryOverlay/PointOverlay from
    // scratch (a different Reconstruction Model needs different geometry),
    // so this runs on every setReconstruction() call, not just the first.
    this.setProjection(this.projectionMode, this.camera);
    this.setOrientation(this.qOrient);
    // A freshly-built Coastlines always starts at its own default ('theme')
    // -- same reconciliation reasoning as setProjection()/setOrientation()
    // just above, for the same "every switch rebuilds from scratch" cause.
    this.setLandColorMode(this.view.landColorMode);
  }

  /** Switch this globe's Projection -- see reconstruction/
   *  reconstructionInstance.ts's identical method for the full reasoning
   *  (docs/adr/0003, always called from main.ts for every instance at once
   *  alongside the shared camera it just built for `mode`). */
  setProjection(mode: ProjectionMode, camera: Camera): void {
    this.camera = camera;
    this.projectionMode = mode;
    this.coastlines?.setProjection(mode);
    this.ocean.setProjection(mode);
    this.graticule.setProjection(mode);
    this.boundaries.setCamera(camera, mode);
    this.poles.setCamera(camera, mode);
    this.gapwapPath.setCamera(camera, mode);
    this.sites.setCamera(camera, mode);
    // See reconstruction/reconstructionInstance.ts's identical call/method
    // for why this re-applies on every mode switch, not just setOrientation().
    this.applyReferenceRotation();
  }

  /** Change Map Orientation's centre/roll rotation -- see CONTEXT.md's Map
   *  Orientation entry and reconstruction/reconstructionInstance.ts's
   *  identical method. */
  setOrientation(q: Quaternion): void {
    this.qOrient = q;
    this.coastlines?.setOrientation(q);
    this.graticule.setOrientation(q);
    this.applyReferenceRotation();
  }

  /** See reconstruction/reconstructionInstance.ts's identical method for the
   *  full reasoning -- Map Orientation must never reach boundaries/poles/
   *  gapwapPath's GLOBE projector, only their flat one. */
  private applyReferenceRotation(): void {
    const qAnchor: Quaternion = this.rotationTable
      ? referenceRotationAt(this.rotationTable, this.anchorPlateId, this.view.age)
      : [0, 0, 0, 1];
    const q = isFlat(this.projectionMode) ? composeQuaternions(this.qOrient, qAnchor) : qAnchor;
    this.boundaries.setReferenceRotation(q);
    this.poles.setReferenceRotation(q);
    this.gapwapPath.setReferenceRotation(q);
    this.sites.setReferenceRotation(q);
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines?.setAge(age);
    void this.boundaries.setAge(age);
    this.poles.setTime(age);
    this.gapwapPath.setTime(age);
    this.sites.setTime(age);
    // The anchor rotation is a function of age (identity only for plate 0).
    if (this.anchorPlateId !== 0) this.applyReferenceRotation();
    this.ui.setAge(age);
    if (this.view.landColorMode === 'count') this.recomputeLandVgpCounts();
  }

  /** See reconstruction/reconstructionInstance.ts's identical method. */
  setLandColorMode(mode: LandColorMode): void {
    this.view.landColorMode = mode;
    if (mode === 'count') this.recomputeLandVgpCounts();
    else if (mode === 'plate') this.coastlines?.setLandColorMode('plate', undefined, this.platesWithData);
    else this.coastlines?.setLandColorMode(mode);
  }

  /** See reconstruction/reconstructionInstance.ts's identical method. */
  private recomputeLandVgpCounts(): void {
    const payload = this.poles.payload();
    const counts = new Map<number, number>();
    if (payload) {
      const age = this.view.age;
      for (const p of payload.points) {
        const recordAge = p.age as number;
        const plateBeginAge = p.plate_begin_age as number | null | undefined;
        if (Math.abs(recordAge - age) > 5) continue;
        if (plateBeginAge != null && age > plateBeginAge) continue;
        const plateId = p.plate_id as number;
        counts.set(plateId, (counts.get(plateId) ?? 0) + 1);
      }
    }
    this.coastlines?.setLandColorMode('count', counts);
  }

  /** See reconstruction/reconstructionInstance.ts's identical method
   *  (including the spiderfy/"explode" handling for a pile of sites sharing
   *  one real-world outcrop). */
  selectSampleAt(x: number, y: number): void {
    const sitePick = this.sites.pick(x, y);
    const openFan = this.sites.spiderfied;
    const onOpenFanMember = !!(openFan && sitePick && openFan.includes(sitePick.index));

    if (!onOpenFanMember && this.sites.clusterSizeAt(x, y) >= 2) {
      this.sites.spiderfy(x, y);
      return;
    }

    const hit = sitePick ?? this.poles.pick(x, y);
    this.poles.highlight(hit?.index ?? null);
    this.sites.highlight(hit?.index ?? null);
    this.hooks.onSelectSample?.(
      this, (hit?.point as PaleomagSampleRecord | undefined) ?? null, this.poleSetCitation,
    );
    if (!hit) this.sites.unspiderfy();
  }

  /** See reconstruction/reconstructionInstance.ts's identical method. */
  clearSelection(): void {
    this.poles.highlight(null);
    this.sites.highlight(null);
  }

  /** Move this instance's boundary overlay and panel onto a new tile -- see
   *  core/multiInstanceHost.ts, docs/adr/0022. */
  applyLayout(rect: Rect): void {
    this.boundaries.setRect(rect);
    this.poles.setRect(rect);
    this.gapwapPath.setRect(rect);
    this.sites.setRect(rect);
    this.ui.setRect(rect);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    this.boundaries.draw();
    this.poles.draw();
    this.gapwapPath.draw();
    this.sites.draw();
  }

  dispose(): void {
    this.ui.dispose();
    this.ocean.dispose();
    this.graticule.dispose();
    this.coastlines?.dispose();
    this.boundaries.dispose();
    this.poles.dispose();
    this.gapwapPath.dispose();
    this.sites.dispose();
  }
}
