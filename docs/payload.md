# Gaia Mapper — Payload System

How game assets get from the baserom into the browser.

## Overview

The app loads a single `payload.zip` file that contains a `manifest.json` and all binary asset files. This ZIP is built offline from an extracted baserom and served as a static file alongside the HTML page.

## Build Pipeline

```
gaia-iog-baserom/
├── us/groups.json       ← Scene definitions, asset lists
├── us/files.json        ← File metadata (type, offsets)
└── extracted/           ← Raw binary assets (.bin, .pal, .set, .map)
         │
         ▼
    tsx scripts/build-payload.ts ../gaia-iog-baserom
         │
         ▼
    payload.zip (~600KB compressed)
    ├── manifest.json    ← Scene graph + asset commands
    ├── gfx_south_cape.bin
    ├── pal_sc03.pal
    ├── set_sc03.set
    ├── map_sc03.map
    └── ... (~200 files)
```

### `build-payload.ts`

Reads `groups.json` (scene definitions) and `files.json` (file metadata) from the baserom's `us/` directory. For each referenced asset:

1. Determines the file type (Bitmap, Palette, Tileset, Tilemap) from `files.json`
2. Appends the appropriate extension (`.bin`, `.pal`, `.set`, `.map`)
3. Locates the file in `extracted/{group}/{scene}/`
4. Adds it to the ZIP archive with level 9 compression

The manifest is the `groups.json` content wrapped with a `game` field.

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

1. **Check IndexedDB cache** for the payload URL
2. If not cached, **fetch** the ZIP via HTTP
3. **Store** the raw ArrayBuffer in IndexedDB for next time
4. **Unzip** with `fflate.unzipSync()` → `Map<string, Uint8Array>`

The cache key is the URL string. Call `clearCache()` to force re-download.

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

**bitmap:** `{ srcOffset, sizeW, dstOffset, sprite }` — all in 512-byte units. `sprite=true` writes to sprite VRAM region.

**palette:** `{ srcOffset, sizeW, dstOffset }` — all in 2-byte units.

**tileset:** `{ srcOffset, sizeW, dstOffset, layer }` — `srcOffset`/`dstOffset` in 4-byte units, `sizeW` in 64-byte units. `layer` is a bitmask: 1=main, 2=effect, 3=both.

**tilemap:** `{ layer }` — bitmask: 1=main, 2=effect.

**label:** `{ label }` — integer label ID.

**jump:** `{ label }` — integer label ID to jump to.

## Serving

The payload must be served over HTTP (not `file://`) for `fetch()` to work. During development:

```bash
npx serve .        # serves index.html + payload.zip
```
