import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three';

import { R_SURFACE, lonLatToVec3 } from './constants';
import { lonLatToProjected, type ProjectionMode } from './projection';
import { rotateLonLat, type Quaternion } from './rotation';
import type { ResolvedTheme } from './theme';

/** Just above the coastline pen (COASTLINE_R in coastlines.ts, R_SURFACE *
 *  1.0014) so the grid draws over land and coastlines rather than under
 *  them, while still sitting close enough to the surface to be occluded by
 *  the opaque ocean sphere on the far hemisphere exactly like they are. */
const GRATICULE_R = R_SURFACE * 1.0018;
/** Plate Carrée/Robinson equivalent of GRATICULE_R -- a Z offset rather than
 *  a radius, same reasoning as coastlines.ts's FLAT_COASTLINE_Z. */
const FLAT_GRATICULE_Z = GRATICULE_R - R_SURFACE;

/**
 * A lon/lat reference grid -- meridians and parallels in the same anchor-0/
 * world frame every reconstruction here is drawn in (coastlines, static
 * polygons, paleomagnetic poles). Never rotates with RECONSTRUCTION AGE,
 * because its whole purpose is to show where the geographic frame (in
 * particular the spin axis/south pole, where the paleomagnetic poles
 * toggle's whole point is to compare against) sits, independent of how
 * continents have drifted under it.
 *
 * It DOES rebuild for Projection and Map Orientation (see CONTEXT.md's Map
 * Orientation entry): under a flat Projection with a non-identity
 * orientation, this is the layer that actually shows WHERE the (now
 * off-centre) pole sits on the map -- an oblique flat view whose graticule
 * stayed pole-up would misrepresent every other reoriented layer. Globe mode
 * ignores `qOrient` entirely (Map Orientation is meaningless there --
 * `OrbitControls` already free-orbits), so its own pole-up grid is
 * unaffected by whatever the flat Projections' orientation is set to.
 *
 * Plain `LineBasicMaterial`, not the masked/animated shader `Coastlines`
 * uses -- rebuilt wholesale on a mode/orientation change rather than
 * animated, so none of that machinery earns its keep here.
 */
export class Graticule {
  readonly lines: LineSegments;

  private readonly material: LineBasicMaterial;
  private readonly geometry: BufferGeometry;
  private readonly positions: Float32Array;
  /** Each entry is one drawn segment's two (lon, lat) endpoints -- the
   *  Projection-independent grid pattern, computed once and reprojected by
   *  rebuild() rather than regenerated per mode/orientation change. */
  private readonly segments: readonly [number, number, number, number][];

  private mode: ProjectionMode = 'globe';
  private qOrient: Quaternion = [0, 0, 0, 1];

  constructor(lonStepDeg = 30, latStepDeg = 30, sampleStepDeg = 3) {
    const segments: [number, number, number, number][] = [];

    // Meridians: fixed longitude, sweep latitude pole to pole.
    for (let lon = -180; lon < 180; lon += lonStepDeg) {
      for (let lat = -90; lat < 90; lat += sampleStepDeg) {
        segments.push([lon, lat, lon, Math.min(90, lat + sampleStepDeg)]);
      }
    }

    // Parallels: fixed latitude, sweep longitude all the way around. Skips
    // +-90 -- every longitude is the same point there, so a "parallel" at
    // the pole is degenerate (and the meridians above already converge on
    // it, which is the whole visual cue for where the pole is).
    for (let lat = -90 + latStepDeg; lat < 90; lat += latStepDeg) {
      for (let lon = -180; lon < 180; lon += sampleStepDeg) {
        segments.push([lon, lat, lon + sampleStepDeg, lat]);
      }
    }

    this.segments = segments;
    this.positions = new Float32Array(segments.length * 2 * 3);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));

    this.material = new LineBasicMaterial({ transparent: true, opacity: 0.35 });
    this.lines = new LineSegments(this.geometry, this.material);
    this.rebuild();
  }

  /** Switch between Globe and a flat Projection -- see this class's own doc
   *  comment for why only the flat case honours `qOrient`. */
  setProjection(mode: ProjectionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.rebuild();
  }

  /** Change Map Orientation's centre/roll rotation -- a no-op in Globe mode
   *  until the next setProjection('robinson'|'plateCarree') picks it up. */
  setOrientation(q: Quaternion): void {
    this.qOrient = q;
    if (this.mode !== 'globe') this.rebuild();
  }

  private rebuild(): void {
    const flat = this.mode !== 'globe';
    let w = 0;
    for (const [lon0, lat0, lon1, lat1] of this.segments) {
      let a: [number, number, number];
      let b: [number, number, number];
      if (flat) {
        const p0 = rotateLonLat(lon0, lat0, this.qOrient);
        const p1 = rotateLonLat(lon1, lat1, this.qOrient);
        a = lonLatToProjected(this.mode, p0.lon, p0.lat, FLAT_GRATICULE_Z);
        // Map Orientation can rotate this pair of originally-adjacent sample
        // points onto opposite sides of the DISPLAY antimeridian even though
        // neither one moved far in TRUE lon/lat -- same seam Coastlines/
        // BoundaryOverlay handle explicitly (docs/plans/reference-plate.md).
        // A jump this large between two points sampleStepDeg apart can only
        // be a seam crossing, never real grid geometry, so the segment is
        // collapsed to a point (invisible) rather than drawn straight across
        // the map -- the same "drop rather than draw a wrong line" choice
        // coastlines.ts's line loop and windStreaks.ts's advect() both make.
        b = Math.abs(p1.lon - p0.lon) > 180
          ? a
          : lonLatToProjected(this.mode, p1.lon, p1.lat, FLAT_GRATICULE_Z);
      } else {
        a = lonLatToVec3(lon0, lat0, GRATICULE_R);
        b = lonLatToVec3(lon1, lat1, GRATICULE_R);
      }
      this.positions[w++] = a[0]; this.positions[w++] = a[1]; this.positions[w++] = a[2];
      this.positions[w++] = b[0]; this.positions[w++] = b[1]; this.positions[w++] = b[2];
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** Subtle by design -- a reference grid, not a data layer. Takes the
   *  Theme's own resolved outline colour (same source as the coastline pen)
   *  rather than a fixed one so it stays coherent if the Theme ever changes,
   *  but always at reduced opacity so it never competes with coastlines or
   *  the paleomagnetic overlay. Hidden entirely for Outline Treatment
   *  'none' -- same convention Coastlines.applyTheme() uses, an invisible
   *  pen still costs a draw call. */
  applyTheme(theme: ResolvedTheme): void {
    this.lines.visible = theme.outline !== null;
    if (theme.outline !== null) this.material.color.set(theme.outline);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
