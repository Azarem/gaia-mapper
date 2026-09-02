export function getParentSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const parent = canvas.parentElement;
  if (!parent) return { width: canvas.clientWidth || 300, height: canvas.clientHeight || 150 };

  const rect = parent.getBoundingClientRect();
  return { width: Math.floor(rect.width), height: Math.floor(rect.height) };
}

export function setupResizeObserver(
  canvas: HTMLCanvasElement,
  callback: (width: number, height: number) => void,
): ResizeObserver {
  const observer = new ResizeObserver(() => {
    const { width, height } = getParentSize(canvas);
    callback(width, height);
  });

  const parent = canvas.parentElement;
  if (parent) observer.observe(parent);
  return observer;
}
