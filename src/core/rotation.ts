import type { RotationTable } from './types';

export type Quaternion = [number, number, number, number];

/**
 * Slerp a plate's rotation between the bracketing 1 Ma samples. Shared by
 * coastlines.ts and staticPolygons.ts (docs/adr/0025) -- both rotate
 * present-day geometry into an age's position via the same RotationTable
 * (ADR-0001); Plate-Frame Point needs no new rotation mechanism of its own.
 */
export function rotationAt(table: RotationTable, plateId: number, age: number): Quaternion {
  const quats = table.plates[String(plateId)];
  if (!quats) return [0, 0, 0, 1];

  const ages = table.ages;
  const lo = Math.max(0, Math.min(ages.length - 2,
    Math.floor((age - ages[0]) / (ages[1] - ages[0]))));
  const t = Math.max(0, Math.min(1, (age - ages[lo]) / (ages[lo + 1] - ages[lo])));

  let [ax, ay, az, aw] = quats[lo];
  const [bx, by, bz, bw] = quats[lo + 1];

  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; d = -d; }

  if (d > 0.9995) {
    const x = ax + t * (bx - ax), y = ay + t * (by - ay);
    const z = az + t * (bz - az), w = aw + t * (bw - aw);
    const n = Math.hypot(x, y, z, w) || 1;
    return [x / n, y / n, z / n, w / n];
  }
  const theta = Math.acos(Math.min(1, d));
  const s = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / s;
  const w1 = Math.sin(t * theta) / s;
  return [
    w0 * ax + w1 * bx, w0 * ay + w1 * by,
    w0 * az + w1 * bz, w0 * aw + w1 * bw,
  ];
}

/** Rotate a vector by a unit quaternion: v' = q*v*q^-1, expanded. Operates in
 *  whatever frame the quaternion and vector were both defined in -- callers
 *  are responsible for using the geographic frame consistently (see
 *  coastlines.ts's module doc comment), never mixing it with the viewer's
 *  (X, Z, -Y) render frame. */
export function rotateVector(
  q: Quaternion, x: number, y: number, z: number,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Inverse of a unit quaternion (its conjugate). Used to reconstruct a point
 *  back to present-day coordinates from wherever it was picked -- see
 *  staticPolygons.ts's createPlateFramePoint(). */
export function conjugateQuaternion(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Compose two rotations: the result of applying `a` THEN `b` (v' =
 *  b*(a*v*a^-1)*b^-1) is rotateVector(composeQuaternions(b, a), v). Order
 *  matters -- the rotation applied SECOND is the first argument, standard
 *  Hamilton-product convention. */
export function composeQuaternions(b: Quaternion, a: Quaternion): Quaternion {
  const [bx, by, bz, bw] = b;
  const [ax, ay, az, aw] = a;
  return [
    bw * ax + bx * aw + by * az - bz * ay,
    bw * ay - bx * az + by * aw + bz * ax,
    bw * az + bx * ay - by * ax + bz * aw,
    bw * aw - bx * ax - by * ay - bz * az,
  ];
}

/**
 * See CONTEXT.md's Reference Plate entry and docs/adr/0030.
 *
 * Reanchoring the view into `referencePlateId`'s own frame is a single
 * rotation: the inverse of that plate's own rotationAt() at the same age,
 * composed ON TOP of whatever rotation a layer already applies to its own
 * present-day geometry. Identity at age 0 by construction (rotationAt is
 * identity for every plate there), so choosing a Reference Plate never moves
 * anything at the present day -- only deeper time is affected.
 */
export function referenceRotationAt(
  table: RotationTable, referencePlateId: number, age: number,
): Quaternion {
  if (referencePlateId === 0) return [0, 0, 0, 1]; // common case, skip the lookup+conjugate
  return conjugateQuaternion(rotationAt(table, referencePlateId, age));
}

/**
 * Fixed change-of-basis from the geographic frame (X to 0N/0E, Y to 0N/90E,
 * Z to the pole -- what RotationTable's quaternions and rotateVector() act
 * in) to the viewer's render frame (X, Z, -Y of geographic -- see
 * constants.ts). A rotation of -90 degrees about the geographic X axis:
 * render = (geoX, geoZ, -geoY) is exactly what that rotation produces.
 *
 * Exists so a rotation computed in the geographic frame (referenceRotationAt,
 * sourced from a RotationTable) can be applied directly to vectors that are
 * ALREADY in render-frame coordinates -- lonLatToVec3()'s output, used
 * throughout core/windGlyphs.ts, core/windStreaks.ts, core/trackedParticles.ts
 * and the volume/raster shaders -- without converting each vector to the
 * geographic frame and back. See toRenderFrameRotation().
 */
const GEOGRAPHIC_TO_RENDER_FRAME: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/**
 * Re-express a geographic-frame rotation (e.g. from referenceRotationAt) as
 * the equivalent rotation in render-frame coordinates, via similarity
 * transform: renderQ = F * geoQ * F^-1, where F is
 * GEOGRAPHIC_TO_RENDER_FRAME. rotateVector(toRenderFrameRotation(q), v) on a
 * render-frame v then gives the same physical rotation rotateVector(q, ...)
 * would give on the equivalent geographic-frame vector -- computed once per
 * age/Reference-Plate change, not per vertex.
 */
export function toRenderFrameRotation(q: Quaternion): Quaternion {
  return composeQuaternions(
    composeQuaternions(GEOGRAPHIC_TO_RENDER_FRAME, q),
    conjugateQuaternion(GEOGRAPHIC_TO_RENDER_FRAME),
  );
}

/** Unit quaternion for a rotation of `angleRad` about `axis` (need not be
 *  normalised -- this normalises it). The primitive `orientationQuaternion`
 *  below is built from. */
export function quaternionFromAxisAngle(
  axis: readonly [number, number, number], angleRad: number,
): Quaternion {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angleRad / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angleRad / 2)];
}

