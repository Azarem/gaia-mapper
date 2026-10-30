/**
 * Saving files through a "Save as" dialog.
 *
 * Uses the File System Access API (`showSaveFilePicker`) so the user picks the
 * location for every export instead of the browser dropping the file into its
 * downloads folder. Each picker `id` makes the browser remember the folder last
 * used with it, so the dialog opens where that kind of file was saved before.
 *
 * Browsers without the API (Firefox, Safari) or without a secure context fall
 * back to a plain download, which goes wherever the browser is configured to
 * put downloads (or asks, if it is set to).
 */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  id?: string;
  suggestedName?: string;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}

interface WritableHandle {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<WritableHandle>;

/** Folder memory slots: each remembers the last folder used with it. */
export type SavePlace = 'mapper-assets' | 'mapper-images';

export interface SaveRequest {
  /** Proposed file name, including extension. The user may change it. */
  suggestedName: string;
  /** Text shown for the file type in the dialog, e.g. "PNG image". */
  description: string;
  mime: string;
  /** Extension with the leading dot, e.g. ".png". */
  extension: string;
  place: SavePlace;
}

function getPicker(): ShowSaveFilePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' && window.isSecureContext ? picker.bind(window) : null;
}

function downloadFallback(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Ask the user where to save, then write the file.
 *
 * `produce` runs after the dialog is open, so slow work (image encoding) does
 * not delay the dialog past the click that must trigger it. Call this
 * directly from the click handler.
 *
 * Resolves to the saved file name (as chosen by the user), or null if the user
 * cancelled the dialog.
 */
export async function saveFile(
  request: SaveRequest,
  produce: () => Blob | Promise<Blob>,
): Promise<string | null> {
  const picker = getPicker();
  if (!picker) {
    downloadFallback(await produce(), request.suggestedName);
    return request.suggestedName;
  }

  let handle: WritableHandle;
  try {
    handle = await picker({
      id: request.place,
      suggestedName: request.suggestedName,
      types: [{ description: request.description, accept: { [request.mime]: [request.extension] } }],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }

  const blob = await produce();
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return handle.name;
}

/** Copy an ImageData onto a new canvas (a snapshot: later edits to the ImageData don't affect it). */
export function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

/** Encode a canvas as a PNG (lossless, keeps transparency). */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
      'image/png',
    );
  });
}

/** A file-name-safe version of a scene description. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim() || 'map';
}
