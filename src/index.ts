import { events } from './ui/events';
import { setupResizeObserver } from './ui/layout';
import { CanvasView } from './ui/canvas-view';
import { History, type UndoAction } from './ui/history';
import { fetchPayload } from './data/payload';
import { parseManifest, type PayloadManifest, type SceneEntry } from './data/manifest';
import { loadScene, type SceneState } from './data/scene-loader';
import { TilesetEditor } from './editor/tileset-editor';
import { TilemapEditor, type TileChange } from './editor/tilemap-editor';
import { GfxViewer } from './editor/gfx-viewer';
import { PaletteViewer } from './editor/palette-viewer';
import { SceneSelector } from './editor/scene-selector';

const PAYLOAD_URL = 'payload.zip';

export interface AppState {
  manifest: PayloadManifest | null;
  payload: Map<string, Uint8Array> | null;
  scene: SceneState | null;
  activeLayer: 1 | 2;
  gridEnabled: boolean;
  selectedMetatile: number;
  selectedQuad: number;
  selectedPalette: number;
  selectedGfxTile: number;
}

export const state: AppState = {
  manifest: null,
  payload: null,
  scene: null,
  activeLayer: 1,
  gridEnabled: false,
  selectedMetatile: 0,
  selectedQuad: 0,
  selectedPalette: 0,
  selectedGfxTile: 0,
};

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

