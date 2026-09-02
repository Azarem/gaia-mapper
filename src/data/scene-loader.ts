import { VirtualVRAM } from '../core/vram';
import { PaletteState } from '../core/palette';
import { TilesetRenderer } from '../core/tileset';
import { TilemapManager } from '../core/tilemap';
import type { PayloadManifest, AssetEntry, SceneDef } from './manifest';

export interface SceneState {
  vram: VirtualVRAM;
  palette: PaletteState;
  mainTileset: TilesetRenderer;
  effectTileset: TilesetRenderer;
  mainTilemap: TilemapManager;
  effectTilemap: TilemapManager;
}

const EXTENSIONS = ['.bin', '.pal', '.set', '.map', '.sprite.asm', ''];

function resolveFile(payload: Map<string, Uint8Array>, filename: string): Uint8Array {
  const direct = payload.get(filename);
  if (direct) return direct;

  for (const ext of EXTENSIONS) {
    const withExt = filename + ext;
    const hit = payload.get(withExt);
    if (hit) return hit;
  }

  for (const [key, data] of payload) {
    const basename = key.replace(/^.*\//, '');
    if (basename === filename) return data;
    for (const ext of EXTENSIONS) {
      if (basename === filename + ext) return data;
    }
  }

  throw new Error(`Asset not found in payload: ${filename}`);
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
      break;
    }

    case 'tilemap': {
      const data = resolveFile(payload, asset.data!);
      const layer = asset.meta.layer as number;
      if (layer & 1) state.mainTilemap.load(data);
      if (layer & 2) state.effectTilemap.load(data);
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
