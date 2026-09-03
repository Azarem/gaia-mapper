# Gaia Mapper — Developer Guide

## Prerequisites

- Node.js 18+
- Access to `gaia-iog-baserom` repo (for building the payload)

## Setup

```bash
cd gaia-mapper
npm install
```

## Building the Payload

The payload archive must be built from an extracted IOG baserom:

```bash
npm run payload ../gaia-iog-baserom
```

This reads `us/groups.json` and `us/files.json` from the baserom, collects binary assets from `extracted/`, and produces `payload.zip` in the project root.

The payload is gitignored. Each developer must build it locally.

## Building the App

```bash
npm run build       # One-shot build → dist/app.iife.js
npm run dev         # Watch mode with auto-rebuild
npm run typecheck   # Type checking without emit
```

## Running

Serve the project root over HTTP:

```bash
npx serve .
```

Open `http://localhost:3000` (or whatever port `serve` reports). The app will fetch `payload.zip`, cache it in IndexedDB, and populate the scene selector.

**Important:** `file://` URLs will not work because `fetch()` requires HTTP.

## Project Conventions

### No UI Framework

All DOM manipulation is vanilla TypeScript. The UI is defined in `index.html` with CSS in `styles.css`. No React, no virtual DOM, no templating.

### Minimal Dependencies

Only `fflate` is a runtime dependency. Build tools (`tsdown`, `tsx`, `typescript`) are dev-only. This is deliberate — the app must remain simple and fast.

### IIFE Bundle

The build produces a single IIFE file, not ESM. This avoids module loading complexity in the browser and allows `<script src="dist/app.iife.js">` with no import map.

### Shared Mutable State

`AppState` is a single object passed by reference to all editors. This is intentional for simplicity in a small app. The event bus decouples notification from mutation.

### Canvas Rendering

All graphics rendering uses the Canvas 2D API. No WebGL, no third-party rendering libraries. `ImageData` manipulation is done with direct `Uint8Array` writes for performance.

## Known Limitations

- **Sprites:** `src/core/sprite.ts` is a type-only placeholder. Sprite rendering and animation editing are Phase 3 features.
- **PPU commands:** Scene asset commands of type `ppu` are read but not acted upon. The `useOffset` flag is set manually based on layer.
- **Single game:** The payload builder is currently hardcoded for IOG structure. The manifest format is game-agnostic, but the builder script would need adaptation for Robotrek or Soul Blazer.
- **No save/load project:** Edits exist only in memory. Export saves individual files via the asset dropdown. There is no project file format yet.
- **Tilemap size:** Maximum 8192 bytes of tilemap data per layer (`TILEMAP_MAX_DATA = 0x2000`), which means `width × height ≤ 32` blocks.
- **Import round-trip fidelity:** Import replays the original load with stored offsets, which works correctly for same-format replacements. Files with different internal layouts may produce unexpected results.

## Troubleshooting

### Blurry rendering

All canvases must enforce:
1. CSS `image-rendering: pixelated` on the canvas element
2. Canvas backing store scaled by `devicePixelRatio`
3. Context scaled by DPR before drawing
4. `imageSmoothingEnabled = false` on every `redraw()`

If images look blurry, check that the DPR scaling chain is intact in both `CanvasView` and the side-panel canvas renderers.

### "Asset not found in payload"

The `resolveFileKey()` / `resolveFile()` functions in `scene-loader.ts` try appending extensions. If a file is genuinely missing, rebuild the payload and check the baserom's `extracted/` directory.

### Scene loads blank

Most scenes depend on `jump` commands to inherit bitmap/tileset assets from parent scenes. Check the browser console for warnings about missing labels. The label index is built from all scenes in the manifest at load time.

### IndexedDB cache stale

If you rebuild the payload but the app still shows old data, clear the cache:

```javascript
// In browser console
GaiaMapper.clearCache?.() // or
indexedDB.deleteDatabase('gaia-mapper-cache')
```

Then reload the page.

## Adding a New Editor Feature

1. Add state fields to `AppState` in `src/index.ts` if needed
2. Add events to `EventMap` in `src/ui/events.ts` if cross-component communication is needed
3. Create or modify an editor class in `src/editor/`
4. Wire events in `src/index.ts`'s `init()` function
5. Add undo support: return old/new values from mutation methods, create an `UndoAction` factory in `init()`
6. Run `npm run build` and test in browser

## Adding Support for Another Game

1. Create a new `build-payload.ts` variant (or parameterize the existing one) to read that game's `groups.json`/`files.json`
2. Build the payload: `npm run payload ../gaia-robotrek-baserom`
3. The manifest format and scene loader are game-agnostic as long as asset types and meta fields match
4. If the game uses different VRAM layouts or tilemap formats, extend `vram.ts`/`tilemap.ts` accordingly
