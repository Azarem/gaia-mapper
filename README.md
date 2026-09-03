# Gaia Mapper

Browser-based SNES tileset and tilemap editor for Illusion of Gaia and other Quintet-engine games. Built with vanilla TypeScript, HTML5 Canvas 2D, and zero UI frameworks.

## Table of Contents

- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Building the Payload](#building-the-payload)
  - [Running the Editor](#running-the-editor)
- [Interface Overview](#interface-overview)
  - [Layout](#layout)
  - [Toolbar](#toolbar)
- [Loading a Scene](#loading-a-scene)
- [Navigating the Map](#navigating-the-map)
- [Editing Tilemaps](#editing-tilemaps)
  - [Stamping Tiles](#stamping-tiles)
  - [Picking Tiles (Eyedropper)](#picking-tiles-eyedropper)
  - [Resizing a Tilemap](#resizing-a-tilemap)
- [Working with the Tileset](#working-with-the-tileset)
  - [Selecting Metatiles](#selecting-metatiles)
  - [Editing Tileset Entries](#editing-tileset-entries)
  - [Assigning VRAM Tiles](#assigning-vram-tiles)
- [VRAM Tiles Panel](#vram-tiles-panel)
- [Palette Panel](#palette-panel)
- [Properties Panel](#properties-panel)
- [Asset Management](#asset-management)
  - [Asset Dropdown](#asset-dropdown)
  - [Importing Assets](#importing-assets)
  - [Exporting Assets](#exporting-assets)
  - [Switching Layers](#switching-layers)
- [Undo and Redo](#undo-and-redo)
- [Grid Overlay](#grid-overlay)
- [Keyboard and Mouse Reference](#keyboard-and-mouse-reference)
- [Technical Details](#technical-details)
  - [Payload Format](#payload-format)
  - [Tilemap Data Model](#tilemap-data-model)
  - [Tileset Entry Format](#tileset-entry-format)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Getting Started

### Prerequisites

- **Node.js 18+**
- Access to the `gaia-iog-baserom` repository (for building the asset payload)

### Installation

```bash
cd gaia-mapper
npm install
```

### Building the Payload

The editor loads scene assets from a `payload.zip` file. This must be built from an extracted IOG baserom:

```bash
npm run payload ../gaia-iog-baserom
```

This reads the scene definitions and file metadata from the baserom's `us/` directory, collects binary assets from `extracted/`, and produces a `payload.zip` (~600KB) in the project root.

The payload is gitignored — each developer must build it locally.

### Running the Editor

Build the app and serve it over HTTP:

```bash
npm run build         # produces dist/app.iife.js
npx serve .           # serves on http://localhost:3000
```

Open the URL in your browser. The editor will fetch `payload.zip`, cache it in IndexedDB, and populate the scene selector.

For development with auto-rebuild:

```bash
npm run dev           # watch mode with auto-rebuild
```

> **Note:** `file://` URLs will not work — `fetch()` requires HTTP.

---

## Interface Overview

### Layout

The editor uses a three-panel layout:

```
┌─────────────────────────────────────────────────────────┐
│  Toolbar                                                │
├──────────┬──────────────────────────┬───────────────────┤
│ Left     │ Main Canvas             │ Right Panel       │
│ Panel    │                         │                   │
│          │ (Tilemap view —         │ VRAM Tiles        │
│ Tileset  │  pannable, zoomable)    │                   │
│ Picker   │                         │ Palette           │
│          │                         │                   │
│          │                         │ Properties        │
├──────────┴──────────────────────────┴───────────────────┤
│  Status Bar                                             │
└─────────────────────────────────────────────────────────┘
```

- **Left Panel** — Tileset picker showing all 256 metatiles in an 8-column grid
- **Main Canvas** — The full tilemap, composed from the active layer's tileset
- **Right Panel** — VRAM tile viewer, palette swatches, and property controls
- **Status Bar** — Shows cursor coordinates and informational messages

### Toolbar

The toolbar contains the following controls (left to right):

| Control | Description |
|---------|-------------|
| **Gaia Mapper** | App title |
| **Scene selector** | Dropdown to choose which scene to load |
| **Layer N ▾** | Asset dropdown — lists all loaded assets; click to open |
| **Grid** | Toggle grid overlay on all canvases |
| **Resize** (icon) | Open the tilemap resize dropdown |
| **⟲ Undo** | Undo the last edit (also Ctrl+Z) |
| **⟳ Redo** | Redo the last undone edit (also Ctrl+Y / Ctrl+Shift+Z) |

---

## Loading a Scene

1. Use the **Scene selector** dropdown in the toolbar
2. Scenes are listed as `ID - Description` (e.g., `3 - South Cape`)
3. Select a scene to load it — the editor will execute the scene's asset commands, including following jump chains to inherit shared assets from parent scenes
4. The active layer is automatically reset to **Layer 1** when a new scene loads

Most IOG scenes use `jump` commands to inherit graphics from parent scenes. For example, Eric's House (ID 4) inherits bitmap and tileset data from Lance's House (ID 3), which in turn inherits from South Cape (ID 1).

---

## Navigating the Map

The main canvas supports panning and zooming:

| Input | Action |
|-------|--------|
| **Mouse wheel** | Zoom in/out (0.25x to 32x, anchored to cursor position) |
| **Middle-click + drag** | Pan the viewport |
| **Shift + left-click + drag** | Pan the viewport (alternative) |

The cursor position in the tilemap is shown in the status bar at the bottom.

---

## Editing Tilemaps

### Stamping Tiles

1. Select a metatile in the **Tileset Picker** (left panel) by clicking on it
2. **Left-click** on the main canvas to stamp the selected metatile at that position
3. **Left-click + drag** to paint multiple cells in a single stroke

All cells painted during one mouse-down-to-mouse-up drag are batched into a single undoable action. If you drag back over a cell you already painted in the same stroke, it is deduplicated (only the first old→new pair is recorded).

### Picking Tiles (Eyedropper)

There are two ways to pick a metatile from the map:

| Method | How |
|--------|-----|
| **Right-click** | Click any cell on the map to pick the metatile at that position |
| **Ctrl + left-click** | Hold Ctrl and left-click (dropper mode) |

Both methods determine the metatile index **and** the 8x8 quadrant (top-left, top-right, bottom-left, bottom-right) under the cursor. The picked metatile becomes the active selection in the tileset picker, and the corresponding VRAM tile and palette are highlighted in the right panel.

**Visual feedback:** When you hold Ctrl, the cursor changes to a `copy` icon to indicate dropper mode. Releasing Ctrl restores the normal `crosshair` cursor.

**Drag behavior:** Ctrl+left-click does not start a stamp drag, so you can safely hold Ctrl and click around without accidentally placing tiles.

### Resizing a Tilemap

The tilemap resize feature lets you change the dimensions (in 256-pixel blocks) of the current tilemap while controlling where existing content is positioned.

1. Click the **Resize button** (icon showing overlapping rectangles) in the toolbar
2. A dropdown panel appears with:
   - **Width** and **Height** number inputs, pre-populated with the current dimensions
   - A **3x3 anchor grid** showing 9 alignment positions
   - A **block count** display (e.g., "2×3 = 6 blocks (max 32)")
   - **Cancel** and **Resize** buttons

3. Set the desired width and height
4. Choose an anchor position by clicking one of the 9 cells:

```
┌────────────┬────────────┬────────────┐
│  Top-Left  │ Top-Center │ Top-Right  │   ← default
├────────────┼────────────┼────────────┤
│ Middle-Left│   Center   │Middle-Right│
├────────────┼────────────┼────────────┤
│Bottom-Left │Bottom-Centr│Bottom-Right│
└────────────┴────────────┴────────────┘
```

The anchor determines where the existing tile data is placed within the new dimensions. For example:
- **Top-Right** (default): Existing content stays in the top-right corner; the map expands left and/or downward
- **Center**: Existing content is centered; the map expands evenly in all directions
- **Bottom-Left**: Existing content stays in the bottom-left corner

5. Click **Resize** to apply — the operation is fully undoable

**Constraints:**
- Width and height must each be at least 1
- The total block count (`width × height`) must not exceed 32 (the 8KB tilemap data limit)
- The Resize button is disabled and the info text turns red when constraints are violated

---

## Working with the Tileset

### Selecting Metatiles

The **Tileset Picker** in the left panel shows all 256 metatiles (8 columns × 32 rows) rendered at 128×512 pixels.

- **Left-click** on any metatile to select it for stamping
- Clicking also selects the specific **8×8 quadrant** within the 16×16 metatile (based on which quarter you click)
- A **cyan box** (16×16) highlights the selected metatile
- An **orange box** (8×8) highlights the selected quadrant

### Editing Tileset Entries

Each metatile is composed of 4 tileset entries (one per 8×8 quadrant: TL, TR, BL, BR). Each entry is a 16-bit word encoding:

| Property | Description |
|----------|-------------|
| **Tile index** (bits 0-8) | Which VRAM tile to display (0-511) |
| **Block/page flag** (bit 9) | Tile page selector |
| **Palette** (bits 10-12) | Which palette row to use (0-7) |
| **Priority** (bit 13) | BG priority bit |
| **H-Flip** (bit 14) | Horizontal mirror |
| **V-Flip** (bit 15) | Vertical mirror |

Use the **Properties panel** (right panel, bottom) to toggle H-Flip, V-Flip, Priority, and Block flags. Changes are applied to the currently selected quadrant and are undoable.

### Assigning VRAM Tiles

1. Select a metatile quadrant in the tileset picker
2. Click a tile in the **VRAM Tiles** panel (right panel, top)
3. The clicked VRAM tile is assigned to the selected quadrant's tile index

This operation is undoable.

---

## VRAM Tiles Panel

The VRAM Tiles panel (right panel, top) shows raw 8×8 tiles from the 64KB Virtual VRAM in a 16-column grid.

- Displays 256 tiles per page (page depends on the active layer's VRAM offset)
- Tiles are rendered using the **currently selected palette** for colorized preview
- **Left-click** a tile to assign it to the selected tileset entry
- **Hover** shows a magenta highlight on the hovered tile
- **Cyan highlight** marks the currently selected tile

---

## Palette Panel

The Palette panel (right panel, middle) shows 8 palette rows of 16 color swatches each, representing the SNES CGRAM.

- **Left-click** a row to select it as the active palette
- The selected palette affects how VRAM tiles are previewed in both the VRAM Tiles panel and the tileset picker
- **White outline** on hover; **cyan outline** on the selected row

---

## Properties Panel

The Properties panel (right panel, bottom) shows and controls the flags for the currently selected tileset entry:

| Control | Description |
|---------|-------------|
| **H-Flip** checkbox | Horizontal mirror |
| **V-Flip** checkbox | Vertical mirror |
| **Priority** checkbox | BG priority bit |
| **Block** checkbox | Page/block flag (bit 9) |
| **Tile** readout | Current VRAM tile index |
| **Palette** readout | Current palette row index |

Changing any checkbox immediately updates the tileset entry and is undoable.

---

## Asset Management

### Asset Dropdown

Click the **Layer N ▾** button in the toolbar to open the asset dropdown. This panel lists all assets loaded for the current scene, grouped by type:

1. **Tilemaps** — Blue grid icon
2. **Tilesets** — Green grid icon
3. **Bitmaps** — Orange frame icon
4. **Palettes** — Purple circle icon

Each asset entry shows:
- A **type icon** (color-coded SVG)
- The **asset filename** and layer hint (e.g., `map_sc03 L1`)
- An **Import button** (down-arrow) to replace the asset data from a file
- An **Export button** (up-arrow) to save the asset data to a file
- For tilemaps: an **Edit button** (pencil) to switch to editing that tilemap's layer

### Importing Assets

1. Open the asset dropdown
2. Click the **Import** (↓) button next to any asset
3. A file picker opens, filtered to the appropriate extension (`.map`, `.set`, `.bin`, or `.pal`)
4. Select a file — the raw data replaces the in-memory asset using the same load parameters (offsets, sizes, flags) as the original
5. All editors refresh automatically

Import replays the original load operation, so the replacement file should match the expected format and size.

### Exporting Assets

1. Open the asset dropdown
2. Click the **Export** (↑) button next to any asset
3. The editor reconstructs the original file format:
   - **Tilemaps**: Serialized directly from the in-memory state (2-byte header + tile data)
   - **Tilesets, Bitmaps, Palettes**: The original payload file is copied and the modified byte range is overlaid at the correct offsets
4. The file is downloaded with its original filename

### Switching Layers

The editor supports two tilemap layers per scene:

- **Layer 1** (main): Uses VRAM page 0 for tiles
- **Layer 2** (effect): Uses VRAM page 1 for tiles

To switch layers:
- Click the **Edit** (pencil) button next to a tilemap in the asset dropdown
- The active layer switches to whichever layer that tilemap belongs to
- All editors refresh to show the new layer's data

When a new scene is loaded, the active layer is automatically reset to Layer 1.

---

## Undo and Redo

All edits are tracked in an undo/redo stack (up to 200 actions).

| Input | Action |
|-------|--------|
| **Ctrl+Z** | Undo |
| **Ctrl+Shift+Z** or **Ctrl+Y** | Redo |
| **⟲ button** (toolbar) | Undo |
| **⟳ button** (toolbar) | Redo |

**Undoable operations:**
- Stamping tiles on the map (entire drag stroke as one action)
- Changing tileset entry properties (H-Flip, V-Flip, Priority, Block)
- Assigning a VRAM tile to a tileset entry
- Resizing a tilemap (restores both dimensions and all tile data)

The undo/redo buttons are disabled when their respective stacks are empty. The history is cleared when a new scene is loaded.

---

## Grid Overlay

Click the **Grid** button in the toolbar to toggle a grid overlay on all canvases:

- **Tilemap canvas**: 16×16 metatile grid lines
- **Tileset picker**: 16×16 metatile grid + finer 8×8 sub-tile guides
- **VRAM Tiles**: 8×8 tile grid

Grid lines are drawn at `rgba(255, 255, 255, 0.25)`.

---

## Keyboard and Mouse Reference

### Main Canvas (Tilemap)

| Input | Action |
|-------|--------|
| Left-click | Stamp selected metatile |
| Left-click + drag | Paint metatiles (batched into one undo action) |
| Right-click | Pick/eyedropper — select metatile at cursor |
| Ctrl + left-click | Pick/eyedropper (alternative — cursor shows `copy` icon) |
| Mouse wheel | Zoom in/out |
| Middle-click + drag | Pan viewport |
| Shift + left-click + drag | Pan viewport (alternative) |

### Tileset Picker (Left Panel)

| Input | Action |
|-------|--------|
| Left-click | Select metatile + quadrant |

### VRAM Tiles (Right Panel)

| Input | Action |
|-------|--------|
| Left-click | Assign tile to selected tileset entry |

### Palette (Right Panel)

| Input | Action |
|-------|--------|
| Left-click | Select palette row |

### Global Shortcuts

| Input | Action |
|-------|--------|
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+Y | Redo (alternative) |
| Escape | Close any open dropdown (resize, asset) |

---

## Technical Details

### Payload Format

The payload is a ZIP file containing:
- `manifest.json` — scene graph with asset command lists (derived from `groups.json`)
- Binary asset files (`.bin`, `.pal`, `.set`, `.map`) extracted from the baserom

Assets are referenced by bare name in the manifest; the loader resolves them by appending extensions.

### Tilemap Data Model

Binary format: `[u8 width][u8 height][data...]`

- Width and height are in **256-pixel blocks** (each block = 16×16 metatile grid)
- Each byte in the data is an index into the tileset's 8×32 metatile grid
- Lower 3 bits = column (0-7), upper 5 bits = row (0-31)
- Maximum data: 8192 bytes (`TILEMAP_MAX_DATA`), constraining `width × height ≤ 32` blocks

### Tileset Entry Format

Each entry is a 16-bit word:

| Bits | Field |
|------|-------|
| 0-8 | VRAM tile index (0-511) |
| 9 | Page/block flag |
| 10-12 | Palette index (0-7) |
| 13 | Priority |
| 14 | H-Flip |
| 15 | V-Flip |

256 metatiles × 4 entries each = 1024 entries = 2048 bytes per tileset.

---

## Troubleshooting

### Editor shows blank after loading

Most scenes depend on `jump` commands to inherit assets from parent scenes. Check the browser console for warnings about missing labels.

### Blurry rendering

All canvases use DPR scaling and `imageSmoothingEnabled = false` for pixel-perfect display. If rendering looks blurry, ensure you're using a modern browser with proper `devicePixelRatio` support.

### "Asset not found in payload"

Rebuild the payload with `npm run payload ../gaia-iog-baserom` and verify the baserom's `extracted/` directory contains the referenced files.

### Stale cached data

If you rebuild the payload but the editor still shows old data, clear the IndexedDB cache:

```javascript
indexedDB.deleteDatabase('gaia-mapper-cache')
```

Then reload the page.

### Import produces unexpected results

Import replays the original load operation using stored offsets. Ensure the replacement file matches the expected binary format and is at least as large as the original.

---

## Development

```bash
npm run build       # One-shot build → dist/app.iife.js
npm run dev         # Watch mode with auto-rebuild
npm run typecheck   # TypeScript type checking only
npm run payload     # Build payload.zip from baserom
```

See `docs/` for detailed architecture documentation:

- `architecture.md` — System design, data flow, event bus
- `editors.md` — Editor component details and interactions
- `snes-data-model.md` — SNES hardware emulation layer
- `rendering.md` — Pixel rendering pipeline
- `undo-redo.md` — Undo/redo system and action types
- `payload.md` — Payload build and loading pipeline
- `design-decisions.md` — Design rationale and tradeoffs
- `dev-guide.md` — Developer setup and conventions
