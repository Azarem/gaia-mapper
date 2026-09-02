/**
 * CGRAM (Color Generator RAM) emulation.
 *
 * SNES CGRAM holds 256 colors as 15-bit BGR words (2 bytes each = 512 bytes).
 * Organized as 8 palettes of 16 colors each for BG, plus 8 for sprites.
 */
export class PaletteState {
  static readonly CGRAM_SIZE = 0x200;
  static readonly COLORS_PER_PALETTE = 16;
  static readonly PALETTE_COUNT = 8;
  static readonly RGBA_SIZE = 256 * 4;

  readonly cgram: Uint8Array;
  private rgbaCache: Uint8Array | null = null;

  constructor() {
    this.cgram = new Uint8Array(PaletteState.CGRAM_SIZE);
  }

  clear(): void {
    this.cgram.fill(0);
    this.rgbaCache = null;
  }

  /**
   * Load palette data into CGRAM, mirroring scene_meta opcode 0x04.
   *
   * @param srcData - Raw palette data from a .pal file
   * @param srcOffset - Source offset in 2-byte units
   * @param sizeW - Size in 2-byte units (end marker)
   * @param dstOffset - Destination offset in 2-byte units
   */
  loadPalette(srcData: Uint8Array, srcOffset: number, sizeW: number, dstOffset: number): void {
    const srcStart = srcOffset << 1;
    const size = (sizeW << 1) - srcStart;
    const dstStart = dstOffset << 1;

    for (let i = 0; i < size && (srcStart + i) < srcData.length; i++) {
      const dstIdx = dstStart + i;
      if (dstIdx < PaletteState.CGRAM_SIZE) {
        this.cgram[dstIdx] = srcData[srcStart + i];
      }
    }
    this.rgbaCache = null;
  }

  /**
   * Convert all 256 BGR555 colors to RGBA8 (1024 bytes).
   * Uses the same scale factor as the legacy C# code: color * 255 / 31.
   */
  expandToRGBA(): Uint8Array {
    if (this.rgbaCache) return this.rgbaCache;

    const rgba = new Uint8Array(PaletteState.RGBA_SIZE);
    for (let i = 0, x = 0; i < this.cgram.length; i += 2, x += 4) {
      const sample = this.cgram[i] | (this.cgram[i + 1] << 8);
      rgba[x] = bgr5toRgb8(sample & 0x1F);
      rgba[x + 1] = bgr5toRgb8((sample >> 5) & 0x1F);
      rgba[x + 2] = bgr5toRgb8((sample >> 10) & 0x1F);
      rgba[x + 3] = 0xFF;
    }

    this.rgbaCache = rgba;
    return rgba;
  }

  /**
   * Get palette offset in the RGBA array for a given palette index (0-7).
   * Each palette = 16 colors * 4 bytes = 64 bytes.
   */
  getPaletteOffset(paletteIndex: number): number {
    return (paletteIndex & 7) << 6;
  }

  invalidateCache(): void {
    this.rgbaCache = null;
  }
}

/** Convert a 5-bit SNES color component to 8-bit. */
export function bgr5toRgb8(value: number): number {
  return Math.round((value & 0x1F) * 255 / 31);
}
