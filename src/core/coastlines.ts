import {
  BufferGeometry, BufferAttribute, LineSegments, Mesh, ShaderMaterial,
  DoubleSide, DataTexture, RGBAFormat, RedFormat, FloatType, NearestFilter,
  ClampToEdgeWrapping, type Texture,
} from 'three';
import { passthroughColor } from './material';
import { GEOGRAPHIC_GLSL } from './glsl/geographic';
import { R_SURFACE, LIGHT_DIR, vec3ToLonLat, wrapLonDelta } from './constants';
import type { ResolvedTheme } from './theme';
import { fetchVolumeBytes } from './volume';
import {
  composeQuaternions, referenceRotationAt, rotationAt, toRenderFrameRotation,
  type Quaternion,
} from './rotation';
import {
  isFlat, lonLatToProjected, type ProjectionMode,
} from './projection';
// plateHue() is plate_id-generic despite living in a file named for its
// first consumer (VGP markers) -- reused here so "By plate" land colouring
// agrees exactly with each plate's own VGP dot colour, per its own doc
// comment's "deterministic plate-id -> colour" framing.
import { plateHue } from './paleomagPalette';
import type { ArchiveIndex, CoastlineLine, CoastlineSet, Manifest, RotationTable } from './types';

const LAND_R = R_SURFACE * 1.0006;      // just clear of the surface sphere
const COASTLINE_R = R_SURFACE * 1.0014; // and the lines just clear of the land
// The Plate Carrée equivalent, same derivation as windGlyphs.ts's FLAT_GLYPH_Z.
const FLAT_COASTLINE_Z = COASTLINE_R - R_SURFACE;

/** How land fill is coloured -- the Theme's own flat colour (default), a
 *  per-plate hue matching that plate's own VGP dots ("By plate"), or a
 *  sequential ramp on how many VGPs are currently visible for that plate
 *  ("By VGP count") -- see `Coastlines.setLandColorMode()`. Defined here
 *  (core/, plate_id-generic) rather than in any one wrapper's UI module,
 *  since a wrapper's view-state type imports it, not the other way round. */
export type LandColorMode = 'theme' | 'plate' | 'count';

/** h in degrees, s/l in [0, 1] -- standard HSL->RGB, returned as [0, 1]
 *  components ready for a vertex colour attribute. Written by hand rather
 *  than routed through `three.Color.setStyle('hsl(...)')` so this file's
 *  colours stay in the same explicit, no-implicit-colour-space-conversion
 *  style `passthroughColor()` already establishes here. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** The classic matplotlib 'hot' ramp (black -> red -> yellow -> white),
 *  `t` in [0, 1] -- "By VGP count"'s sequential scale, chosen over a single-
 *  hue lightness ramp for a brighter, higher-contrast read at the high end
 *  (per this session's own feedback). Zero-count plates never call this --
 *  see setAge()'s land-colour block -- they render `landRgb` (the Theme's
 *  own grey) instead, since 'hot' at t=0 is black, not grey. */
function hotColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  return [
    Math.min(1, 3 * c),
    Math.min(1, Math.max(0, 3 * c - 1)),
    Math.min(1, Math.max(0, 3 * c - 2)),
  ];
}

/**
 * Where land sits on a flat map, in Z.
 *
 * On the sphere, land (LAND_R or LAND_R_UNDER_SURFACE) and the lines
 * (COASTLINE_R) are separated by RADIUS. A plane has no radius, so the ordering
 * has to be restated as depth -- and the sign matters: the orthographic camera
 * looks down -Z from +Z, so nearer means LARGER z.
 *
 * Land must end up in front of whatever opaque backdrop the page puts behind it
 * (which sits below R_SURFACE, i.e. at negative z) and behind the lines. Halfway
 * to the lines does both. Getting the sign wrong here put land at the same depth
 * as the backdrop, where it z-fought and lost -- continents rendered as bare
 * outlines on an empty ocean.
 */
const FLAT_LAND_Z = (COASTLINE_R - R_SURFACE) * 0.5;

/** Symmetric offset below R_SURFACE, for a caller that wants land to sit
 *  UNDER a data sphere rather than above it -- see Coastlines' `landRadius`
 *  constructor option. Depth-tested against the data sphere in front of it,
 *  so it only shows through wherever that sphere discards (e.g. a no-data
 *  sentinel, see ADR-0005), the same way any other occluded geometry would. */
export const LAND_R_UNDER_SURFACE = R_SURFACE * (1 - 0.0006);

/** Parse geometry.bin (see prep_coastlines.py for the layout). */
export function parseGeometry(buf: ArrayBuffer): CoastlineLine[] {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3),
  );
  if (magic !== 'ESCL') throw new Error(`bad coastline magic: ${magic}`);
  const version = dv.getUint32(4, true);
  if (version !== 3) {
    throw new Error(
      `coastline geometry is version ${version}, expected 3 -- re-run prep_coastlines.py`,
    );
  }
  const nLines = dv.getUint32(8, true);

  const lines: CoastlineLine[] = [];
  let o = 12;
  for (let i = 0; i < nLines; i++) {
    const plateId = dv.getInt32(o, true); o += 4;
    const appearAge = dv.getFloat32(o, true); o += 4;
    const disappearAge = dv.getFloat32(o, true); o += 4;
    const nPts = dv.getUint32(o, true); o += 4;
    const nLand = dv.getUint32(o, true); o += 4;
    const nTris = dv.getUint32(o, true); o += 4;

    const points = new Float32Array(buf, o, nPts * 3);
    o += nPts * 3 * 4;
    const landPoints = nLand ? new Float32Array(buf, o, nLand * 3) : null;
    o += nLand * 3 * 4;
    const triangles = nTris
      ? new Uint32Array(buf.slice(o, o + nTris * 3 * 4))
      : null;
    o += nTris * 3 * 4;

    lines.push({ plateId, appearAge, disappearAge, points, landPoints, triangles });
  }
  return lines;
}

/** Flat/Plate-Carrée mode's vertex shader: a plain passthrough, since that
 *  mode's per-vertex rotation + reprojection + antimeridian seam-dropping is
 *  still done on the CPU (rebuildFlat()) -- see this file's module doc
 *  comment for why only Globe mode moved to the GPU. */
const VERT_FLAT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const LINE_FRAG = /* glsl */ `
${GEOGRAPHIC_GLSL}

uniform sampler2D uMask;
uniform vec3 uColor;
uniform float uUseMask;
uniform float uOpacity;
varying vec3 vWorldPos;
void main() {
  if (uUseMask > 0.5) {
    vec2 uv = geographicToUV(worldToGeographic(vWorldPos));
    if (texture2D(uMask, uv).r > 0.5) discard;
  }
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

/**
 * Globe mode's vertex shader: `position` is the STATIC, present-day,
 * render-frame vertex (built once in the constructor, never rewritten).
 * Each vertex carries a `plateIndex` into `uPlateQuat` (a DataTexture, one
 * render-frame quaternion per distinct plate id, rewritten in
 * updatePlateRotations() -- O(#plates), not O(#vertices)) and a `lineIndex`
 * into `uLineVisible` (one 0/1 flag per line, rewritten in
 * updateLineVisibility()). An invisible line's vertices are pushed to
 * (2,2,2,1) -- outside every clip plane -- so the whole segment/triangle is
 * trivially clipped, with no dependence on depth-test occlusion.
 *
 * `rotateByQuat()` is GEOGRAPHIC_GLSL's existing primitive (the GLSL twin of
 * rotation.ts's rotateVector(), already used the same way by
 * core/material.ts's own VERT) -- `uPlateQuat` texels are pre-converted to
 * the render frame by toRenderFrameRotation() before upload, so this can
 * apply them directly to a render-frame `position`, exactly as that
 * function's own doc comment describes.
 */
function buildLineVertGlobe(plateCount: number, lineCount: number): string {
  const pc = plateCount.toFixed(1);
  const lc = lineCount.toFixed(1);
  return /* glsl */ `
