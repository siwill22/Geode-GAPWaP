/*
 * DOM wiring for a DistanceHeatmap: canvas, resizing, category toggle buttons and
 * pointer handling -- the same split timeseries-panel.js uses for a line chart.
 */

import { DistanceHeatmap } from './distance-heatmap.js';

const DEFAULTS = {
  thumbWidth: 14,
  seekStep: 1,
};

/**
 * @param element    container to fill with the canvas and toggle buttons
 * @param samplesUrl JSON array of { time, distance, ...category fields }
 * @param baselineUrl JSON array of { time, d10..d90 }
 * @param categories { field: { label, options: [string] } }
 * @param range      [minTime, maxTime] in Ma
 * @param onSeek     (time) => void, called when the reader clicks or drags the chart
 * @param onRender   called when the panel needs repainting
 */
export async function attachDistanceHeatmap({
  element, samplesUrl, baselineUrl, categories, range, note,
  onSeek = null, onRender = null, ...rest
}) {
  const opts = { ...DEFAULTS, ...rest };

  const [samples, baseline] = await Promise.all([
    fetch(samplesUrl).then((r) => { if (!r.ok) throw new Error(`${samplesUrl}: ${r.status}`); return r.json(); }),
    fetch(baselineUrl).then((r) => { if (!r.ok) throw new Error(`${baselineUrl}: ${r.status}`); return r.json(); }),
  ]);

  const chart = new DistanceHeatmap(samples, baseline, categories, { ...rest, range });

  /* ---- DOM ------------------------------------------------------------------ */

  const canvas = document.createElement('canvas');
  canvas.className = 'ts-canvas dtm-heatmap-canvas';
  element.appendChild(canvas);

  const controls = document.createElement('div');
  controls.className = 'dtm-heatmap-toggles';
  const buttons = [];
  for (const [field, cat] of Object.entries(categories)) {
    const row = document.createElement('div');
    row.className = 'dtm-heatmap-toggle-row';
    const label = document.createElement('span');
    label.className = 'dtm-heatmap-toggle-label';
    label.textContent = cat.label;
    row.appendChild(label);
    for (const option of cat.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = option;
      b.className = 'dtm-heatmap-toggle';
      b.classList.toggle('is-on', chart.isOn(field, option));
      b.addEventListener('click', () => {
        chart.toggle(field, option);
        b.classList.toggle('is-on', chart.isOn(field, option));
        request();
      });
      row.appendChild(b);
      buttons.push(b);
    }
    controls.appendChild(row);
  }
  element.appendChild(controls);

  if (note) {
    element.appendChild(Object.assign(document.createElement('p'), {
      className: 'dtm-chart-note', textContent: note,
    }));
  }

  const ctx = canvas.getContext('2d');
  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;

  function request() {
    if (onRender) onRender(); else draw();
  }

  function resize() {
    const width = element.clientWidth;
    const height = chart.heightFor();
    if (!width) return false;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = width;
    cssHeight = height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    chart.layout({ width, height, inset: opts.thumbWidth / 2 });
    return true;
  }

  function draw() {
    if (!cssWidth) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    chart.draw(ctx);
  }

  /* ---- pointer -------------------------------------------------------------- */

  let dragging = false;

  const timeAtEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = chart.timeAt(e.clientX - rect.left);
    if (t == null) return null;
    const [lo, hi] = range;
    const snapped = Math.round(t / opts.seekStep) * opts.seekStep;
    return Math.max(lo, Math.min(hi, snapped));
  };

  function onMove(e) {
    const t = timeAtEvent(e);
    if (t == null) return;
    chart.setGhost(t);
    if (dragging && onSeek) onSeek(t);
    request();
  }

  function onDown(e) {
    if (!onSeek) return;
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    const t = timeAtEvent(e);
    if (t != null) onSeek(t);
    request();
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  }

  function onLeave() {
    chart.setGhost(null);
    request();
  }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', onLeave);

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (resize()) request(); })
    : null;
  observer?.observe(element);
  if (!observer) window.addEventListener('resize', () => { if (resize()) request(); });

  resize();

  return {
    chart,
    element,
    canvas,
    setTime(time) { chart.setTime(time); return this; },
    resize,
    draw,
    destroy() {
      observer?.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onLeave);
      element.removeChild(canvas);
      element.removeChild(controls);
    },
  };
}
