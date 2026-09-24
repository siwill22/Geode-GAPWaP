/*
 * A time/distance heatmap beside the map, sharing its clock -- the same role
 * timeseries.js plays for a line chart, for a 2D density instead.
 *
 * Built for one question: "does this category of sample sit closer to some target
 * than chance would put it?" A quantile-shift bar answers that in one number per
 * reconstruction time (positive = closer than a random point would be); the heatmap
 * below it shows the age/distance density behind that number.
 *
 * ---- Why deciles, not raw baseline points -----------------------------------
 *
 * The random baseline does not depend on which samples are toggled on -- only the
 * REAL samples do. So the host (see artifact.py) ships the baseline pre-reduced to
 * nine deciles per reconstruction time rather than the raw points (tens of
 * thousands per time step): the only thing ever done with them is exactly the
 * quantile-shift arithmetic this module does here, and redoing that per toggle
 * change from raw points would be strictly more work for the same answer.
 *
 * ---- No DOM here -------------------------------------------------------------
 *
 * Exactly the split timeseries.js/timeseries-panel.js already uses: this module
 * draws into a 2D context and holds no canvas, no buttons, no pointer handling.
 */

const DECILES = [10, 20, 30, 40, 50, 60, 70, 80, 90];

export const DEFAULT_OPTIONS = {
  barHeight: 46,
  gapHeight: 6,
  gridHeight: 96,
  padTop: 4,

  ageBinSize: 50,
  distanceBinSize: 200,
  distanceMax: 7000,

  shiftRange: 3000,           // colour-scale half-range for the quantile-shift bar
  positiveColour: 'rgba(230, 96, 96, 0.9)',    // closer than random
  negativeColour: 'rgba(96, 140, 230, 0.9)',   // farther than random
  neutralColour: 'rgba(180, 190, 200, 0.35)',

  cellLow: 'rgba(120, 200, 190, 0.05)',
  cellHigh: 'rgba(120, 220, 200, 0.95)',

  marker: 'rgba(232, 240, 248, 0.85)',
  markerWidth: 1,

  labels: true,
  labelFont: '10px ui-sans-serif, system-ui, sans-serif',
  labelColour: 'rgba(232, 240, 248, 0.62)',
};

/** Linear quantile matching numpy's default ('linear') interpolation. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function lerpColour(a, b, t) {
  const pa = a.match(/[\d.]+/g).map(Number);
  const pb = b.match(/[\d.]+/g).map(Number);
  const c = pa.map((v, i) => v + (pb[i] - v) * t);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`;
}

/**
 * @param samples    [{ time, distance, ...category fields }]
 * @param baseline   [{ time, d10, d20, ..., d90 }] -- one row per reconstruction time
 * @param categories { field: { label, options: [string] } }
 */
export class DistanceHeatmap {
  constructor(samples, baseline, categories, options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.samples = samples;
    this.baseline = new Map(baseline.map((b) => [b.time, DECILES.map((p) => b[`d${p}`])]));
    this.times = baseline.map((b) => b.time).sort((a, b) => a - b);
    this.categoryFields = Object.keys(categories);
    this.categories = categories;

    // Default: everything on -- the reader sees the full pooled set first.
    this.filter = {};
    for (const field of this.categoryFields) {
      this.filter[field] = new Set(categories[field].options);
    }

    this.currentTime = null;
    this.ghostTime = null;
    this.range = options.range || this._dataRange();
    this._layout = null;
    this._recompute();
  }

  _dataRange() {
    if (!this.times.length) return [0, 1];
    return [this.times[0], this.times[this.times.length - 1]];
  }

  /** Toggle one option within one category on/off; recomputes and returns self. */
  toggle(field, option) {
    const s = this.filter[field];
    if (!s) return this;
    if (s.has(option)) s.delete(option); else s.add(option);
    this._recompute();
    return this;
  }

  isOn(field, option) {
    return this.filter[field]?.has(option) ?? false;
  }

  get _filteredSamples() {
    return this.samples.filter((s) =>
      this.categoryFields.every((f) => this.filter[f].has(s[f])));
  }

