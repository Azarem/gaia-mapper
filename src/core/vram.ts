/**
 * Virtual VRAM buffer emulating the SNES 64KB VRAM.
 *
 * Layout (IOG, BG12NBA = $22):
 *   0x0000-0x3FFF  Tilemaps / mode 7 etc.
 *   0x4000-0x5FFF  BG tiles page 0 (256 tiles × 32 bytes)
 *   0x6000-0x7FFF  BG tiles page 1 (256 tiles × 32 bytes)
 *   0x8000-0xFFFF  Sprite tiles
 *
 * BG12NBA is always $22, so both BG1 and BG2 share character base
 * VRAM word $2000 (byte $4000).  Page selection is determined by the
 * game engine's PPU table: byte 4 bit 7 controls whether layer 2 tile
 * indices are OR'd with $0100 (adding 256, shifting to page 1).
 * The mapper mirrors this via the `useOffset` flag on TilesetRenderer,
 * which adds BG_PAGE_SIZE ($2000) to the VRAM address.
 *
 * Each 4bpp tile is 32 bytes (8 rows × 2 bytes × 2 bitplane pairs).
 */
export class VirtualVRAM {
  static readonly SIZE = 0x10000;
  static readonly BG_BASE = 0x4000;
  static readonly BG_PAGE_SIZE = 0x2000;
  static readonly SPRITE_BASE = 0x8000;
  static readonly BYTES_PER_TILE = 32;

  readonly data: Uint8Array;

  constructor() {
    this.data = new Uint8Array(VirtualVRAM.SIZE);
  }

  clear(): void {
    this.data.fill(0);
  }

  /**
   * Load bitmap data into VRAM, mirroring scene_meta opcode 0x03.
   *
   * @param srcData - Raw 4bpp tile data from a .bin file
   * @param srcOffset - Source offset in 512-byte units
   * @param sizeW - Size in 512-byte units (end marker)
   * @param dstOffset - Destination offset in 512-byte units
   * @param isSprite - If true, write to sprite region (0x8000+), else BG (0x4000+)
   */
  loadBitmap(srcData: Uint8Array, srcOffset: number, sizeW: number, dstOffset: number, isSprite: boolean): void {
    const srcStart = srcOffset << 9;
    const size = (sizeW - srcOffset) << 9;
    const dstStart = (dstOffset << 9) + (isSprite ? VirtualVRAM.SPRITE_BASE : VirtualVRAM.BG_BASE);

    for (let i = 0; i < size && (srcStart + i) < srcData.length; i++) {
      const dstIdx = dstStart + i;
      if (dstIdx < VirtualVRAM.SIZE) {
        this.data[dstIdx] = srcData[srcStart + i];
      }
    }
  }

  /**
   * Import raw graphics data at a specific VRAM offset (for manual VRAM management).
   */
  importRawGraphics(srcData: Uint8Array, dstOffset: number): void {
    for (let i = 0; i < srcData.length && (dstOffset + i) < VirtualVRAM.SIZE; i++) {
      this.data[dstOffset + i] = srcData[i];
    }
  }

  getTileAddress(tileIndex: number, useOffset = false): number {
    const base = useOffset ? VirtualVRAM.BG_BASE + VirtualVRAM.BG_PAGE_SIZE : VirtualVRAM.BG_BASE;
    return (tileIndex << 5) + base;
  }
}
