# Gaia Mapper — Rendering Pipeline

How SNES binary data becomes pixels on screen.

## Pipeline Stages

### Stage 1: VRAM → Decoded Tiles

`decodeTile8x8(vram, offset)` reads 32 bytes of interleaved 4bpp planar data and produces a 64-byte array of palette indices (0-15).

The bitplane interleaving scheme:
```
Row 0: [BP0_byte, BP1_byte] at offset+0, offset+1
Row 1: [BP0_byte, BP1_byte] at offset+2, offset+3
...
Row 7: [BP0_byte, BP1_byte] at offset+14, offset+15
Row 0: [BP2_byte, BP3_byte] at offset+16, offset+17
...
Row 7: [BP2_byte, BP3_byte] at offset+30, offset+31
```

For each pixel, the 4-bit index is assembled from one bit from each bitplane.

### Stage 2: Tiles → Tileset Bitmap

`TilesetRenderer.renderToImageData()` iterates all 256 metatiles:

1. For each metatile (4 entries), read the 16-bit entry word
2. Extract tile index, palette, H-flip, V-flip flags
3. Compute VRAM address: `tileIndex * 32 + BG_BASE + (useOffset ? 0x2000 : 0)`
4. Decode the 8×8 tile from VRAM
5. Render into the tileset bitmap at the correct 8×8 position within the 16×16 metatile cell

Output: 128×512 pixel RGBA `ImageData` (8 metatiles wide × 32 metatiles tall).

### Stage 3: Tileset Bitmap + Tilemap → Map Image

`renderTilemapToImageData()` iterates the tilemap's block grid:

1. For each byte in the tilemap data, extract column (bits 0-2) and row (bits 3-7)
2. Copy the 16×16 pixel region from the tileset bitmap at that metatile's position
3. Paste into the output image at the corresponding map position

Output: Full-size tilemap `ImageData` (width × height × 256 pixels per block). Stages 2 and 3 run **once per layer**, so each layer keeps its own tileset bitmap and map image (a "plane").

### Stage 3b: Layer Compositing

`compositeRegion()` (`src/core/compositor.ts`) blends the two layer planes into the image the canvas shows, the way the PPU would for the scene's display preset. The preset comes from the scene's `ppu` asset and is parsed on scene load into `SceneState.blend` (`src/core/display.ts`).

Layer 1 is BG1 and layer 2 is BG2. The preset registers that matter:

| Register | Preset byte | Used for |
|----------|-------------|----------|
| TM | +0 | Layers on the main screen |
| TS | +1 | Layers on the sub screen |
| CGWSEL | +2 | Bit 1: color math addend is the sub screen (else the fixed color). Bits 4-5: color-window gating |
| CGADSUB | +3 | Bits 0-1: math on BG1/BG2. Bit 5: math on backdrop. Bit 6: half. Bit 7: subtract |
| Layer flags | +4 | Bits 0-1: force the tile-priority bit on layer 1/2 tiles. Bit 7 clear: layer 2 tile page offset |

Per pixel, with both layers shown:

1. **Order.** Main and sub screen each pick their top opaque layer by BG priority: BG1 priority 1 > BG2 priority 1 > BG1 priority 0 > BG2 priority 0. A tile's priority is its tileset entry bit 13 OR the forced bit from the layer flags. With no priority bits, layer 1 covers layer 2.
2. **Color math.** If the main-screen top (or the backdrop) has its CGADSUB bit set and a sub-screen pixel exists, the result is `main ± sub` (halved when CGADSUB bit 6 is set), computed per 5-bit channel with clamping like the hardware. Backdrop math uses CGRAM entry 0.
3. Otherwise the main-screen top pixel is shown as-is.

`DisplayBlend.kind` summarizes the result for the status bar: `overlay` (layer 1 over layer 2), `additive`, `average` (half-add) or `subtractive`.

When **only one layer is shown** it is copied through untouched, whatever TM/TS say, so a layer can always be inspected and edited.

