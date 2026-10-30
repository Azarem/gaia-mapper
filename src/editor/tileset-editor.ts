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
  private pickerDragging = false;
  private pickerDragStartCol = -1;
  private pickerDragStartRow = -1;
  private pickerDragEndCol = -1;
  private pickerDragEndRow = -1;
  private _patternSource: null | 'tilemap' | { c1: number; r1: number; c2: number; r2: number } = null;

  constructor(state: AppState) {
    this.state = state;
  }

  setPatternSource(source: null | 'tilemap' | { c1: number; r1: number; c2: number; r2: number }): void {
    this._patternSource = source;
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

  /**
   * Set up mouse interaction on the tileset picker canvas.
   * - Left-click/drag: dropper behavior (continuously updates selection)
   * - Right-click: select metatile (same as left-click)
   * - Right-drag (past threshold): select metatile region as stamp pattern
   */
  initPickerInteraction(
    onPatternSelected: (tiles: number[], width: number, height: number, sourceCol: number, sourceRow: number) => void,
  ): void {
    const canvas = document.getElementById('tileset-picker-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    const DRAG_THRESHOLD_SQ = 36; // 6px squared

    const posToCell = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const ts = rect.width / TILESET_COLS;
      const col = Math.max(0, Math.min(TILESET_COLS - 1, Math.floor(x / ts)));
      const row = Math.max(0, Math.min(TILESET_ROWS - 1, Math.floor(y / ts)));
      const half = ts / 2;
      const qx = (x - col * ts) >= half ? 1 : 0;
      const qy = (y - row * ts) >= half ? 1 : 0;
      return { col, row, idx: row * TILESET_COLS + col, quad: (qy << 1) | qx };
    };

    const selectTile = (clientX: number, clientY: number) => {
      const { idx, quad } = posToCell(clientX, clientY);
      if (idx >= 0 && idx < METATILE_COUNT) {
        this.state.selectedMetatile = idx;
        this.state.selectedQuad = quad;
        events.emit('tileset:selected', { metatileIndex: idx, quadIndex: quad });
        events.emit('status:info', `Picked metatile ${idx} quad ${quad}`);
      }
    };

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        e.preventDefault();
        selectTile(e.clientX, e.clientY);

        const onMove = (me: MouseEvent) => selectTile(me.clientX, me.clientY);
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return;
      }

      if (e.button === 2) {
        e.preventDefault();
        const startScreenX = e.clientX;
        const startScreenY = e.clientY;
        const { col: startCol, row: startRow } = posToCell(e.clientX, e.clientY);
        let dragStarted = false;

        const onMove = (me: MouseEvent) => {
          if (!dragStarted) {
            const dx = me.clientX - startScreenX;
            const dy = me.clientY - startScreenY;
            if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return;
            dragStarted = true;
            this.pickerDragging = true;
            this.pickerDragStartCol = startCol;
            this.pickerDragStartRow = startRow;
          }
          const { col, row } = posToCell(me.clientX, me.clientY);
          this.pickerDragEndCol = col;
          this.pickerDragEndRow = row;
          this.refreshPicker();
        };

        const onUp = (ue: MouseEvent) => {
          if (ue.button !== 2) return;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          this.pickerDragging = false;

          if (!dragStarted) {
            selectTile(ue.clientX, ue.clientY);
            this.refreshPicker();
            return;
          }

          const c1 = Math.min(this.pickerDragStartCol, this.pickerDragEndCol);
          const r1 = Math.min(this.pickerDragStartRow, this.pickerDragEndRow);
          const c2 = Math.max(this.pickerDragStartCol, this.pickerDragEndCol);
          const r2 = Math.max(this.pickerDragStartRow, this.pickerDragEndRow);
          const w = c2 - c1 + 1;
          const h = r2 - r1 + 1;

          this.pickerDragStartCol = -1;
          this.pickerDragEndCol = -1;

          if (w <= 1 && h <= 1) {
            selectTile(ue.clientX, ue.clientY);
            this.refreshPicker();
            return;
          }

          const tiles: number[] = [];
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
              tiles.push(r * TILESET_COLS + c);
            }
          }

          onPatternSelected(tiles, w, h, c1, r1);
          this.refreshPicker();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }
    });
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

    if (this.state.blockViewEnabled) {
      const ts = this.tileset;
      if (ts) {
        const blockFlags = ts.getBlockFlags();
        const half = tileSize / 2;
        ctx.fillStyle = 'rgba(255, 40, 40, 0.25)';
        for (let m = 0; m < METATILE_COUNT; m++) {
          const mask = blockFlags[m];
          if (!mask) continue;
          const col = m % TILESET_COLS;
          const row = Math.floor(m / TILESET_COLS);
          const mx = col * tileSize;
          const my = row * tileSize;
          if (mask & 1) ctx.fillRect(mx, my, half, half);           // TL
          if (mask & 2) ctx.fillRect(mx + half, my, half, half);    // TR
          if (mask & 4) ctx.fillRect(mx, my + half, half, half);    // BL
          if (mask & 8) ctx.fillRect(mx + half, my + half, half, half); // BR
        }
      }
    }

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

    // Single-tile selection indicator (hidden when pattern stamp is active)
    if (!this._patternSource) {
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
    }

    // Stamp source region (tileset-sourced pattern)
    if (this._patternSource && typeof this._patternSource === 'object') {
      const { c1, r1, c2, r2 } = this._patternSource;
      ctx.fillStyle = 'rgba(0, 212, 255, 0.1)';
      ctx.fillRect(c1 * tileSize, r1 * tileSize, (c2 - c1 + 1) * tileSize, (r2 - r1 + 1) * tileSize);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(c1 * tileSize + 1, r1 * tileSize + 1, (c2 - c1 + 1) * tileSize - 2, (r2 - r1 + 1) * tileSize - 2);
      ctx.setLineDash([]);
    }

    // Drag selection rectangle (during active right-drag)
    if (this.pickerDragging && this.pickerDragStartCol >= 0) {
      const c1 = Math.min(this.pickerDragStartCol, this.pickerDragEndCol);
      const r1 = Math.min(this.pickerDragStartRow, this.pickerDragEndRow);
      const c2 = Math.max(this.pickerDragStartCol, this.pickerDragEndCol);
      const r2 = Math.max(this.pickerDragStartRow, this.pickerDragEndRow);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.15)';
      ctx.fillRect(c1 * tileSize, r1 * tileSize, (c2 - c1 + 1) * tileSize, (r2 - r1 + 1) * tileSize);
      ctx.strokeStyle = 'rgba(255, 165, 0, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(c1 * tileSize + 1, r1 * tileSize + 1, (c2 - c1 + 1) * tileSize - 2, (r2 - r1 + 1) * tileSize - 2);
      ctx.setLineDash([]);
    }
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

  assignPalette(paletteIndex: number): { entryIndex: number; oldWord: number; newWord: number } | null {
    if (!this.tileset) return null;
    const entryIndex = (this.state.selectedMetatile << 2) + this.state.selectedQuad;
    const oldWord = this.tileset.getEntryWord(entryIndex);
    const entry = this.tileset.getEntry(entryIndex);
    entry.paletteIndex = paletteIndex;
    this.tileset.setEntry(entryIndex, entry);
    const newWord = this.tileset.getEntryWord(entryIndex);
    if (oldWord === newWord) return null;
    return { entryIndex, oldWord, newWord };
  }
}
