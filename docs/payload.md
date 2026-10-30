# Gaia Mapper — Payload System

How game assets get from the baserom into the browser.

## Overview

The app loads a single `payload.zip` file that contains a `manifest.json` and all binary asset files. This ZIP is built offline from an extracted baserom and served as a static file alongside the HTML page.

## Build Pipeline

```
gaia-iog-baserom/
├── db-us/groups.json                  ← Scene grouping structure (prefix, ids, descriptions)
├── db-us/files.json                   ← File metadata (type, offsets)
├── extracted/tables/scene_meta.asm    ← Per-scene asset commands (parsed from ROM)
├── extracted/tables/display_preset_table.asm ← PPU display presets (effect offset flags)
└── extracted/                         ← Raw binary assets (.bin, .pal, .set, .map)
         │
         ▼
    tsx scripts/build-payload.ts ../gaia-iog-baserom
         │
         ▼
    payload.zip (~850KB compressed)
    ├── manifest.json    ← Scene graph + asset commands
    ├── gfx_south_cape.bin
    ├── pal_sc03.pal
    ├── set_sc03.set
    ├── map_sc03.map
    └── ... (~600 files)
```

### `build-payload.ts`

Reads three data sources from the baserom:

1. **`db-us/groups.json`** — Scene grouping structure (group names, prefixes, scene names/IDs/descriptions). Does NOT contain asset commands.
2. **`extracted/tables/scene_meta.asm`** — Parsed to extract per-scene asset command lists. Each `scene_meta_XXXX` block is matched to a `groups.json` scene by its hex scene ID.
3. **`db-us/files.json`** — File metadata (type, offsets) used to locate extracted binary files.

Additionally, `extracted/tables/display_preset_table.asm` is parsed (47 ten-byte records) and the first five bytes of each record are injected into the matching `ppu` asset entries. The build fails if a `ppu` entry references a preset that does not exist.

For each referenced asset:

1. Determines the file type (Bitmap, Palette, Tileset, Tilemap) from `files.json`
2. Appends the appropriate extension (`.bin`, `.pal`, `.set`, `.map`)
3. Locates the file in `extracted/{group}/{scene}/`
4. Adds it to the ZIP archive with level 9 compression

The manifest merges `groups.json` structure with parsed `scene_meta.asm` assets, wrapped with a `game` field.

### File Naming

The manifest references assets by bare name (e.g., `map_sc03`). The payload ZIP stores them with extensions (e.g., `map_sc03.map`). The scene loader's `resolveFile()` function tries appending common extensions to resolve bare names.

**Extension mapping:**

| Asset Type | Extension |
|-----------|-----------|
| Bitmap | `.bin` |
| Palette | `.pal` |
| Tileset | `.set` |
| Tilemap | `.map` |
| Spritemap | `.sprite.asm` |

## Runtime Loading (`payload.ts`)

1. **Check IndexedDB cache** for the payload URL plus format version (`PAYLOAD_VERSION` in `index.ts`; bump it whenever the payload format changes so clients re-download, and older cached versions are pruned)
2. If not cached, **fetch** the ZIP via HTTP
3. **Store** the raw ArrayBuffer in IndexedDB for next time
4. **Unzip** with `fflate.unzipSync()` → `Map<string, Uint8Array>`

The cache key is the URL plus the format version (`<url>?v=<n>`). Call `clearCache()` to force re-download.

## Manifest Format (`manifest.ts`)

```typescript
interface PayloadManifest {
  game: string;                          // e.g. "illusion-of-gaia"
  groups: Record<string, GroupDef>;      // "south_cape", "edward_castle", etc.
}

interface GroupDef {
  prefix: string;
  scenes: Record<string, SceneDef>;     // "sc03", "sc04", etc.
}

interface SceneDef {
  id: number;                            // Unique scene ID
  description: string;                   // Human-readable name
  assets: AssetEntry[];                  // Ordered command list
}

interface AssetEntry {
  type: 'ppu' | 'bitmap' | 'palette' | 'tileset' | 'tilemap'
      | 'spritemap' | 'music' | 'label' | 'jump';
  data?: string;                         // Filename (bare, no extension)
  meta: Record<string, number | boolean>; // Type-specific parameters
}
```

### Asset Entry `meta` Fields

**ppu:** `{ index, tm, ts, cgwsel, cgadsub, layerFlags }` — PPU display preset index plus the first five bytes of its `display_preset_table` record: TM, TS, CGWSEL, CGADSUB and the layer flags byte. `scene-loader.ts` parses these into `SceneState.blend` (how the two layers combine, see `rendering.md`) and sets the layer 2 tile page offset from `layerFlags` bit 7 (clear = tiles shift to VRAM page 1). Payloads older than version 2 lack these fields and fail to load.

**bitmap:** `{ srcOffset, sizeW, dstOffset, isSprite }` — all in 512-byte units. `isSprite=true` writes to sprite VRAM region.

**palette:** `{ srcOffset, sizeW, dstOffset }` — all in 2-byte units.

**tileset:** `{ srcOffset, sizeW, dstOffset, layer }` — `srcOffset`/`dstOffset` in 4-byte units, `sizeW` in 64-byte units. `layer` is a bitmask: 1=main, 2=effect, 3=both.

**tilemap:** `{ layer }` — bitmask: 1=main, 2=effect.

**label:** `{ id }` — integer label ID (jump target declaration).

**jump:** `{ label }` — integer label ID to jump to.

### scene_meta.asm → AssetEntry Mapping

| ASM Command | AssetEntry type | meta fields |
|-------------|----------------|-------------|
| `display-mode < #XX >` | `ppu` | `index` (+ injected `tm`, `ts`, `cgwsel`, `cgadsub`, `layerFlags`) |
| `bitmap < #a, #b, #c, @file, #mode >` | `bitmap` | `srcOffset=a, sizeW=b, dstOffset=c, isSprite=(mode>0)` |
| `palette < #a, #b, #c, @file >` | `palette` | `srcOffset=a, sizeW=b, dstOffset=c` |
| `tileset < #a, #b, #c, #layer, @file >` | `tileset` | `srcOffset=a, sizeW=b, dstOffset=c, layer` |
| `tilemap < #layer, @file >` | `tilemap` | `layer` |
| `music < ... >` | `music` | `{}` |
| `spritemap < #size, #flags, @file >` | `spritemap` | `{}` |
| `meta_label_XX:` | `label` | `id=0xXX` |
| `jump < #XX >` | `jump` | `label=0xXX` |
| `branch`, `char-tiles`, `meta-skip` | *(skipped)* | — |

## Serving

The payload must be served over HTTP (not `file://`) for `fetch()` to work. During development:

```bash
npx serve .        # serves index.html + payload.zip
```
