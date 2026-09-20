/**
 * Build the payload.zip archive from extracted baserom assets.
 *
 * Usage: tsx scripts/build-payload.ts <path-to-baserom>
 *
 * Reads db-us/groups.json for scene grouping structure, parses
 * extracted/tables/scene_meta.asm for per-scene asset commands,
 * and reads db-us/files.json for file metadata. Collects all
 * referenced binary assets from extracted/ and produces a
 * payload.zip with a manifest.json + flat asset files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { zipSync, type Zippable } from 'fflate';

/* ------------------------------------------------------------------ */
/*  Type definitions                                                   */
/* ------------------------------------------------------------------ */

interface AssetEntry {
  type: string;
  data?: string;
  meta: Record<string, unknown>;
}

interface SceneDef {
  id: number;
  description: string;
  assets: AssetEntry[];
}

interface GroupDef {
  prefix: string;
  scenes: Record<string, SceneDef>;
}

interface GroupsJson {
  [group: string]: {
    prefix: string;
    scenes: {
      [scene: string]: {
        id: number;
        description: string;
      };
    };
  };
}

interface FileEntry {
  start: number;
  end: number;
  type: string;
  compressed?: boolean;
}

interface FilesJson {
  [group: string]: {
    [sceneOrEmpty: string]: {
      [filename: string]: FileEntry;
    };
  };
}

/* ------------------------------------------------------------------ */
/*  scene_meta.asm parser                                              */
/* ------------------------------------------------------------------ */

/** Parse a hex literal: #$XXXX or #XX → number */
function parseHex(s: string): number {
  const cleaned = s.replace(/^#\$?/, '');
  return parseInt(cleaned, 16);
}

/** Strip the @ prefix from a reference: @name → name */
function parseRef(s: string): string {
  return s.replace(/^@/, '');
}

/** Parse a single scene_meta command line into an AssetEntry (or null to skip). */
function parseCommand(cmdType: string, args: string[]): AssetEntry | null {
  switch (cmdType) {
    case 'display-mode':
      return { type: 'ppu', meta: { index: parseHex(args[0]) } };

    case 'bitmap':
      return {
        type: 'bitmap',
        data: parseRef(args[3]),
        meta: {
          srcOffset: parseHex(args[0]),
          sizeW: parseHex(args[1]),
          dstOffset: parseHex(args[2]),
          isSprite: parseHex(args[4]) > 0,
        },
      };

    case 'palette':
      return {
        type: 'palette',
        data: parseRef(args[3]),
        meta: {
          srcOffset: parseHex(args[0]),
          sizeW: parseHex(args[1]),
          dstOffset: parseHex(args[2]),
        },
      };

    case 'tileset':
      return {
        type: 'tileset',
        data: parseRef(args[4]),
        meta: {
          srcOffset: parseHex(args[0]),
          sizeW: parseHex(args[1]),
          dstOffset: parseHex(args[2]),
          layer: parseHex(args[3]),
        },
      };

    case 'tilemap':
      return {
        type: 'tilemap',
        data: parseRef(args[1]),
        meta: { layer: parseHex(args[0]) },
      };

    case 'jump':
      return { type: 'jump', meta: { label: parseHex(args[0]) } };

    case 'spritemap':
      return {
        type: 'spritemap',
        data: parseRef(args[2]),
        meta: {},
      };

    case 'music':
      return { type: 'music', meta: {} };

    // branch, char-tiles, meta-skip: not actionable in the mapper
    default:
      return null;
  }
}

/** Parse the body of a scene_meta_XXXX [ ... ] block into an AssetEntry array. */
function parseSceneBody(body: string): AssetEntry[] {
  const assets: AssetEntry[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/;.*$/, '').trim();
    if (!line) continue;

    // Label declaration: meta_label_XX:
    const labelMatch = line.match(/^meta_label_([0-9A-Fa-f]+):$/);
    if (labelMatch) {
      assets.push({ type: 'label', meta: { id: parseInt(labelMatch[1], 16) } });
      continue;
    }

    // Command: type < arg1, arg2, ... >
    const cmdMatch = line.match(/^([\w-]+)\s*<\s*(.*?)\s*>$/);
    if (cmdMatch) {
      const args = cmdMatch[2].split(',').map(a => a.trim());
      const entry = parseCommand(cmdMatch[1], args);
      if (entry) assets.push(entry);
    }
  }

  return assets;
}

