import { geoVecFromLonLat, rotateVector, type Quaternion } from './rotation';

const SIZE = 44;
const RADIUS = SIZE / 2 - 3;

/** A handful of parallels/meridians, sampled coarsely -- this is a compass,
 *  not a data map, so it only needs to read as "a globe, oriented this way"
 *  at a glance. */
const MERIDIANS = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
const PARALLELS = [-60, -30, 0, 30, 60];
const SAMPLE_STEP = 10;

/**
 * A small READ-ONLY compass showing Map Orientation's current centre (see
 * CONTEXT.md's Map Orientation entry) -- the actual click-and-drag control
 * lives directly on the main map now (main.ts's canvas pointer handlers,
 * matching the linked Observable "versor dragging" notebook's own
 * click-the-map UX exactly), NOT on this widget. An earlier version made
 * THIS circle the drag target instead of the map itself, which needed
 * explaining ("why drag the little globe, not the big one") rather than
 * being obvious -- dragging the actual map is the whole point of Map
 * Orientation, so it should be the thing you drag.
 *
 * What survives here: a glance-able readout of where the pole currently
 * sits (the one fact a fully-oblique map doesn't otherwise show at a
 * glance), and double-click-to-reset -- a single, discoverable escape
 * hatch back to the default view, the same role Reference Plate's "0
 * (default)" plays there.
 */
export class MapOrientationControl {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private q: Quaternion;
  private readonly defaultQ: Quaternion;
  private dpr = Math.min(devicePixelRatio, 2);

  constructor(defaultOrientation: Quaternion, private onReset: (q: Quaternion) => void) {
    this.q = defaultOrientation;
    this.defaultQ = defaultOrientation;

    this.el = document.createElement('canvas');
    this.el.width = SIZE * this.dpr;
    this.el.height = SIZE * this.dpr;
    Object.assign(this.el.style, {
      width: `${SIZE}px`, height: `${SIZE}px`,
      borderRadius: '50%', cursor: 'pointer', touchAction: 'none',
      background: '#1b1f24', border: '1px solid #3a4048',
    });
    this.el.setAttribute('aria-label', 'Current map orientation -- double-click to reset');
    this.el.title = 'Drag the map to reorient it -- double-click here to reset';
    this.ctx = this.el.getContext('2d')!;

    this.el.addEventListener('dblclick', () => {
      this.setOrientation(this.defaultQ);
      this.onReset(this.defaultQ);
    });

    this.draw();
  }

  /** Reflect a new orientation (set by dragging the main map, or by this
   *  widget's own reset) -- purely a readout, never itself the source of a
   *  change other than reset. */
  setOrientation(q: Quaternion): void {
    this.q = q;
    this.draw();
  }

  getOrientation(): Quaternion {
    return this.q;
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
  }

  private draw(): void {
    const ctx = this.ctx;
    const s = SIZE * this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    ctx.strokeStyle = '#3a4048';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#5a636d';
    const project = (lon: number, lat: number): [number, number] | null => {
      const v = rotateVector(this.q, ...geoVecFromLonLat(lon, lat));
      if (v[2] < 0) return null; // far hemisphere -- not drawn
      return [cx + v[0] * RADIUS, cy - v[1] * RADIUS];
    };
    const polyline = (points: (readonly [number, number])[]): void => {
      let started = false;
      ctx.beginPath();
      for (const [lon, lat] of points) {
        const p = project(lon, lat);
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    };

    for (const lon of MERIDIANS) {
      const pts: [number, number][] = [];
      for (let lat = -90; lat <= 90; lat += SAMPLE_STEP) pts.push([lon, lat]);
      polyline(pts);
    }
    for (const lat of PARALLELS) {
      const pts: [number, number][] = [];
      for (let lon = -180; lon <= 180; lon += SAMPLE_STEP) pts.push([lon, lat]);
      polyline(pts);
    }

    // Pole markers -- the one fact this widget exists to show.
    const drawPole = (lat: 90 | -90, label: string): void => {
      const p = project(0, lat);
      if (!p) return;
      ctx.fillStyle = lat > 0 ? '#e8ecef' : '#f2a65a';
      ctx.beginPath();
      ctx.arc(p[0], p[1], 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#97a3ad';
      ctx.font = '8px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(label, p[0] + 3, p[1] + 3);
    };
    drawPole(90, 'N');
    drawPole(-90, 'S');
  }
}
