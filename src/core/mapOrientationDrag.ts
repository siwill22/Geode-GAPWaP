import { Vector3, type Camera } from 'three';

import { flatWorldToLonLat, isFlat, type ProjectionMode } from './projection';
import { composeQuaternions, deltaRotation, geoVecFromLonLat, type Quaternion } from './rotation';

export interface MapOrientationDragDeps {
  getCamera(): Camera;
  getMode(): ProjectionMode;
  getOrientation(): Quaternion;
}

/**
 * Click-and-drag-the-map itself to change Map Orientation (see CONTEXT.md's
 * Map Orientation entry) -- the linked Observable "versor dragging"
 * notebook's own UX, on the actual map rather than a separate widget (an
 * earlier version of this control put the drag target on a small inset
 * compass instead; confusing on its own terms -- "drag the little globe,
 * not the big one" needed explaining rather than being obvious).
 *
 * Grabs the TRUE (lon, lat) under the cursor at drag start (`flatWorldToLonLat`,
 * the inverse of `lonLatToProjected`) and, on every move, the versor
 * (`deltaRotation`) that would carry that point to wherever the cursor is
 * NOW -- composed onto the orientation captured at drag start, so a
 * continuous drag reads as "grab this point and drag it", exactly like
 * spinning a ball under your finger. Both points are read in DISPLAY space
 * (i.e. already Map-Oriented, not unrotated back to true) -- consistent
 * with how the map itself is drawn, and the only frame in which "the point
 * under the cursor" is meaningful.
 *
 * A no-op outside a flat Projection (Globe already free-orbits via
 * `OrbitControls`) and wherever the cursor falls outside the map's own
 * outline (Robinson's boundary is a curve; `flatWorldToLonLat` returns null
 * there) -- a drag that starts off the map, or wanders off it mid-drag,
 * simply stops updating rather than snapping to a meaningless edge value.
 *
 * The caller is responsible for disabling `OrbitControls`' own pan on the
 * SAME element in flat mode -- otherwise both this and OrbitControls try to
 * interpret the identical drag (docs/plans -- this session's Map
 * Orientation plan's "click-and-drag the main view" follow-up).
 */
export function wireMapOrientationDrag(
  el: HTMLElement,
  deps: MapOrientationDragDeps,
  onChange: (q: Quaternion) => void,
): void {
  let dragStart: [number, number, number] | null = null;
  let qAtDragStart: Quaternion = [0, 0, 0, 1];

  function pointToGeoVec(ev: PointerEvent): [number, number, number] | null {
    const mode = deps.getMode();
    if (!isFlat(mode)) return null;
    const rect = el.getBoundingClientRect();
    const ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const world = new Vector3(ndcX, ndcY, 0).unproject(deps.getCamera());
    const ll = flatWorldToLonLat(mode, world.x, world.y);
    return ll ? geoVecFromLonLat(ll.lon, ll.lat) : null;
  }

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const p = pointToGeoVec(ev);
    if (!p) return;
    dragStart = p;
    qAtDragStart = deps.getOrientation();
    el.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
    if (!dragStart) return;
    const cur = pointToGeoVec(ev);
    if (!cur) return;
    onChange(composeQuaternions(deltaRotation(dragStart, cur), qAtDragStart));
  });

  const endDrag = (): void => { dragStart = null; };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}
