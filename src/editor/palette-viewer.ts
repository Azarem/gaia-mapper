import { events } from '../ui/events';
import { PaletteState } from '../core/palette';
import type { AppState } from '../index';

const PAL_ROWS = 8;
const PAL_COLS = 16;
const SWATCH_SIZE = 12;

export class PaletteViewer {
  private canvas: HTMLCanvasElement;
  private state: AppState;
  private hoverRow = -1;

  constructor(canvas: HTMLCanvasElement, state: AppState) {
    this.canvas = canvas;
    this.state = state;

    canvas.addEventListener('click', (e) => this.handleClick(e));
    canvas.addEventListener('mousemove', (e) => this.handleHover(e));
    canvas.addEventListener('mouseleave', () => { this.hoverRow = -1; this.refresh(); });
  }

  refresh(): void {
    if (!this.state.scene) return;
    const { palette } = this.state.scene;
    const rgba = palette.expandToRGBA();

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = PAL_COLS * SWATCH_SIZE;
    const cssHeight = PAL_ROWS * SWATCH_SIZE;

    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    for (let row = 0; row < PAL_ROWS; row++) {
      for (let col = 0; col < PAL_COLS; col++) {
        const idx = (row * PAL_COLS + col) << 2;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];

        const x = col * SWATCH_SIZE;
        const y = row * SWATCH_SIZE;

        if (col === 0) {
          ctx.fillStyle = '#222';
          ctx.fillRect(x, y, SWATCH_SIZE, SWATCH_SIZE);
          ctx.strokeStyle = '#555';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y + SWATCH_SIZE);
          ctx.lineTo(x + SWATCH_SIZE, y);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, SWATCH_SIZE, SWATCH_SIZE);
        }
      }
    }

    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      0,
      this.state.selectedPalette * SWATCH_SIZE,
      cssWidth,
      SWATCH_SIZE,
    );

    if (this.hoverRow >= 0 && this.hoverRow !== this.state.selectedPalette) {
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        0,
        this.hoverRow * SWATCH_SIZE,
        cssWidth,
        SWATCH_SIZE,
      );
    }
  }

  private handleHover(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const row = Math.floor(y / SWATCH_SIZE);
    this.hoverRow = (row >= 0 && row < PAL_ROWS) ? row : -1;
    this.refresh();
  }

  private handleClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const row = Math.floor(y / SWATCH_SIZE);

    if (row >= 0 && row < PAL_ROWS) {
      this.state.selectedPalette = row;
      events.emit('palette:selected', { paletteIndex: row });
      this.refresh();
    }
  }
}
