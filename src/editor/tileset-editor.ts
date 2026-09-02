import { events } from '../ui/events';
import {
  TilesetRenderer,
  TILESET_WIDTH, TILESET_HEIGHT, TILESET_COLS, TILESET_ROWS, METATILE_COUNT,
} from '../core/tileset';
import type { AppState } from '../index';

export class TilesetEditor {
  private state: AppState;
  private imageData: ImageData | null = null;
  private hoverX = -1;
  private hoverY = -1;

  constructor(state: AppState) {
    this.state = state;
  }

  get tileset(): TilesetRenderer | null {
    if (!this.state.scene) return null;
    return this.state.activeLayer === 2
      ? this.state.scene.effectTileset
      : this.state.scene.mainTileset;
  }

  refresh(): void {
    if (!this.state.scene) return;
    const { vram, palette } = this.state.scene;
    const ts = this.tileset;
    if (!ts) return;
    this.imageData = ts.renderToImageData(vram, palette);
    this.refreshPicker();
  }

  getImageData(): ImageData | null {
    return this.imageData;
  }

  refreshPicker(): void {
    const pickerCanvas = document.getElementById('tileset-picker-canvas') as HTMLCanvasElement;
    if (pickerCanvas && this.imageData) {
      this.renderPickerPanel(pickerCanvas);
    }
  }