**Not modelled** (the status bar says so where it applies): OBJ and BG3; the fixed-color addend (a runtime `COLDATA` value, so fixed-color fades render unmodified); the color window (the engine initializes it empty, so math gated to "inside the window" is skipped and "outside the window" is applied everywhere); mosaic.

### Canvas area and layer 2 wrapping

The composite is **layer 1's size whenever layer 1 is shown**; layer 2 alone defines it only while layer 1 is hidden. This confined area is both the viewport content and the editable area.

Layer 2 is sampled **modulo its own size** in both directions, with its top-left at the canvas origin. The game does the same: `WrapMapIndex` wraps the map index modulo the layer's data size, so a layer 2 that is narrower than layer 1 repeats across it (Edward's Castle: layer 1 is 4×4 blocks, layer 2 is 1×4; the Great Wall maps are similar). A layer 2 that is larger than layer 1 is cropped to layer 1's area (South Cape house interiors: layer 1 is 1×1, layer 2 is 2×2); the rest of it is visible and editable by hiding layer 1.

Scenes that scroll layer 2 with parallax are drawn unscrolled; the preset carries no scroll ratio (it comes from the scene's camera actors).

### Stage 4: ImageData → Canvas

`CanvasView.setImageData(img)` stores the composite image in an offscreen canvas. `redraw()` composites the offscreen canvas onto the display canvas with pan/zoom transforms.

The offscreen canvas avoids re-uploading `ImageData` on every frame — only the `drawImage()` call runs during pan/zoom interactions.

## Color Conversion

BGR555 (SNES) → RGBA8 (Canvas):

```
Red   = (word & 0x1F) * 255 / 31
Green = ((word >> 5) & 0x1F) * 255 / 31
Blue  = ((word >> 10) & 0x1F) * 255 / 31
Alpha = 0xFF (opaque)
```

Palette index 0 is transparent (alpha = 0).

## Refresh Strategy

Two view refresh modes prevent unnecessary work:

| Function | When | Effect |
|----------|------|--------|
| `refreshMainView()` | Scene load, resize, nudge | Pushes the composite to the canvas and calls `fitToView()` |
| `updateMainPixels()` | Tileset edit, undo/redo, layer visibility or active-layer change | Pushes the composite, preserves pan/zoom unless the image size changed |

Behind them, `TilemapEditor` has three levels of rebuild:

| Method | When | Work |
|--------|------|------|
| `refresh()` | Scene load, asset import, resize/nudge | Stage 2 + 3 for both layers, then composite everything |
| `refreshLayer(layer)` | A layer's tileset changed | Stage 2 + 3 for that layer, then composite everything |
| `recomposite()` | Layer visibility changed | Composite only |

A stamp does not rebuild anything: it redraws the 16×16 cell in the edited layer's plane and re-blends every canvas cell that shows it from both planes (`patchLayerPixels` → `forEachCanvasTile` → `compositeCell`). Blending reads both layers, so those cells are recomputed from both rather than patched. A repeating layer 2 tile shows at several canvas cells, so one stamp can re-blend several.

Side-panel canvases (tileset picker, GFX viewer, palette) each have independent `refresh()` methods that re-render their specific content.

## Overlay Drawing

Overlays are drawn in the `onDraw` callback of `CanvasView`, which runs after the base image is composited. All overlay coordinates are in content-space pixels (pre-zoom).

| Overlay | Color | Context |
|---------|-------|---------|
| Grid lines | `rgba(255,255,255,0.25)` | All canvases when grid enabled |
| Hover box | `rgba(255,255,0,0.6)` | Tilemap (16×16) |
| Hover box | `rgba(255,0,255,0.6)` | GFX viewer (8×8) |
| Hover box | `rgba(255,255,255,0.5)` | Palette (full row) |
| Selected metatile | `rgba(0,255,255,0.7)` | Tileset picker (16×16 cyan) |
| Selected quad | `rgba(255,165,0,0.8)` | Tileset picker (8×8 orange) |
| Selected tile | `rgba(0,255,255,0.7)` | GFX viewer (8×8 cyan) |
| Selected palette | `rgba(0,255,255,0.7)` | Palette viewer (full row) |