${GEOGRAPHIC_GLSL}
attribute float plateIndex;
attribute float lineIndex;
uniform sampler2D uPlateQuat;
uniform sampler2D uLineVisible;
varying vec3 vWorldPos;
void main() {
  vec2 luv = vec2((lineIndex + 0.5) / ${lc}, 0.5);
  if (texture2D(uLineVisible, luv).r < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 puv = vec2((plateIndex + 0.5) / ${pc}, 0.5);
  vec4 q = texture2D(uPlateQuat, puv);
  vec3 rotated = rotateByQuat(q, position);
  vec4 wp = modelMatrix * vec4(rotated, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
}

/** Land's own flat-mode vertex shader, distinct from VERT_FLAT above only in
 *  that it passes through the per-vertex `color` attribute (populated in
 *  rebuildFlat() -- see LandColorMode) for LAND_FRAG to blend against the
 *  flat Theme colour. */
const LAND_VERT_FLAT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vColor;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vColor = color;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Globe mode's land vertex shader -- same static-position/per-plate-texture
 *  mechanism as buildLineVertGlobe() above, plus a second per-plate texture
 *  (`uPlateColor`, rewritten in updatePlateColors()) sampled into the same
 *  `vColor` varying LAND_FRAG already reads. No `color` BufferAttribute
 *  exists on the globe land geometry at all -- colour is entirely a
 *  per-plate texture lookup here, never a per-vertex value. */
function buildLandVertGlobe(plateCount: number, lineCount: number): string {
  const pc = plateCount.toFixed(1);
  const lc = lineCount.toFixed(1);
  return /* glsl */ `
${GEOGRAPHIC_GLSL}
attribute float plateIndex;
attribute float lineIndex;
uniform sampler2D uPlateQuat;
uniform sampler2D uPlateColor;
uniform sampler2D uLineVisible;
varying vec3 vWorldPos;
varying vec3 vColor;
void main() {
  vec2 luv = vec2((lineIndex + 0.5) / ${lc}, 0.5);
  if (texture2D(uLineVisible, luv).r < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 puv = vec2((plateIndex + 0.5) / ${pc}, 0.5);
  vec4 q = texture2D(uPlateQuat, puv);
  vColor = texture2D(uPlateColor, puv).rgb;
  vec3 rotated = rotateByQuat(q, position);
  vec4 wp = modelMatrix * vec4(rotated, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
}

/** Land fill takes the same key light as the globe so it sits on the sphere.
 *  Shared by both the Flat and Globe land materials -- both vertex shaders
 *  (LAND_VERT_FLAT, buildLandVertGlobe()) write the same `vWorldPos`/
 *  `vColor` varyings, just sourced differently (a `color` attribute vs. a
 *  per-plate texture lookup). `uColorMode` switches between the flat Theme
 *  colour (0, the default) and the per-vertex `vColor` (1, "By plate"/"By
 *  VGP count" -- see `Coastlines.setLandColorMode()`); a `mix()` rather than
 *  a branch since both are cheap and this avoids a dynamic branch per
 *  fragment for no benefit. */
const LAND_FRAG = /* glsl */ `
${GEOGRAPHIC_GLSL}

uniform sampler2D uMask;
uniform vec3 uColor;
uniform float uUseMask;
uniform float uOpacity;
uniform vec3 uLightDir;
uniform float uColorMode;
varying vec3 vWorldPos;
varying vec3 vColor;
void main() {
  if (uUseMask > 0.5) {
    vec2 uv = geographicToUV(worldToGeographic(vWorldPos));
    if (texture2D(uMask, uv).r > 0.5) discard;
  }
  vec3 base = mix(uColor, vColor, uColorMode);
  vec3 n = normalize(vWorldPos);
  float ndl = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  gl_FragColor = vec4(base * (0.5 + 0.5 * ndl * ndl), uOpacity);
}
`;

/**
 * Coastlines reconstructed in the browser.
 *
 * Geometry is stored once in present-day coordinates; each age we slerp the
 * plate rotations and apply them to the vertices. We interpolate the
 * ROTATION, never the geometry -- plates rotate about Euler poles rather
 * than translating, so interpolating vertex positions between two baked
 * ages is simply wrong.
 *
 * Points arrive in the geographic frame (X to 0N/0E, Y to 0N/90E, Z to the
 * pole) and the quaternions act in that frame, so the rotation happens
 * there and the result is converted to the viewer's (X, Z, -Y) frame
 * afterwards -- see constants.ts.
 *
 * GLOBE mode's rotation is done on the GPU (see buildLineVertGlobe()/
 * buildLandVertGlobe() above): vertex positions are static (present-day,
 * pre-converted to the render frame once in the constructor) and only a
 * small per-plate quaternion texture (`plateQuatTex`) plus a per-line
 * visibility texture (`lineVisibleTex`) are rewritten per age -- O(#plates
 * + #lines), not O(#vertices). This is what fixes reconstruction models
 * with dense source geometry (e.g. Torsvik's ~614K coastline vertices)
 * feeling jerky on every age-slider tick: the old CPU path re-rotated every
 * vertex by hand on every single call.
 *
 * FLAT/Plate-Carrée mode keeps the ORIGINAL CPU path (rebuildFlat()):
 * reprojecting a rotated point via (lon, lat) and dropping antimeridian-
 * seam segments/triangles are both per-segment screen-space decisions that
 * don't map cleanly onto the static-buffer GPU mechanism above, and aren't
 * the reported performance problem (docs/plans -- Map Orientation dragging,
 * the flat-mode-only interaction, is a separate, unfixed-by-this issue).
 * The class keeps two full geometry+material pairs (globe/flat) and swaps
 * which one is attached to the public `lines`/`land` fields in
 * applyActiveGeometry(), so those two fields' IDENTITY never changes -- see
 * that method's own doc comment for why that matters.
 */
export class Coastlines {
  readonly lines: LineSegments;
  readonly land: Mesh;

  // -- Flat/Plate-Carrée path: unchanged from before this file's GPU
  // rewrite, just renamed with a Flat suffix now that a Globe sibling
  // exists. Allocated once at maximum size; each rebuildFlat() call writes
  // a compacted prefix (the currently-visible subset) and trims the draw
  // range, exactly as this class always did.
  private lineGeomFlat: BufferGeometry;
  private linePosFlat: Float32Array;
  private landGeomFlat: BufferGeometry;
  private landPosFlat: Float32Array;
  private landColorAttrFlat: Float32Array;
  // Display-space (lon, lat) per land vertex, flat mode only. The seam and
  // pole repairs in rebuildFlat() work in these coordinates and re-project,
  // rather than trying to patch up an already-projected x -- see that
  // method's triangle block for why.
  private landLonFlat: Float32Array;
  private landLatFlat: Float32Array;
  // prep_coastlines.py triangulates the densified outline ring itself, so a
  // line's first `points.length/3 - 1` land vertices ARE its outline points,
  // in order -- the ring, before the repeated closing point and before the
  // interior grid samples. Verified per line at load (below) rather than
  // assumed, since it is a property of the exporter, not of the format.
  // Where it holds, rebuildFlat() rotates and projects those points once for
  // the outline and reuses the result for the fill instead of redoing it:
  // on Torsvik that is 304k of the 307k land vertices.
  private reuseBoundary: Uint8Array;
  private cacheX: Float32Array;
  private cacheY: Float32Array;
  private cacheLon: Float32Array;
  private cacheLat: Float32Array;
  private landIdxFlat: Uint32Array;
  // Write cursors, shared between rebuildFlat() and the emit helpers it calls
  // (which append repaired/clipped vertices past the end of the line's own).
  private wVert = 0;
  private scratchLon = new Float64Array(3);
  private scratchLat = new Float64Array(3);
  private scratchIdx = new Int32Array(3);
  // A repaired triangle becomes at most a quad, and Sutherland-Hodgman against
  // one meridian adds at most one vertex to it.
  private polyLon = new Float64Array(8);
  private polyLat = new Float64Array(8);
  private clipLon = new Float64Array(12);
  private clipLat = new Float64Array(12);
  private lineMatFlat: ShaderMaterial;
  private landMatFlat: ShaderMaterial;

  // -- Globe path: static geometry (built once below, never rewritten),
  // GPU-side rotation via small per-plate/per-line lookup textures.
  private lineGeomGlobe: BufferGeometry;
  private landGeomGlobe: BufferGeometry;
  private lineMatGlobe: ShaderMaterial;
  private landMatGlobe: ShaderMaterial;
  /** plate_id -> compact 0..P-1 index, built once from every line's
   *  plateId -- what a vertex's `plateIndex` attribute actually stores, so
   *  the per-plate textures below can be sized to the DISTINCT plate count
   *  (~266-479) rather than indexed by raw (sparse, much larger) plate
   *  ids. Immutable for the instance's lifetime. */
  private plateIdToIndex: Map<number, number>;
  /** Backing array for `plateQuatTex`, kept around so updatePlateRotations()
   *  can rewrite it in place without reallocating. One render-frame
   *  quaternion (xyzw) per distinct plate, pre-converted by
   *  toRenderFrameRotation() so the vertex shader can apply it directly to
   *  a render-frame `position` -- see that function's own doc comment. */
  private plateQuatData: Float32Array;
  private plateQuatTex: DataTexture;
  /** Same per-plate indexing as plateQuatTex, one RGB colour per plate --
   *  the GPU-side equivalent of the Flat path's per-vertex `landColorAttr`,
   *  see updatePlateColors(). */
  private plateColorData: Float32Array;
  private plateColorTex: DataTexture;
  /** One 0/1 flag per line (`this.data[i]`), read via each vertex's
   *  `lineIndex` attribute to decide whether that line's segments/triangles
   *  should render at this age -- see updateLineVisibility() and
   *  buildLineVertGlobe()'s clip-collapse trick. */
  private lineVisibleData: Float32Array;
  private lineVisibleTex: DataTexture;

  /** 'theme' (default, matches every existing caller unchanged) draws flat
   *  `theme.land`; 'plate'/'count' populate a per-plate colour (the Flat
   *  path's `landColorAttrFlat`, the Globe path's `plateColorTex`) and flip
   *  LAND_FRAG's `uColorMode` uniform to read it instead -- see
   *  `setLandColorMode()`. */
  private landColorMode: LandColorMode = 'theme';
  /** plate_id -> live VGP count, supplied by setLandColorMode('count', ...)
   *  -- the caller's job (it alone knows about the paleomagnetic pole
   *  overlay; this class only knows about plate ids), recomputed by the
   *  caller on every age change while this mode is selected. */
  private plateVgpCounts: Map<number, number> = new Map();
  /** plate_id set for "By plate": which plates EVER have a VGP anywhere in
   *  the whole dataset (not age-filtered, unlike `plateVgpCounts` above) --
   *  supplied by setLandColorMode('plate', ...). A plate outside this set
   *  renders as plain `landRgb` (the Theme's own grey/land colour) rather
   *  than a hash hue nothing was ever actually measured on. `null` (the
   *  default, and any caller that never supplies one) means "no such
   *  restriction -- colour every plate", so a caller with no paleomagnetic
   *  data at all is unaffected. */
  private platesWithData: Set<number> | null = null;
  /** The current Theme's `land` colour, as float RGB -- captured by
   *  applyTheme() so "By plate"'s no-data plates and "By VGP count"'s
   *  zero-count plates can both render as this exact grey rather than a
   *  second, slightly-different hardcoded one. */
  private landRgb: [number, number, number] = [0.5, 0.5, 0.5];
  /** See CONTEXT.md's Reference Plate entry and docs/adr/0030 -- 0 (the
   *  prep-time anchor) reduces every composeQuaternions() below to a no-op
   *  extra multiply by identity, so this never needs its own branch in
   *  setAge(). Set via setReferencePlate(), which also re-renders the
   *  current age. */
  private referencePlateId = 0;
  /** Map Orientation's rotation (see CONTEXT.md's Map Orientation entry) --
   *  GEOGRAPHIC frame, same as `qRef` below, and composed the same way:
   *  identity (the default) reduces its composeQuaternions() in
   *  rebuildFlat() to a no-op. Only ever consulted in Flat mode (see that
   *  method) -- Globe mode's fast path never reads it, same invariant the
   *  old single-path setAge() enforced via its own isFlat() branch. */
  private qOrient: Quaternion = [0, 0, 0, 1];
  private currentAge = 0;
  /** Only affects the LINE set (see rebuildFlat()'s mode branch) -- land
   *  fill is never shown in a wrapper that also offers Plate Carrée today
   *  (climate.html always sets landVisible false, see climateInstance.ts),
   *  so its geometry is left on the sphere unconditionally in Flat mode
   *  rather than build flat-map polygon-clipping (a materially bigger job
   *  than the line case, which can just drop a seam-crossing segment) for a
   *  mesh nothing draws. */
  private mode: ProjectionMode = 'globe';

  constructor(
    private data: CoastlineLine[],
    private table: RotationTable,
    maskTexture: Texture,
    /** Defaults match every existing caller (land just clear of R_SURFACE,
     *  drawn OVER the data sphere -- the mantle/climate viewers' "land fill
     *  substitutes for missing data" use). A caller that wants land as a
     *  backdrop UNDER a data sphere instead (e.g. plain grey continents)
     *  passes LAND_R_UNDER_SURFACE and a plain grey landColor. */
    private readonly landRadius: number = LAND_R,
    /** Initial land fill. Usually superseded immediately by applyTheme(); a
     *  caller that wants land OUTSIDE the Theme system (e.g. plain grey
     *  continents) passes one and never calls
     *  applyTheme. */
    private readonly landColor: number = 0x808080,
  ) {
    // Allocate the FLAT path once at maximum size, exactly as before -- its
    // visible set changes with age, so it updates the draw range rather
    // than rebuilding the buffers.
    let maxSegments = 0;
    let maxLandPts = 0;
    let maxTris = 0;
    let maxLinePts = 0;
    this.reuseBoundary = new Uint8Array(data.length);
    for (let li = 0; li < data.length; li++) {
      const l = data[li];
      const n = l.points.length / 3;
      maxSegments += n - 1;
      maxLinePts = Math.max(maxLinePts, n);
      if (l.triangles && l.landPoints) {
        maxLandPts += l.landPoints.length / 3;
        maxTris += l.triangles.length / 3;
        // Checked, not trusted: a future exporter change that reorders or
        // re-densifies the fill's vertices would silently misplace land
        // otherwise, and this costs one pass at load.
        const ring = n - 1;
        if (l.landPoints.length / 3 >= ring) {
          let same = true;
          for (let i = 0; i < ring * 3; i++) {
            if (l.landPoints[i] !== l.points[i]) { same = false; break; }
          }
          if (same) this.reuseBoundary[li] = 1;
        }
      }
    }
    this.cacheX = new Float32Array(maxLinePts);
    this.cacheY = new Float32Array(maxLinePts);
    this.cacheLon = new Float32Array(maxLinePts);
    this.cacheLat = new Float32Array(maxLinePts);

    this.linePosFlat = new Float32Array(maxSegments * 2 * 3);
    this.lineGeomFlat = new BufferGeometry();
    this.lineGeomFlat.setAttribute('position', new BufferAttribute(this.linePosFlat, 3));

    // Headroom past the source geometry's own size: clipping a triangle at
    // the seam replaces it with up to four, and repairing a pole vertex
    // splits it per incident triangle, so both write vertices that no line
    // in `data` accounts for. Measured need is a few thousand on the worst
    // frame (Torsvik at 0 Ma); the emit helpers bounds-check anyway and fall
    // back to dropping the triangle rather than overrunning.
    const slack = 1 << 16;
    this.landPosFlat = new Float32Array((maxLandPts + slack) * 3);
    this.landColorAttrFlat = new Float32Array((maxLandPts + slack) * 3);
    this.landLonFlat = new Float32Array(maxLandPts + slack);
    this.landLatFlat = new Float32Array(maxLandPts + slack);
    this.landIdxFlat = new Uint32Array((maxTris + slack) * 3);
    this.landGeomFlat = new BufferGeometry();
    this.landGeomFlat.setAttribute('position', new BufferAttribute(this.landPosFlat, 3));
    this.landGeomFlat.setAttribute('color', new BufferAttribute(this.landColorAttrFlat, 3));
    this.landGeomFlat.setIndex(new BufferAttribute(this.landIdxFlat, 1));

    this.lineMatFlat = new ShaderMaterial({
      vertexShader: VERT_FLAT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uMask: { value: maskTexture },
        uColor: { value: passthroughColor(0xffffff) },
        uUseMask: { value: 1 },
        uOpacity: { value: 1 },
      },
    });
    this.landMatFlat = new ShaderMaterial({
      vertexShader: LAND_VERT_FLAT,
      fragmentShader: LAND_FRAG,
      // Delaunay returns simplices in arbitrary winding order, so about half
      // the land triangles face inward. With front-face culling they vanish and
      // the continents come out full of holes.
      side: DoubleSide,
      // Required for three.js to inject `attribute vec3 color;` for
      // LAND_VERT_FLAT to read (its own `color` BufferAttribute above) --
      // without this the attribute is simply undefined in the compiled
      // shader. The Globe material below needs no equivalent -- it has no
      // `color` attribute at all, colour comes from a texture lookup.
      vertexColors: true,
      uniforms: {
        uMask: { value: maskTexture },
        uColor: { value: passthroughColor(this.landColor) },
        uUseMask: { value: 1 },
        uOpacity: { value: 1 },
        uLightDir: { value: LIGHT_DIR.clone() },
        uColorMode: { value: 0 },
      },
    });

    // -- Globe path: static buffers, sized EXACTLY to the whole dataset
    // (every line always contributes -- visibility is a per-age texture
    // lookup in the shader, not a buffer compaction), so the default draw
    // range (the full attribute count) is always correct and never needs
    // setDrawRange() after this point.
    this.plateIdToIndex = new Map();
    for (const line of data) {
      if (!this.plateIdToIndex.has(line.plateId)) {
        this.plateIdToIndex.set(line.plateId, this.plateIdToIndex.size);
      }
    }
    const plateCount = Math.max(1, this.plateIdToIndex.size);
    const lineCount = Math.max(1, data.length);

    const linePosGlobe = new Float32Array(maxSegments * 2 * 3);
    const linePlateIdx = new Float32Array(maxSegments * 2);
    const lineLineIdx = new Float32Array(maxSegments * 2);
    const landPosGlobe = new Float32Array(maxLandPts * 3);
    const landPlateIdx = new Float32Array(maxLandPts);
    const landLineIdx = new Float32Array(maxLandPts);
    const landIdxGlobe = new Uint32Array(maxTris * 3);

    let lv = 0; // line VERTEX cursor (linePosGlobe/linePlateIdx/lineLineIdx)
    let vw = 0; // land vertex cursor
    let iw = 0; // land index cursor
    data.forEach((line, lineIdx) => {
      const plateIdx = this.plateIdToIndex.get(line.plateId)!;
      const p = line.points;
      const n = p.length / 3;
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i < n; i++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
        // Present-day (identity rotation) geographic -> render frame
        // (X, Z, -Y), scaled -- the ROTATION is applied later, per-plate,
        // entirely on the GPU (see buildLineVertGlobe()).
        const cx = x * COASTLINE_R, cy = z * COASTLINE_R, cz = -y * COASTLINE_R;
        if (i > 0) {
          linePosGlobe[lv * 3] = px; linePosGlobe[lv * 3 + 1] = py; linePosGlobe[lv * 3 + 2] = pz;
          linePlateIdx[lv] = plateIdx; lineLineIdx[lv] = lineIdx; lv++;
          linePosGlobe[lv * 3] = cx; linePosGlobe[lv * 3 + 1] = cy; linePosGlobe[lv * 3 + 2] = cz;
          linePlateIdx[lv] = plateIdx; lineLineIdx[lv] = lineIdx; lv++;
        }
        px = cx; py = cy; pz = cz;
      }

      if (line.triangles && line.landPoints) {
        const base = vw;
        const lp = line.landPoints;
        const m = lp.length / 3;
        for (let i = 0; i < m; i++) {
          const x = lp[i * 3], y = lp[i * 3 + 1], z = lp[i * 3 + 2];
          landPosGlobe[vw * 3] = x * this.landRadius;
          landPosGlobe[vw * 3 + 1] = z * this.landRadius;
          landPosGlobe[vw * 3 + 2] = -y * this.landRadius;
          landPlateIdx[vw] = plateIdx;
          landLineIdx[vw] = lineIdx;
          vw++;
        }
        const t = line.triangles;
        for (let k = 0; k < t.length; k++) landIdxGlobe[iw++] = base + t[k];
      }
    });

    this.lineGeomGlobe = new BufferGeometry();
    this.lineGeomGlobe.setAttribute('position', new BufferAttribute(linePosGlobe, 3));
    this.lineGeomGlobe.setAttribute('plateIndex', new BufferAttribute(linePlateIdx, 1));
    this.lineGeomGlobe.setAttribute('lineIndex', new BufferAttribute(lineLineIdx, 1));

    this.landGeomGlobe = new BufferGeometry();
    this.landGeomGlobe.setAttribute('position', new BufferAttribute(landPosGlobe, 3));
    this.landGeomGlobe.setAttribute('plateIndex', new BufferAttribute(landPlateIdx, 1));
    this.landGeomGlobe.setAttribute('lineIndex', new BufferAttribute(landLineIdx, 1));
    this.landGeomGlobe.setIndex(new BufferAttribute(landIdxGlobe, 1));

    // Per-plate/per-line lookup textures -- see this class's own field doc
    // comments. NearestFilter/ClampToEdgeWrapping: these are exact-index
    // LUTs, never interpolated between neighbouring plates/lines. FloatType
    // + RGBAFormat for the two per-plate textures (a quaternion needs all 4
    // channels); RedFormat for the single-channel visibility texture,
    // mirroring core/mask.ts's own DataTexture precedent.
    this.plateQuatData = new Float32Array(plateCount * 4);
    for (let i = 0; i < plateCount; i++) this.plateQuatData[i * 4 + 3] = 1; // seed identity
    this.plateQuatTex = new DataTexture(this.plateQuatData, plateCount, 1, RGBAFormat, FloatType);

    this.plateColorData = new Float32Array(plateCount * 4);
    this.plateColorTex = new DataTexture(this.plateColorData, plateCount, 1, RGBAFormat, FloatType);

    this.lineVisibleData = new Float32Array(lineCount).fill(1);
    this.lineVisibleTex = new DataTexture(this.lineVisibleData, lineCount, 1, RedFormat, FloatType);

    for (const tex of [this.plateQuatTex, this.plateColorTex, this.lineVisibleTex]) {
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      tex.wrapS = ClampToEdgeWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
    }

    this.lineMatGlobe = new ShaderMaterial({
      vertexShader: buildLineVertGlobe(plateCount, lineCount),
      fragmentShader: LINE_FRAG,
      uniforms: {
        uMask: { value: maskTexture },
        uColor: { value: passthroughColor(0xffffff) },
        uUseMask: { value: 1 },
        uOpacity: { value: 1 },
        uPlateQuat: { value: this.plateQuatTex },
        uLineVisible: { value: this.lineVisibleTex },
      },
    });
    this.landMatGlobe = new ShaderMaterial({
      vertexShader: buildLandVertGlobe(plateCount, lineCount),
      fragmentShader: LAND_FRAG,
      side: DoubleSide,
      uniforms: {
        uMask: { value: maskTexture },
        uColor: { value: passthroughColor(this.landColor) },
        uUseMask: { value: 1 },
        uOpacity: { value: 1 },
        uLightDir: { value: LIGHT_DIR.clone() },
        uColorMode: { value: 0 },
        uPlateQuat: { value: this.plateQuatTex },
        uPlateColor: { value: this.plateColorTex },
        uLineVisible: { value: this.lineVisibleTex },
      },
    });

    // Default mode is 'globe' (see `mode`'s field initializer), so start
    // attached to the Globe pair -- applyActiveGeometry() only needs to run
    // again if setProjection() later switches mode.
    this.lines = new LineSegments(this.lineGeomGlobe, this.lineMatGlobe);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;

    this.land = new Mesh(this.landGeomGlobe, this.landMatGlobe);
    this.land.frustumCulled = false;
    this.land.renderOrder = 2;

    this.setAge(0);
  }

  set landVisible(v: boolean) { this.land.visible = v; }

  /** Whether the CURRENT Theme provides a pen at all (false for Outline
   *  Treatment 'none'). */
  private themeHasPen = true;
  /** Whether the USER wants edges drawn. Separate from the Theme's own
   *  treatment because they answer different questions -- "does this look draw
   *  continent edges" versus "do I want to see them right now" -- and the pen
   *  is drawn only when both say yes. A single flag would mean switching to a
   *  'none' Theme and back silently discarded the user's choice. */
  private penWanted = true;

  /** Show or hide the continent-polygon edges, independently of the Theme.
   *  A Theme whose Outline Treatment is 'none' has no pen colour to draw in,
   *  so it stays hidden regardless and this records intent for the next Theme
   *  that does have one. */
  set penVisible(v: boolean) {
    this.penWanted = v;
    this.updatePenVisibility();
  }

  get penVisible(): boolean { return this.penWanted; }

  private updatePenVisibility(): void {
    this.lines.visible = this.themeHasPen && this.penWanted;
  }

  /**
   * Re-colour to a Theme. Land takes `land`, the pen takes the resolved
   * outline -- which is null for Outline Treatment 'none', and then the pen is
   * HIDDEN rather than painted in the fill colour: an invisible seam still
   * costs a draw call and still writes depth.
   *
   * Nothing is rebuilt. Both colours are shader uniforms and the geometry is
   * unchanged, so a Theme switch is a uniform write per material.
   */
  applyTheme(theme: ResolvedTheme): void {
    const landColor = passthroughColor(theme.land);
    this.landMatFlat.uniforms.uColor.value = landColor;
    this.landMatGlobe.uniforms.uColor.value = landColor;
    if (theme.outline !== null) {
      const outlineColor = passthroughColor(theme.outline);
      this.lineMatFlat.uniforms.uColor.value = outlineColor;
      this.lineMatGlobe.uniforms.uColor.value = outlineColor;
    }
    this.themeHasPen = theme.outline !== null;
    this.updatePenVisibility();
    // Captured for "By plate"'s no-data plates and "By VGP count"'s
    // zero-count plates (setLandColorMode()) -- both fall back to this
    // exact grey rather than a second hardcoded one.
    this.landRgb = [landColor.r, landColor.g, landColor.b];
  }

  /** Switch land fill between the Theme's flat colour ('theme', the
   *  default), a per-plate hue matching that plate's own VGP dots ('plate'),
   *  and a "hot"-style sequential ramp on `counts` ('count') -- see this
   *  class's own `landColorMode`/`plateVgpCounts`/`platesWithData` field doc
   *  comments. `counts` is used for 'count', `platesWithData` for 'plate';
   *  each is ignored for the other mode. Rebuilds via setAge() only for
   *  'plate'/'count': switching back to 'theme' is just flipping LAND_FRAG's
   *  `uColorMode` uniform back to 0, since the flat `uColor` path never
   *  stopped being correct underneath. */
  setLandColorMode(
    mode: LandColorMode, counts?: Map<number, number>, platesWithData?: Set<number>,
  ): void {
    this.landColorMode = mode;
    if (counts) this.plateVgpCounts = counts;
    if (platesWithData) this.platesWithData = platesWithData;
    const uColorMode = mode === 'theme' ? 0 : 1;
    this.landMatFlat.uniforms.uColorMode.value = uColorMode;
    this.landMatGlobe.uniforms.uColorMode.value = uColorMode;
    if (mode !== 'theme') this.setAge(this.currentAge);
  }

  /** Change which plate the whole set reanchors around, and re-render the
   *  current age with it -- see CONTEXT.md's Reference Plate entry. */
  setReferencePlate(plateId: number): void {
    this.referencePlateId = plateId;
    this.setAge(this.currentAge);
  }

  /** Change Map Orientation's centre/roll rotation and re-render the current
   *  age with it -- see CONTEXT.md's Map Orientation entry and
   *  `setReferencePlate()`'s identical shape. `q` is GEOGRAPHIC frame (e.g.
   *  from `core/rotation.ts`'s `orientationQuaternion()`), composed the same
   *  way `qRef` already is in `setAge()`. */
  setOrientation(q: Quaternion): void {
    this.qOrient = q;
    this.setAge(this.currentAge);
  }

  /** Switch between Globe and a flat Projection -- swaps which
   *  geometry+material pair is attached to the public `lines`/`land`
   *  fields (see applyActiveGeometry()), then rebuilds the newly-active
   *  path for the current age. */
  setProjection(mode: ProjectionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyActiveGeometry();
    this.setAge(this.currentAge);
  }

  /** `this.lines`/`this.land`'s geometry/material for whichever mode is
   *  now active. Their IDENTITY never changes -- ~10 existing consumers
   *  across the codebase (every wrapper that uses Coastlines) add these two
   *  objects to a THREE.Scene once and never re-add them, so switching
   *  Projection has to reassign what a fixed object POINTS AT rather than
   *  replace the object itself. */
  private applyActiveGeometry(): void {
    const flat = isFlat(this.mode);
    this.lines.geometry = flat ? this.lineGeomFlat : this.lineGeomGlobe;
    this.lines.material = flat ? this.lineMatFlat : this.lineMatGlobe;
    this.land.geometry = flat ? this.landGeomFlat : this.landGeomGlobe;
    this.land.material = flat ? this.landMatFlat : this.landMatGlobe;
  }

  /** Re-render for a reconstruction age. Globe mode's fast path only
   *  rewrites a handful of small per-plate/per-line lookup textures (see
   *  updatePlateRotations()/updateLineVisibility()/updatePlateColors()) --
   *  the actual per-vertex rotation happens on the GPU, every render frame,
   *  at no extra CPU cost on top of what three.js already pays to draw the
   *  scene. Flat mode is unchanged from before this file's GPU rewrite. */
  setAge(age: number): void {
    this.currentAge = age;
    if (isFlat(this.mode)) {
      this.rebuildFlat(age);
      return;
    }
    this.updatePlateRotations(age);
    this.updateLineVisibility(age);
    if (this.landColorMode !== 'theme') this.updatePlateColors();
  }

  /** One render-frame quaternion per distinct plate -- O(#plates), not
   *  O(#vertices). Reference Plate (`qRef`) is folded in here; Map
   *  Orientation is NOT (see `qOrient`'s own field doc comment) -- Globe
   *  mode must never be affected by a rotation that only makes sense for a
   *  flat map's reprojection. */
  private updatePlateRotations(age: number): void {
    const qRef = referenceRotationAt(this.table, this.referencePlateId, age);
    for (const [plateId, idx] of this.plateIdToIndex) {
      const qGeo = composeQuaternions(qRef, rotationAt(this.table, plateId, age));
      const [x, y, z, w] = toRenderFrameRotation(qGeo);
      this.plateQuatData[idx * 4] = x;
      this.plateQuatData[idx * 4 + 1] = y;
      this.plateQuatData[idx * 4 + 2] = z;
      this.plateQuatData[idx * 4 + 3] = w;
    }
    this.plateQuatTex.needsUpdate = true;
  }

  /** One appear/disappear check per LINE -- O(#lines), not O(#vertices).
   *  The GPU-side equivalent of rebuildFlat()'s `continue` skip. */
  private updateLineVisibility(age: number): void {
    for (let i = 0; i < this.data.length; i++) {
      const l = this.data[i];
      // Ages increase into the past, so appearAge is the LARGER value. A
      // feature appearing at 100 Ma must be absent at 150 Ma.
      this.lineVisibleData[i] = (age > l.appearAge || age < l.disappearAge) ? 0 : 1;
    }
    this.lineVisibleTex.needsUpdate = true;
  }

  /** One colour per distinct plate -- O(#plates), not O(#vertices). Same
   *  colour logic rebuildFlat() computes per LINE (every line belonging to
   *  a plate would compute the identical value there); deduplicated here
   *  since a plate's colour doesn't depend on which of its lines is asking. */
  private updatePlateColors(): void {
    // See rebuildFlat()'s identical comment: rescaled against the observed
    // max so "By VGP count" always reads as "brightest plate currently
    // visible", not saturated against some other age's densest plate.
    let maxVgpCount = 1;
    if (this.landColorMode === 'count') {
      for (const c of this.plateVgpCounts.values()) maxVgpCount = Math.max(maxVgpCount, c);
    }
    for (const [plateId, idx] of this.plateIdToIndex) {
      let [r, g, b] = this.landRgb;
      if (this.landColorMode === 'plate') {
        if (!this.platesWithData || this.platesWithData.has(plateId)) {
          [r, g, b] = hslToRgb(plateHue(plateId), 0.65, 0.55);
        }
      } else if (this.landColorMode === 'count') {
        const count = this.plateVgpCounts.get(plateId) ?? 0;
        if (count > 0) {
          [r, g, b] = hotColor(0.22 + (0.78 * count) / maxVgpCount);
        }
      }
      this.plateColorData[idx * 4] = r;
      this.plateColorData[idx * 4 + 1] = g;
      this.plateColorData[idx * 4 + 2] = b;
      this.plateColorData[idx * 4 + 3] = 1;
    }
    this.plateColorTex.needsUpdate = true;
  }

  /** Project and append one land vertex, returning its index, or -1 when the
   *  buffers are full (see their allocation for the headroom they carry). */
  private appendLandVertex(
    lon: number, lat: number, r: number, g: number, b: number,
  ): number {
    const i = this.wVert;
    if ((i + 1) * 3 > this.landPosFlat.length) return -1;
    const [fx, fy, fz] = lonLatToProjected(this.mode, lon, lat, 0);
    this.landPosFlat[i * 3] = fx;
    this.landPosFlat[i * 3 + 1] = fy;
    this.landPosFlat[i * 3 + 2] = fz + FLAT_LAND_Z;
    this.landColorAttrFlat[i * 3] = r;
    this.landColorAttrFlat[i * 3 + 1] = g;
    this.landColorAttrFlat[i * 3 + 2] = b;
    this.landLonFlat[i] = lon;
    this.landLatFlat[i] = lat;
    this.wVert++;
    return i;
  }

  /** Fan-triangulate `n` vertices held in clipLon/clipLat and emit them. */
  private emitFan(n: number, r: number, g: number, b: number, iw: number): number {
    if (n < 3) return iw;
    const first = this.appendLandVertex(this.clipLon[0], this.clipLat[0], r, g, b);
    if (first < 0) return iw;
    let prev = this.appendLandVertex(this.clipLon[1], this.clipLat[1], r, g, b);
    if (prev < 0) return iw;
    for (let i = 2; i < n; i++) {
      const cur = this.appendLandVertex(this.clipLon[i], this.clipLat[i], r, g, b);
      if (cur < 0 || iw + 3 > this.landIdxFlat.length) return iw;
      this.landIdxFlat[iw++] = first;
      this.landIdxFlat[iw++] = prev;
      this.landIdxFlat[iw++] = cur;
      prev = cur;
    }
    return iw;
  }

  /**
   * Emit the polygon held in polyLon/polyLat, splitting it at the seam first
   * if it reaches past lon +-180.
   *
   * Sutherland-Hodgman against a single meridian, run twice with the side
   * reversed, and the far half shifted a whole turn so it lands on the
   * opposite edge of the map rather than stretching back across it. Clipping
   * in longitude rather than in projected x is what makes this hold for
   * Robinson as well as Plate Carrée -- the seam is a meridian on the sphere,
   * and only becomes a straight map edge after projection.
   */
  private emitLonPolygon(
    n: number, r: number, g: number, b: number, iw: number,
  ): number {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (this.polyLon[i] < lo) lo = this.polyLon[i];
      if (this.polyLon[i] > hi) hi = this.polyLon[i];
    }
    if (lo >= -180 && hi <= 180) {
      for (let i = 0; i < n; i++) {
        this.clipLon[i] = this.polyLon[i];
        this.clipLat[i] = this.polyLat[i];
      }
      return this.emitFan(n, r, g, b, iw);
    }
    const cut = hi > 180 ? 180 : -180;
    for (let side = 0; side < 2; side++) {
      const keepBelow = side === 0 ? cut > 0 : cut < 0;
      const shift = side === 0 ? 0 : (cut > 0 ? -360 : 360);
      let m = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const lonI = this.polyLon[i], latI = this.polyLat[i];
        const lonJ = this.polyLon[j], latJ = this.polyLat[j];
        const inI = keepBelow ? lonI <= cut : lonI >= cut;
        const inJ = keepBelow ? lonJ <= cut : lonJ >= cut;
        if (inI) { this.clipLon[m] = lonI + shift; this.clipLat[m] = latI; m++; }
        if (inI !== inJ) {
          const t = (cut - lonI) / (lonJ - lonI);
          this.clipLon[m] = cut + shift;
          this.clipLat[m] = latI + t * (latJ - latI);
          m++;
        }
      }
      iw = this.emitFan(m, r, g, b, iw);
    }
    return iw;
  }

  /**
   * Emit the map-space quad between one edge of a spherical triangle and the
   * pole line.
   *
   * A pole is ONE point on the sphere and a whole horizontal LINE on a flat
   * map, so a triangle that reaches it has no single correct image: the
   * vertex has to become the entire stretch of pole line the triangle's
   * opposite edge subtends. Emitting a quad rather than a triangle with the
   * pole at one longitude is what makes neighbouring caps meet exactly along
   * that line instead of leaving wedge-shaped gaps between them.
   */
  private emitPoleCap(
    lonA: number, latA: number, lonB: number, latB: number, poleLat: number,
    r: number, g: number, b: number, iw: number,
  ): number {
    const lonBu = lonA + wrapLonDelta(lonB - lonA);
    this.polyLon[0] = lonA; this.polyLat[0] = latA;
    this.polyLon[1] = lonBu; this.polyLat[1] = latB;
    this.polyLon[2] = lonBu; this.polyLat[2] = poleLat;
    this.polyLon[3] = lonA; this.polyLat[3] = poleLat;
    return this.emitLonPolygon(4, r, g, b, iw);
  }

  /**
   * Flat/Plate-Carrée mode's rebuild -- CPU per-vertex rotation +
   * reprojection + antimeridian seam-dropping, exactly as this class always
   * did (see the class's own doc comment for why this path was never moved
   * to the GPU alongside Globe mode).
   *
   * REVERTED: an interaction-quality decimation (subsampling the outline
   * and reusing its points for land's boundary ring, to speed up a Map
   * Orientation drag on Torsvik) briefly lived here and was pulled back
   * out -- it broke the invariant that adjacent plates' land polygons must
   * still meet EXACTLY along their shared edge once one side's boundary
   * points had been decimated/held to a coarser position, producing dark
   * seam slivers between continents during a drag, plus a broader Robinson-
   * edge artifact on every model, not just Torsvik. Flat-mode dragging on a
   * dense dataset (Torsvik) is still slow -- see docs/plans (or ask) for
   * the follow-up: a proper, topology-preserving simplification of the
   * SOURCE polygons at prep time (so shared edges between neighbours are
   * simplified consistently, never independently), rather than a runtime
   * per-frame shortcut.
   */
  private rebuildFlat(age: number): void {
    let lw = 0;   // line float cursor
    let vw = 0;   // land vertex count
    let iw = 0;   // land index cursor

    const qRef = referenceRotationAt(this.table, this.referencePlateId, age);
    // The observed max, not a fixed constant: "By VGP count" reads as
    // "brightest plate currently visible", which needs the ramp to rescale
    // as the age slider moves VGPs in and out of their ±5 Ma window rather
    // than saturating against whatever the single densest plate/age
    // combination anywhere in the dataset happens to be.
    let maxVgpCount = 1;
    if (this.landColorMode === 'count') {
      for (const c of this.plateVgpCounts.values()) maxVgpCount = Math.max(maxVgpCount, c);
    }

    for (let li = 0; li < this.data.length; li++) {
      const line = this.data[li];
      // Ages increase into the past, so appearAge is the LARGER value. A
      // feature appearing at 100 Ma must be absent at 150 Ma.
      if (age > line.appearAge || age < line.disappearAge) continue;

      // Flat mode only -- Map Orientation rotates this reprojection, never
      // Globe mode's GPU-side rotation (see `qOrient`'s field doc comment).
      const [qx, qy, qz, qw] = composeQuaternions(
        this.qOrient,
        composeQuaternions(qRef, rotationAt(this.table, line.plateId, age)),
      );
      const p = line.points;
      const n = p.length / 3;
      const base = vw;

      let px = 0, py = 0, pz = 0, plon = 0;
      for (let i = 0; i < n; i++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];

        // v' = q * v * q^-1, expanded.
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        const rx = x + qw * tx + (qy * tz - qz * ty);
        const ry = y + qw * ty + (qz * tx - qx * tz);
        const rz = z + qw * tz + (qx * ty - qy * tx);

        // Geographic (X, Y, Z) -> viewer (X, Z, -Y).
        const gx = rx * COASTLINE_R, gy = rz * COASTLINE_R, gz = -ry * COASTLINE_R;

        let cx: number, cy: number, cz: number, lon = 0;
        if (!isFlat(this.mode)) {
          cx = gx; cy = gy; cz = gz;
        } else {
          // Recover (lon, lat) from the already-fully-rotated (reconstruction
          // + Reference Plate) viewer-frame point and reproject onto the flat
          // map -- the same "rotate the true point forward, then reproject"
          // direction as windGlyphs.ts/windStreaks.ts's referencePlateFlat*
          // helpers, just computed via this class's own CPU rotation instead
          // of calling them (the composed quaternion above already bakes in
          // BOTH rotations at once, which those helpers don't need to since
          // they're only ever given one).
          const ll = vec3ToLonLat(gx, gy, gz);
          lon = ll.lon;
          [cx, cy, cz] = lonLatToProjected(this.mode, ll.lon, ll.lat, FLAT_COASTLINE_Z);
          // Kept for the land loop below, which would otherwise redo this
          // exact rotation and projection for the same point.
          this.cacheX[i] = cx; this.cacheY[i] = cy;
          this.cacheLon[i] = lon; this.cacheLat[i] = ll.lat;
        }

        if (i > 0) {
          // Plate Carrée: a non-zero Reference Plate can put the antimeridian
          // seam at a different TRUE longitude than the map's own fixed
          // edges (see docs/plans/reference-plate.md), so an ordinary short
          // segment in the reconstructed geometry can land on opposite
          // DISPLAY edges of the flat map. Same "drop rather than draw a
          // wrong line" choice as windStreaks.ts's advect() -- one skipped
          // segment (a handful of pixels, given prep_coastlines.py's sampling
          // density) is invisible; a line spanning the whole map width isn't.
          //
          // Tested on raw DISPLAY longitude (`lon`, already wrapped to
          // (-180, 180] by vec3ToLonLat), not projected x-spread as this used
          // to be: Robinson's x = KX*R*lon*X(lat) shrinks by the X(lat) table
          // toward the poles (down to ~0.53x at the pole), so a segment that
          // genuinely wraps most of the way around the antimeridian can still
          // have a small x-SPREAD at high latitude and slip past a fixed
          // half-width threshold undropped -- exactly the "dark polygonal
          // patch eating in from the Robinson margins" artifact reported
          // against this class. A raw longitude test has no such latitude
          // dependence: a genuine seam crossing is >180 deg apart in (-180,
          // 180] terms regardless of where on the map it happens to land.
          if (!isFlat(this.mode) || Math.abs(lon - plon) <= 180) {
            this.linePosFlat[lw++] = px; this.linePosFlat[lw++] = py; this.linePosFlat[lw++] = pz;
            this.linePosFlat[lw++] = cx; this.linePosFlat[lw++] = cy; this.linePosFlat[lw++] = cz;
          }
        }
        px = cx; py = cy; pz = cz; plon = lon;
      }

      if (line.triangles && line.landPoints) {
        // Colour is constant per LINE (each belongs to exactly one plate),
        // computed once here rather than per vertex. Only actually read by
        // LAND_FRAG when uColorMode is 1 ('plate'/'count'); harmless,
        // unused writes otherwise -- see setLandColorMode()'s own doc
        // comment for why 'theme' never needs to skip this loop instead.
        let lr = 0, lg = 0, lb = 0;
        if (this.landColorMode === 'plate') {
          // "Only give colour to polygons that ever have data" -- a plate
          // outside platesWithData renders as plain landRgb, same as a
          // Theme with no paleomagnetic overlay at all.
          if (this.platesWithData && !this.platesWithData.has(line.plateId)) {
            [lr, lg, lb] = this.landRgb;
          } else {
            [lr, lg, lb] = hslToRgb(plateHue(line.plateId), 0.65, 0.55);
          }
        } else if (this.landColorMode === 'count') {
          const count = this.plateVgpCounts.get(line.plateId) ?? 0;
          if (count === 0) {
            [lr, lg, lb] = this.landRgb;
          } else {
            // Rescaled so even a single VGP reads as a visible dark red
            // rather than 'hot's own near-black floor at t=0.
            [lr, lg, lb] = hotColor(0.22 + (0.78 * count) / maxVgpCount);
          }
        }

        const lp = line.landPoints;
        const m = lp.length / 3;
        // How many leading fill vertices the outline loop above has already
        // done the work for (see `reuseBoundary`). Zero on the Globe path,
        // which does not project and so fills no cache.
        const reused = isFlat(this.mode) && this.reuseBoundary[li] ? n - 1 : 0;
        for (let i = 0; i < reused; i++) {
          this.landPosFlat[vw * 3] = this.cacheX[i];
          this.landPosFlat[vw * 3 + 1] = this.cacheY[i];
          this.landPosFlat[vw * 3 + 2] = FLAT_LAND_Z;
          this.landLonFlat[vw] = this.cacheLon[i];
          this.landLatFlat[vw] = this.cacheLat[i];
          this.landColorAttrFlat[vw * 3] = lr;
          this.landColorAttrFlat[vw * 3 + 1] = lg;
          this.landColorAttrFlat[vw * 3 + 2] = lb;
          vw++;
        }
        for (let i = reused; i < m; i++) {
          const x = lp[i * 3], y = lp[i * 3 + 1], z = lp[i * 3 + 2];
          const tx = 2 * (qy * z - qz * y);
          const ty = 2 * (qz * x - qx * z);
          const tz = 2 * (qx * y - qy * x);
          const rx = x + qw * tx + (qy * tz - qz * ty);
          const ry = y + qw * ty + (qz * tx - qx * tz);
          const rz = z + qw * tz + (qx * ty - qy * tx);
          const gx2 = rx * this.landRadius;
          const gy2 = rz * this.landRadius;
          const gz2 = -ry * this.landRadius;
          if (isFlat(this.mode)) {
            // Land fill used to stay on the sphere in every Projection, so a
            // flat map showed flat coastLINES over a spherical blob of land.
            // Tolerable while the only flat mode always had an opaque raster
            // over it; not tolerable for a viewer whose land fill IS the
            // basemap. Same reproject-the-rotated-point step the lines above
            // do, applied to the triangulated vertices.
            const { lon, lat } = vec3ToLonLat(gx2, gy2, gz2);
            const [fx, fy, fz] = lonLatToProjected(this.mode, lon, lat, 0);
            this.landPosFlat[vw * 3] = fx;
            this.landPosFlat[vw * 3 + 1] = fy;
            this.landPosFlat[vw * 3 + 2] = fz + FLAT_LAND_Z;
            this.landLonFlat[vw] = lon;
            this.landLatFlat[vw] = lat;
          } else {
            this.landPosFlat[vw * 3] = gx2;
            this.landPosFlat[vw * 3 + 1] = gy2;
            this.landPosFlat[vw * 3 + 2] = gz2;
          }
          this.landColorAttrFlat[vw * 3] = lr;
          this.landColorAttrFlat[vw * 3 + 1] = lg;
          this.landColorAttrFlat[vw * 3 + 2] = lb;
          vw++;
        }
        const t = line.triangles;
        if (isFlat(this.mode)) {
          // Flattening a spherical triangle is only safe away from the two
          // places the projection stops being locally well behaved, and BOTH
          // of them are the map's own edge -- which is why every artifact this
          // block exists to prevent showed up there and nowhere else:
          //
          //   - the SEAM (lon +-180, the map's left and right edge). A
          //     triangle straddling it has vertices that project to opposite
          //     edges, so drawn flat it lies across the whole map. This used
          //     to be dropped outright; measured on the live viewer that threw
          //     away 50-640 triangles per frame, every one a real piece of
          //     coastline, leaving the dark polygonal bites out of the land
          //     that appear along both curved edges. Clipped now instead, so
          //     both halves survive on the edge they belong to.
          //
          //   - the POLES, which are ONE point on the sphere but a whole
          //     horizontal LINE on the map. A vertex there has no meaningful
          //     longitude, so it lands at an arbitrary x and every triangle
          //     touching it is stretched across to wherever that fell --
          //     measured at up to a quarter of the map's width for a triangle
          //     under 2 deg across, which is the band that smears along the
          //     top edge. Given the longitude of the side it is actually
          //     closing off, the fan collapses back onto the pole line.
          //
          // Both work in (lon, lat) and re-project, rather than trying to
          // repair the projected x -- the seam and the pole line are features
          // of the sphere's coordinates, not of any one flat Projection, so
          // fixing them here keeps Plate Carree and Robinson honest with the
          // same code.
          const sLon = this.scratchLon, sLat = this.scratchLat;
          const idx = this.scratchIdx;
          this.wVert = vw;
          for (let k = 0; k < t.length; k += 3) {
            idx[0] = base + t[k]; idx[1] = base + t[k + 1]; idx[2] = base + t[k + 2];
            for (let j = 0; j < 3; j++) {
              sLon[j] = this.landLonFlat[idx[j]];
              sLat[j] = this.landLatFlat[idx[j]];
            }

            // Winding in longitude. A triangle that encircles a pole comes
            // back to where it started having gone a whole turn round;
            // anything else nets to zero. This is the only test that tells
            // the two apart, because near a pole the longitudes themselves
            // say nothing -- adjacent vertices a few km apart can sit 160 deg
            // of longitude from each other.
            // Fast path, and the overwhelming majority: a triangle whose
            // vertices are within half a turn of each other and clear of both
            // poles cannot encircle a pole and cannot cross the seam, so it
            // needs none of the repair below and can reuse the vertices the
            // loop above already projected.
            if (Math.abs(sLon[0] - sLon[1]) < 180 && Math.abs(sLon[1] - sLon[2]) < 180
              && Math.abs(sLon[2] - sLon[0]) < 180
              && Math.abs(sLat[0]) < 89.999 && Math.abs(sLat[1]) < 89.999
              && Math.abs(sLat[2]) < 89.999) {
              if (iw + 3 > this.landIdxFlat.length) continue;
              this.landIdxFlat[iw++] = idx[0];
              this.landIdxFlat[iw++] = idx[1];
              this.landIdxFlat[iw++] = idx[2];
              continue;
            }

            const d01 = wrapLonDelta(sLon[1] - sLon[0]);
            const d12 = wrapLonDelta(sLon[2] - sLon[1]);
            const d20 = wrapLonDelta(sLon[0] - sLon[2]);
            if (Math.abs(d01 + d12 + d20) > 180) {
              // Encircles a pole: it has no image as a flat triangle at all.
              // Each edge closes up to the pole line instead, and the three
              // caps together tile exactly the region the triangle covered.
              const poleLat = sLat[0] + sLat[1] + sLat[2] >= 0 ? 90 : -90;
              for (let e = 0; e < 3; e++) {
                const f = (e + 1) % 3;
                iw = this.emitPoleCap(sLon[e], sLat[e], sLon[f], sLat[f],
                  poleLat, lr, lg, lb, iw);
              }
              continue;
            }

            // A vertex sitting ON a pole has no meaningful longitude either --
            // same treatment, from the edge opposite it.
            let polar = -1;
            for (let j = 0; j < 3; j++) if (Math.abs(sLat[j]) >= 89.999) polar = j;
            if (polar >= 0) {
              const e = (polar + 1) % 3, f = (polar + 2) % 3;
              iw = this.emitPoleCap(sLon[e], sLat[e], sLon[f], sLat[f],
                sLat[polar] >= 0 ? 90 : -90, lr, lg, lb, iw);
              continue;
            }

            // Ordinary triangle. Unwrap onto one branch so one sitting on the
            // seam reads as (179, 181) rather than (179, -179) and stays
            // small, then emit -- straight through if it is wholly on the map,
            // split at the seam if it is not.
            sLon[1] = sLon[0] + d01;
            sLon[2] = sLon[1] + d12;
            if (sLon[0] >= -180 && sLon[1] >= -180 && sLon[2] >= -180
              && sLon[0] <= 180 && sLon[1] <= 180 && sLon[2] <= 180) {
              // The common case by a wide margin: reuse the vertices the loop
              // above already projected rather than appending copies.
              if (iw + 3 > this.landIdxFlat.length) continue;
              this.landIdxFlat[iw++] = idx[0];
              this.landIdxFlat[iw++] = idx[1];
              this.landIdxFlat[iw++] = idx[2];
              continue;
            }
            for (let j = 0; j < 3; j++) {
              this.polyLon[j] = sLon[j];
              this.polyLat[j] = sLat[j];
            }
            iw = this.emitLonPolygon(3, lr, lg, lb, iw);
          }
          vw = this.wVert;
        } else {
          for (let k = 0; k < t.length; k++) this.landIdxFlat[iw++] = base + t[k];
        }
      }
    }

    this.lineGeomFlat.setDrawRange(0, lw / 3);
    (this.lineGeomFlat.getAttribute('position') as BufferAttribute).needsUpdate = true;

    this.landGeomFlat.setDrawRange(0, iw);
    (this.landGeomFlat.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.landGeomFlat.getAttribute('color') as BufferAttribute).needsUpdate = true;
    this.landGeomFlat.getIndex()!.needsUpdate = true;
  }

  setMaskEnabled(on: boolean): void {
    for (const m of [this.lineMatFlat, this.lineMatGlobe, this.landMatFlat, this.landMatGlobe]) {
      m.uniforms.uUseMask.value = on ? 1 : 0;
    }
  }

  dispose(): void {
    this.lineGeomFlat.dispose();
    this.lineGeomGlobe.dispose();
    this.landGeomFlat.dispose();
    this.landGeomGlobe.dispose();
    this.lineMatFlat.dispose();
    this.lineMatGlobe.dispose();
    this.landMatFlat.dispose();
    this.landMatGlobe.dispose();
    this.plateQuatTex.dispose();
    this.plateColorTex.dispose();
    this.lineVisibleTex.dispose();
  }

  /**
   * Fade with the globe surface.
   *
   * The land fill sits a fraction above the surface sphere and is opaque, so
   * without this, turning the surface down to see the isosurfaces leaves the
   * continents painted solidly over them -- the control appears to half-work,
   * which is worse than not working.
   *
   * `transparent` is only switched on when it is actually needed. Left on
   * permanently it would move these meshes into the sorted transparent pass at
   * full opacity too, and that changes what the existing renders look like for
   * no reason.
   */
  setOpacity(v: number): void {
    for (const m of [this.lineMatFlat, this.lineMatGlobe, this.landMatFlat, this.landMatGlobe]) {
      m.uniforms.uOpacity.value = v;
      const wantTransparent = v < 1;
      if (m.transparent !== wantTransparent) {
        m.transparent = wantTransparent;
        m.needsUpdate = true;
      }
    }
  }
}

export interface CoastlineData {
  lines: CoastlineLine[];
  table: RotationTable;
}

/**
 * Which coastline set belongs on this Model's globe, generalized from the
 * four hand-written versions of this same decision that predate it
 * (tomography/main.ts, climate/main.ts, valdes/main.ts, and one more).
 *
 * 1. A Manifest with its own `reconstruction_model` (ADR-0004) is looked up
 *    in `archive.native_coastlines` -- never guessed from the model's id or
 *    name, and never falls back to (2) even if the lookup misses, since a
 *    run's own reconstruction is the only correct pairing for it.
 * 2. Otherwise, by Manifest type: the climate family sits on the Scotese
 *    plate model (Li et al. and the Scotese & Wright PaleoDEMs both do);
 *    tomography/convection sit on Muller et al. (`archive.coastlines`).
 * 3. Otherwise null -- a bare globe, tolerated everywhere already.
 */
export function resolveCoastlineSet(archive: ArchiveIndex, manifest: Manifest): CoastlineSet | null {
  if (manifest.reconstruction_model) {
    return archive.native_coastlines?.[manifest.reconstruction_model.toLowerCase()] ?? null;
  }
  switch (manifest.type) {
    case 'climate':
    case 'climate-monthly':
    case 'climate-ocean-depth':
    case 'paleogeography':
      return archive.scotese_coastlines ?? null;
    case 'tomography':
    case 'convection':
      return archive.coastlines ?? null;
    default:
      return null;
  }
}

/**
 * Fetch and parse the coastline geometry and rotation table, without building
 * any GPU-side `Coastlines` instance.
 *
 * Split out so multiple globes can share one fetch: the parsed data is
 * immutable and present-day, so every instance's `Coastlines` object can be
 * built from the same `CoastlineData` without re-downloading or re-parsing it.
 */
export async function fetchCoastlineData(
  base: string,
  geometryPath: string,
  rotationsPath: string,
): Promise<CoastlineData> {
  const [gBytes, rBytes] = await Promise.all([
    fetchVolumeBytes(`${base}/${geometryPath}`),
    fetchVolumeBytes(`${base}/${rotationsPath}`),
  ]);
  const lines = parseGeometry(gBytes.buffer.slice(gBytes.byteOffset, gBytes.byteOffset + gBytes.byteLength) as ArrayBuffer);
  const table: RotationTable = JSON.parse(new TextDecoder().decode(rBytes));
  return { lines, table };
}

export async function loadCoastlines(
  base: string,
  geometryPath: string,
  rotationsPath: string,
  maskTexture: Texture,
): Promise<Coastlines> {
  const { lines, table } = await fetchCoastlineData(base, geometryPath, rotationsPath);
  return new Coastlines(lines, table, maskTexture);
}
