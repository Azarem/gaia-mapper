/**
 * Sprite bundle parser (Phase 3+ placeholder).
 *
 * Format hierarchy: SpriteMap -> FrameSets -> Frames -> Groups -> Parts
 * Binary format matches GaiaLib/Sprites/SpriteMap.cs.
 */

export interface SpritePart {
  x: number;
  y: number;
  tileIndex: number;
  paletteIndex: number;
  hFlip: boolean;
  vFlip: boolean;
  isLarge: boolean;
}

export interface SpriteGroup {
  xOffset: number;
  yOffset: number;
  parts: SpritePart[];
}

export interface SpriteFrame {
  duration: number;
  groupIndex: number;
}

export interface SpriteFrameSet {
  frames: SpriteFrame[];
}

export interface SpriteMap {
  frameSets: SpriteFrameSet[];
  groups: SpriteGroup[];
}
