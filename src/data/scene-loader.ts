import { VirtualVRAM } from '../core/vram';
import { PaletteState } from '../core/palette';
import { TilesetRenderer } from '../core/tileset';
import { TilemapManager, serializeTilemap } from '../core/tilemap';
import {
  DEFAULT_BLEND, parseDisplayBlend, parseDisplayRegisters, usesEffectTileOffset,
  type DisplayBlend,
} from '../core/display';
import type { PayloadManifest, AssetEntry, SceneDef } from './manifest';

export type LoadedAssetType = 'tilemap' | 'tileset' | 'bitmap' | 'palette';

export interface LoadedAsset {
  type: LoadedAssetType;
  filename: string;
  resolvedKey: string;
  extension: string;
  layer: number;
  meta: Record<string, number | boolean>;
}

export interface SceneState {
  vram: VirtualVRAM;
  palette: PaletteState;
  mainTileset: TilesetRenderer;
  effectTileset: TilesetRenderer;
  mainTilemap: TilemapManager;
  effectTilemap: TilemapManager;
  /** How layers 1 and 2 combine on screen, parsed from the scene's display-mode preset. */
  blend: DisplayBlend;
  loadedAssets: LoadedAsset[];
}

const EXTENSIONS = ['.bin', '.pal', '.set', '.map', '.sprite.asm', ''];

const ASSET_EXT: Record<LoadedAssetType, string> = {
  tilemap: '.map',
  tileset: '.set',
  bitmap: '.bin',
  palette: '.pal',
};