async function init(): Promise<void> {
  events.emit('status:info', 'Downloading payload...');

  try {
    state.payload = await fetchPayload(PAYLOAD_URL);
  } catch (err) {
    events.emit('status:info', `Failed to load payload: ${err}`);
    return;
  }

  const manifestData = state.payload.get('manifest.json');
  if (!manifestData) {
    events.emit('status:info', 'Payload missing manifest.json');
    return;
  }

  state.manifest = parseManifest(manifestData);
  events.emit('status:info', `Loaded ${state.manifest.game} payload`);

  const history = new History();

  const sceneSelector = new SceneSelector(
    $('scene-selector') as HTMLSelectElement,
    state.manifest,
  );

  const mainCanvas = $('main-canvas') as HTMLCanvasElement;
  const mainView = new CanvasView({
    canvas: mainCanvas,
    pannable: true,
    zoomable: true,
    onHover: (x, y) => {
      tilemapEditor.onHover(x, y);
      mainView.redraw();
    },
    onClick: (x, y, btn) => {
      tilemapEditor.onClick(x, y, btn);
      mainView.refreshOffscreen();
      mainView.redraw();
    },
    onDraw: (ctx, zoom) => tilemapEditor.drawOverlay(ctx, zoom),
    onDragEnd: () => {
      const changes = tilemapEditor.commitStampBatch();
      if (changes) {
        history.push(makeTilemapAction(changes));
        updateUndoRedoButtons();
      }
    },
  });

  setupResizeObserver(mainCanvas, (w, h) => {
    mainView.resize(w, h);
    mainView.fitToView();
  });

  const tilesetEditor = new TilesetEditor(state);
  const tilemapEditor = new TilemapEditor(state);
  const gfxViewer = new GfxViewer($('gfx-canvas') as HTMLCanvasElement, state);
  const paletteViewer = new PaletteViewer($('palette-canvas') as HTMLCanvasElement, state);

  // --- View refresh helpers ---

  function refreshMainView(): void {
    if (!state.scene) return;
    const img = tilemapEditor.getImageData();
    if (img) {
      mainView.setContentSize(img.width, img.height);
      mainView.setImageData(img);
      mainView.fitToView();
    }
  }

  function updateMainPixels(): void {
    if (!state.scene) return;
    const img = tilemapEditor.getImageData();
    if (img) {
      mainView.setImageData(img);
      mainView.redraw();
    }
  }

  function refreshAll(): void {
    tilesetEditor.refresh();
    tilemapEditor.refresh();
    gfxViewer.refresh();
    paletteViewer.refresh();
    refreshMainView();
  }

  function refreshAfterTilesetEdit(): void {
    tilesetEditor.refresh();
    tilemapEditor.refresh();
    gfxViewer.refresh();
    updateMainPixels();
  }

  // --- Undo/redo action factories ---

  function makeTilemapAction(changes: TileChange[]): UndoAction {
    return {
      description: `Stamp ${changes.length} tile(s)`,
      undo() {
        tilemapEditor.applyTileChanges(changes, false);
        updateMainPixels();
      },
      redo() {
        tilemapEditor.applyTileChanges(changes, true);
        updateMainPixels();
      },
    };
  }

  function makeTilesetAction(entryIndex: number, oldWord: number, newWord: number): UndoAction {
    return {
      description: `Edit tileset entry ${entryIndex}`,
      undo() {
        const ts = state.activeLayer === 2
          ? state.scene?.effectTileset
          : state.scene?.mainTileset;
        ts?.setEntryWord(entryIndex, oldWord);
        refreshAfterTilesetEdit();
      },
      redo() {
        const ts = state.activeLayer === 2
          ? state.scene?.effectTileset
          : state.scene?.mainTileset;
        ts?.setEntryWord(entryIndex, newWord);
        refreshAfterTilesetEdit();
      },
    };
  }

  // --- Undo/redo UI ---

  const btnUndo = $('btn-undo') as HTMLButtonElement;
  const btnRedo = $('btn-redo') as HTMLButtonElement;

  function updateUndoRedoButtons(): void {
    btnUndo.disabled = !history.canUndo;
    btnRedo.disabled = !history.canRedo;
  }

  function performUndo(): void {
    const action = history.undo();
    if (action) {
      events.emit('status:info', `Undo: ${action.description}`);
      updateUndoRedoButtons();
    }
  }

  function performRedo(): void {
    const action = history.redo();
    if (action) {
      events.emit('status:info', `Redo: ${action.description}`);
      updateUndoRedoButtons();
    }
  }

  btnUndo.addEventListener('click', performUndo);
  btnRedo.addEventListener('click', performRedo);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      performUndo();
    } else if (e.ctrlKey && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      performRedo();
    }
  });

  // --- Layer switching ---

  const layerBtn = $('btn-layer') as HTMLButtonElement;
  layerBtn.addEventListener('click', () => {
    state.activeLayer = state.activeLayer === 1 ? 2 : 1;
    layerBtn.textContent = `Layer ${state.activeLayer}`;
    layerBtn.classList.toggle('active', state.activeLayer === 2);
    events.emit('layer:changed', { layer: state.activeLayer });
    refreshAll();
  });

  // Grid toggle
  const gridBtn = $('btn-grid') as HTMLButtonElement;
  gridBtn.addEventListener('click', () => {
    state.gridEnabled = !state.gridEnabled;
    gridBtn.classList.toggle('active', state.gridEnabled);
    events.emit('grid:toggled', { enabled: state.gridEnabled });
    mainView.redraw();
    tilesetEditor.refreshPicker();
    gfxViewer.refresh();
  });

  // Property controls
  const propHFlip = $('prop-hflip') as HTMLInputElement;
  const propVFlip = $('prop-vflip') as HTMLInputElement;
  const propPriority = $('prop-priority') as HTMLInputElement;
  const propBlock = $('prop-block') as HTMLInputElement;

  function onPropChange(): void {
    const change = tilesetEditor.setEntryFlags(
      propHFlip.checked,
      propVFlip.checked,
      propPriority.checked,
      propBlock.checked,
    );
    if (change) {
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord));
      updateUndoRedoButtons();
    }
    events.emit('tileset:changed');
  }

  propHFlip.addEventListener('change', onPropChange);
  propVFlip.addEventListener('change', onPropChange);
  propPriority.addEventListener('change', onPropChange);
  propBlock.addEventListener('change', onPropChange);

  // Export
  $('btn-export').addEventListener('click', () => {
    if (!state.scene) return;
    tilemapEditor.exportTilemap();
  });

  // Import GFX
  const fileInput = $('file-import-gfx') as HTMLInputElement;
  $('btn-import-gfx').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file || !state.scene) return;

    const reader = new FileReader();
    reader.onload = () => {
      const data = new Uint8Array(reader.result as ArrayBuffer);
      state.scene!.vram.importRawGraphics(data, 0x4000);
      events.emit('vram:imported');
    };
    reader.readAsArrayBuffer(file);
    fileInput.value = '';
  });

  // --- Event subscriptions ---

  events.on('scene:loaded', () => {
    history.clear();
    updateUndoRedoButtons();
    refreshAll();
  });

  events.on('tileset:changed', refreshAfterTilesetEdit);

  events.on('tileset:selected', ({ metatileIndex, quadIndex }) => {
    state.selectedMetatile = metatileIndex;
    state.selectedQuad = quadIndex;
    tilesetEditor.updatePropertyPanel();
    tilesetEditor.syncGfxAndPalette();
    tilesetEditor.refreshPicker();
    gfxViewer.refresh();
    paletteViewer.refresh();
    mainView.redraw();
  });

  events.on('palette:selected', ({ paletteIndex }) => {
    state.selectedPalette = paletteIndex;
    gfxViewer.refresh();
    paletteViewer.refresh();
  });

  events.on('gfx:selected', ({ tileIndex }) => {
    state.selectedGfxTile = tileIndex;
    const change = tilesetEditor.assignTile(tileIndex);
    if (change) {
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord));
      updateUndoRedoButtons();
    }
    events.emit('tileset:changed');
  });

  events.on('vram:imported', () => refreshAll());

  events.on('status:coords', (text) => {
    ($('status-coords') as HTMLSpanElement).textContent = text;
  });

  events.on('status:info', (text) => {
    ($('status-info') as HTMLSpanElement).textContent = text;
  });

  // Scene selection handler
  sceneSelector.onSelect(async (entry: SceneEntry) => {
    if (!state.payload || !state.manifest) return;
    events.emit('status:info', `Loading ${entry.description}...`);

    state.scene = loadScene(state.manifest, state.payload, entry.group, entry.name);
    events.emit('scene:loaded');
    events.emit('status:info', `Loaded: ${entry.description} (ID ${entry.id})`);
  });
}

document.addEventListener('DOMContentLoaded', init);
