import GUI, { type Controller } from 'lil-gui';
import type { Rect } from '../core/layout';
import type { LandColorMode } from '../core/coastlines';

export type { LandColorMode };

export interface ReconstructionGroupViewState {
  /** Current reconstruction_models[].id, e.g. "muller2019". */
  reconstruction: string;
  age: number;
  showBoundaries: boolean;
  showPaleomagPoles: boolean;
  landColorMode: LandColorMode;
}

export interface ReconstructionGroupUICallbacks {
  onReconstruction(id: string): void;
  onAge(age: number): void;
  onShowBoundaries(show: boolean): void;
  onShowPaleomagPoles(show: boolean): void;
  onLandColorMode(mode: LandColorMode): void;
}

/**
 * The `reconstruction-group-globe` panel: one dropdown over
 * `reconstruction_models[]` (see docs/adr/0020 -- ONE axis, never a 2-D
 * grid, unlike `model-group-globe`), a Reconstruction Age slider, and,
 * only when the currently-selected Reconstruction Model actually has
 * Boundary Frames (docs/adr/0019), a visibility toggle. No Variable, no
 * legend, no clip range, no query-point -- see
 * reconstruction/reconstructionUi.ts's identical reasoning; this is that
 * wrapper's multi-reconstruction sibling.
 */
export class ReconstructionGroupUI {
  readonly gui: GUI;
  private reconstructionCtrl: Controller;
  private boundariesCtrl: Controller | null = null;
  private polesCtrl: Controller | null = null;
  private status: HTMLDivElement;
  private credit: HTMLDivElement;
  /** See reconstruction/reconstructionUi.ts's identical fields -- native
   *  range input, not lil-gui, moved to the bottom of the screen. */
  private ageSlider: HTMLInputElement;
  private ageReadout: HTMLSpanElement;
  private ageSliderWrap: HTMLDivElement;
  private ageGroup: HTMLDivElement;
  private bottomBar: HTMLDivElement;
  /** Positioned per-instance by setRect(); anchors the panel's top-right
   *  corner -- see globe/globeUi.ts's identical panelAnchor. */
  private panelAnchor: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(
    private state: ReconstructionGroupViewState,
    private cb: ReconstructionGroupUICallbacks,
    title: string,
    onRemove?: () => void,
  ) {
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });

    this.reconstructionCtrl = this.gui.add(this.state, 'reconstruction', {})
      .name('Reconstruction')
      .onChange((id: string) => cb.onReconstruction(id));

    // Always present -- see reconstruction/reconstructionUi.ts's identical
    // control for why this doesn't gate on pole-set availability.
    this.gui.add(this.state, 'landColorMode', {
      Theme: 'theme', 'By plate': 'plate', 'By VGP count': 'count',
    })
      .name('Land Colour')
      .onChange((v: LandColorMode) => cb.onLandColorMode(v));

    // top: 48, not 12 -- clears the page-level #globe-menu-toggle icon
    // fixed at the screen's actual top-left corner (core/multiGlobeMenu.css),
    // which for the top-left tile is the same screen position this would
    // otherwise sit at.
    this.status = document.createElement('div');
    this.status.className = 'status';
    Object.assign(this.status.style, { top: '48px', left: '12px' });
    document.body.appendChild(this.status);
    this.setStatus('');

    this.credit = document.createElement('div');
    this.credit.className = 'credit';

    this.ageSlider = document.createElement('input');
    this.ageSlider.type = 'range';
    this.ageSlider.className = 'age-slider';
    this.ageSlider.min = '0';
    this.ageSlider.max = '1';
    this.ageSlider.step = '1';
    this.ageSlider.addEventListener('input', () => {
      const age = Number(this.ageSlider.value);
      this.state.age = age;
      this.setAge(age);
      cb.onAge(age);
    });
    this.ageReadout = document.createElement('span');
    this.ageReadout.className = 'age-readout';
    this.ageSliderWrap = document.createElement('div');
    this.ageSliderWrap.className = 'age-slider-wrap';
    this.ageSliderWrap.append(this.ageSlider, this.ageReadout);

    this.ageGroup = document.createElement('div');
    this.ageGroup.className = 'age-group';
    this.ageGroup.append(this.ageSliderWrap);

    // credit lives in this SAME grid row now -- see
    // reconstruction/reconstructionUi.ts's identical comment for why.
    this.bottomBar = document.createElement('div');
    this.bottomBar.className = 'bottom-bar';
    this.bottomBar.append(this.ageGroup, this.credit);
    document.body.appendChild(this.bottomBar);

    if (onRemove) {
      this.gui.add({ remove: onRemove }, 'remove').name('remove this globe');
    }

    this.applyRect();
  }

  /** Move this instance's panel/status/age slider/credit onto a new tile --
   *  see core/multiInstanceHost.ts, docs/adr/0022. */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    const rightEdge = innerWidth - (x + width);
    const bottomEdge = innerHeight - (y + height);
    this.panelAnchor.style.top = `${y + 8}px`;
    this.panelAnchor.style.right = `${rightEdge + 8}px`;
    this.status.style.top = `${y + 48}px`;
    this.status.style.left = `${x + 12}px`;

    this.bottomBar.style.left = `${x + 12}px`;
    this.bottomBar.style.width = `${width - 24}px`;
    this.bottomBar.style.bottom = `${bottomEdge + 8}px`;
    const sliderWidth = Math.max(200, Math.min(700, width * 0.4));
    this.ageSliderWrap.style.width = `${sliderWidth}px`;
  }

  setReconstructionOptions(entries: Array<{ id: string; name: string }>): void {
    this.reconstructionCtrl.options(Object.fromEntries(entries.map((e) => [e.name, e.id])));
  }

  setAgeRange(min: number, max: number, step = 1): void {
    this.ageSlider.min = String(min);
    this.ageSlider.max = String(max);
    this.ageSlider.step = String(step);
  }

  setAge(age: number): void {
    this.ageSlider.value = String(age);
    this.ageReadout.textContent = `${age.toFixed(0)} Ma`;
  }

  setBoundariesAvailable(available: boolean): void {
    if (available && !this.boundariesCtrl) {
      this.boundariesCtrl = this.gui.add(this.state, 'showBoundaries')
        .name('Show boundaries')
        .onChange((v: boolean) => this.cb.onShowBoundaries(v));
    } else if (!available && this.boundariesCtrl) {
      this.boundariesCtrl.destroy();
      this.boundariesCtrl = null;
    }
  }

  /** Same added/removed reasoning as setBoundariesAvailable() -- whether
   *  this control exists depends on whether the CURRENTLY SELECTED
   *  Reconstruction Model has an exported paleomagnetic pole set
   *  (ADR-0029/docs/plans/paleomagnetic-poles.md), so it is re-evaluated on
   *  every setReconstruction() switch, not just once at boot. */
  setPaleomagPolesAvailable(available: boolean): void {
    if (available && !this.polesCtrl) {
      this.polesCtrl = this.gui.add(this.state, 'showPaleomagPoles')
        .name('Paleomagnetic poles')
        .onChange((v: boolean) => this.cb.onShowPaleomagPoles(v));
    } else if (!available && this.polesCtrl) {
      this.polesCtrl.destroy();
      this.polesCtrl = null;
    }
  }

  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.setAge(this.state.age);
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
  }

  setCredit(text: string): void {
    this.credit.textContent = text;
  }

  dispose(): void {
    this.gui.destroy();
    this.panelAnchor.remove();
    this.status.remove();
    this.bottomBar.remove(); // takes ageGroup/credit with it -- both live inside it now
  }
}