function resolveFileKey(payload: Map<string, Uint8Array>, filename: string): string {
  if (payload.has(filename)) return filename;
  for (const ext of EXTENSIONS) {
    const withExt = filename + ext;
    if (payload.has(withExt)) return withExt;
  }
  for (const [key] of payload) {
    const basename = key.replace(/^.*\//, '');
    if (basename === filename) return key;
    for (const ext of EXTENSIONS) {
      if (basename === filename + ext) return key;
    }
  }
  throw new Error(`Asset not found in payload: ${filename}`);
}

function resolveFile(payload: Map<string, Uint8Array>, filename: string): Uint8Array {
  const key = resolveFileKey(payload, filename);
  return payload.get(key)!;
}

interface LabelRef {
  scene: SceneDef;
  assetIndex: number;
}

/**
 * Build a lookup from label ID to the scene + asset index where it's declared.
 */
function buildLabelIndex(manifest: PayloadManifest): Map<number, LabelRef> {
  const index = new Map<number, LabelRef>();
  for (const group of Object.values(manifest.groups)) {
    for (const scene of Object.values(group.scenes)) {
      for (let i = 0; i < scene.assets.length; i++) {
        const a = scene.assets[i];
        if (a.type === 'label') {
          index.set(a.meta.id as number, { scene, assetIndex: i });
        }
      }
    }
  }
  return index;
}

let _labelIndex: Map<number, LabelRef> | null = null;

function getLabelIndex(manifest: PayloadManifest): Map<number, LabelRef> {
  if (!_labelIndex) _labelIndex = buildLabelIndex(manifest);
  return _labelIndex;
}

/**
 * Load a scene's assets into memory, following jump/label chains
 * to inherit shared assets from parent scenes.
 */
export function loadScene(
  manifest: PayloadManifest,
  payload: Map<string, Uint8Array>,
  groupName: string,
  sceneName: string,
): SceneState {
  const scene = manifest.groups[groupName]?.scenes[sceneName];
  if (!scene) throw new Error(`Scene not found: ${groupName}/${sceneName}`);

  const state: SceneState = {
    vram: new VirtualVRAM(),
    palette: new PaletteState(),
    mainTileset: new TilesetRenderer(),
    effectTileset: new TilesetRenderer(),
    mainTilemap: new TilemapManager(),
    effectTilemap: new TilemapManager(),
    blend: DEFAULT_BLEND,
    loadedAssets: [],
  };

  const labelIndex = getLabelIndex(manifest);
  const visited = new Set<number>();

  executeAssetList(state, payload, labelIndex, scene.assets, 0, visited);

  return state;
}

/**
 * Execute a list of asset commands starting from `startIndex`, following
 * jump chains with cycle detection.
 */
function executeAssetList(
  state: SceneState,
  payload: Map<string, Uint8Array>,
  labelIndex: Map<number, LabelRef>,
  assets: AssetEntry[],
  startIndex: number,
  visited: Set<number>,
): void {
  for (let i = startIndex; i < assets.length; i++) {
    const asset = assets[i];

    if (asset.type === 'jump') {
      const targetLabel = asset.meta.label as number;
      if (visited.has(targetLabel)) continue;
      visited.add(targetLabel);

      const ref = labelIndex.get(targetLabel);
      if (!ref) continue;

      executeAssetList(
        state, payload, labelIndex,
        ref.scene.assets, ref.assetIndex + 1, visited,
      );
      continue;
    }

    if (asset.type === 'label') continue;

    executeAssetCommand(state, payload, asset);
  }
}

function executeAssetCommand(
  state: SceneState,
  payload: Map<string, Uint8Array>,
  asset: AssetEntry,
): void {
  switch (asset.type) {
    case 'bitmap': {
      const data = resolveFile(payload, asset.data!);
      state.vram.loadBitmap(
        data,
        asset.meta.srcOffset as number,
        asset.meta.sizeW as number,
        asset.meta.dstOffset as number,
        asset.meta.isSprite as boolean,
      );
      state.loadedAssets.push({
        type: 'bitmap',
        filename: asset.data!,
        resolvedKey: resolveFileKey(payload, asset.data!),
        extension: ASSET_EXT.bitmap,
        layer: 0,
        meta: { ...asset.meta },
      });
      break;
    }

    case 'palette': {
      const data = resolveFile(payload, asset.data!);
      state.palette.loadPalette(
        data,
        asset.meta.srcOffset as number,
        asset.meta.sizeW as number,
        asset.meta.dstOffset as number,
      );
      state.loadedAssets.push({
        type: 'palette',
        filename: asset.data!,
        resolvedKey: resolveFileKey(payload, asset.data!),
        extension: ASSET_EXT.palette,
        layer: 0,
        meta: { ...asset.meta },
      });
      break;
    }

    case 'tileset': {
      const data = resolveFile(payload, asset.data!);
      const layer = asset.meta.layer as number;
      if (layer & 1) {
        state.mainTileset.loadTileset(
          data,
          asset.meta.srcOffset as number,
          asset.meta.sizeW as number,
          asset.meta.dstOffset as number,
        );
      }
      if (layer & 2) {
        state.effectTileset.loadTileset(
          data,
          asset.meta.srcOffset as number,
          asset.meta.sizeW as number,
          asset.meta.dstOffset as number,
        );
      }
      state.loadedAssets.push({
        type: 'tileset',
        filename: asset.data!,
        resolvedKey: resolveFileKey(payload, asset.data!),
        extension: ASSET_EXT.tileset,
        layer,
        meta: { ...asset.meta },
      });
      break;
    }

    case 'tilemap': {
      const data = resolveFile(payload, asset.data!);
      const layer = asset.meta.layer as number;
      if (layer & 1) state.mainTilemap.load(data);
      if (layer & 2) state.effectTilemap.load(data);
      state.loadedAssets.push({
        type: 'tilemap',
        filename: asset.data!,
        resolvedKey: resolveFileKey(payload, asset.data!),
        extension: ASSET_EXT.tilemap,
        layer,
        meta: { ...asset.meta },
      });
      break;
    }

    case 'ppu': {
      // The last display-mode command executed wins, as on hardware.
      const regs = parseDisplayRegisters(asset.meta);
      state.blend = parseDisplayBlend(regs);
      state.effectTileset.useOffset = usesEffectTileOffset(regs.layerFlags);
      break;
    }
    case 'spritemap':
    case 'music':
      break;
  }
}

/**
 * Replay bitmap assets that follow `afterIndex` and whose VRAM destination
 * overlaps with [rangeStart, rangeEnd). Used after an expanded bitmap import
 * to restore data from subsequent scene loads (e.g. effect tiles in page 1).
 */
function replayOverlappingBitmaps(
  scene: SceneState,
  payload: Map<string, Uint8Array>,
  afterIndex: number,
  rangeStart: number,
  rangeEnd: number,
): void {
  for (let i = afterIndex + 1; i < scene.loadedAssets.length; i++) {
    const other = scene.loadedAssets[i];
    if (other.type !== 'bitmap') continue;

    const otherSrcOffset = other.meta.srcOffset as number;
    const otherSizeW = other.meta.sizeW as number;
    const otherDstOffset = other.meta.dstOffset as number;
    const otherIsSprite = other.meta.isSprite as boolean;

    const otherDstStart = (otherDstOffset << 9)
      + (otherIsSprite ? VirtualVRAM.SPRITE_BASE : VirtualVRAM.BG_BASE);
    const otherDstEnd = otherDstStart + ((otherSizeW - otherSrcOffset) << 9);

    if (otherDstStart < rangeEnd && rangeStart < otherDstEnd) {
      const otherData = payload.get(other.resolvedKey);
      if (otherData) {
        scene.vram.loadBitmap(otherData, otherSrcOffset, otherSizeW, otherDstOffset, otherIsSprite);
      }
    }
  }
}

export function importAssetData(
  scene: SceneState,
  asset: LoadedAsset,
  fileData: Uint8Array,
  payload?: Map<string, Uint8Array>,
): void {
  switch (asset.type) {
    case 'tilemap': {
      const layer = asset.layer;
      if (layer & 1) scene.mainTilemap.load(fileData);
      if (layer & 2) scene.effectTilemap.load(fileData);
      break;
    }
    case 'tileset': {
      const layer = asset.layer;
      if (layer & 1) {
        scene.mainTileset.loadTileset(
          fileData,
          asset.meta.srcOffset as number,
          asset.meta.sizeW as number,
          asset.meta.dstOffset as number,
        );
      }
      if (layer & 2) {
        scene.effectTileset.loadTileset(
          fileData,
          asset.meta.srcOffset as number,
          asset.meta.sizeW as number,
          asset.meta.dstOffset as number,
        );
      }
      break;
    }
    case 'bitmap': {
      const srcOffset = asset.meta.srcOffset as number;
      const originalSizeW = asset.meta.sizeW as number;
      const dstOffset = asset.meta.dstOffset as number;
      const isSprite = asset.meta.isSprite as boolean;

      const srcStartBytes = srcOffset << 9;
      const fileDataSizeW = srcOffset + Math.floor(
        Math.max(0, fileData.length - srcStartBytes) / 512,
      );

      const maxSizeW = isSprite ? fileDataSizeW : srcOffset + (32 - dstOffset);
      const effectiveSizeW = Math.max(originalSizeW, Math.min(fileDataSizeW, maxSizeW));

      scene.vram.loadBitmap(fileData, srcOffset, effectiveSizeW, dstOffset, isSprite);

      if (effectiveSizeW > originalSizeW && payload) {
        const dstStart = (dstOffset << 9)
          + (isSprite ? VirtualVRAM.SPRITE_BASE : VirtualVRAM.BG_BASE);
        const dstEnd = dstStart + ((effectiveSizeW - srcOffset) << 9);
        const importedIndex = scene.loadedAssets.indexOf(asset);
        if (importedIndex >= 0) {
          replayOverlappingBitmaps(scene, payload, importedIndex, dstStart, dstEnd);
        }
      }

      asset.meta.sizeW = effectiveSizeW;
      break;
    }
    case 'palette':
      scene.palette.loadPalette(
        fileData,
        asset.meta.srcOffset as number,
        asset.meta.sizeW as number,
        asset.meta.dstOffset as number,
      );
      scene.palette.invalidateCache();
      break;
  }
}

export function exportAssetData(
  scene: SceneState,
  asset: LoadedAsset,
  payload: Map<string, Uint8Array>,
): Uint8Array | null {
  switch (asset.type) {
    case 'tilemap': {
      const tm = (asset.layer & 1) ? scene.mainTilemap : scene.effectTilemap;
      if (!tm.tilemap) return null;
      return serializeTilemap(tm.tilemap);
    }
    case 'tileset': {
      const ts = (asset.layer & 1) ? scene.mainTileset : scene.effectTileset;
      const original = payload.get(asset.resolvedKey);
      if (!original) return null;
      const output = new Uint8Array(original);
      const srcStart = (asset.meta.srcOffset as number) << 2;
      const size = ((asset.meta.sizeW as number) << 6) - srcStart;
      const dstStart = (asset.meta.dstOffset as number) << 2;
      for (let i = 0; i < size; i++) {
        if (srcStart + i < output.length && dstStart + i < ts.data.length) {
          output[srcStart + i] = ts.data[dstStart + i];
        }
      }
      return output;
    }
    case 'bitmap': {
      const original = payload.get(asset.resolvedKey);
      if (!original) return null;
      const isSprite = asset.meta.isSprite as boolean;
      const srcStart = (asset.meta.srcOffset as number) << 9;
      const size = ((asset.meta.sizeW as number) - (asset.meta.srcOffset as number)) << 9;
      const dstStart = ((asset.meta.dstOffset as number) << 9)
        + (isSprite ? VirtualVRAM.SPRITE_BASE : VirtualVRAM.BG_BASE);
      const neededSize = srcStart + size;
      const output = new Uint8Array(Math.max(original.length, neededSize));
      output.set(original);
      for (let i = 0; i < size; i++) {
        if (dstStart + i < scene.vram.data.length) {
          output[srcStart + i] = scene.vram.data[dstStart + i];
        }
      }
      return output;
    }
    case 'palette': {
      const original = payload.get(asset.resolvedKey);
      if (!original) return null;
      const output = new Uint8Array(original);
      const srcStart = (asset.meta.srcOffset as number) << 1;
      const size = ((asset.meta.sizeW as number) << 1) - srcStart;
      const dstStart = (asset.meta.dstOffset as number) << 1;
      for (let i = 0; i < size; i++) {
        if (srcStart + i < output.length && dstStart + i < scene.palette.cgram.length) {
          output[srcStart + i] = scene.palette.cgram[dstStart + i];
        }
      }
      return output;
    }
  }
}
