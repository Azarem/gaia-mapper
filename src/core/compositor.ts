import type { TilemapState } from './tilemap';
import type { DisplayBlend } from './display';

/**
 * Layer compositor.
 *
 * Combines the two rendered tilemap layers (layer 1 = BG1, layer 2 = BG2)
 * into a single image the way the SNES PPU would for a scene's display
 * preset: BG-vs-BG ordering by tile priority, then sub-screen color math.
 *
 * Modelled (mode 1 BG1/BG2): main screen = TM layers, sub screen = TS layers,
 * both ordered BG1 priority 1 > BG2 priority 1 > BG1 priority 0 > BG2
 * priority 0. A main-screen pixel whose layer (or the backdrop) has its
 * CGADSUB bit set is added to / subtracted from the top sub-screen pixel
 * (CGWSEL bit 1), optionally halved.
 *
 * Not modelled: OBJ and BG3, color windows (an empty window is assumed, see
 * display.ts), mosaic, and the fixed color addend (a runtime COLDATA value, not part of the preset), so
 * pixels with no sub-screen pixel under them are shown unmodified.
 *
 * Layer 1 defines the composite's area. Layer 2 is sampled modulo its own
 * size, so a layer 2 smaller than layer 1 repeats across it (the hardware
 * indexes the map modulo its size) and a larger one is cropped to layer 1's
 * area. Layer 2 parallax scrolling is not modelled: both layers start at the
 * top-left corner.
 *
 * When only one layer is shown it is copied through untouched at its own size,
 * so a layer can always be inspected (and edited) regardless of what the
 * preset enables.
 */

/** One layer's rendered pixels plus what is needed to look up per-tile priority. */
export interface LayerPlane {
  /** The layer's own full-size rendered tilemap (RGBA, transparent where palette index 0). */
  image: ImageData;
  /** Tilemap the image was rendered from (metatile index per cell). */
  tilemap: TilemapState;
  /** Per-metatile quad priority mask (bit 0 = TL ... bit 3 = BR) from the layer's tileset. */
  quadPriority: Uint8Array;
}

export type LayerPlanes = readonly [LayerPlane | null, LayerPlane | null];

export interface CompositeInput {
  planes: LayerPlanes;
  /** Whether each layer is currently displayed. A missing plane counts as not shown. */
  shown: readonly [boolean, boolean];
  blend: DisplayBlend;
  /** Backdrop color (CGRAM entry 0), used when color math applies to the backdrop. */
  backdrop: readonly [number, number, number];
}

// 5-bit <-> 8-bit channel conversion. The palette expands with
// round(v * 255 / 31), so the round trip is lossless and color math can run
// on the original 5-bit values exactly as the PPU does.
const TO5 = new Uint8Array(256);
const TO8 = new Uint8Array(32);
for (let i = 0; i < 256; i++) TO5[i] = Math.round(i * 31 / 255);
for (let i = 0; i < 32; i++) TO8[i] = Math.round(i * 255 / 31);

/**
 * Size of the composite image. Layer 1 defines the visible and editable area
 * whenever it is shown; layer 2 alone defines it only when layer 1 is hidden.
 * Null when nothing is shown.
 */
export function getCompositeSize(
  planes: LayerPlanes,
  shown: readonly [boolean, boolean],
): { width: number; height: number } | null {
  const plane = shown[0] && planes[0] ? planes[0] : shown[1] ? planes[1] : null;
  return plane ? { width: plane.image.width, height: plane.image.height } : null;
}

function tilePriority(plane: LayerPlane, x: number, y: number): boolean {
  const tm = plane.tilemap;
  const offset = ((((y >> 8) * tm.width) + (x >> 8)) << 8)
    | (((y >> 4) & 15) << 4)
    | ((x >> 4) & 15);
  const quad = (((y >> 3) & 1) << 1) | ((x >> 3) & 1);
  return ((plane.quadPriority[tm.data[offset]] >> quad) & 1) !== 0;
}

/**
 * Composite the pixel rectangle [x0, x1) x [y0, y1) into `target`.
 * `target` must be sized with getCompositeSize for the same planes/shown set.
 */
