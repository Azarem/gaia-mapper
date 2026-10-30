# Gaia Mapper — SNES Data Model

How the app emulates SNES graphics hardware in `src/core/`.

## Virtual VRAM (`vram.ts`)

Emulates the SNES 64KB Video RAM as a flat `Uint8Array(0x10000)`.

| Address Range | Size | Content |
|---------------|------|---------|
| `0x0000-0x3FFF` | 16 KB | Unused (mode 7, etc.) |
| `0x4000-0x5FFF` | 8 KB | BG tiles page 0 (256 tiles × 32 bytes) |
| `0x6000-0x7FFF` | 8 KB | BG tiles page 1 (256 tiles × 32 bytes) |
| `0x8000-0xFFFF` | 32 KB | Sprite tiles |

**Key constants:** `BG_BASE = 0x4000`, `BG_PAGE_SIZE = 0x2000`, `BYTES_PER_TILE = 32`.

**Page offset:** Layer 1 (main) tileset reads from page 0 (`useOffset = false`). Layer 2 (effect) tileset reads from page 1 (`useOffset = true`). This matches the SNES BG12NBA register configuration used by IOG.

**Bitmap loading** (`loadBitmap`): Parameters use 512-byte units inherited from the game's scene_meta opcodes. `dstOffset=0` → page 0, `dstOffset=16` → page 1.

## Palette / CGRAM (`palette.ts`)

Emulates the 512-byte Color Generator RAM (256 colors × 2 bytes).

**Color format:** BGR555 — `bbbbb_ggggg_rrrrr` packed into a 16-bit word. Converted to RGBA8 via `Math.round(component * 255 / 31)`.

**Layout:** 8 BG palettes × 16 colors + 8 sprite palettes × 16 colors. Palette loading uses 2-byte units from the scene_meta opcode format.

## 4bpp Tile Decoding (`tile-decoder.ts`)

Each 8×8 tile occupies 32 bytes in VRAM with interleaved bitplanes:

```
Bytes  0-15: Bitplanes 0 & 1 (row-interleaved, 2 bytes/row)
Bytes 16-31: Bitplanes 2 & 3 (row-interleaved, 2 bytes/row)
```

`decodeTile8x8()` extracts 64 palette indices (0-15). `renderTile8x8()` composites into an RGBA pixel buffer with flip support.

## Tileset (`tileset.ts`)

A tileset is 2048 bytes (`TILESET_SIZE = 0x800`) containing 1024 16-bit entries. Each group of 4 consecutive entries forms one 16×16 metatile (TL, TR, BL, BR quadrants).

**Total:** 256 metatiles in an 8-column × 32-row grid. Rendered as a 128×512 pixel image.

**Entry bit layout (16-bit word):**

| Bits | Mask | Field |
|------|------|-------|
| 0-8 | `0x01FF` | VRAM tile index (0-511, spans both BG pages) |
| 9 | `0x0200` | Block flag (collision — prevents actor passage) |
| 10-12 | `0x1C00` | Palette index (0-7) |
| 13 | `0x2000` | Priority |
| 14 | `0x4000` | Horizontal mirror |
| 15 | `0x8000` | Vertical mirror |

> **Note on tile page selection:** The 9-bit tile index (bits 0-8) inherently spans both BG VRAM pages: indices 0-255 address page 0 (`$4000-$5FFF`), indices 256-511 address page 1 (`$6000-$7FFF`). Page selection is *not* controlled by bit 9 — that bit is the block/collision flag. For layer 2, the game engine (via `sub_028FCD`) may OR `$0100` into all tileset entries based on PPU table configuration, shifting tile lookups to page 1. The mapper mirrors this with `TilesetRenderer.useOffset`.

**Loading** uses 4-byte source units and 64-byte size units (matching scene_meta opcode 0x05).

## Tilemap (`tilemap.ts`)

Binary format: `[u8 width][u8 height][data...]`

Width/height are in 256-pixel blocks. Each block is a 16×16 grid of metatile indices. Each byte is an index into the tileset grid:
- Lower 3 bits: column (0-7)
- Upper 5 bits: row (0-31)

**Rendering** (`renderTilemapToImageData`): Iterates blocks → cells, copies 16×16 pixel regions from the pre-rendered tileset bitmap into the output image.

