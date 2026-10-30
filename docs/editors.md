# Gaia Mapper — Editor Components

How the interactive editors in `src/editor/` work.

## Layout

The UI is a three-panel layout:

```
┌──────────────────────────────────────────────────────────┐
│  Toolbar: [Scene ▾]  [Layer 1 ▾] [Grid] [⊞ Resize]  [⟲] [⟳]  │
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

The main canvas shows the scene's **visible layers blended** the way the game's display preset combines them (see `rendering.md` Stage 3b). Edits only ever touch the **active layer**, whose tileset fills the picker. Overlays (grid, block view, hover, stamp previews) follow the active layer.

**Canvas area and wrapping.** While layer 1 is shown, the canvas, zoom-to-fit and the editable area are layer 1's size, whichever layer is active. Pointer positions are canvas positions and the active layer maps them to its own tiles modulo its size (`toLayerTile`):

- Layer 2 smaller than layer 1 (Edward's Castle: 1×4 under 4×4): it repeats. A stamp lands on the wrapped layer 2 tile and appears at every repeat; previews are drawn at every repeat, the hover box also marks the other repeats dimmer, and the coordinate readout shows the layer tile (`Map (4, 2) (wrapped from 20, 2)`). A drag region that covers several repeats writes in reading order, so the last write to a layer tile wins, and the preview shows that result. Patterns crossing a repeat seam wrap to the other edge.
- Layer 2 larger than layer 1 (a South Cape house: 2×2 under 1×1): only the part under layer 1's area can be clicked, stamped or selected. Hide layer 1 to edit the rest.
- Layer 1 hidden: the canvas is layer 2's own size and nothing wraps.

The status bar says when the active layer repeats or is cropped (`describeLayerFit`).

Undo records tile changes in the layer's own block/cell coordinates, so they undo correctly whatever the canvas shows.

**Interactions:**

| Input | Action |
|-------|--------|
| Left-click + drag | Stamp selected metatile onto map cells |
| Ctrl + left-click | Dropper/eyedropper mode — picks the metatile at cursor (same as right-click) |
| Right-click | Pick metatile at cursor position → selects metatile + quadrant in tileset |
| Mouse wheel | Zoom in/out (through CanvasView) |
| Middle-click + drag | Pan the viewport (through CanvasView) |
| Shift + left-click + drag | Pan the viewport (alternative) |
| Hover | Yellow highlight box (16×16) follows cursor; coordinates shown in status bar |

**Ctrl dropper mode:** Holding Ctrl changes the cursor to `copy` as visual feedback. Ctrl+left-click is remapped to button 2 (dropper) in `index.ts`, so `TilemapEditor.onClick` runs its pick/eyedropper logic. Ctrl+left-drag does *not* start a stamp batch — `isLeftDragging` is suppressed when `ctrlKey` is true.

**Stamp batching:** Left-click drag accumulates `TileChange` records (`{ blockX, blockY, cellX, cellY, oldValue, newValue }`). Duplicate coordinates within a drag are deduplicated. On mouse-up, `commitStampBatch()` returns the batch for the undo system.

**Right-click pick:** Determines the metatile index AND the 8×8 quadrant (0-3) under the cursor within the 16×16 metatile. Sets `state.selectedMetatile` and `state.selectedQuad`, emits `tileset:selected`.

**Overlay rendering:** Grid lines (when enabled, `rgba(255,255,255,0.25)`) and hover box (`rgba(255,255,0,0.6)`).

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

## Asset Dropdown

The "Layer" button in the toolbar doubles as an asset dropdown trigger. Clicking it reveals a panel listing all assets loaded for the current scene, grouped by type in the order: Tilemaps, Tilesets, Bitmaps, Palettes.

Each asset entry shows:

| Element | Description |
|---------|-------------|
| Type icon | Colored inline SVG (blue grid for tilemap, green grid for tileset, orange frame for bitmap, purple circle for palette) |
| Filename | The asset's manifest data name + layer hint (e.g., `map_sc03 L1`) |
| Visibility button | Tilemaps only — eye icon, shows or hides that layer. Disabled on the last visible layer |
| Edit button | Tilemaps only — pencil icon, makes that layer the active (edited) layer. Highlighted on the active layer |
| Import button | Down-arrow icon — opens a file picker filtered by the asset's extension (`.map`, `.set`, `.bin`, `.pal`) |
| Export button | Up-arrow icon — serializes the current in-memory data back to the native format and downloads it |

**Edit:** Calls `selectLayerForEdit()` for whichever layer the tilemap belongs to (determined by its layer bitmask), then closes the dropdown and emits `status:info`.

- Both layers visible: only the active layer changes.
- Only one layer visible: the visible layer is hidden and the selected layer is shown, so the edited layer is always on screen.

**Visibility:** Calls `toggleLayerVisibility()`. The dropdown stays open and rebuilds in place.

- Turning a layer **on** only displays it. The active layer does not change.
- Turning a layer **off** while it is the active layer makes the other layer active.
- The last visible layer cannot be turned off (its eye is disabled).

Both layers are visible after a scene load, with layer 1 active. A scene with a single tilemap has nothing to toggle: its only layer is always visible.

**Layer-aware undo:** Tilemap and tileset history entries record the layer they were made on and apply to it on undo/redo, regardless of which layer is active at that point.

**Import:** Sets `fileInput.accept` to the asset's extension, then reads the selected file via `FileReader` and passes the raw bytes to `importAssetData()` in `scene-loader.ts`. This replays the original load operation with the stored meta offsets (source/destination offsets, size, flags). Emits `asset:imported` to trigger a full refresh.

**Export:** Calls `exportAssetData()` in `scene-loader.ts`, which retrieves the original payload file, copies it, and overlays the modified in-memory data at the correct byte ranges. The result is downloaded with the resolved filename from the payload.

**Mutual exclusion:** Opening the asset dropdown closes the resize dropdown (and vice versa). Clicking outside or pressing Escape closes either.

**Layer reset on scene switch:** When a new scene is loaded, `state.activeLayer` is automatically reset to `1`, both layers are made visible, and the button text is updated. The status bar reports the scene's blend (e.g. "Additive blend").

## Tilemap Resize

The resize button (SVG icon showing a dashed old rectangle + solid new rectangle) opens a dropdown panel with:

| Control | Description |
|---------|-------------|
| Width input | Number input (min 1), pre-populated with current tilemap width in blocks |
| Height input | Number input (min 1), pre-populated with current tilemap height in blocks |
| Anchor grid | 3×3 grid of selectable cells (default: top-right) controlling where existing content is anchored within the new dimensions |
| Info text | Shows block count (e.g., `2×3 = 6 blocks (max 32)`) — turns red if constraints are violated |
| Cancel/Resize buttons | Cancel closes the dropdown; Resize applies the operation |

**Anchor positions:** `top-left`, `top-center`, `top-right`, `middle-left`, `middle-center`, `middle-right`, `bottom-left`, `bottom-center`, `bottom-right`. The anchor determines where the existing tile data is placed within the resized tilemap. For example, `top-right` keeps existing content pinned to the top-right corner while the map expands left and/or downward.

**Constraints:** `width × height` must not exceed `TILEMAP_MAX_BLOCKS` (32 blocks = 8192 bytes / 256 bytes per block). The Resize button is disabled when constraints are violated.

**Implementation:** `resizeTilemap()` in `src/core/tilemap.ts` computes horizontal and vertical offsets in metatile units (each block = 16 metatiles), creates a new `TILEMAP_MAX_DATA`-sized buffer, and copies each source metatile to its offset position in the destination. Center anchors use `delta × 8` metatiles, giving half-block precision when the change is an odd number of screens. Metatiles that fall outside the new dimensions are clipped.

**Undo/redo:** `makeResizeAction()` captures the target layer and snapshots of both old and new tilemap state (`width`, `height`, `data` copy). Undo restores the old snapshot; redo re-applies the new one. Fresh `Uint8Array` copies are made on each invocation to prevent cross-contamination with subsequent edits.

## Scene Selector (`scene-selector.ts`)

Toolbar dropdown populated from the manifest. Shows `ID - Description` for each scene, sorted by ID. On change, calls the registered callback to load the new scene. Loading a new scene resets the active layer to 1.

## CanvasView (`canvas-view.ts`)

Shared base class for the main tilemap canvas. Provides:

- **Pan:** Middle-click drag or Shift+left-click drag shifts the viewport offset
- **Zoom:** Mouse wheel scales 0.25×–32× with scroll-position-anchored zoom
- **DPR scaling:** Canvas backing store resolution = CSS size × `devicePixelRatio`. The 2D context is pre-scaled by DPR so all drawing coordinates remain in CSS pixels
- **Image smoothing:** Disabled on every `redraw()` call to enforce nearest-neighbor rendering
- **Offscreen canvas:** `setImageData()` stores pixel data in an offscreen canvas for efficient `drawImage()` compositing. `refreshOffscreen()` updates pixels in-place without re-creating the offscreen canvas
- **Callbacks:** `onHover`, `onClick(x, y, button, ctrlKey)`, `onDraw` (overlay), `onDragEnd` (stamp batch commit)
- **Drag tracking:** Tracks left-button drag state for stamp batching. Ctrl+left-click suppresses drag tracking (dropper mode)
- **Ctrl modifier forwarding:** `ctrlKey` is passed through `onClick` so callers can remap the effective button (e.g., Ctrl+left → dropper)

## DPR / Crisp Rendering

All canvases enforce pixel-perfect rendering:

1. **CSS:** `image-rendering: pixelated; image-rendering: crisp-edges;`
2. **Canvas backing store:** `canvas.width = cssWidth * devicePixelRatio`
3. **Context transform:** `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
4. **Image smoothing:** `ctx.imageSmoothingEnabled = false` set on every redraw

Side-panel canvases (tileset picker, GFX viewer, palette) also apply DPR scaling internally.
