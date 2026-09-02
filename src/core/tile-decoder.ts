/**
 * SNES 4bpp planar tile decoder.
 *
 * Each 8x8 tile is 32 bytes in VRAM (4 bitplanes, interleaved in pairs):
 *   Bytes  0-15: Bitplanes 0 & 1 (interleaved, 2 bytes per row)
 *   Bytes 16-31: Bitplanes 2 & 3 (interleaved, 2 bytes per row)
 *
 * Output is a 64-byte array of 4-bit palette indices (one per pixel).
 */

/**
 * Decode a single 8x8 4bpp tile from VRAM into palette indices.
 *
 * @param vram - Full VRAM buffer
 * @param vramOffset - Start address of the tile (tileIndex * 32 + base)
 * @returns 64-byte array where each byte is a 4-bit color index (0-15)
 */
export function decodeTile8x8(vram: Uint8Array, vramOffset: number): Uint8Array {
  const indices = new Uint8Array(64);
  const offsets = [vramOffset, vramOffset + 16];

  let ofsLo = offsets[0];
  let ofsHi = offsets[1];

  for (let row = 0; row < 8; row++) {
    const bp0 = vram[ofsLo++];
    const bp1 = vram[ofsLo++];
    const bp2 = vram[ofsHi++];
    const bp3 = vram[ofsHi++];

    const rowBase = row << 3;
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      let idx = 0;
      if (bp0 & (1 << bit)) idx |= 1;
      if (bp1 & (1 << bit)) idx |= 2;
      if (bp2 & (1 << bit)) idx |= 4;
      if (bp3 & (1 << bit)) idx |= 8;
      indices[rowBase + col] = idx;
    }
  }

  return indices;
}

/**
 * Render a decoded 8x8 tile into an RGBA buffer at a given position.
 *
 * @param indices - 64-byte palette index array from decodeTile8x8
 * @param palette - Expanded RGBA palette (256 colors * 4 bytes)
 * @param paletteOffset - Byte offset into palette for this tile's sub-palette
 * @param dest - Destination RGBA buffer
 * @param destX - X position in dest (pixels)
 * @param destY - Y position in dest (pixels)
 * @param destStride - Row stride of dest in pixels
 * @param hFlip - Horizontal mirror
 * @param vFlip - Vertical mirror
 */
export function renderTile8x8(
  indices: Uint8Array,
  palette: Uint8Array,
  paletteOffset: number,
  dest: Uint8Array,
  destX: number,
  destY: number,
  destStride: number,
  hFlip: boolean,
  vFlip: boolean,
): void {
  for (let row = 0; row < 8; row++) {
    const srcRow = vFlip ? (7 - row) : row;
    const dstRowOffset = ((destY + row) * destStride + destX) << 2;

    for (let col = 0; col < 8; col++) {
      const srcCol = hFlip ? (7 - col) : col;
      const colorIndex = indices[(srcRow << 3) + srcCol];
      const dstOffset = dstRowOffset + (col << 2);

      if (colorIndex === 0) {
        dest[dstOffset] = 0;
        dest[dstOffset + 1] = 0;
        dest[dstOffset + 2] = 0;
        dest[dstOffset + 3] = 0;
      } else {
        const palIdx = paletteOffset + (colorIndex << 2);
        dest[dstOffset] = palette[palIdx];
        dest[dstOffset + 1] = palette[palIdx + 1];
        dest[dstOffset + 2] = palette[palIdx + 2];
        dest[dstOffset + 3] = 0xFF;
      }
    }
  }
}

/**
 * Render a decoded 8x8 tile as grayscale (no palette) for VRAM preview.
 */
export function renderTile8x8Grayscale(
  indices: Uint8Array,
  dest: Uint8Array,
  destX: number,
  destY: number,
  destStride: number,
): void {
  for (let row = 0; row < 8; row++) {
    const dstRowOffset = ((destY + row) * destStride + destX) << 2;
    for (let col = 0; col < 8; col++) {
      const colorIndex = indices[(row << 3) + col];
      const dstOffset = dstRowOffset + (col << 2);

      if (colorIndex === 0) {
        dest[dstOffset] = 0;
        dest[dstOffset + 1] = 0;
        dest[dstOffset + 2] = 0;
        dest[dstOffset + 3] = 0;
      } else {
        const gray = colorIndex << 4;
        dest[dstOffset] = gray;
        dest[dstOffset + 1] = gray;
        dest[dstOffset + 2] = gray;
        dest[dstOffset + 3] = 0xFF;
      }
    }
  }
}
