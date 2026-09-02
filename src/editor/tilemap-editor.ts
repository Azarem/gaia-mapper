import { events } from '../ui/events';
import { renderTilemapToImageData, serializeTilemap } from '../core/tilemap';
import { TILESET_WIDTH } from '../core/tileset';
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

export class TilemapEditor {
  private state: AppState;
  private imageData: ImageData | null = null;
  private tilesetBitmapRaw: Uint8Array | null = null;
  private hoverTileX = -1;
  private hoverTileY = -1;
  private pendingStamps = new Map<number, TileChange>();

  constructor(state: AppState) {
    this.state = state;
  }

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

    this.imageData = renderTilemapToImageData(tm.tilemap, this.tilesetBitmapRaw);
  }

  getImageData(): ImageData | null {
    return this.imageData;
  }

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

  onClick(x: number, y: number, button: number): void {
    if (!this.tilemapManager?.tilemap || !this.state.scene) return;
    const { blockX, blockY, cellX, cellY } = this.tilemapManager.pixelToCell(x, y);
    const tm = this.tilemapManager.tilemap;

    if (blockX < 0 || blockX >= tm.width || blockY < 0 || blockY >= tm.height) return;
    if (cellX < 0 || cellX >= 16 || cellY < 0 || cellY >= 16) return;

    if (button === 0) {
      const key = this.cellKey(blockX, blockY, cellX, cellY);
      const existing = this.pendingStamps.get(key);
      const oldValue = existing ? existing.oldValue : this.tilemapManager.getTileAt(blockX, blockY, cellX, cellY);
      const newValue = this.state.selectedMetatile;
      this.tilemapManager.setTileAt(blockX, blockY, cellX, cellY, newValue);
      this.patchTilemapPixels(blockX, blockY, cellX, cellY, newValue);
      this.pendingStamps.set(key, { blockX, blockY, cellX, cellY, oldValue, newValue });
      events.emit('tilemap:changed');
    } else if (button === 2) {
      const idx = this.tilemapManager.getTileAt(blockX, blockY, cellX, cellY);
      const subX = ((x % 16) >= 8) ? 1 : 0;
      const subY = ((y % 16) >= 8) ? 1 : 0;
      const quadIndex = (subY << 1) | subX;
      this.state.selectedMetatile = idx;
      this.state.selectedQuad = quadIndex;
      events.emit('tileset:selected', { metatileIndex: idx, quadIndex });
      events.emit('status:info', `Picked metatile ${idx} quad ${quadIndex}`);
    }
  }

  /** Finalize the current drag and return the accumulated changes (or null if empty/no-op). */
  commitStampBatch(): TileChange[] | null {
    if (this.pendingStamps.size === 0) return null;
    const changes = [...this.pendingStamps.values()].filter(c => c.oldValue !== c.newValue);
    this.pendingStamps.clear();
    return changes.length > 0 ? changes : null;
  }

  /** Apply a set of tile changes (used by undo/redo). */
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

    if (this.hoverTileX >= 0 && this.hoverTileY >= 0) {
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
