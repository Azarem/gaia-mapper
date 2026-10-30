/**
 * Scene display configuration: the PPU registers a scene's `display-mode`
 * command (`SceneCmd_ConfigDisplay`) programs, parsed into the shape the
 * layer compositor needs.
 *
 * The two tilemap layers are BG1 (layer 1, "main") and BG2 (layer 2, "effect").
 * How they combine on screen is decided by these preset bytes:
 *
 *   TM      ($212C)  layers on the main screen (bit 0 = BG1, bit 1 = BG2)
 *   TS      ($212D)  layers on the sub screen  (same bits)
 *   CGWSEL  ($2130)  bit 1 set  -> color math addend is the sub screen
 *                    bit 1 clear -> addend is the fixed color (COLDATA)
 *                    bits 4-5 gate the math by the color window
 *   CGADSUB ($2131)  bit 0/1 = math on BG1/BG2, bit 5 = math on backdrop,
 *                    bit 6 = half result, bit 7 = subtract instead of add
 *   layer flags      bit 0/1 = tile-priority bit forced on layer 1/2 tiles
 *
 * Without color math BG1 simply covers BG2. With sub-screen math the main
 * pixel is added to (or subtracted from) the sub-screen pixel.
 */

/** Raw preset bytes carried by a `ppu` manifest entry. */
export interface DisplayRegisters {
  tm: number;
  ts: number;
  cgwsel: number;
  cgadsub: number;
  layerFlags: number;
}

/**
 * How the two layers combine:
 * - `overlay`     layer 1 drawn on top of layer 2 (no cross-layer color math)
 * - `additive`    sub-screen color math, added
 * - `average`     sub-screen color math, added then halved
 * - `subtractive` sub-screen color math, subtracted (optionally halved)
 */
export type BlendKind = 'overlay' | 'additive' | 'average' | 'subtractive';

/** Per-layer flag pair indexed by layer - 1 (index 0 = layer 1/BG1, index 1 = layer 2/BG2). */
export type LayerFlags = readonly [boolean, boolean];

export interface DisplayBlend {
  kind: BlendKind;
  /** Layer is enabled on the main screen (TM). */
  main: LayerFlags;
  /** Layer is enabled on the sub screen (TS). */
  sub: LayerFlags;
  /**
   * Sub-screen color math is active: the addend is the sub screen (CGWSEL bit 1)
   * and the color window does not suppress it. When the addend is the fixed
   * color instead, see fixedColorMath.
   */
  subscreenMath: boolean;
  /** Color math is applied to main-screen pixels of this layer (CGADSUB bits 0-1). */
  math: LayerFlags;
  /** Color math is applied to main-screen pixels showing the backdrop (CGADSUB bit 5). */
  backdropMath: boolean;
  subtract: boolean;
  half: boolean;
  /** The tile-priority bit is forced on for every tile of this layer (layer flags bits 0-1). */
  forcedPriority: LayerFlags;
  /**
   * Color math is configured but its addend is the fixed color, whose value
   * is set at runtime (COLDATA) and not part of the preset. Not rendered.
   */
  fixedColorMath: boolean;
  /**
   * Sub-screen color math is configured but gated to the inside of the color
   * window (CGWSEL bits 4-5 = 1). Window geometry is set at runtime and
   * system_init leaves the window empty, so the math is not rendered.
   */
  windowGatedMath: boolean;
}

/** Layer flags bit 7 clear: layer 2 tile indices get +$100 (VRAM tile page 1). */
export function usesEffectTileOffset(layerFlags: number): boolean {
  return (layerFlags & 0x80) === 0;
}

export function parseDisplayRegisters(meta: Record<string, number | boolean>): DisplayRegisters {
  const read = (key: keyof DisplayRegisters): number => {
    const value = meta[key];
    if (typeof value !== 'number') {
      throw new Error(`ppu entry is missing "${key}" (payload built without display registers)`);
    }
    return value;
  };
  return {
    tm: read('tm'),
    ts: read('ts'),
    cgwsel: read('cgwsel'),
    cgadsub: read('cgadsub'),
    layerFlags: read('layerFlags'),
  };
}

export function parseDisplayBlend(regs: DisplayRegisters): DisplayBlend {
  const main: LayerFlags = [(regs.tm & 0x01) !== 0, (regs.tm & 0x02) !== 0];
  const sub: LayerFlags = [(regs.ts & 0x01) !== 0, (regs.ts & 0x02) !== 0];
  const math: LayerFlags = [(regs.cgadsub & 0x01) !== 0, (regs.cgadsub & 0x02) !== 0];
  const backdropMath = (regs.cgadsub & 0x20) !== 0;
  const subscreenAddend = (regs.cgwsel & 0x02) !== 0;
  // CGWSEL bits 4-5: 0 = math everywhere, 1 = only inside the color window,
  // 2 = only outside it, 3 = never. The window is empty unless a scene opens
  // one at runtime, so "inside only" never applies and "outside only" always does.
  const windowGate = (regs.cgwsel >> 4) & 3;
  const windowAllowsMath = windowGate === 0 || windowGate === 2;
  const subtract = (regs.cgadsub & 0x80) !== 0;
  const half = (regs.cgadsub & 0x40) !== 0;

  const mathOnMainLayer = (math[0] && main[0]) || (math[1] && main[1]);
  const anyMath = mathOnMainLayer || backdropMath;
  const subscreenHasLayer = sub[0] || sub[1];

  const subscreenMath = subscreenAddend && windowAllowsMath;
  const crossLayerMath = subscreenMath && anyMath && subscreenHasLayer;

  let kind: BlendKind = 'overlay';
  if (crossLayerMath) {
    kind = subtract ? 'subtractive' : half ? 'average' : 'additive';
  }

  return {
    kind,
    main,
    sub,
    subscreenMath,
    math,
    backdropMath,
    subtract,
    half,
    forcedPriority: [(regs.layerFlags & 0x01) !== 0, (regs.layerFlags & 0x02) !== 0],
    fixedColorMath: !subscreenAddend && windowAllowsMath && anyMath,
    windowGatedMath: subscreenAddend && windowGate === 1 && anyMath && subscreenHasLayer,
  };
}

/**
 * Blend used when a scene never issues a `display-mode` command:
 * both layers on the main screen, no color math.
 */
export const DEFAULT_BLEND: DisplayBlend = parseDisplayBlend({
  tm: 0x17, ts: 0, cgwsel: 0, cgadsub: 0, layerFlags: 0,
});

const KIND_LABELS: Record<BlendKind, string> = {
  overlay: 'Layer 1 over Layer 2',
  additive: 'Additive blend',
  average: 'Additive blend (half)',
  subtractive: 'Subtractive blend',
};

/**
 * Short human-readable description for the status bar.
 * `present` flags which layers the scene actually has a tilemap for.
 */
export function describeBlend(blend: DisplayBlend, present: LayerFlags): string {
  let text = present[0] && present[1] ? KIND_LABELS[blend.kind] : 'Single layer';
  if (blend.fixedColorMath) text += ' (fixed-color fade not shown)';
  if (blend.windowGatedMath) text += ' (color-window blend not shown)';
  for (let i = 0; i < 2; i++) {
    if (present[i] && !blend.main[i] && !blend.sub[i]) {
      text += `; layer ${i + 1} is not enabled in-game`;
    }
  }
  return text;
}
