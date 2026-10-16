import { events } from '../ui/events';
import { renderTilemapToImageData, serializeTilemap } from '../core/tilemap';
import { TILESET_WIDTH, TILESET_HEIGHT } from '../core/tileset';
import type { TilemapManager } from '../core/tilemap';
import type { AppState } from '../index';

export interface TileChange {
  blockX: number;
  blockY: number;
  cellX: number;
  cellY: number;
  oldValue: number;
  newValue: number;
}

export interface PatternData {
  width: number;
  height: number;
  tiles: number[];
  sourceX: number;
  sourceY: number;
}

export class TilemapEditor {
  private state: AppState;
  private imageData: ImageData | null = null;
  private tilesetBitmapRaw: Uint8Array | null = null;
  private tilesetCanvas: HTMLCanvasElement | null = null;
  private hoverTileX = -1;
  private hoverTileY = -1;
  private pendingStamps = new Map<number, TileChange>();

  // Pattern state
  private _patternMode = false;
  private _pattern: PatternData | null = null;
  private isSelectingPattern = false;
  private selStartTileX = -1;
  private selStartTileY = -1;
  private selEndTileX = -1;
  private selEndTileY = -1;
  private _isStamping = false;
  private stampAnchorX = -1;
  private stampAnchorY = -1;
  private stampExtentX = -1;
  private stampExtentY = -1;

  // Normal paint state
  private _isPainting = false;
  private paintAnchorX = -1;
  private paintAnchorY = -1;
  private paintExtentX = -1;
  private paintExtentY = -1;
  private paintDragged = false;

  constructor(state: AppState) {
    this.state = state;
  }

  get patternMode(): boolean { return this._patternMode; }
  get hasPattern(): boolean { return this._pattern !== null; }

  get tilemapManager(): TilemapManager | null {
    if (!this.state.scene) return null;
    return this.state.activeLayer === 2
      ? this.state.scene.effectTilemap
      : this.state.scene.mainTilemap;
  }

  get activeTileset() {
    if (!this.state.scene) return null;
    return this.state.activeLayer === 2
      ? this.state.scene.effectTileset
      : this.state.scene.mainTileset;
  }

  refresh(): void {
    if (!this.state.scene) return;
    const { vram, palette } = this.state.scene;
    const ts = this.activeTileset;
    const tm = this.tilemapManager;

    if (!ts || !tm?.tilemap) return;

    const tilesetImg = ts.renderToImageData(vram, palette);
    this.tilesetBitmapRaw = new Uint8Array(tilesetImg.data.buffer);

    this.tilesetCanvas = document.createElement('canvas');
    this.tilesetCanvas.width = TILESET_WIDTH;
    this.tilesetCanvas.height = TILESET_HEIGHT;
    this.tilesetCanvas.getContext('2d')!.putImageData(tilesetImg, 0, 0);

    this.imageData = renderTilemapToImageData(tm.tilemap, this.tilesetBitmapRaw);
  }

  getImageData(): ImageData | null {
    return this.imageData;
  }

  // --- Pattern mode ---

  setPatternMode(on: boolean): void {
    this._patternMode = on;
    if (!on) {
      this._pattern = null;
      this.isSelectingPattern = false;
      this._isStamping = false;
      this.selStartTileX = -1;
      this.selStartTileY = -1;
      this.selEndTileX = -1;
      this.selEndTileY = -1;
      this.stampExtentX = -1;
      this.stampExtentY = -1;
    }
  }

  clearPattern(): void {
    this._pattern = null;
    this.isSelectingPattern = false;
    this._isStamping = false;
  }

  beginPatternSelection(px: number, py: number): void {
    if (!this.tilemapManager?.tilemap) return;
    const tileX = Math.floor(px / 16);
    const tileY = Math.floor(py / 16);
    this._patternMode = true;
    this._pattern = null;
    this.isSelectingPattern = true;
    this._isStamping = false;
    this.selStartTileX = tileX;
    this.selStartTileY = tileY;
    this.selEndTileX = tileX;
    this.selEndTileY = tileY;
  }

  updatePatternSelection(px: number, py: number): void {
    if (!this.isSelectingPattern) return;
    this.selEndTileX = Math.floor(px / 16);
    this.selEndTileY = Math.floor(py / 16);
  }

