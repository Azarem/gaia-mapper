/**
 * Build the payload.zip archive from extracted baserom assets.
 *
 * Usage: tsx scripts/build-payload.ts --baserom ../gaia-iog-baserom
 *
 * Reads groups.json and files.json from the baserom's us/ directory,
 * collects all referenced binary assets from extracted/, and produces
 * a payload.zip with a manifest.json + flat asset files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { zipSync, type Zippable } from 'fflate';

interface FileEntry {
  start: number;
  end: number;
  type: string;
  compressed?: boolean;
}

interface GroupsJson {
  [group: string]: {
    prefix: string;
    scenes: {
      [scene: string]: {
        id: number;
        description: string;
        assets: Array<{
          type: string;
          data?: string;
          meta: Record<string, unknown>;
        }>;
      };
    };
  };
}

interface FilesJson {
  [group: string]: {
    [sceneOrEmpty: string]: {
      [filename: string]: FileEntry;
    };
  };
}

/**
 * Parse table_018000.asm to extract the effect-layer VRAM page-select flag for
 * each PPU index.  The game engine reads byte 4 of each PPU table entry:
 * when bit 7 is clear, layer 2 tile indices are OR'd with $0100 (+256),
 * shifting them from VRAM page 0 ($4000) to page 1 ($6000).
 */
function parsePpuEffectOffset(extractedPath: string): boolean[] {
  const asmPath = path.join(extractedPath, 'tables', 'table_018000.asm');
  if (!fs.existsSync(asmPath)) {
    console.warn('PPU table not found, effectOffset will default to false');
    return [];
  }
  const src = fs.readFileSync(asmPath, 'utf-8');
  const entries = [...src.matchAll(/unk7 < (#\w+), (#\w+), (#\w+), (#\w+), (#\w+)/g)];
  return entries.map(m => {
    const byte4 = parseInt(m[5].replace('#', ''), 16);
    return (byte4 & 0x80) === 0;
  });
}

const TYPE_EXTENSIONS: Record<string, string> = {
  Bitmap: '.bin',
  Palette: '.pal',
  Tileset: '.set',
  Tilemap: '.map',
  Spritemap: '.sprite.asm',
};

const RELEVANT_TYPES = new Set(['Bitmap', 'Palette', 'Tileset', 'Tilemap']);

function main(): void {
  const args = process.argv.slice(2);
  let baseromPath = args[0] ?? '../gaia-iog-baserom';

  if (!baseromPath) {
    console.error('Usage: tsx scripts/build-payload.ts --baserom <path-to-baserom>');
    process.exit(1);
  }

  baseromPath = path.resolve(baseromPath);
  const usPath = path.join(baseromPath, 'us');
  const extractedPath = path.join(baseromPath, 'extracted');

  const groups: GroupsJson = JSON.parse(fs.readFileSync(path.join(usPath, 'groups.json'), 'utf-8'));
  const files: FilesJson = JSON.parse(fs.readFileSync(path.join(usPath, 'files.json'), 'utf-8'));

  const ppuEffectOffset = parsePpuEffectOffset(extractedPath);
  for (const group of Object.values(groups)) {
    for (const scene of Object.values(group.scenes)) {
      for (const asset of scene.assets) {
        if (asset.type === 'ppu' && typeof asset.meta.index === 'number') {
          asset.meta.effectOffset = ppuEffectOffset[asset.meta.index as number] ?? false;
        }
      }
    }
  }

  const collectedFiles = new Map<string, Uint8Array>();
  let missingCount = 0;

  function findExtractedFile(group: string, fileName: string, fileType: string): string | null {
    const ext = TYPE_EXTENSIONS[fileType] || '.bin';
    const fullName = fileName + ext;

    const groupFiles = files[group];
    if (groupFiles) {
      for (const [sceneName, sceneFiles] of Object.entries(groupFiles)) {
        if (fileName in sceneFiles) {
          const scenePath = sceneName === '' ? group : path.join(group, sceneName);
          const filePath = path.join(extractedPath, scenePath, fullName);
          if (fs.existsSync(filePath)) return filePath;
        }
      }
    }

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

  function getFileType(fileName: string): string {
    for (const [group, groupData] of Object.entries(files)) {
      for (const [, sceneFiles] of Object.entries(groupData)) {
        if (fileName in sceneFiles) {
          return sceneFiles[fileName].type;
        }
      }
    }
    return 'Bitmap';
  }

  for (const [, group] of Object.entries(groups)) {
    for (const [, scene] of Object.entries(group.scenes)) {
      for (const asset of scene.assets) {
        if (!asset.data || collectedFiles.has(asset.data)) continue;
        if (!['bitmap', 'palette', 'tileset', 'tilemap'].includes(asset.type)) continue;

        const fileType = getFileType(asset.data);
        if (!RELEVANT_TYPES.has(fileType)) continue;

        const ext = TYPE_EXTENSIONS[fileType] || '.bin';
        const archiveName = asset.data + ext;

        for (const [groupName] of Object.entries(groups)) {
          const filePath = findExtractedFile(groupName, asset.data, fileType);
          if (filePath) {
            collectedFiles.set(archiveName, new Uint8Array(fs.readFileSync(filePath)));
            break;
          }
        }

        if (!collectedFiles.has(archiveName)) {
          console.warn(`  Missing: ${asset.data} (${fileType})`);
          missingCount++;
        }
      }
    }
  }

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