/**
 * Parse extracted/tables/scene_meta.asm and return a map from
 * numeric scene ID → asset command list.
 */
function parseSceneMeta(extractedPath: string): Map<number, AssetEntry[]> {
  const asmPath = path.join(extractedPath, 'tables', 'scene_meta.asm');
  const src = fs.readFileSync(asmPath, 'utf-8').replace(/\r/g, '');
  const scenes = new Map<number, AssetEntry[]>();

  const entryPattern = /scene_meta_([0-9A-Fa-f]{4})\s*\[([\s\S]*?)\]/g;
  for (const m of src.matchAll(entryPattern)) {
    const sceneId = parseInt(m[1], 16);
    scenes.set(sceneId, parseSceneBody(m[2]));
  }

  return scenes;
}

/* ------------------------------------------------------------------ */
/*  PPU effect-offset table parser                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse display_preset_table.asm to extract the effect-layer VRAM page-select
 * flag for each PPU index. Byte 4 (0-indexed) bit 7 controls whether layer 2
 * tile indices are OR'd with $0100 (+256), shifting to page 1.
 * Bit 7 clear → effectOffset = true.
 */
function parsePpuEffectOffset(extractedPath: string): boolean[] {
  const asmPath = path.join(extractedPath, 'tables', 'display_preset_table.asm');
  if (!fs.existsSync(asmPath)) {
    console.warn('PPU display preset table not found, effectOffset will default to false');
    return [];
  }
  const src = fs.readFileSync(asmPath, 'utf-8').replace(/\r/g, '');

  // Each display-preset has 10 byte args; byte index 4 (5th arg) has the flag
  const entries = [...src.matchAll(/display-preset\s*<\s*((?:#\w+,\s*){4})(#\w+)/g)];
  return entries.map(m => {
    const byte4 = parseInt(m[2].replace('#', ''), 16);
    return (byte4 & 0x80) === 0;
  });
}

/* ------------------------------------------------------------------ */
/*  File collection                                                    */
/* ------------------------------------------------------------------ */

const TYPE_EXTENSIONS: Record<string, string> = {
  Bitmap: '.bin',
  Palette: '.pal',
  Tileset: '.set',
  Tilemap: '.map',
  Spritemap: '.sprite.asm',
};

const RELEVANT_TYPES = new Set(['Bitmap', 'Palette', 'Tileset', 'Tilemap']);

function getFileType(files: FilesJson, fileName: string): string {
  for (const groupData of Object.values(files)) {
    for (const sceneFiles of Object.values(groupData)) {
      if (fileName in sceneFiles) {
        return sceneFiles[fileName].type;
      }
    }
  }
  return 'Bitmap';
}

function findExtractedFile(
  files: FilesJson,
  extractedPath: string,
  fileName: string,
  fileType: string,
): string | null {
  const ext = TYPE_EXTENSIONS[fileType] || '.bin';
  const fullName = fileName + ext;

  for (const [g, groupData] of Object.entries(files)) {
    for (const [s, sceneFiles] of Object.entries(groupData)) {
      if (fileName in sceneFiles) {
        const scenePath = s === '' ? g : path.join(g, s);
        const filePath = path.join(extractedPath, scenePath, fullName);
        if (fs.existsSync(filePath)) return filePath;
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

function main(): void {
  const baseromPath = path.resolve(process.argv[2] ?? '../gaia-iog-baserom');
  const dbPath = path.join(baseromPath, 'db-us');
  const extractedPath = path.join(baseromPath, 'extracted');

  // 1. Read group structure (no assets — just prefix + scene id/description)
  const rawGroups: GroupsJson = JSON.parse(
    fs.readFileSync(path.join(dbPath, 'groups.json'), 'utf-8'),
  );

  // 2. Read file metadata
  const files: FilesJson = JSON.parse(
    fs.readFileSync(path.join(dbPath, 'files.json'), 'utf-8'),
  );

  // 3. Parse scene_meta.asm → sceneId → AssetEntry[]
  const sceneMeta = parseSceneMeta(extractedPath);
  console.log(`Parsed ${sceneMeta.size} scene_meta entries from ASM`);

  // 4. Parse PPU effect-offset table
  const ppuEffectOffset = parsePpuEffectOffset(extractedPath);

  // 5. Build the manifest groups by merging groups.json structure with scene_meta assets
  const groups: Record<string, GroupDef> = {};
  let matched = 0;
  let unmatched = 0;

  for (const [groupName, group] of Object.entries(rawGroups)) {
    const scenes: Record<string, SceneDef> = {};

    for (const [sceneName, sceneDef] of Object.entries(group.scenes)) {
      const assets = sceneMeta.get(sceneDef.id);
      if (!assets) {
        console.warn(`  No scene_meta entry for ${groupName}/${sceneName} (id ${sceneDef.id})`);
        unmatched++;
        scenes[sceneName] = {
          id: sceneDef.id,
          description: sceneDef.description,
          assets: [],
        };
        continue;
      }

      matched++;

      // Inject effectOffset into PPU entries
      for (const asset of assets) {
        if (asset.type === 'ppu' && typeof asset.meta.index === 'number') {
          asset.meta.effectOffset = ppuEffectOffset[asset.meta.index as number] ?? false;
        }
      }

      scenes[sceneName] = {
        id: sceneDef.id,
        description: sceneDef.description,
        assets,
      };
    }

    groups[groupName] = { prefix: group.prefix, scenes };
  }

  console.log(`Matched ${matched} scenes, ${unmatched} unmatched`);

  // 6. Collect binary asset files referenced by the manifest
  const collectedFiles = new Map<string, Uint8Array>();
  let missingCount = 0;

  for (const group of Object.values(groups)) {
    for (const scene of Object.values(group.scenes)) {
      for (const asset of scene.assets) {
        if (!asset.data || collectedFiles.has(asset.data)) continue;
        if (!['bitmap', 'palette', 'tileset', 'tilemap'].includes(asset.type)) continue;

        const fileType = getFileType(files, asset.data);
        if (!RELEVANT_TYPES.has(fileType)) continue;

        const ext = TYPE_EXTENSIONS[fileType] || '.bin';
        const archiveName = asset.data + ext;

        if (collectedFiles.has(archiveName)) continue;

        const filePath = findExtractedFile(files, extractedPath, asset.data, fileType);
        if (filePath) {
          collectedFiles.set(archiveName, new Uint8Array(fs.readFileSync(filePath)));
        } else {
          console.warn(`  Missing: ${asset.data} (${fileType})`);
          missingCount++;
        }
      }
    }
  }

  // 7. Build the ZIP
  const manifest = { game: 'illusion-of-gaia', groups };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const zipInput: Zippable = {
    'manifest.json': [manifestBytes, { level: 9 }],
  };

  for (const [name, data] of collectedFiles) {
    zipInput[name] = [data, { level: 9 }];
  }

  const zipped = zipSync(zipInput);

  const outPath = path.resolve('payload.zip');
  fs.writeFileSync(outPath, zipped);

  const sizeMB = (zipped.length / (1024 * 1024)).toFixed(2);
  console.log(`Payload: ${collectedFiles.size} files, ${sizeMB} MB`);
  if (missingCount > 0) {
    console.warn(`${missingCount} files not found in extracted/`);
  }
  console.log(`Written to: ${outPath}`);
}

main();