  finalizePatternSelection(): void {
    if (!this.isSelectingPattern || !this.tilemapManager?.tilemap) {
      this.isSelectingPattern = false;
      return;
    }

    const tm = this.tilemapManager.tilemap;
    const totalTilesW = tm.width << 4;
    const totalTilesH = tm.height << 4;

    const x1 = Math.max(0, Math.min(this.selStartTileX, this.selEndTileX));
    const y1 = Math.max(0, Math.min(this.selStartTileY, this.selEndTileY));
    const x2 = Math.min(totalTilesW - 1, Math.max(this.selStartTileX, this.selEndTileX));
    const y2 = Math.min(totalTilesH - 1, Math.max(this.selStartTileY, this.selEndTileY));

    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;

    this.isSelectingPattern = false;

    if (w <= 1 && h <= 1) return;

    const tiles: number[] = [];
    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        const bx = tx >> 4;
        const by = ty >> 4;
        const cx = tx & 0x0F;
        const cy = ty & 0x0F;
        tiles.push(this.tilemapManager.getTileAt(bx, by, cx, cy));
      }
    }

    this._pattern = { width: w, height: h, tiles, sourceX: x1, sourceY: y1 };
    events.emit('status:info', `Pattern selected: ${w}\u00d7${h} tiles`);
  }

  // --- Hover ---

  onHover(x: number, y: number): void {
    if (!this.tilemapManager?.tilemap) {
      this.hoverTileX = -1;
      this.hoverTileY = -1;
      return;
    }
    const { blockX, blockY, cellX, cellY, tileX, tileY } = this.tilemapManager.pixelToCell(x, y);
    const tm = this.tilemapManager.tilemap;

    if (blockX >= 0 && blockX < tm.width && blockY >= 0 && blockY < tm.height &&
        cellX >= 0 && cellX < 16 && cellY >= 0 && cellY < 16) {
      this.hoverTileX = tileX;
      this.hoverTileY = tileY;
      const idx = this.tilemapManager.getTileAt(blockX, blockY, cellX, cellY);
      events.emit('status:coords',
        `Map (${tileX}, ${tileY}) Block (${blockX}, ${blockY}) Cell (${cellX}, ${cellY}) Tile: ${idx}`);
    } else {
      this.hoverTileX = -1;
      this.hoverTileY = -1;
    }
  }

  // --- Click ---

  onClick(x: number, y: number, button: number): void {
    if (!this.tilemapManager?.tilemap || !this.state.scene) return;
    const { blockX, blockY, cellX, cellY, tileX, tileY } = this.tilemapManager.pixelToCell(x, y);
    const tm = this.tilemapManager.tilemap;

    if (blockX < 0 || blockX >= tm.width || blockY < 0 || blockY >= tm.height) return;
    if (cellX < 0 || cellX >= 16 || cellY < 0 || cellY >= 16) return;

    if (button === 0) {
      if (this._patternMode && this._pattern) {
        // Pattern stamp — track region, no tile writing
        if (!this._isStamping) {
          this.stampAnchorX = tileX;
          this.stampAnchorY = tileY;
          this._isStamping = true;
        }
        this.stampExtentX = tileX;
        this.stampExtentY = tileY;
      } else if (this._patternMode && !this._pattern) {
        // Pattern selection via left-drag
        if (!this.isSelectingPattern) {
          this.isSelectingPattern = true;
          this.selStartTileX = tileX;
          this.selStartTileY = tileY;
        }
        this.selEndTileX = tileX;
        this.selEndTileY = tileY;
      } else {
        // Normal tile painting — track region, no tile writing
        if (!this._isPainting) {
          this._isPainting = true;
          this.paintAnchorX = tileX;
          this.paintAnchorY = tileY;
          this.paintDragged = false;
        }
        this.paintExtentX = tileX;
        this.paintExtentY = tileY;
        if (tileX !== this.paintAnchorX || tileY !== this.paintAnchorY) {
          this.paintDragged = true;
        }
      }
    } else if (button === 2) {
      const idx = this.tilemapManager.getTileAt(blockX, blockY, cellX, cellY);
      const subX = ((x % 16) >= 8) ? 1 : 0;
      const subY = ((y % 16) >= 8) ? 1 : 0;
      const quadIndex = (subY << 1) | subX;
      this.state.selectedMetatile = idx;
      this.state.selectedQuad = quadIndex;

      if (this._patternMode) {
        this.setPatternMode(false);
        events.emit('pattern:toggled', { enabled: false });
      }

      events.emit('tileset:selected', { metatileIndex: idx, quadIndex });
      events.emit('status:info', `Picked metatile ${idx} quad ${quadIndex}`);
    }
  }

  // --- Apply regions on release ---

  /** Apply the pattern stamp preview to the tilemap. Called on mouse release. */
  private applyStampRegion(): void {
    if (!this._pattern || !this.tilemapManager?.tilemap) return;

    const tm = this.tilemapManager.tilemap;
    const totalTilesW = tm.width << 4;
    const totalTilesH = tm.height << 4;
    const pw = this._pattern.width;
    const ph = this._pattern.height;
    const ax = this.stampAnchorX;
    const ay = this.stampAnchorY;
    const ex = this.stampExtentX;
    const ey = this.stampExtentY;

    if (ax < 0 || ay < 0 || ex < 0 || ey < 0) return;

    const x1 = Math.max(0, Math.min(ax, ex));
    const y1 = Math.max(0, Math.min(ay, ey));
    const x2 = Math.min(totalTilesW - 1, Math.max(ax + pw - 1, ex));
    const y2 = Math.min(totalTilesH - 1, Math.max(ay + ph - 1, ey));

    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        const patCol = ((tx - ax) % pw + pw) % pw;
        const patRow = ((ty - ay) % ph + ph) % ph;
        const newValue = this._pattern.tiles[patRow * pw + patCol];

        const bx = tx >> 4;
        const by = ty >> 4;
        const cx = tx & 0x0F;
        const cy = ty & 0x0F;

        const key = this.cellKey(bx, by, cx, cy);
        const existing = this.pendingStamps.get(key);
        const oldValue = existing ? existing.oldValue : this.tilemapManager.getTileAt(bx, by, cx, cy);

        this.tilemapManager.setTileAt(bx, by, cx, cy, newValue);
        this.patchTilemapPixels(bx, by, cx, cy, newValue);
        this.pendingStamps.set(key, { blockX: bx, blockY: by, cellX: cx, cellY: cy, oldValue, newValue });
      }
    }

    events.emit('tilemap:changed');
  }

  /** Apply the normal paint region to the tilemap. Called on mouse release. */
  private applyPaintRegion(): void {
    if (!this.tilemapManager?.tilemap) return;

    const tm = this.tilemapManager.tilemap;
    const totalTilesW = tm.width << 4;
    const totalTilesH = tm.height << 4;
    const newValue = this.state.selectedMetatile;

    const x1 = Math.max(0, Math.min(this.paintAnchorX, this.paintExtentX));
    const y1 = Math.max(0, Math.min(this.paintAnchorY, this.paintExtentY));
    const x2 = Math.min(totalTilesW - 1, Math.max(this.paintAnchorX, this.paintExtentX));
    const y2 = Math.min(totalTilesH - 1, Math.max(this.paintAnchorY, this.paintExtentY));

    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        const bx = tx >> 4;
        const by = ty >> 4;
        const cx = tx & 0x0F;
        const cy = ty & 0x0F;

        const key = this.cellKey(bx, by, cx, cy);
        const existing = this.pendingStamps.get(key);
        const oldValue = existing ? existing.oldValue : this.tilemapManager.getTileAt(bx, by, cx, cy);

        this.tilemapManager.setTileAt(bx, by, cx, cy, newValue);
        this.patchTilemapPixels(bx, by, cx, cy, newValue);
        this.pendingStamps.set(key, { blockX: bx, blockY: by, cellX: cx, cellY: cy, oldValue, newValue });
      }
    }

    events.emit('tilemap:changed');
  }

  /**
   * Finalize the current left-drag interaction.
   * Returns the type of interaction that ended.
   */
  finalizeLeftDrag(): 'stamp' | 'select' | 'paint' {
    if (this.isSelectingPattern) {
      this.finalizePatternSelection();
      return 'select';
    }
    if (this._isStamping) {
      this.applyStampRegion();
      this._isStamping = false;
      this.stampExtentX = -1;
      this.stampExtentY = -1;
      return 'stamp';
    }
    if (this._isPainting) {
      this.applyPaintRegion();
      this._isPainting = false;
      this.paintDragged = false;
      this.paintExtentX = -1;
      this.paintExtentY = -1;
      return 'paint';
    }
    return 'paint';
  }

  commitStampBatch(): TileChange[] | null {
    if (this.pendingStamps.size === 0) return null;
    const changes = [...this.pendingStamps.values()].filter(c => c.oldValue !== c.newValue);
    this.pendingStamps.clear();
    return changes.length > 0 ? changes : null;
  }

  applyTileChanges(changes: TileChange[], useNewValue: boolean): void {
    if (!this.tilemapManager?.tilemap) return;
    for (const c of changes) {
      const val = useNewValue ? c.newValue : c.oldValue;
      this.tilemapManager.setTileAt(c.blockX, c.blockY, c.cellX, c.cellY, val);
    }
    this.refresh();
  }

  private cellKey(blockX: number, blockY: number, cellX: number, cellY: number): number {
    return (blockY << 20) | (blockX << 12) | (cellY << 4) | cellX;
  }

  private patchTilemapPixels(
    blockX: number, blockY: number,
    cellX: number, cellY: number,
    metatileIndex: number,
  ): void {
    if (!this.imageData || !this.tilesetBitmapRaw || !this.tilemapManager?.tilemap) return;

    const tm = this.tilemapManager.tilemap;
    const mapWidth = tm.width << 8;
    const pixels = this.imageData.data;

    const srcCol = metatileIndex & 0x07;
    const srcRow = (metatileIndex >> 3) & 0x1F;
    let srcBase = ((srcRow << 4) * TILESET_WIDTH + (srcCol << 4)) << 2;

    const dstTileX = (blockX << 4) | cellX;
    const dstTileY = (blockY << 4) | cellY;
    let dstBase = ((dstTileY << 4) * mapWidth + (dstTileX << 4)) << 2;

    const tilesetStride = TILESET_WIDTH << 2;
    const mapStride = mapWidth << 2;

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16 * 4; x++) {
        pixels[dstBase + x] = this.tilesetBitmapRaw[srcBase + x];
      }
      srcBase += tilesetStride;
      dstBase += mapStride;
    }
  }

  /** Compute the current pattern stamp region. Returns null if not stamping. */
  private getStampRegion(): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!this._isStamping || !this._pattern || !this.tilemapManager?.tilemap) return null;
    if (this.stampAnchorX < 0 || this.stampExtentX < 0) return null;

    const tm = this.tilemapManager.tilemap;
    const totalTilesW = tm.width << 4;
    const totalTilesH = tm.height << 4;
    const pw = this._pattern.width;
    const ph = this._pattern.height;
    const ax = this.stampAnchorX;
    const ay = this.stampAnchorY;

    return {
      x1: Math.max(0, Math.min(ax, this.stampExtentX)),
      y1: Math.max(0, Math.min(ay, this.stampExtentY)),
      x2: Math.min(totalTilesW - 1, Math.max(ax + pw - 1, this.stampExtentX)),
      y2: Math.min(totalTilesH - 1, Math.max(ay + ph - 1, this.stampExtentY)),
    };
  }

  /** Compute the current normal paint region. Returns null if not in a paint drag. */
  private getPaintRegion(): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!this._isPainting || !this.paintDragged || !this.tilemapManager?.tilemap) return null;

    const tm = this.tilemapManager.tilemap;
    const totalTilesW = tm.width << 4;
    const totalTilesH = tm.height << 4;

    return {
      x1: Math.max(0, Math.min(this.paintAnchorX, this.paintExtentX)),
      y1: Math.max(0, Math.min(this.paintAnchorY, this.paintExtentY)),
      x2: Math.min(totalTilesW - 1, Math.max(this.paintAnchorX, this.paintExtentX)),
      y2: Math.min(totalTilesH - 1, Math.max(this.paintAnchorY, this.paintExtentY)),
    };
  }

  /** Draw a metatile from the tileset canvas onto ctx at the given tile position. */
  private drawMetatilePreview(
    ctx: CanvasRenderingContext2D,
    metatileIndex: number,
    destTileX: number, destTileY: number,
  ): void {
    if (!this.tilesetCanvas) return;
    const srcCol = metatileIndex & 0x07;
    const srcRow = (metatileIndex >> 3) & 0x1F;
    ctx.drawImage(
      this.tilesetCanvas,
      srcCol * 16, srcRow * 16, 16, 16,
      destTileX * 16, destTileY * 16, 16, 16,
    );
  }

  /** Render a tiled pattern preview for a given region. */
  private drawPatternPreview(
    ctx: CanvasRenderingContext2D,
    pattern: PatternData,
    anchorX: number, anchorY: number,
    x1: number, y1: number, x2: number, y2: number,
    alpha: number,
  ): void {
    if (!this.tilesetCanvas) return;
    const pw = pattern.width;
    const ph = pattern.height;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        const patCol = ((tx - anchorX) % pw + pw) % pw;
        const patRow = ((ty - anchorY) % ph + ph) % ph;
        const metatileIndex = pattern.tiles[patRow * pw + patCol];
        this.drawMetatilePreview(ctx, metatileIndex, tx, ty);
      }
    }
    ctx.globalAlpha = prevAlpha;
  }

  /** Render a uniform metatile preview for a rectangular region. */
  private drawUniformPreview(
    ctx: CanvasRenderingContext2D,
    metatileIndex: number,
    x1: number, y1: number, x2: number, y2: number,
    alpha: number,
  ): void {
    if (!this.tilesetCanvas) return;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        this.drawMetatilePreview(ctx, metatileIndex, tx, ty);
      }
    }
    ctx.globalAlpha = prevAlpha;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (!this.tilemapManager?.tilemap) return;
    const tm = this.tilemapManager.tilemap;
    const mapW = tm.width << 8;
    const mapH = tm.height << 8;

    if (this.state.gridEnabled) {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1 / zoom;
      for (let x = 16; x < mapW; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mapH);
        ctx.stroke();
      }
      for (let y = 16; y < mapH; y += 16) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(mapW, y);
        ctx.stroke();
      }
    }

    // Pattern source region outline
    if (this._patternMode && this._pattern && !this.isSelectingPattern) {
      const { sourceX, sourceY, width, height } = this._pattern;
      ctx.fillStyle = 'rgba(0, 212, 255, 0.1)';
      ctx.fillRect(sourceX * 16, sourceY * 16, width * 16, height * 16);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.8)';
      ctx.lineWidth = 2 / zoom;
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      ctx.strokeRect(sourceX * 16, sourceY * 16, width * 16, height * 16);
      ctx.setLineDash([]);
    }

    // Selection box during active pattern selection
    if (this.isSelectingPattern && this.selStartTileX >= 0) {
      const x1 = Math.min(this.selStartTileX, this.selEndTileX);
      const y1 = Math.min(this.selStartTileY, this.selEndTileY);
      const x2 = Math.max(this.selStartTileX, this.selEndTileX);
      const y2 = Math.max(this.selStartTileY, this.selEndTileY);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(x1 * 16, y1 * 16, (x2 - x1 + 1) * 16, (y2 - y1 + 1) * 16);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 2 / zoom;
      ctx.setLineDash([6 / zoom, 3 / zoom]);
      ctx.strokeRect(x1 * 16, y1 * 16, (x2 - x1 + 1) * 16, (y2 - y1 + 1) * 16);
      ctx.setLineDash([]);
    }

    // Pattern stamp drag preview
    const stampRegion = this.getStampRegion();
    if (stampRegion && this._pattern) {
      const { x1, y1, x2, y2 } = stampRegion;
      this.drawPatternPreview(
        ctx, this._pattern,
        this.stampAnchorX, this.stampAnchorY,
        x1, y1, x2, y2, 0.75,
      );
      ctx.strokeStyle = 'rgba(255, 165, 0, 0.9)';
      ctx.lineWidth = 2 / zoom;
      ctx.setLineDash([4 / zoom, 2 / zoom]);
      ctx.strokeRect(x1 * 16, y1 * 16, (x2 - x1 + 1) * 16, (y2 - y1 + 1) * 16);
      ctx.setLineDash([]);
    }

    // Pattern stamp hover preview (not dragging)
    if (this._patternMode && this._pattern && !this.isSelectingPattern && !this._isStamping &&
        this.hoverTileX >= 0 && this.hoverTileY >= 0 && this.tilesetCanvas) {
      const { width, height } = this._pattern;
      this.drawPatternPreview(
        ctx, this._pattern,
        this.hoverTileX, this.hoverTileY,
        this.hoverTileX, this.hoverTileY,
        this.hoverTileX + width - 1, this.hoverTileY + height - 1, 0.55,
      );
      ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
      ctx.lineWidth = 2 / zoom;
      ctx.strokeRect(this.hoverTileX * 16, this.hoverTileY * 16, width * 16, height * 16);
    }

    // Normal paint drag rectangle preview (shown only after drag threshold)
    const paintRegion = this.getPaintRegion();
    if (paintRegion && this.tilesetCanvas) {
      const { x1, y1, x2, y2 } = paintRegion;
      this.drawUniformPreview(ctx, this.state.selectedMetatile, x1, y1, x2, y2, 0.75);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.9)';
      ctx.lineWidth = 2 / zoom;
      ctx.strokeRect(x1 * 16, y1 * 16, (x2 - x1 + 1) * 16, (y2 - y1 + 1) * 16);
    }

    // Hover tile highlight (when not in an active drag)
    if (this.hoverTileX >= 0 && this.hoverTileY >= 0 &&
        !this._isStamping && !this.paintDragged &&
        (!this._patternMode || !this._pattern)) {
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
      ctx.lineWidth = 1.5 / zoom;
      ctx.strokeRect(this.hoverTileX * 16, this.hoverTileY * 16, 16, 16);
    }
  }

  exportTilemap(): void {
    if (!this.tilemapManager?.tilemap) return;
    const data = serializeTilemap(this.tilemapManager.tilemap);
    const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tilemap.map';
    a.click();
    URL.revokeObjectURL(url);
    events.emit('status:info', 'Tilemap exported');
  }
}
