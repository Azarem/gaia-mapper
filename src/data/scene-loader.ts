import { VirtualVRAM } from '../core/vram';
import { PaletteState } from '../core/palette';
import { TilesetRenderer } from '../core/tileset';
import { TilemapManager, serializeTilemap } from '../core/tilemap';
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

    case 'ppu':
      if (asset.meta.effectOffset) {
        state.effectTileset.useOffset = true;
      }
      break;
    case 'spritemap':
    case 'music':
      break;
  }
}

export function importAssetData(scene: SceneState, asset: LoadedAsset, fileData: Uint8Array): void {
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
    case 'bitmap':
      scene.vram.loadBitmap(
        fileData,
        asset.meta.srcOffset as number,
        asset.meta.sizeW as number,
        asset.meta.dstOffset as number,
        asset.meta.isSprite as boolean,
      );
      break;
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
      const output = new Uint8Array(original);
      const isSprite = asset.meta.isSprite as boolean;
      const srcStart = (asset.meta.srcOffset as number) << 9;
      const size = ((asset.meta.sizeW as number) - (asset.meta.srcOffset as number)) << 9;
      const dstStart = ((asset.meta.dstOffset as number) << 9)
        + (isSprite ? VirtualVRAM.SPRITE_BASE : VirtualVRAM.BG_BASE);
      for (let i = 0; i < size; i++) {
        if (srcStart + i < output.length && dstStart + i < scene.vram.data.length) {
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