**Coordinate system** (`pixelToCell`): Pixel → tile (÷16) → block (÷16) + cell (mod 16). Used for mouse hit-testing.

### Tilemap Resize

`resizeTilemap(src, newWidth, newHeight, anchor)` creates a new tilemap at the target dimensions, copying individual metatiles into their new positions based on the anchor. Offsets are computed in metatile units (each block = 16 metatiles) for sub-block precision:

- **Horizontal:** `left` → offset 0, `right` → offset = delta × 16, `center` → delta × 8
- **Vertical:** `top` → offset 0, `bottom` → offset = delta × 16, `center` → delta × 8

When the change in width or height is an odd number of blocks, center anchors shift tiles by half a block (8 metatiles) so the content is truly centered. Metatiles that fall outside the new bounds are clipped. The maximum block count is `TILEMAP_MAX_BLOCKS = 32` (8192 / 256).

The 9 anchor positions are defined as the `TilemapAnchor` type:
```
top-left    | top-center    | top-right
middle-left | middle-center | middle-right
bottom-left | bottom-center | bottom-right
```

## Scene Loading (`scene-loader.ts`)

Scenes are loaded by executing an ordered list of asset commands from the manifest, mirroring the game's scene_meta script execution.

**Asset command types:**

| Type | Action |
|------|--------|
| `bitmap` | Load 4bpp tile data into VRAM (page 0 or 1) |
| `palette` | Load BGR555 palette data into CGRAM |
| `tileset` | Load tileset entries (layer bitmask: 1=main, 2=effect, 3=both) |
| `tilemap` | Load tilemap data (layer bitmask: 1=main, 2=effect) |
| `label` | Mark a checkpoint in the asset list |
| `jump` | Follow to a labeled checkpoint in another scene's asset list |
| `ppu` | Display preset: TM, TS, CGWSEL, CGADSUB and layer flags. Drives layer blending and the layer 2 tile page offset |

### Jump/Label System

Many scenes (172 out of ~240 in IOG) use `jump` commands to inherit shared assets from parent scenes. Example chain:

```
Eric's House (ID 4):
  ppu, music, palette, tilemap×2, jump→label 1

Label 1 declared in Lance's House (ID 3) at asset index 5:
  bitmap×2, tileset×2, jump→label 62

Label 62 declared in South Cape (ID 1) at asset index 9:
  sprite bitmap, sprite palette, spritemap
```

The scene loader builds a label index at startup and follows jumps recursively with cycle detection.

### Layer 2 / Effect Layer

The effect tileset reads from VRAM page 1 (`useOffset = true`) unless the scene's last `ppu` command has `layerFlags` bit 7 set. This matches the SNES hardware where BG1 and BG2 use separate character base addresses. The same `ppu` command sets `SceneState.blend`, which the compositor uses to combine the two layers.

## SceneState

The loaded scene holds all rendering state:

```typescript
interface SceneState {
  vram: VirtualVRAM;               // 64KB shared VRAM
  palette: PaletteState;           // 512-byte shared CGRAM
  mainTileset: TilesetRenderer;    // Layer 1 tileset (useOffset=false)
  effectTileset: TilesetRenderer;  // Layer 2 tileset (useOffset=true)
  mainTilemap: TilemapManager;     // Layer 1 tilemap
  effectTilemap: TilemapManager;   // Layer 2 tilemap
  blend: DisplayBlend;             // How layers 1 and 2 combine (from the ppu command)
  loadedAssets: LoadedAsset[];     // Tracked assets for the asset dropdown
}
```

### LoadedAsset Tracking

Each asset loaded during `executeAssetCommand` is recorded in `loadedAssets`:

```typescript
interface LoadedAsset {
  type: LoadedAssetType;               // 'tilemap' | 'tileset' | 'bitmap' | 'palette'
  filename: string;                    // Manifest data name (e.g., "map_sc03")
  resolvedKey: string;                 // Actual payload key (e.g., "map_sc03.map")
  extension: string;                   // File extension for import/export filtering
  layer: number;                       // Layer bitmask (0 for bitmap/palette, 1/2/3 for tileset/tilemap)
  meta: Record<string, number | boolean>;  // Original load parameters (offsets, sizes, flags)
}
```

This metadata enables round-trip import/export: `importAssetData()` replays the original load with stored offsets, and `exportAssetData()` reconstructs the native file format by overlaying modified data back into the original payload bytes.