  /** Bin the currently-filtered samples and compute the quantile-shift bar. */
  _recompute() {
    const { ageBinSize, distanceBinSize, distanceMax } = this.options;
    const filtered = this._filteredSamples;

    const [lo, hi] = this.range;
    const nAgeBins = Math.max(1, Math.ceil((hi - lo) / ageBinSize));
    const nDistBins = Math.max(1, Math.ceil(distanceMax / distanceBinSize));
    const grid = new Uint32Array(nAgeBins * nDistBins);
    let maxCount = 0;

    // Real distances at each reconstruction time, for the quantile-shift bar.
    const byTime = new Map();
    for (const row of filtered) {
      const ageBin = Math.min(nAgeBins - 1, Math.max(0, Math.floor((row.age - lo) / ageBinSize)));
      const distBin = Math.min(nDistBins - 1, Math.max(0, Math.floor(row.distance / distanceBinSize)));
      const gi = ageBin * nDistBins + distBin;
      grid[gi]++;
      if (grid[gi] > maxCount) maxCount = grid[gi];

      let arr = byTime.get(row.time);
      if (!arr) { arr = []; byTime.set(row.time, arr); }
      arr.push(row.distance);
    }

    const shift = this.times.map((t) => {
      const arr = byTime.get(t);
      const base = this.baseline.get(t);
      if (!arr || !arr.length || !base) return null;
      arr.sort((a, b) => a - b);
      let sum = 0;
      for (let i = 0; i < DECILES.length; i++) {
        sum += base[i] - quantile(arr, DECILES[i] / 100);
      }
      return sum / DECILES.length;
    });

    this._grid = { nAgeBins, nDistBins, grid, maxCount };
    this._shift = shift;
  }

  setTime(time) { this.currentTime = time; return this; }
  setGhost(time) { this.ghostTime = time; return this; }

  heightFor() {
    const o = this.options;
    return o.padTop + o.barHeight + o.gapHeight + o.gridHeight;
  }

  timeAt(x) {
    const L = this._layout;
    if (!L) return null;
    const f = (x - L.x0) / (L.x1 - L.x0);
    const [lo, hi] = this.range;
    return hi - f * (hi - lo);           // oldest-left, present-right -- matches timeseries.js
  }

  xFor(time) {
    const L = this._layout;
    if (!L) return null;
    const [lo, hi] = this.range;
    if (hi === lo) return L.x0;
    return L.x0 + ((hi - time) / (hi - lo)) * (L.x1 - L.x0);
  }

  layout({ width, height, inset = 0 }) {
    const o = this.options;
    const x0 = inset;
    const x1 = width - inset;
    const barTop = o.padTop;
    const barBottom = barTop + o.barHeight;
    const gridTop = barBottom + o.gapHeight;
    const gridBottom = gridTop + o.gridHeight;
    this._layout = { width, height, x0, x1, barTop, barBottom, gridTop, gridBottom };
    return this;
  }

  draw(ctx) {
    const L = this._layout;
    if (!L) return;
    const o = this.options;
    const { nAgeBins, nDistBins, grid, maxCount } = this._grid;
    const [lo, hi] = this.range;

    ctx.save();

    // -- quantile-shift bar ---------------------------------------------------
    const barW = (L.x1 - L.x0) / this.times.length;
    for (let i = 0; i < this.times.length; i++) {
      const v = this._shift[i];
      const x = this.xFor(this.times[i]) - barW / 2;
      const mid = (L.barTop + L.barBottom) / 2;
      if (v == null) {
        ctx.fillStyle = o.neutralColour;
        ctx.fillRect(x, mid - 1, barW * 0.82, 2);
        continue;
      }
      const frac = Math.max(-1, Math.min(1, v / o.shiftRange));
      const h = Math.abs(frac) * (o.barHeight / 2 - 2);
      ctx.fillStyle = frac >= 0 ? o.positiveColour : o.negativeColour;
      ctx.fillRect(x, frac >= 0 ? mid - h : mid, barW * 0.82, h);
    }
    ctx.strokeStyle = o.neutralColour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.x0, (L.barTop + L.barBottom) / 2 + 0.5);
    ctx.lineTo(L.x1, (L.barTop + L.barBottom) / 2 + 0.5);
    ctx.stroke();

    // -- heatmap grid -----------------------------------------------------------
    const cellW = (L.x1 - L.x0) / nAgeBins;
    const cellH = (L.gridBottom - L.gridTop) / nDistBins;
    for (let a = 0; a < nAgeBins; a++) {
      for (let d = 0; d < nDistBins; d++) {
        const count = grid[a * nDistBins + d];
        if (!count) continue;
        const t = maxCount ? Math.min(1, count / maxCount) : 0;
        ctx.fillStyle = lerpColour(o.cellLow, o.cellHigh, Math.sqrt(t));
        // Age bin 0 is nearest-present; drawn at the right, matching the time axis.
        const x = L.x1 - (a + 1) * cellW;
        const y = L.gridBottom - (d + 1) * cellH;
        ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    // -- marker at the current reconstruction time -------------------------------
    if (this.currentTime != null) {
      const mx = Math.round(this.xFor(this.currentTime) - o.markerWidth / 2);
      ctx.fillStyle = o.marker;
      ctx.fillRect(mx, L.barTop, Math.max(1, o.markerWidth), L.gridBottom - L.barTop);
    }

    if (o.labels) {
      ctx.font = o.labelFont;
      ctx.fillStyle = o.labelColour;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('closer than random ↑ / farther ↓', L.x0 + 1, L.barTop + 9);
    }

    ctx.restore();
  }
}
