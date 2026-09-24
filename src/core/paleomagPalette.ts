/**
 * Deterministic plate-id -> colour for paleomagnetic pole markers -- see
 * docs/plans/paleomagnetic-poles.md's "Resolved -- rendering and
 * interaction" section. `plate_id_regular.cpt`/`plate_id_categorical.cpt`
 * (GPlates' own illustrative example files) were checked directly and found
 * to only cover 2-4 named buckets, not the dozens of distinct plate ids a
 * real assignment produces, so this hashes instead of looking up a table --
 * a page-side styling choice per points.js's own restyle() doc comment
 * ("Colours do not belong in the exported JSON"), not a property of the
 * data. 701 and 801 are pinned so this agrees with GPlates' own convention
 * on the two plates GPlates itself names.
 */

const PINNED_HUES: Record<number, number> = {
  701: 30, // orange
  801: 130, // green
};

/** FNV-1a, good enough spread for a few hundred small integers -- this is a
 *  styling hash, not a cryptographic one. */
function hashPlateId(plateId: number): number {
  let h = 0x811c9dc5;
  const s = String(plateId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function plateHue(plateId: number): number {
  return PINNED_HUES[plateId] ?? (hashPlateId(plateId) % 360);
}

/** Fill (mid lightness) and edge (darker shade) for a pole marker/ring, both
 *  the same hue -- see the plan doc's marker spec. */
export function plateColors(plateId: number): { fill: string; edge: string } {
  const h = plateHue(plateId);
  return { fill: `hsl(${h}, 65%, 55%)`, edge: `hsl(${h}, 70%, 32%)` };
}

/** A95 values across the T2012_TC2017 dataset run ~0-21 deg (median ~5.4) --
 *  checked directly against the actual export, not guessed. Alpha is clamped
 *  to this range and interpolated linearly outside the eyeballed "typical"
 *  band, so an unusually large or tiny future dataset degrades gracefully
 *  rather than clipping to a flat colour. */
const RING_FILL_RADIUS_RANGE: [number, number] = [0, 20];
const RING_FILL_ALPHA_RANGE: [number, number] = [0.32, 0.04];

/** Semi-transparent fill for a confidence ring, same hue as its edge --
 *  larger radius (a less precise pole) reads as more transparent, so a tight
 *  cluster of precise poles reads as solid colour while a sprawl of loose
 *  ones does not visually overwhelm it. */
export function ringFill(plateId: number, radiusDeg: number): string {
  const h = plateHue(plateId);
  const [r0, r1] = RING_FILL_RADIUS_RANGE;
  const [a0, a1] = RING_FILL_ALPHA_RANGE;
  const t = Math.max(0, Math.min(1, (radiusDeg - r0) / (r1 - r0)));
  const alpha = a0 + t * (a1 - a0);
  return `hsla(${h}, 70%, 32%, ${alpha.toFixed(3)})`;
}

/** One VGP's full record, as prep_paleomag.py writes it into points.json --
 *  see docs/plans/paleomagnetic-poles.md. `lon`/`lat` is the computed pole
 *  position (what `poles`, a PointOverlay, draws); `sample_lon`/`sample_lat`
 *  is the real-world outcrop it was measured from (what `sites`, a SECOND
 *  PointOverlay over the same records, draws instead -- see
 *  reconstructionInstance.ts's `boot()`). Used wherever a picked point's
 *  metadata needs a real shape rather than `unknown` -- the metadata popup
 *  (`core/samplePopup.ts`) and the VGP-count land-colouring pass both read
 *  this shape off `PointOverlay.pick()`/`payload()`. */
export interface PaleomagSampleRecord {
  lon: number;
  lat: number;
  age: number;
  a95?: number;
  name?: string;
  description?: string | null;
  sample_lon: number;
  sample_lat: number;
  plate_id: number;
  plate_begin_age?: number | null;
}

/** `PointLayer`'s `options.style()` hook for a VGP pole marker -- shared by
 *  every reconstruction wrapper that offers the Paleomagnetic poles toggle,
 *  so the marker/ring/transparency treatment stays one definition. */
export function poleStyle(point: { plate_id: number; a95?: number }): {
  fill: string; ringColor: string; ringFill: string; ringRadiusDeg: number | undefined;
} {
  const { fill, edge } = plateColors(point.plate_id);
  return {
    fill,
    ringColor: edge,
    ringFill: point.a95 != null ? ringFill(point.plate_id, point.a95) : edge,
    ringRadiusDeg: point.a95,
  };
}

/** `PointLayer`'s `options.style()` hook for a Sample Site marker -- the
 *  real-world outcrop a VGP was measured from (`sample_lon`/`sample_lat`,
 *  see prep_paleomag.py), drawn from the SAME record as its VGP at the same
 *  array index (see `resolvePaleomagPoleSetFor()`'s callers), so it takes
 *  the identical hue for "this site and that pole are the same measurement"
 *  to read at a glance. Larger and brighter than the VGP dot itself
 *  (`poleStyle()`'s default `size` is petrify's own 3.4) -- sites are the
 *  PRIMARY click target for the metadata popup (`selectSampleAt()`), so
 *  they need to read as the thing to interact with, not as faint context. */
export function siteStyle(point: { plate_id: number }): { fill: string; size: number } {
  const h = plateHue(point.plate_id);
  return { fill: `hsla(${h}, 75%, 62%, 0.9)`, size: 4.2 };
}

/** The GAPWaP path's own colour/width -- a bright, saturated blue rather
 *  than a hue any plate_id's hash could ever land on (plateHue()'s spread
 *  covers the full 360 degrees), and wider than the default connectWidth
 *  (petrify's `PointLayer` DEFAULT_OPTIONS, 1.5), so the modelled path
 *  reads as a distinct curve threading through the poles rather than
 *  blending into them -- the graphite Theme's coastlines/graticule are
 *  deliberately subdued (see vendor/petrify's own CHANGELOG) precisely so
 *  this is the thing that stands out. */
export const GAPWAP_PATH_COLOR = '#4d8dff';
export const GAPWAP_PATH_WIDTH = 2.5;
