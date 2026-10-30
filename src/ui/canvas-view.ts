export interface CanvasViewOptions {
  canvas: HTMLCanvasElement;
  pannable?: boolean;
  zoomable?: boolean;
  minZoom?: number;
  maxZoom?: number;
  onHover?: (x: number, y: number) => void;
  onClick?: (x: number, y: number, button: number, ctrlKey: boolean) => void;
  onDraw?: (ctx: CanvasRenderingContext2D, zoom: number) => void;
  onDragEnd?: () => void;
  onRightDragStart?: (x: number, y: number) => void;
  onRightDrag?: (x: number, y: number) => void;
  onRightDragEnd?: () => void;
  rightDragThreshold?: number;
}

export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private isPanning = false;
  private isLeftDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private contentWidth = 0;
  private contentHeight = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private imageData: ImageData | null = null;
  private offscreen: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  private isRightDown = false;
  private isRightDragging = false;
  private rightDownScreenX = 0;
  private rightDownScreenY = 0;

  private opts: CanvasViewOptions;

  constructor(opts: CanvasViewOptions) {
    this.opts = opts;
    this.canvas = opts.canvas;
    this.ctx = opts.canvas.getContext('2d')!;

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('mouseleave', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  get currentZoom(): number { return this.zoom; }

  setContentSize(width: number, height: number): void {
    this.contentWidth = width;
    this.contentHeight = height;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    this.offscreenCtx = this.offscreen.getContext('2d')!;
    this.offscreenCtx.imageSmoothingEnabled = false;
  }

  setImageData(data: ImageData): void {
    this.imageData = data;
    if (this.offscreenCtx) {
      this.offscreenCtx.putImageData(data, 0, 0);
    }
  }

  /** Remove the displayed content (e.g. a scene with no tilemaps). */
  clearContent(): void {
    this.imageData = null;
    this.offscreen = null;
    this.offscreenCtx = null;
    this.contentWidth = 0;
    this.contentHeight = 0;
    this.redraw();
  }

  refreshOffscreen(): void {
    if (this.imageData && this.offscreenCtx) {
      this.offscreenCtx.putImageData(this.imageData, 0, 0);
    }
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.redraw();
  }

  fitToView(): void {
    if (!this.contentWidth || !this.contentHeight) return;
    const scaleX = this.cssWidth / this.contentWidth;
    const scaleY = this.cssHeight / this.contentHeight;
    this.zoom = Math.min(scaleX, scaleY, (this.opts.maxZoom ?? 16));
    this.zoom = Math.max(this.zoom, (this.opts.minZoom ?? 0.25));
    this.panX = (this.cssWidth - this.contentWidth * this.zoom) / 2;
    this.panY = (this.cssHeight - this.contentHeight * this.zoom) / 2;
    this.redraw();
  }

  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.redraw();
  }

  redraw(): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    if (this.offscreen && this.contentWidth > 0) {
      ctx.save();
      ctx.translate(this.panX, this.panY);
      ctx.scale(this.zoom, this.zoom);
      ctx.drawImage(this.offscreen, 0, 0);
      ctx.restore();
    }

    if (this.opts.onDraw) {
      ctx.save();
      ctx.translate(this.panX, this.panY);
      ctx.scale(this.zoom, this.zoom);
      this.opts.onDraw(ctx, this.zoom);
      ctx.restore();
    }
  }

  screenToContent(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      this.isPanning = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }

    if (e.button === 2) {
      if (this.opts.onRightDragStart) {
        this.isRightDown = true;
        this.rightDownScreenX = e.clientX;
        this.rightDownScreenY = e.clientY;
        e.preventDefault();
        return;
      }
      if (this.opts.onClick) {
        const rect = this.canvas.getBoundingClientRect();
        const { x, y } = this.screenToContent(e.clientX - rect.left, e.clientY - rect.top);
        this.opts.onClick(x, y, 2, e.ctrlKey);
      }
      return;
    }

    if (e.button === 0 && !e.ctrlKey) {
      this.isLeftDragging = true;
    }
    if (this.opts.onClick) {
      const rect = this.canvas.getBoundingClientRect();
      const { x, y } = this.screenToContent(e.clientX - rect.left, e.clientY - rect.top);
      this.opts.onClick(x, y, e.button, e.ctrlKey);
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.isPanning && (this.opts.pannable !== false)) {
      this.panX += e.clientX - this.lastMouseX;
      this.panY += e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.redraw();
      return;
    }

    if (this.isRightDown && (e.buttons & 2)) {
      const dx = e.clientX - this.rightDownScreenX;
      const dy = e.clientY - this.rightDownScreenY;
      const threshold = this.opts.rightDragThreshold ?? 5;

      if (!this.isRightDragging && (dx * dx + dy * dy) >= threshold * threshold) {
        this.isRightDragging = true;
        const rect = this.canvas.getBoundingClientRect();
        const start = this.screenToContent(
          this.rightDownScreenX - rect.left,
          this.rightDownScreenY - rect.top,
        );
        this.opts.onRightDragStart!(start.x, start.y);
      }

      if (this.isRightDragging) {
        const rect = this.canvas.getBoundingClientRect();
        const { x, y } = this.screenToContent(e.clientX - rect.left, e.clientY - rect.top);
        this.opts.onRightDrag?.(x, y);
        this.redraw();
      }
      return;
    }

    if (this.opts.onHover) {
      const rect = this.canvas.getBoundingClientRect();
      const { x, y } = this.screenToContent(e.clientX - rect.left, e.clientY - rect.top);
      this.opts.onHover(x, y);
    }

    if (this.opts.onClick && (e.buttons & 1) && !this.isPanning) {
      const rect = this.canvas.getBoundingClientRect();
      const { x, y } = this.screenToContent(e.clientX - rect.left, e.clientY - rect.top);
      this.opts.onClick(x, y, 0, e.ctrlKey);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = 'crosshair';
    }

    if (this.isRightDown) {
      if (this.isRightDragging) {
        this.opts.onRightDragEnd?.();
      } else if (e.type === 'mouseup') {
        if (this.opts.onClick) {
          const rect = this.canvas.getBoundingClientRect();
          const { x, y } = this.screenToContent(e.clientX - rect.left, e.clientY - rect.top);
          this.opts.onClick(x, y, 2, e.ctrlKey);
        }
      }
      this.isRightDown = false;
      this.isRightDragging = false;
    }

    if (this.isLeftDragging) {
      this.isLeftDragging = false;
      this.opts.onDragEnd?.();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.opts.zoomable === false) return;
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldZoom = this.zoom;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.zoom = Math.max(
      this.opts.minZoom ?? 0.25,
      Math.min(this.opts.maxZoom ?? 32, this.zoom * factor),
    );

    this.panX = mx - (mx - this.panX) * (this.zoom / oldZoom);
    this.panY = my - (my - this.panY) * (this.zoom / oldZoom);
    this.redraw();
  };

  destroy(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mouseleave', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }
}
