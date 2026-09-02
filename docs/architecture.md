# Gaia Mapper — Architecture

Browser-based SNES tileset and tilemap editor for Illusion of Gaia (and other Quintet games). Built with vanilla TypeScript, HTML5 Canvas 2D API, and zero UI frameworks.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript (strict) | Type safety for bitwise-heavy SNES data |
| Bundler | tsdown (rolldown) | Fast IIFE builds for browser, bundles fflate |
| ZIP handling | fflate | Lightweight, browser-native, no Node dependencies |
| Rendering | HTML5 Canvas 2D | Pixel-perfect control, `imageSmoothingEnabled = false` |
| Caching | IndexedDB | Payload persists across sessions |
| UI | Vanilla DOM | Minimal dependencies, dark theme CSS |

## Build Output

`tsdown` produces a single `dist/app.iife.js` IIFE bundle (global `GaiaMapper`). The HTML page loads this directly — no module system at runtime.

```
npm run build     → dist/app.iife.js
npm run dev       → watch mode
npm run payload   → payload.zip from baserom
```

## Directory Structure

```
gaia-mapper/
├── index.html                    # Static shell: toolbar, 3-panel layout, status bar
├── styles.css                    # Dark theme, CSS variables, panel layout
├── tsdown.config.ts              # IIFE bundle config, platform: 'browser'
├── scripts/
│   └── build-payload.ts          # Extracts assets from baserom → payload.zip
├── src/
│   ├── index.ts                  # Entry point, app state, event wiring, undo/redo
│   ├── core/                     # SNES data model (pure logic, no DOM)
│   │   ├── vram.ts               # 64KB Virtual VRAM emulation
│   │   ├── palette.ts            # CGRAM (512 bytes), BGR555→RGBA8 conversion
│   │   ├── tile-decoder.ts       # 4bpp planar tile decode + render to RGBA
│   │   ├── tileset.ts            # Tileset entries (16-bit words), metatile rendering
│   │   ├── tilemap.ts            # Tilemap parse/serialize/render, block coordinate math
│   │   └── sprite.ts             # Sprite format types (Phase 3 placeholder)
│   ├── data/                     # Asset loading pipeline
│   │   ├── payload.ts            # Fetch ZIP, IndexedDB cache, fflate unzip
│   │   ├── manifest.ts           # Parse manifest.json, scene list builder
│   │   └── scene-loader.ts       # Execute asset commands, jump/label resolution
│   ├── editor/                   # Interactive editors (DOM + Canvas)
│   │   ├── tilemap-editor.ts     # Main view: stamp, pick, hover, drag batching
│   │   ├── tileset-editor.ts     # Left panel: picker, subtile selection, properties
│   │   ├── gfx-viewer.ts         # Right panel: raw VRAM tile grid
│   │   ├── palette-viewer.ts     # Right panel: 8-row palette swatches
│   │   └── scene-selector.ts     # Toolbar: dropdown populated from manifest
│   └── ui/                       # Shared UI infrastructure
│       ├── canvas-view.ts        # Pannable/zoomable canvas with DPR scaling
│       ├── events.ts             # Typed pub/sub event bus
│       ├── history.ts            # Undo/redo stack (200 action limit)
│       └── layout.ts             # ResizeObserver helper
└── docs/                         # This documentation
```

## Data Flow

```
payload.zip ──fetch──> IndexedDB cache ──unzip──> Map<filename, Uint8Array>
                                                         │
manifest.json ──parse──> PayloadManifest                 │
                              │                          │
scene selector ──pick──> loadScene() ─────────────────> SceneState
                              │                     ┌──────┴──────────┐
                         execute asset commands     │                 │
                              │                     │                 │
                    ┌─────────┼─────────┐    VirtualVRAM      PaletteState
                    │         │         │    (64KB buffer)     (512B CGRAM)
              TilesetRenderer(s)  TilemapManager(s)           │
              (main + effect)     (main + effect)             │
                    │                   │                     │
                    └───────┬───────────┘                     │
                            ▼                                 │
              renderToImageData() ◄───────────────────────────┘
                            │
                            ▼
              renderTilemapToImageData()
                            │
                            ▼
                    CanvasView.setImageData()
                            │
                            ▼
                      redraw() with DPR scaling
```

## Event Bus

All inter-component communication goes through a typed event bus (`src/ui/events.ts`):

| Event | Payload | Trigger |
|-------|---------|---------|
| `scene:loaded` | void | New scene selected |
| `tileset:changed` | void | Tileset entry modified (VRAM tile assigned, property changed) |
| `tilemap:changed` | void | Tile stamped on map |
| `tileset:selected` | `{ metatileIndex, quadIndex }` | Click on tileset picker or right-click tilemap |
| `palette:selected` | `{ paletteIndex }` | Click on palette row |
| `gfx:selected` | `{ tileIndex }` | Click on VRAM tile |
| `layer:changed` | `{ layer: 1 \| 2 }` | Layer toggle button |
| `grid:toggled` | `{ enabled }` | Grid toggle button |
| `vram:imported` | void | Raw GFX file imported |
| `status:coords` | string | Mouse hover coordinate text |
| `status:info` | string | Status bar info text |

## AppState

A single mutable `AppState` object is shared by reference across all editors:

```typescript
interface AppState {
  manifest: PayloadManifest | null;
  payload: Map<string, Uint8Array> | null;
  scene: SceneState | null;
  activeLayer: 1 | 2;
  gridEnabled: boolean;
  selectedMetatile: number;   // 0-255
  selectedQuad: number;       // 0-3 (TL, TR, BL, BR)
  selectedPalette: number;    // 0-7
  selectedGfxTile: number;    // 0-511
}
```