/**
 * Map Orientation's own rotation (see CONTEXT.md's Map Orientation entry):
 * a GEOGRAPHIC-frame quaternion, independent of any RotationTable/plate id
 * and unrelated to Reference Plate (ADR-0030), such that rotating the point
 * `(centerLon, centerLat)` by it lands at `(0, 0)` -- i.e. at a flat map's
 * own centre, once the rotated point is reprojected there. `rollDeg` spins
 * the result about the resulting boresight (the geographic X axis, after
 * centering) without moving `(centerLon, centerLat)` itself.
 *
 * Two axis rotations, composed in the same order as any other multi-step
 * rotation here (rotate about Z to bring the point's longitude to 0, then
 * about Y to bring its latitude to 0, then roll) -- verified numerically
 * (not just derived) against geoVec()/geoLonLat()'s own convention before
 * relying on it anywhere downstream: rotateVector(orientationQuaternion(lon0,
 * lat0, 0), ...geoVec(lon0, lat0)) recovers (1, 0, 0) (i.e. lon 0, lat 0) to
 * float precision, for any (lon0, lat0) and independent of rollDeg.
 */
export function orientationQuaternion(
  centerLon: number, centerLat: number, rollDeg = 0,
): Quaternion {
  const DEG = Math.PI / 180;
  const qLon = quaternionFromAxisAngle([0, 0, 1], -centerLon * DEG);
  const qLat = quaternionFromAxisAngle([0, 1, 0], centerLat * DEG);
  const qCenter = composeQuaternions(qLat, qLon);
  const qRoll = quaternionFromAxisAngle([1, 0, 0], rollDeg * DEG);
  return composeQuaternions(qRoll, qCenter);
}

/** (lon, lat) degrees -> unit vector in the GEOGRAPHIC frame (X to 0N/0E, Y
 *  to 0N/90E, Z to the pole) -- the frame `orientationQuaternion`,
 *  `referenceRotationAt` and every `RotationTable` quaternion act in. Paired
 *  with `lonLatFromGeoVec()`; used wherever a (lon, lat) itself (not a
 *  petrify vector already in this frame) needs to be carried through a
 *  geographic-frame rotation -- e.g. `core/graticule.ts`'s flat rebuild. */
export function geoVecFromLonLat(lon: number, lat: number): [number, number, number] {
  const DEG = Math.PI / 180;
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

/** Inverse of `geoVecFromLonLat()`. */
export function lonLatFromGeoVec(v: readonly [number, number, number]): { lon: number; lat: number } {
  const DEG = Math.PI / 180;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG,
    lon: Math.atan2(v[1], v[0]) / DEG,
  };
}

/** Rotate a (lon, lat) by a GEOGRAPHIC-frame quaternion and read the result
 *  back off as (lon, lat) -- `geoVecFromLonLat`/`lonLatFromGeoVec` round
 *  trip, `rotateVector` in between. */
export function rotateLonLat(
  lon: number, lat: number, q: Quaternion,
): { lon: number; lat: number } {
  return lonLatFromGeoVec(rotateVector(q, ...geoVecFromLonLat(lon, lat)));
}

/**
 * The quaternion that rotates unit vector `a` to unit vector `b`, both in
 * the SAME frame -- the "versor" of the linked Observable notebook's own
 * drag technique (`versor.delta`), and the core of Map Orientation's
 * click-and-drag-the-map control (see CONTEXT.md's Map Orientation entry):
 * grabbing the point under the cursor and dragging it to a new position is
 * exactly "rotate whatever was at `a` to now be at `b`".
 *
 * Standard axis = normalize(a x b), angle = acos(a . b); identity when `a`
 * and `b` already coincide (guards the otherwise-degenerate zero-length
 * cross product at the very start of a drag, where a === b exactly).
 */
export function deltaRotation(
  a: readonly [number, number, number], b: readonly [number, number, number],
): Quaternion {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const axis: [number, number, number] = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const axisLen = Math.hypot(...axis);
  if (axisLen < 1e-9) return [0, 0, 0, 1];
  return quaternionFromAxisAngle(axis, Math.acos(dot));
}
