import { TILESET_WIDTH } from './tileset';

/**
 * Tilemap format:
 *   [u8 width][u8 height][width * height * 256 bytes of tile indices]
 *
 * Width/height are in 256-pixel blocks (16x16 metatiles arranged in 16x16 grids).
 * Each byte is an index into the tileset metatile grid (8 cols x 32 rows):
 *   Lower 3 bits: column (0-7)
 *   Upper 5 bits: row (0-31)
 */

export const TILEMAP_BLOCK_SIZE = 256;
export const TILEMAP_MAX_DATA = 0x2000;

export interface TilemapState {
  width: number;
  height: number;
  data: Uint8Array;
}

export function parseTilemap(raw: Uint8Array): TilemapState {
  const width = raw[0];
  const height = raw[1];
  const data = new Uint8Array(TILEMAP_MAX_DATA);
  const toCopy = Math.min(raw.length - 2, width * height * TILEMAP_BLOCK_SIZE, TILEMAP_MAX_DATA);
  data.set(raw.subarray(2, 2 + toCopy));
  return { width, height, data };
}

export function serializeTilemap(tilemap: TilemapState): Uint8Array {
  const dataSize = (tilemap.width * tilemap.height) << 8;
  const out = new Uint8Array(2 + dataSize);
  out[0] = tilemap.width;
  out[1] = tilemap.height;
  out.set(tilemap.data.subarray(0, dataSize), 2);
  return out;
}

/**
 * Render the full tilemap by compositing metatile regions from a pre-rendered tileset bitmap.
 * Port of ControlTest.ReloadTilemap().
 *
 * @param tilemap - Parsed tilemap state
 * @param tilesetBitmap - Pre-rendered tileset RGBA buffer (128x512, stride = 128 * 4)
 * @returns Full-size tilemap ImageData
 */
export function renderTilemapToImageData(
  tilemap: TilemapState,
  tilesetBitmap: Uint8Array,
): ImageData {
  const mapWidth = tilemap.width << 8;
  const mapHeight = tilemap.height << 8;
  const pixels = new Uint8Array(mapWidth * mapHeight * 4);
  let mapOffset = 0;

  const tilesetStride = TILESET_WIDTH << 2;

  for (let py = 0; py < tilemap.height; py++) {
    for (let px = 0; px < tilemap.width; px++) {
      for (let ty = 0; ty < 16; ty++) {
        for (let tx = 0; tx < 16 && mapOffset < tilemap.data.length; tx++) {
          const index = tilemap.data[mapOffset++];

          const srcCol = index & 0x07;
          const srcRow = (index >> 3) & 0x1F;
          let srcBase = ((srcRow << 4) * TILESET_WIDTH + (srcCol << 4)) << 2;
          let dstBase = (((py << 4 | ty) << 4) * mapWidth + ((px << 4 | tx) << 4)) << 2;

          for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16 * 4; x++) {
              pixels[dstBase + x] = tilesetBitmap[srcBase + x];
            }
            srcBase += tilesetStride;
            dstBase += mapWidth << 2;
          }
        }
      }
    }
  }

  return new ImageData(new Uint8ClampedArray(pixels.buffer), mapWidth, mapHeight);
}

export class TilemapManager {
  tilemap: TilemapState | null = null;

  load(raw: Uint8Array): void {
    this.tilemap = parseTilemap(raw);
  }

  clear(): void {
    this.tilemap = null;
  }

  getTileAt(blockX: number, blockY: number, cellX: number, cellY: number): number {
    if (!this.tilemap) return 0;
    const blockOffset = (blockY * this.tilemap.width + blockX) << 8;
    const cellOffset = (cellY << 4) | cellX;
    return this.tilemap.data[blockOffset + cellOffset];
  }

  setTileAt(blockX: number, blockY: number, cellX: number, cellY: number, value: number): void {
    if (!this.tilemap) return;
    const blockOffset = (blockY * this.tilemap.width + blockX) << 8;
    const cellOffset = (cellY << 4) | cellX;
    this.tilemap.data[blockOffset + cellOffset] = value;
  }

  /**
   * Convert pixel coordinates in the rendered tilemap to block + cell coordinates.
   */
  pixelToCell(px: number, py: number): { blockX: number; blockY: number; cellX: number; cellY: number; tileX: number; tileY: number } {
    const tileX = Math.floor(px / 16);
    const tileY = Math.floor(py / 16);
    const blockX = tileX >> 4;
    const blockY = tileY >> 4;
    const cellX = tileX & 0x0F;
    const cellY = tileY & 0x0F;
    return { blockX, blockY, cellX, cellY, tileX, tileY };
  }
}
