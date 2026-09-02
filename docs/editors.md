# Gaia Mapper — Editor Components

How the interactive editors in `src/editor/` work.

## Layout

The UI is a three-panel layout:

```
┌──────────────────────────────────────────────────────────┐
│  Toolbar: [Scene ▾]  [Layer 1] [Grid]  [⟲ Undo] [⟳ Redo]  [Import GFX] [Export]  │
├──────────┬───────────────────────────┬───────────────────┤
│ Left     │ Main                      │ Right             │
│          │                           │                   │
│ Tileset  │   Tilemap Canvas          │ VRAM Tiles        │
│ Picker   │   (pannable, zoomable)    │                   │
│ 128×512  │                           │ Palette           │
│          │                           │                   │
│          │                           │ Properties        │
│          │                           │ ☑ H-Flip          │
│          │                           │ ☑ V-Flip          │
│          │                           │ ☑ Priority        │
│          │                           │ ☑ Block           │
│          │                           │ Tile: 42          │
│          │                           │ Pal: 3            │
├──────────┴───────────────────────────┴───────────────────┤
│  Status: (16, 32)  Picked metatile 5 quad 2             │
└──────────────────────────────────────────────────────────┘
```

## Tilemap Editor (`tilemap-editor.ts`)

The main canvas shows the full tilemap composed from the active layer's tileset.

**Interactions:**

| Input | Action |
|-------|--------|
| Left-click + drag | Stamp selected metatile onto map cells |
| Right-click | Pick metatile at cursor position → selects metatile + quadrant in tileset |
| Mouse wheel | Zoom in/out (through CanvasView) |
| Middle-click + drag | Pan the viewport (through CanvasView) |
| Hover | Yellow highlight box (16×16) follows cursor; coordinates shown in status bar |

**Stamp batching:** Left-click drag accumulates `TileChange` records (`{ blockX, blockY, cellX, cellY, oldValue, newValue }`). Duplicate coordinates within a drag are deduplicated. On mouse-up, `commitStampBatch()` returns the batch for the undo system.

**Right-click pick:** Determines the metatile index AND the 8×8 quadrant (0-3) under the cursor within the 16×16 metatile. Sets `state.selectedMetatile` and `state.selectedQuad`, emits `tileset:selected`.

**Overlay rendering:** Grid lines (when enabled, `rgba(255,255,255,0.25)`) and hover box (`rgba(255,255,0,0.6)`).

**Export:** Serializes the active tilemap to binary format and triggers a browser download as `.map`.

## Tileset Editor (`tileset-editor.ts`)

The left panel shows all 256 metatiles (8 columns × 32 rows) in a 128×512 pixel canvas.

**Interactions:**

| Input | Action |
|-------|--------|
| Left-click | Select metatile + 8×8 quadrant within it |
| Grid overlay | 16×16 grid (white) + finer 8×8 guides when enabled |

**Selection display:**
- Cyan box (16×16) highlights the selected metatile
- Orange box (8×8) highlights the selected quadrant within it

**On selection:** Calls `syncGfxAndPalette()` which reads the selected entry's tile index and palette from the tileset data and updates `state.selectedGfxTile` and `state.selectedPalette`. The VRAM viewer and palette viewer then highlight the matching tile/row.

**Property panel sync:** `updatePropertyPanel()` reads the entry's flip, priority, and block flags and updates the checkbox controls. Changing a checkbox calls `setEntryFlags()` which writes a new 16-bit word to the tileset data and returns old/new values for undo tracking.

**Tile assignment:** When a VRAM tile is clicked (`gfx:selected` event), `assignTile()` replaces the tile index bits in the current entry word while preserving all other flags.

## GFX Viewer (`gfx-viewer.ts`)

Right panel showing raw VRAM tiles in a 16-column grid. Renders 256 tiles per page (page determined by active layer's `useOffset` flag).

**Interactions:**

| Input | Action |
|-------|--------|
| Left-click | Select VRAM tile → emits `gfx:selected` → assigns to current tileset entry |
| Hover | Magenta highlight box on hovered tile |

**Selection display:** Cyan box on the currently selected tile.

**Rendering:** Each tile is decoded from VRAM using the currently selected palette for colorized preview (not grayscale).

## Palette Viewer (`palette-viewer.ts`)

Right panel showing 8 palette rows of 16 color swatches each.

**Interactions:**

| Input | Action |
|-------|--------|
| Left-click | Select palette row → emits `palette:selected` |
| Hover | White outline on hovered row |

**Selection display:** Cyan outline on the selected row.

## Scene Selector (`scene-selector.ts`)

Toolbar dropdown populated from the manifest. Shows `ID - Description` for each scene, sorted by ID. On change, calls the registered callback to load the new scene.

## CanvasView (`canvas-view.ts`)

Shared base class for the main tilemap canvas. Provides:

- **Pan:** Middle-click drag or right-click drag shifts the viewport offset
- **Zoom:** Mouse wheel scales 0.5×–32× with scroll-position-anchored zoom
- **DPR scaling:** Canvas backing store resolution = CSS size × `devicePixelRatio`. The 2D context is pre-scaled by DPR so all drawing coordinates remain in CSS pixels
- **Image smoothing:** Disabled on every `redraw()` call to enforce nearest-neighbor rendering
- **Offscreen canvas:** `setImageData()` stores pixel data in an offscreen canvas for efficient `drawImage()` compositing. `refreshOffscreen()` updates pixels in-place without re-creating the offscreen canvas
- **Callbacks:** `onHover`, `onClick`, `onDraw` (overlay), `onDragEnd` (stamp batch commit)
- **Drag tracking:** Tracks left-button drag state for stamp batching

## DPR / Crisp Rendering

All canvases enforce pixel-perfect rendering:

1. **CSS:** `image-rendering: pixelated; image-rendering: crisp-edges;`
2. **Canvas backing store:** `canvas.width = cssWidth * devicePixelRatio`
3. **Context transform:** `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
4. **Image smoothing:** `ctx.imageSmoothingEnabled = false` set on every redraw

Side-panel canvases (tileset picker, GFX viewer, palette) also apply DPR scaling internally.