export function compositeRegion(
  target: ImageData,
  input: CompositeInput,
  x0: number, y0: number, x1: number, y1: number,
): void {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(target.width, x1);
  y1 = Math.min(target.height, y1);
  if (x0 >= x1 || y0 >= y1) return;

  const out = target.data;
  const outWidth = target.width;
  const { blend, backdrop } = input;
  const plane1 = input.shown[0] ? input.planes[0] : null;
  const plane2 = input.shown[1] ? input.planes[1] : null;

  if (!plane1 && !plane2) {
    for (let y = y0; y < y1; y++) {
      out.fill(0, ((y * outWidth) + x0) << 2, ((y * outWidth) + x1) << 2);
    }
    return;
  }

  // Single layer shown: raw pass-through.
  if (!plane1 || !plane2) {
    const src = (plane1 ?? plane2)!.image;
    const srcData = src.data;
    for (let y = y0; y < y1; y++) {
      let o = ((y * outWidth) + x0) << 2;
      for (let x = x0; x < x1; x++, o += 4) {
        if (x < src.width && y < src.height) {
          const s = ((y * src.width) + x) << 2;
          out[o] = srcData[s];
          out[o + 1] = srcData[s + 1];
          out[o + 2] = srcData[s + 2];
          out[o + 3] = srcData[s + 3];
        } else {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = 0;
        }
      }
    }
    return;
  }

  const d1 = plane1.image.data;
  const w1 = plane1.image.width;
  const h1 = plane1.image.height;
  const d2 = plane2.image.data;
  const w2 = plane2.image.width;
  const h2 = plane2.image.height;

  const [main1, main2] = blend.main;
  const [sub1, sub2] = blend.sub;
  const [forced1, forced2] = blend.forcedPriority;
  const { subscreenMath, backdropMath, subtract, half } = blend;

  for (let y = y0; y < y1; y++) {
    let o = ((y * outWidth) + x0) << 2;
    const y2 = y % h2;
    for (let x = x0; x < x1; x++, o += 4) {
      // Layer 1 is the composite's own coordinate space. Layer 2 repeats in
      // both directions, as the hardware indexes its map modulo its size.
      const x2 = x % w2;
      let s1 = -1;
      let s2 = -1;
      if (x < w1 && y < h1) {
        const s = ((y * w1) + x) << 2;
        if (d1[s + 3] !== 0) s1 = s;
      }
      const p2 = ((y2 * w2) + x2) << 2;
      if (d2[p2 + 3] !== 0) s2 = p2;

      if (s1 < 0 && s2 < 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }

      // Layer 1 is above layer 2 unless layer 2's tile has priority and layer 1's does not.
      let layer1Above = true;
      if (s1 >= 0 && s2 >= 0) {
        layer1Above = forced1 || tilePriority(plane1, x, y)
          || !(forced2 || tilePriority(plane2, x2, y2));
      }

      const mainOpaque1 = s1 >= 0 && main1;
      const mainOpaque2 = s2 >= 0 && main2;
      const mainTop = mainOpaque1 && mainOpaque2 ? (layer1Above ? 1 : 2)
        : mainOpaque1 ? 1 : mainOpaque2 ? 2 : 0;

      const subOpaque1 = s1 >= 0 && sub1;
      const subOpaque2 = s2 >= 0 && sub2;
      const subTop = subOpaque1 && subOpaque2 ? (layer1Above ? 1 : 2)
        : subOpaque1 ? 1 : subOpaque2 ? 2 : 0;

      const mathApplies = subscreenMath && subTop !== 0
        && (mainTop === 0 ? backdropMath : (mainTop === 1 ? blend.math[0] : blend.math[1]));

      if (mathApplies) {
        let mr: number;
        let mg: number;
        let mb: number;
        if (mainTop === 0) {
          mr = backdrop[0];
          mg = backdrop[1];
          mb = backdrop[2];
        } else if (mainTop === 1) {
          mr = d1[s1];
          mg = d1[s1 + 1];
          mb = d1[s1 + 2];
        } else {
          mr = d2[s2];
          mg = d2[s2 + 1];
          mb = d2[s2 + 2];
        }
        const sd = subTop === 1 ? d1 : d2;
        const ss = subTop === 1 ? s1 : s2;

        out[o] = TO8[blendChannel(TO5[mr], TO5[sd[ss]], subtract, half)];
        out[o + 1] = TO8[blendChannel(TO5[mg], TO5[sd[ss + 1]], subtract, half)];
        out[o + 2] = TO8[blendChannel(TO5[mb], TO5[sd[ss + 2]], subtract, half)];
        out[o + 3] = 0xFF;
      } else if (mainTop === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      } else {
        const sd = mainTop === 1 ? d1 : d2;
        const ss = mainTop === 1 ? s1 : s2;
        out[o] = sd[ss];
        out[o + 1] = sd[ss + 1];
        out[o + 2] = sd[ss + 2];
        out[o + 3] = 0xFF;
      }
    }
  }
}

/** PPU color math on one 5-bit channel: main +/- sub, optionally halved, clamped to 0-31. */
function blendChannel(main: number, sub: number, subtract: boolean, half: boolean): number {
  if (subtract) {
    const diff = main - sub;
    const clamped = diff < 0 ? 0 : diff;
    return half ? clamped >> 1 : clamped;
  }
  const sum = half ? (main + sub) >> 1 : main + sub;
  return sum > 31 ? 31 : sum;
}
