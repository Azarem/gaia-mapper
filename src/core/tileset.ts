import { VirtualVRAM } from './vram';
import { PaletteState } from './palette';
import { decodeTile8x8, renderTile8x8 } from './tile-decoder';

/**
 * Tileset entry bit layout (16-bit word):
 *   Bits  0-7:  VRAM tile index  (0x00FF)
 *   Bit   8:    Tile page select (0x0100) — selects BG page 1 (+256 tiles)
 *   Bit   9:    Block flag       (0x0200) — collision, prevents actor passage
 *   Bits 10-12: Palette index    (0x1C00)
 *   Bit  13:    Priority          (0x2000)
 *   Bit  14:    H-mirror          (0x4000)
 *   Bit  15:    V-mirror          (0x8000)
 *
 * The 9-bit tile index (bits 0-8) directly addresses VRAM:
 *   indices 0-255 → BG page 0 ($4000-$5FFF)
 *   indices 256-511 → BG page 1 ($6000-$7FFF)
 *
 * The game engine (sub_028FCD) may OR $0100 into all layer-2 entries
 * based on PPU table byte 4 bit 7, shifting tile lookups to page 1.
 * The mapper mirrors this with TilesetRenderer.useOffset.
 */

export const TILESET_SIZE = 0x800;
export const TILESET_ENTRIES = 1024;
export const METATILE_COUNT = 256;
export const TILESET_COLS = 8;
export const TILESET_ROWS = 32;
export const TILESET_WIDTH = 128;
export const TILESET_HEIGHT = 512;

export interface TilesetEntry {
  tileIndex: number;
  block: boolean;
  paletteIndex: number;
  priority: boolean;
  hFlip: boolean;
  vFlip: boolean;
  raw: number;
}

export function decodeTilesetEntry(word: number): TilesetEntry {
  return {
    tileIndex: word & 0x01FF,
    block: (word & 0x0200) !== 0,
    paletteIndex: (word >> 10) & 7,
    priority: (word & 0x2000) !== 0,
    hFlip: (word & 0x4000) !== 0,
    vFlip: (word & 0x8000) !== 0,
    raw: word,
  };
}

export function encodeTilesetEntry(entry: TilesetEntry): number {
  return (entry.tileIndex & 0x01FF)
    | (entry.block ? 0x0200 : 0)
    | ((entry.paletteIndex & 7) << 10)
    | (entry.priority ? 0x2000 : 0)
    | (entry.hFlip ? 0x4000 : 0)
    | (entry.vFlip ? 0x8000 : 0);
}

export class TilesetRenderer {
  readonly data: Uint8Array;
  useOffset = false;

  constructor() {
    this.data = new Uint8Array(TILESET_SIZE);
  }

  clear(): void {
    this.data.fill(0);
  }

  /**
   * Load tileset data, mirroring scene_meta opcode 0x05.
   *
   * @param srcData - Raw tileset data from a .set file
   * @param srcOffset - Source offset in 4-byte units
   * @param sizeW - Size in 64-byte units (end marker)
   * @param dstOffset - Destination offset in 4-byte units
   */
  loadTileset(srcData: Uint8Array, srcOffset: number, sizeW: number, dstOffset: number): void {
    const src = srcOffset << 2;
    const size = (sizeW << 6) - src;
    const dst = dstOffset << 2;

    for (let i = 0; i < size && (src + i) < srcData.length; i++) {
      const dstIdx = dst + i;
      if (dstIdx < TILESET_SIZE) {
        this.data[dstIdx] = srcData[src + i];
      }
    }
  }

  getEntry(index: number): TilesetEntry {
    const byteOffset = index << 1;
    const word = this.data[byteOffset] | (this.data[byteOffset + 1] << 8);
    return decodeTilesetEntry(word);
  }

  setEntry(index: number, entry: TilesetEntry): void {
    const word = encodeTilesetEntry(entry);
    const byteOffset = index << 1;
    this.data[byteOffset] = word & 0xFF;
    this.data[byteOffset + 1] = (word >> 8) & 0xFF;
  }

  getEntryWord(index: number): number {
    const byteOffset = index << 1;
    return this.data[byteOffset] | (this.data[byteOffset + 1] << 8);
  }

  setEntryWord(index: number, word: number): void {
    const byteOffset = index << 1;
    this.data[byteOffset] = word & 0xFF;
    this.data[byteOffset + 1] = (word >> 8) & 0xFF;
  }

  /**
   * Render the full 128x512 tileset bitmap.
   * Port of ControlTest.ReloadTileset() from the legacy C# codebase.
   *
   * Layout: 8 columns x 32 rows of 16x16 metatiles.
   * Each metatile is composed of 4 consecutive tileset entries (TL, TR, BL, BR quads).
   */
  renderToImageData(vram: VirtualVRAM, palette: PaletteState): ImageData {
    const rgba = palette.expandToRGBA();
    const pixels = new Uint8Array(TILESET_WIDTH * TILESET_HEIGHT * 4);
    let tileIx = 0;

    for (let ty = 0; ty < TILESET_ROWS; ty++) {
      for (let tx = 0; tx < TILESET_COLS && tileIx < this.data.length; tx++) {
        for (let quad = 0; quad < 4; quad++) {
          const word = this.data[tileIx++] | (this.data[tileIx++] << 8);
          const tileIndex = word & 0x01FF;
          const hFlip = (word & 0x4000) !== 0;
          const vFlip = (word & 0x8000) !== 0;
          const paletteOffset = (word & 0x1C00) >> 4;

          const vramAddr = vram.getTileAddress(tileIndex, this.useOffset);
          const indices = decodeTile8x8(vram.data, vramAddr);

          const destX = (tx << 4) + ((quad & 1) ? 8 : 0);
          const destY = (ty << 4) + ((quad > 1) ? 8 : 0);

          renderTile8x8(
            indices, rgba, paletteOffset,
            pixels, destX, destY, TILESET_WIDTH,
            hFlip, vFlip,
          );
        }
      }
    }

    return new ImageData(new Uint8ClampedArray(pixels.buffer), TILESET_WIDTH, TILESET_HEIGHT);
  }

  /**
   * Get the 4 entry indices for a metatile.
   * Metatile N → entries [N*4, N*4+1, N*4+2, N*4+3] = [TL, TR, BL, BR]
   */
  getMetatileEntries(metatileIndex: number): [number, number, number, number] {
    const base = metatileIndex << 2;
    return [base, base + 1, base + 2, base + 3];
  }

  /**
   * Convert a pixel position on the tileset image to a metatile + quad index.
   */
  pixelToSelection(x: number, y: number): { metatileIndex: number; quadIndex: number; entryIndex: number } {
    const col = Math.floor(x / 16);
    const row = Math.floor(y / 16);
    const metatileIndex = (row * TILESET_COLS) + col;

    const subX = Math.floor((x % 16) / 8);
    const subY = Math.floor((y % 16) / 8);
    const quadIndex = (subY << 1) | subX;

    const entryIndex = (metatileIndex << 2) + quadIndex;
    return { metatileIndex, quadIndex, entryIndex };
  }
}
