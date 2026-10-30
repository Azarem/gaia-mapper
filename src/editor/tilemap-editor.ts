import { events } from '../ui/events';
import { renderTilemapToImageData, serializeTilemap } from '../core/tilemap';
import { TILESET_WIDTH, TILESET_HEIGHT } from '../core/tileset';
import {
  compositeRegion, getCompositeSize,
  type CompositeInput, type LayerPlane,
} from '../core/compositor';
import type { TilemapManager } from '../core/tilemap';
import type { TilesetRenderer } from '../core/tileset';
import type { AppState } from '../index';

/** Everything rendered for one layer: its own map image and the tileset it was drawn from. */
interface LayerRender {
  /** Raw RGBA of the layer's 128x512 tileset bitmap, used to patch single cells. */
  tilesetRaw: Uint8Array;
  /** Same bitmap as a canvas, used for stamp previews. */
  tilesetCanvas: HTMLCanvasElement;
  plane: LayerPlane;
}

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
  /** Per-layer render results, index 0 = layer 1, index 1 = layer 2. Null when the layer has no tilemap. */
  private layers: [LayerRender | null, LayerRender | null] = [null, null];
  /** Blended image of the shown layers; this is what the main canvas displays. */
  private composite: ImageData | null = null;
  /** Compositor input reused across the cells of one stamp, so it is built once. */
  private batchInput: CompositeInput | null = null;
  /** Hover position in canvas tiles (not the active layer's tiles). */
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

  /** Tilemap of any layer (not only the active one). */
  managerFor(layer: 1 | 2): TilemapManager | null {
    if (!this.state.scene) return null;
    return layer === 2 ? this.state.scene.effectTilemap : this.state.scene.mainTilemap;
  }

  private tilesetFor(layer: 1 | 2): TilesetRenderer | null {
    if (!this.state.scene) return null;
    return layer === 2 ? this.state.scene.effectTileset : this.state.scene.mainTileset;
  }

  /** The active (edited) layer's tilemap. All edits go through this. */
  get tilemapManager(): TilemapManager | null {
    return this.managerFor(this.state.activeLayer);
  }

  get activeTileset() {
    return this.tilesetFor(this.state.activeLayer);
  }

  private get activeTilesetCanvas(): HTMLCanvasElement | null {
    return this.layers[this.state.activeLayer - 1]?.tilesetCanvas ?? null;
  }

  /** Render both layers and rebuild the composite. */
  refresh(): void {
    this.renderLayer(1);
    this.renderLayer(2);
    this.rebuildComposite();
  }

  /** Re-render one layer (e.g. after its tileset changed) and rebuild the composite. */
  refreshLayer(layer: 1 | 2): void {
    this.renderLayer(layer);
    this.rebuildComposite();
  }

  /** Rebuild the composite from the existing layer renders (visibility change). */
  recomposite(): void {
    this.rebuildComposite();
  }

  private renderLayer(layer: 1 | 2): void {
    const scene = this.state.scene;
    const ts = this.tilesetFor(layer);
    const tilemap = this.managerFor(layer)?.tilemap;
    if (!scene || !ts || !tilemap) {
      this.layers[layer - 1] = null;
      return;
    }

    const tilesetImg = ts.renderToImageData(scene.vram, scene.palette);
    const tilesetRaw = new Uint8Array(tilesetImg.data.buffer);

    const tilesetCanvas = document.createElement('canvas');
    tilesetCanvas.width = TILESET_WIDTH;
    tilesetCanvas.height = TILESET_HEIGHT;
    tilesetCanvas.getContext('2d')!.putImageData(tilesetImg, 0, 0);

    this.layers[layer - 1] = {
      tilesetRaw,
      tilesetCanvas,
      plane: {
        image: renderTilemapToImageData(tilemap, tilesetRaw),
        tilemap,
        quadPriority: ts.getPriorityFlags(),
      },
    };
  }

  private compositeInput(): CompositeInput | null {
    const scene = this.state.scene;
    if (!scene) return null;
    const planes = [this.layers[0]?.plane ?? null, this.layers[1]?.plane ?? null] as const;
    const rgba = scene.palette.expandToRGBA();
    return {
      planes,
      shown: [
        planes[0] !== null && this.state.layerVisible[1],
        planes[1] !== null && this.state.layerVisible[2],
      ],
      blend: scene.blend,
      backdrop: [rgba[0], rgba[1], rgba[2]],
    };
  }

  private rebuildComposite(): void {
    const input = this.compositeInput();
    const size = input && getCompositeSize(input.planes, input.shown);
    if (!input || !size) {
      this.composite = null;
      return;
    }
    if (!this.composite
        || this.composite.width !== size.width || this.composite.height !== size.height) {
      this.composite = new ImageData(size.width, size.height);
      // Hover positions belong to the previous canvas area.
      this.hoverTileX = -1;
      this.hoverTileY = -1;
    }
    compositeRegion(this.composite, input, 0, 0, size.width, size.height);
  }

  /** Re-blend one 16x16 canvas cell after its pixels changed in a layer. */
  private compositeCell(tileX: number, tileY: number): void {
    const input = this.batchInput ?? this.compositeInput();
    if (!input || !this.composite) return;
    const x = tileX << 4;
    const y = tileY << 4;
    compositeRegion(this.composite, input, x, y, x + 16, y + 16);
  }

  // --- Canvas area and layer wrapping ---
  //
  // The main canvas shows the composite, whose area is layer 1's whenever
  // layer 1 is shown (layer 2's otherwise). Pointer positions are canvas
  // positions. A layer maps a canvas tile to its own tile modulo its size:
  // the identity for the layer that defines the canvas, wrapping for a
  // smaller layer 2 (which repeats), and a crop for a larger layer 2.

  /** Size of the visible/editable canvas area in tiles. Null when nothing is shown. */
  private get canvasTiles(): { w: number; h: number } | null {
    return this.composite ? { w: this.composite.width >> 4, h: this.composite.height >> 4 } : null;
  }

  /** The active layer's tile for a canvas tile, or null outside the canvas area. */
  private toLayerTile(canvasX: number, canvasY: number): { x: number; y: number } | null {
    const area = this.canvasTiles;
    const tm = this.tilemapManager?.tilemap;
    if (!area || !tm) return null;
    if (canvasX < 0 || canvasY < 0 || canvasX >= area.w || canvasY >= area.h) return null;
    return { x: canvasX % (tm.width << 4), y: canvasY % (tm.height << 4) };
  }

  /** Visit every canvas tile that shows the given tile of a layer. */
  private forEachCanvasTile(
    layer: 1 | 2, layerX: number, layerY: number,
    visit: (canvasX: number, canvasY: number) => void,
  ): void {
    const area = this.canvasTiles;
    const tm = this.managerFor(layer)?.tilemap;
    if (!area || !tm) return;
    const stepX = tm.width << 4;
    const stepY = tm.height << 4;
    for (let y = layerY; y < area.h; y += stepY) {
      for (let x = layerX; x < area.w; x += stepX) visit(x, y);
    }
  }

  private layerTileValue(layerX: number, layerY: number): number {
    return this.tilemapManager?.getTileAt(layerX >> 4, layerY >> 4, layerX & 15, layerY & 15) ?? 0;
  }

  /**
   * Describe how the active layer maps onto the canvas when it differs from a
   * one-to-one fit (layer 2 shown under layer 1), or null when it doesn't.
   */
  describeLayerFit(): string | null {
    const area = this.canvasTiles;
    const tm = this.tilemapManager?.tilemap;
    if (!area || !tm) return null;
    const blocksW = area.w >> 4;
    const blocksH = area.h >> 4;
    if (tm.width === blocksW && tm.height === blocksH) return null;
    const repeats = tm.width < blocksW || tm.height < blocksH;
    const cropped = tm.width > blocksW || tm.height > blocksH;
    const verb = repeats && cropped ? 'repeats and is cropped to'
      : repeats ? 'repeats across' : 'is cropped to';
    const hint = repeats ? 'edits show at every repeat' : 'hide layer 1 to edit the rest';
    return `Layer ${this.state.activeLayer} (${tm.width}\u00d7${tm.height}) ${verb} the ${blocksW}\u00d7${blocksH} layer 1 area; ${hint}`;
  }

  /** The blended image shown on the main canvas. */
  getImageData(): ImageData | null {
    return this.composite;
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

  /** Set a pattern from an external source (e.g. tileset picker drag). */
  setExternalPattern(tiles: number[], width: number, height: number): void {
    this._patternMode = true;
    this._pattern = { width, height, tiles, sourceX: -1, sourceY: -1 };
    this.isSelectingPattern = false;
    this._isStamping = false;
    this.selStartTileX = -1;
    this.selStartTileY = -1;
    this.selEndTileX = -1;
    this.selEndTileY = -1;
    this.stampExtentX = -1;
    this.stampExtentY = -1;
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

    const area = this.canvasTiles;
    if (!area) {
      this.isSelectingPattern = false;
      return;
    }

    const x1 = Math.max(0, Math.min(this.selStartTileX, this.selEndTileX));
    const y1 = Math.max(0, Math.min(this.selStartTileY, this.selEndTileY));
    const x2 = Math.min(area.w - 1, Math.max(this.selStartTileX, this.selEndTileX));
    const y2 = Math.min(area.h - 1, Math.max(this.selStartTileY, this.selEndTileY));

    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;

    this.isSelectingPattern = false;

    if (w <= 1 && h <= 1) return;

    // The selection is in canvas tiles; read each through the layer's wrapping.
    const tiles: number[] = [];
    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        const lt = this.toLayerTile(tx, ty);
        tiles.push(lt ? this.layerTileValue(lt.x, lt.y) : 0);
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
    const { tileX, tileY } = this.tilemapManager.pixelToCell(x, y);
    const lt = this.toLayerTile(tileX, tileY);

    if (lt) {
      this.hoverTileX = tileX;
      this.hoverTileY = tileY;
      const idx = this.layerTileValue(lt.x, lt.y);
      const wrapped = lt.x !== tileX || lt.y !== tileY ? ` (wrapped from ${tileX}, ${tileY})` : '';
      events.emit('status:coords',
        `Map (${lt.x}, ${lt.y})${wrapped} Block (${lt.x >> 4}, ${lt.y >> 4}) Cell (${lt.x & 15}, ${lt.y & 15}) Tile: ${idx}`);
    } else {
      this.hoverTileX = -1;
      this.hoverTileY = -1;
    }
  }

  // --- Click ---

  onClick(x: number, y: number, button: number): void {
    if (!this.tilemapManager?.tilemap || !this.state.scene) return;
    const { tileX, tileY } = this.tilemapManager.pixelToCell(x, y);
    const lt = this.toLayerTile(tileX, tileY);
    if (!lt) return;

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
      const idx = this.layerTileValue(lt.x, lt.y);
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
    const area = this.canvasTiles;
    if (!this._pattern || !this.tilemapManager?.tilemap || !area) return;

    const pw = this._pattern.width;
    const ph = this._pattern.height;
    const ax = this.stampAnchorX;
    const ay = this.stampAnchorY;
    const ex = this.stampExtentX;
    const ey = this.stampExtentY;

    if (ax < 0 || ay < 0 || ex < 0 || ey < 0) return;

    const x1 = Math.max(0, Math.min(ax, ex));
    const y1 = Math.max(0, Math.min(ay, ey));
    const x2 = Math.min(area.w - 1, Math.max(ax + pw - 1, ex));
    const y2 = Math.min(area.h - 1, Math.max(ay + ph - 1, ey));

    this.writeRegion(x1, y1, x2, y2, (tx, ty) => {
      const patCol = ((tx - ax) % pw + pw) % pw;
      const patRow = ((ty - ay) % ph + ph) % ph;
      return this._pattern!.tiles[patRow * pw + patCol];
    });
  }

  /**
   * Write `valueAt` over a rectangle of canvas tiles into the active layer.
   * Each canvas tile lands on the layer's wrapped tile. When a smaller layer 2
   * repeats under the rectangle, several canvas tiles hit one layer tile and
   * the last one wins, which is also what the previews show.
   */
  private writeRegion(
    x1: number, y1: number, x2: number, y2: number,
    valueAt: (canvasX: number, canvasY: number) => number,
  ): void {
    const manager = this.tilemapManager;
    if (!manager?.tilemap) return;
    const layer = this.state.activeLayer;

    this.batchInput = this.compositeInput();
    try {
      for (let ty = y1; ty <= y2; ty++) {
        for (let tx = x1; tx <= x2; tx++) {
          const lt = this.toLayerTile(tx, ty);
          if (!lt) continue;
          const newValue = valueAt(tx, ty);

          const bx = lt.x >> 4;
          const by = lt.y >> 4;
          const cx = lt.x & 0x0F;
          const cy = lt.y & 0x0F;

          const key = this.cellKey(bx, by, cx, cy);
          const existing = this.pendingStamps.get(key);
          const oldValue = existing ? existing.oldValue : manager.getTileAt(bx, by, cx, cy);

          manager.setTileAt(bx, by, cx, cy, newValue);
          this.patchLayerPixels(layer, bx, by, cx, cy, newValue);
          this.pendingStamps.set(key, { blockX: bx, blockY: by, cellX: cx, cellY: cy, oldValue, newValue });
        }
      }
    } finally {
      this.batchInput = null;
    }

    events.emit('tilemap:changed');
  }

  /** Apply the normal paint region to the tilemap. Called on mouse release. */
  private applyPaintRegion(): void {
    const area = this.canvasTiles;
    if (!this.tilemapManager?.tilemap || !area) return;

    const newValue = this.state.selectedMetatile;

    const x1 = Math.max(0, Math.min(this.paintAnchorX, this.paintExtentX));
    const y1 = Math.max(0, Math.min(this.paintAnchorY, this.paintExtentY));
    const x2 = Math.min(area.w - 1, Math.max(this.paintAnchorX, this.paintExtentX));
    const y2 = Math.min(area.h - 1, Math.max(this.paintAnchorY, this.paintExtentY));

    this.writeRegion(x1, y1, x2, y2, () => newValue);
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

  /**
   * Apply (or revert) recorded tile changes on a specific layer, which may
   * differ from the active layer when an undo/redo crosses a layer switch.
   */
  applyTileChanges(changes: TileChange[], useNewValue: boolean, layer: 1 | 2): void {
    const manager = this.managerFor(layer);
    if (!manager?.tilemap) return;
    this.batchInput = this.compositeInput();
    try {
      for (const c of changes) {
        const val = useNewValue ? c.newValue : c.oldValue;
        manager.setTileAt(c.blockX, c.blockY, c.cellX, c.cellY, val);
        this.patchLayerPixels(layer, c.blockX, c.blockY, c.cellX, c.cellY, val);
      }
    } finally {
      this.batchInput = null;
    }
  }

  private cellKey(blockX: number, blockY: number, cellX: number, cellY: number): number {
    return (blockY << 20) | (blockX << 12) | (cellY << 4) | cellX;
  }

  /**
   * Redraw one map cell in a layer's own image, then re-blend every canvas
   * cell that shows it. Blending depends on the pixels of both layers
   * (priority, color math), so those cells are recomputed from both rather
   * than patched.
   */
  private patchLayerPixels(
    layer: 1 | 2,
    blockX: number, blockY: number,
    cellX: number, cellY: number,
    metatileIndex: number,
  ): void {
    const render = this.layers[layer - 1];
    if (!render) return;

    const { tilesetRaw, plane } = render;
    const mapWidth = plane.tilemap.width << 8;
    const pixels = plane.image.data;

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
        pixels[dstBase + x] = tilesetRaw[srcBase + x];
      }
      srcBase += tilesetStride;
      dstBase += mapStride;
    }

    // A layer tile can appear at several canvas tiles (layer 2 repeating).
    this.forEachCanvasTile(layer, dstTileX, dstTileY, (cx, cy) => this.compositeCell(cx, cy));
  }

  /** Compute the current pattern stamp region. Returns null if not stamping. */
  private getStampRegion(): { x1: number; y1: number; x2: number; y2: number } | null {
    const area = this.canvasTiles;
    if (!this._isStamping || !this._pattern || !this.tilemapManager?.tilemap || !area) return null;
    if (this.stampAnchorX < 0 || this.stampExtentX < 0) return null;

    const pw = this._pattern.width;
    const ph = this._pattern.height;
    const ax = this.stampAnchorX;
    const ay = this.stampAnchorY;

    return {
      x1: Math.max(0, Math.min(ax, this.stampExtentX)),
      y1: Math.max(0, Math.min(ay, this.stampExtentY)),
      x2: Math.min(area.w - 1, Math.max(ax + pw - 1, this.stampExtentX)),
      y2: Math.min(area.h - 1, Math.max(ay + ph - 1, this.stampExtentY)),
    };
  }

  /** Compute the current normal paint region. Returns null if not in a paint drag. */
  private getPaintRegion(): { x1: number; y1: number; x2: number; y2: number } | null {
    const area = this.canvasTiles;
    if (!this._isPainting || !this.paintDragged || !this.tilemapManager?.tilemap || !area) return null;

    return {
      x1: Math.max(0, Math.min(this.paintAnchorX, this.paintExtentX)),
      y1: Math.max(0, Math.min(this.paintAnchorY, this.paintExtentY)),
      x2: Math.min(area.w - 1, Math.max(this.paintAnchorX, this.paintExtentX)),
      y2: Math.min(area.h - 1, Math.max(this.paintAnchorY, this.paintExtentY)),
    };
  }

  /**
   * Draw a metatile from the tileset canvas at a canvas tile, and at every
   * other canvas tile showing the same layer tile (a repeating layer 2), so the
   * preview matches what the stamp will produce. Tiles outside the canvas area
   * are skipped: they cannot be edited.
   */
  private drawMetatilePreview(
    ctx: CanvasRenderingContext2D,
    metatileIndex: number,
    destTileX: number, destTileY: number,
  ): void {
    const tileset = this.activeTilesetCanvas;
    const lt = this.toLayerTile(destTileX, destTileY);
    if (!tileset || !lt) return;
    const srcX = (metatileIndex & 0x07) * 16;
    const srcY = ((metatileIndex >> 3) & 0x1F) * 16;
    this.forEachCanvasTile(this.state.activeLayer, lt.x, lt.y, (cx, cy) => {
      ctx.drawImage(tileset, srcX, srcY, 16, 16, cx * 16, cy * 16, 16, 16);
    });
  }

  /** Render a tiled pattern preview for a given region. */
  private drawPatternPreview(
    ctx: CanvasRenderingContext2D,
    pattern: PatternData,
    anchorX: number, anchorY: number,
    x1: number, y1: number, x2: number, y2: number,
    alpha: number,
  ): void {
    if (!this.activeTilesetCanvas) return;
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
    if (!this.activeTilesetCanvas) return;
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
    const area = this.canvasTiles;
    if (!area) return;
    const mapW = area.w << 4;
    const mapH = area.h << 4;

    if (this.state.blockViewEnabled) {
      const ts = this.activeTileset;
      if (ts) {
        const blockFlags = ts.getBlockFlags();
        ctx.fillStyle = 'rgba(255, 40, 40, 0.25)';
        // Walk the canvas area so a wrapped or cropped layer 2 is shown as it appears.
        const layerTilesW = tm.width << 4;
        const layerTilesH = tm.height << 4;
        for (let ty = 0; ty < area.h; ty++) {
          const ly = ty % layerTilesH;
          for (let tx = 0; tx < area.w; tx++) {
            const lx = tx % layerTilesW;
            const offset = ((((ly >> 4) * tm.width) + (lx >> 4)) << 8) | ((ly & 15) << 4) | (lx & 15);
            const mask = blockFlags[tm.data[offset]];
            if (!mask) continue;
            const px = tx << 4;
            const py = ty << 4;
            if (mask & 1) ctx.fillRect(px, py, 8, 8);         // TL
            if (mask & 2) ctx.fillRect(px + 8, py, 8, 8);     // TR
            if (mask & 4) ctx.fillRect(px, py + 8, 8, 8);     // BL
            if (mask & 8) ctx.fillRect(px + 8, py + 8, 8, 8); // BR
          }
        }
      }
    }

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

    // Pattern source region outline (only for tilemap-sourced patterns)
    if (this._patternMode && this._pattern && !this.isSelectingPattern && this._pattern.sourceX >= 0
        && this._pattern.sourceX < area.w && this._pattern.sourceY < area.h) {
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
        this.hoverTileX >= 0 && this.hoverTileY >= 0 && this.activeTilesetCanvas) {
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
    if (paintRegion && this.activeTilesetCanvas) {
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
      ctx.lineWidth = 1.5 / zoom;
      // Other canvas tiles that show the same layer tile (a repeating layer 2), dimmer.
      const lt = this.toLayerTile(this.hoverTileX, this.hoverTileY);
      if (lt) {
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.3)';
        this.forEachCanvasTile(this.state.activeLayer, lt.x, lt.y, (cx, cy) => {
          if (cx !== this.hoverTileX || cy !== this.hoverTileY) ctx.strokeRect(cx * 16, cy * 16, 16, 16);
        });
      }
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
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
