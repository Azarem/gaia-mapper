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

Output: Full-size tilemap `ImageData` (width × height × 256 pixels per block).

### Stage 4: ImageData → Canvas

`CanvasView.setImageData(img)` stores the image in an offscreen canvas. `redraw()` composites the offscreen canvas onto the display canvas with pan/zoom transforms.

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

Two refresh modes prevent unnecessary work:

| Function | When | Effect |
|----------|------|--------|
| `refreshMainView()` | Scene load, window resize | Rebuilds tileset + tilemap images, calls `fitToView()` |
| `updateMainPixels()` | Tileset edit, VRAM import | Rebuilds tileset + tilemap images, preserves pan/zoom |

Both follow the same Stage 2 → Stage 3 → Stage 4 pipeline. The difference is whether the viewport resets.

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