  private renderPickerPanel(canvas: HTMLCanvasElement): void {
    if (!this.imageData) return;

    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    const parentWidth = parent ? parent.clientWidth - 12 : 188;
    const scale = parentWidth / TILESET_WIDTH;

    const cssWidth = Math.floor(TILESET_WIDTH * scale);
    const cssHeight = Math.floor(TILESET_HEIGHT * scale);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const tmp = document.createElement('canvas');
    tmp.width = TILESET_WIDTH;
    tmp.height = TILESET_HEIGHT;
    tmp.getContext('2d')!.putImageData(this.imageData, 0, 0);

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(tmp, 0, 0, cssWidth, cssHeight);

    const tileSize = cssWidth / TILESET_COLS;

    if (this.state.gridEnabled) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      for (let c = 1; c < TILESET_COLS; c++) {
        ctx.beginPath();
        ctx.moveTo(c * tileSize, 0);
        ctx.lineTo(c * tileSize, cssHeight);
        ctx.stroke();
      }
      for (let r = 1; r < TILESET_ROWS; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * tileSize);
        ctx.lineTo(cssWidth, r * tileSize);
        ctx.stroke();
      }
    }

    const { selectedMetatile, selectedQuad } = this.state;
    const selCol = selectedMetatile % TILESET_COLS;
    const selRow = Math.floor(selectedMetatile / TILESET_COLS);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(selCol * tileSize + 1, selRow * tileSize + 1, tileSize - 2, tileSize - 2);

    const halfTile = tileSize / 2;
    const quadOffX = (selectedQuad & 1) * halfTile;
    const quadOffY = ((selectedQuad >> 1) & 1) * halfTile;
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      selCol * tileSize + quadOffX + 1,
      selRow * tileSize + quadOffY + 1,
      halfTile - 2,
      halfTile - 2,
    );

    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const col = Math.floor(x / tileSize);
      const row = Math.floor(y / tileSize);
      const idx = row * TILESET_COLS + col;
      if (idx >= 0 && idx < METATILE_COUNT) {
        const localX = (x % tileSize) / halfTile;
        const localY = (y % tileSize) / halfTile;
        const qx = localX >= 1 ? 1 : 0;
        const qy = localY >= 1 ? 1 : 0;
        const quadIndex = (qy << 1) | qx;
        this.state.selectedMetatile = idx;
        this.state.selectedQuad = quadIndex;
        events.emit('tileset:selected', { metatileIndex: idx, quadIndex });
        events.emit('status:info', `Picked metatile ${idx} quad ${quadIndex}`);
      }
    };
  }

  onHover(x: number, y: number): void {
    this.hoverX = x;
    this.hoverY = y;

    const tileX = Math.floor(x / 16);
    const tileY = Math.floor(y / 16);
    if (tileX >= 0 && tileX < 8 && tileY >= 0 && tileY < 32) {
      const idx = tileY * 8 + tileX;
      events.emit('status:coords', `Metatile ${idx} (${tileX}, ${tileY}) | Sub: ${Math.floor((x % 16) / 8)},${Math.floor((y % 16) / 8)}`);
    }
  }

  onClick(x: number, y: number, button: number): void {
    if (!this.tileset) return;
    if (x < 0 || y < 0 || x >= TILESET_WIDTH || y >= TILESET_HEIGHT) return;

    const { metatileIndex, quadIndex } = this.tileset.pixelToSelection(x, y);

    if (button === 0) {
      this.state.selectedMetatile = metatileIndex;
      this.state.selectedQuad = quadIndex;
      events.emit('tileset:selected', { metatileIndex, quadIndex });
    } else if (button === 2) {
      this.state.selectedMetatile = metatileIndex;
      this.state.selectedQuad = quadIndex;
      events.emit('tileset:selected', { metatileIndex, quadIndex });
    }
  }

  drawOverlay(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (this.state.gridEnabled) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / zoom;
      for (let c = 1; c < TILESET_COLS; c++) {
        ctx.beginPath();
        ctx.moveTo(c * 16, 0);
        ctx.lineTo(c * 16, TILESET_HEIGHT);
        ctx.stroke();
      }
      for (let r = 1; r < TILESET_ROWS; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * 16);
        ctx.lineTo(TILESET_WIDTH, r * 16);
        ctx.stroke();
      }
    }

    const { selectedMetatile, selectedQuad } = this.state;
    const col = selectedMetatile % TILESET_COLS;
    const row = Math.floor(selectedMetatile / TILESET_COLS);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2 / zoom;
    ctx.strokeRect(col * 16, row * 16, 16, 16);

    const subX = (selectedQuad & 1) * 8;
    const subY = ((selectedQuad >> 1) & 1) * 8;
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(col * 16 + subX, row * 16 + subY, 8, 8);

    if (this.hoverX >= 0 && this.hoverX < TILESET_WIDTH &&
        this.hoverY >= 0 && this.hoverY < TILESET_HEIGHT) {
      const hCol = Math.floor(this.hoverX / 16);
      const hRow = Math.floor(this.hoverY / 16);
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(hCol * 16, hRow * 16, 16, 16);
    }
  }

  /** Sync GFX tile and palette selection from the currently selected tileset entry. */
  syncGfxAndPalette(): void {
    if (!this.tileset) return;
    const entryIndex = (this.state.selectedMetatile << 2) + this.state.selectedQuad;
    const entry = this.tileset.getEntry(entryIndex);
    this.state.selectedGfxTile = entry.tileIndex;
    this.state.selectedPalette = entry.paletteIndex;
  }

  updatePropertyPanel(): void {
    if (!this.tileset) return;
    const entryIndex = (this.state.selectedMetatile << 2) + this.state.selectedQuad;
    const entry = this.tileset.getEntry(entryIndex);

    (document.getElementById('prop-hflip') as HTMLInputElement).checked = entry.hFlip;
    (document.getElementById('prop-vflip') as HTMLInputElement).checked = entry.vFlip;
    (document.getElementById('prop-priority') as HTMLInputElement).checked = entry.priority;
    (document.getElementById('prop-block') as HTMLInputElement).checked = entry.block;
    (document.getElementById('prop-tile-index') as HTMLSpanElement).textContent =
      `$${entry.tileIndex.toString(16).toUpperCase().padStart(3, '0')}`;
    (document.getElementById('prop-palette-index') as HTMLSpanElement).textContent =
      String(entry.paletteIndex);
  }

  setEntryFlags(hFlip: boolean, vFlip: boolean, priority: boolean, block: boolean): { entryIndex: number; oldWord: number; newWord: number } | null {
    if (!this.tileset) return null;
    const entryIndex = (this.state.selectedMetatile << 2) + this.state.selectedQuad;
    const oldWord = this.tileset.getEntryWord(entryIndex);
    const entry = this.tileset.getEntry(entryIndex);
    entry.hFlip = hFlip;
    entry.vFlip = vFlip;
    entry.priority = priority;
    entry.block = block;
    this.tileset.setEntry(entryIndex, entry);
    const newWord = this.tileset.getEntryWord(entryIndex);
    if (oldWord === newWord) return null;
    return { entryIndex, oldWord, newWord };
  }

  assignTile(tileIndex: number): { entryIndex: number; oldWord: number; newWord: number } | null {
    if (!this.tileset) return null;
    const entryIndex = (this.state.selectedMetatile << 2) + this.state.selectedQuad;
    const oldWord = this.tileset.getEntryWord(entryIndex);
    const entry = this.tileset.getEntry(entryIndex);
    entry.tileIndex = tileIndex;
    entry.paletteIndex = this.state.selectedPalette;
    this.tileset.setEntry(entryIndex, entry);
    const newWord = this.tileset.getEntryWord(entryIndex);
    if (oldWord === newWord) return null;
    return { entryIndex, oldWord, newWord };
  }

  exportTileset(): void {
    if (!this.tileset) return;
    const blob = new Blob([this.tileset.data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tileset.set';
    a.click();
    URL.revokeObjectURL(url);
    events.emit('status:info', 'Tileset exported');
  }
}
