import { events } from '../ui/events';
import { decodeTile8x8, renderTile8x8 } from '../core/tile-decoder';
import { VirtualVRAM } from '../core/vram';
import type { AppState } from '../index';

const GFX_COLS = 16;
const GFX_ROWS = 32;
const GFX_WIDTH = 128;
const GFX_HEIGHT = 256;

export class GfxViewer {
  private canvas: HTMLCanvasElement;
  private state: AppState;
  private hoverTile = -1;
  private cssWidth = 0;
  private cssHeight = 0;
  private tmpCanvas: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement, state: AppState) {
    this.canvas = canvas;
    this.state = state;

    canvas.addEventListener('click', (e) => this.handleClick(e));
    canvas.addEventListener('mousemove', (e) => this.handleHover(e));
    canvas.addEventListener('mouseleave', () => { this.hoverTile = -1; this.drawOverlays(); });
  }

  refresh(): void {
    if (!this.state.scene) return;
    const { vram, palette } = this.state.scene;

    const pixels = new Uint8Array(GFX_WIDTH * GFX_HEIGHT * 4);
    const rgba = palette.expandToRGBA();
    const palOffset = palette.getPaletteOffset(this.state.selectedPalette);

    let vOffset = VirtualVRAM.BG_BASE;
    const activeTileset = this.state.activeLayer === 2
      ? this.state.scene.effectTileset
      : this.state.scene.mainTileset;
    if (activeTileset?.useOffset) vOffset += VirtualVRAM.BG_PAGE_SIZE;

    for (let ty = 0; ty < GFX_ROWS; ty++) {
      for (let tx = 0; tx < GFX_COLS; tx++) {
        const indices = decodeTile8x8(vram.data, vOffset);
        vOffset += VirtualVRAM.BYTES_PER_TILE;

        renderTile8x8(
          indices, rgba, palOffset,
          pixels, tx * 8, ty * 8, GFX_WIDTH,
          false, false,
        );
      }
    }

    const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), GFX_WIDTH, GFX_HEIGHT);
    const dpr = window.devicePixelRatio || 1;

    const parent = this.canvas.parentElement;
    const parentWidth = parent ? parent.clientWidth - 12 : 188;
    const scale = parentWidth / GFX_WIDTH;

    this.cssWidth = Math.floor(GFX_WIDTH * scale);
    this.cssHeight = Math.floor(GFX_HEIGHT * scale);

    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;

    if (!this.tmpCanvas) this.tmpCanvas = document.createElement('canvas');
    this.tmpCanvas.width = GFX_WIDTH;
    this.tmpCanvas.height = GFX_HEIGHT;
    this.tmpCanvas.getContext('2d')!.putImageData(imageData, 0, 0);

    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.drawImage(this.tmpCanvas, 0, 0, this.cssWidth, this.cssHeight);

    this.drawOverlays();
  }

  private drawOverlays(): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    if (this.cssWidth === 0) return;
    const tileSize = this.cssWidth / GFX_COLS;

    if (this.state.gridEnabled) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      for (let c = 1; c < GFX_COLS; c++) {
        ctx.beginPath();
        ctx.moveTo(c * tileSize, 0);
        ctx.lineTo(c * tileSize, this.cssHeight);
        ctx.stroke();
      }
      for (let r = 1; r < GFX_ROWS; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * tileSize);
        ctx.lineTo(this.cssWidth, r * tileSize);
        ctx.stroke();
      }
    }

    const selX = this.state.selectedGfxTile % GFX_COLS;
    const selY = Math.floor(this.state.selectedGfxTile / GFX_COLS);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(selX * tileSize + 1, selY * tileSize + 1, tileSize - 2, tileSize - 2);

    if (this.hoverTile >= 0 && this.hoverTile !== this.state.selectedGfxTile) {
      const hx = this.hoverTile % GFX_COLS;
      const hy = Math.floor(this.hoverTile / GFX_COLS);
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(hx * tileSize + 1, hy * tileSize + 1, tileSize - 2, tileSize - 2);
    }
  }

  private handleHover(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (this.cssWidth === 0) return;
    const tileSize = this.cssWidth / GFX_COLS;
    const tileX = Math.floor(x / tileSize);
    const tileY = Math.floor(y / tileSize);

    if (tileX >= 0 && tileX < GFX_COLS && tileY >= 0 && tileY < GFX_ROWS) {
      this.hoverTile = tileY * GFX_COLS + tileX;
    } else {
      this.hoverTile = -1;
    }

    this.refresh();
  }

  private handleClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.cssWidth === 0) return;
    const tileSize = this.cssWidth / GFX_COLS;
    const tileX = Math.floor(x / tileSize);
    const tileY = Math.floor(y / tileSize);

    if (tileX < 0 || tileX >= GFX_COLS || tileY < 0 || tileY >= GFX_ROWS) return;

    const tileIndex = (tileY * GFX_COLS + tileX) & 0x1FF;
    this.state.selectedGfxTile = tileIndex;
    events.emit('gfx:selected', { tileIndex });
    this.refresh();
  }
}
