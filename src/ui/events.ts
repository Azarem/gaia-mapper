type Listener<T = void> = (data: T) => void;

interface EventMap {
  'scene:loaded': void;
  'tileset:changed': void;
  'tilemap:changed': void;
  'tileset:selected': { metatileIndex: number; quadIndex: number };
  'palette:selected': { paletteIndex: number };
  'gfx:selected': { tileIndex: number };
  'layer:changed': { layer: 1 | 2 };
  'grid:toggled': { enabled: boolean };
  'pattern:toggled': { enabled: boolean };
  'asset:imported': void;
  'status:coords': string;
  'status:info': string;
}

type EventName = keyof EventMap;

class EventBus {
  private listeners = new Map<string, Set<Listener<any>>>();

  on<K extends EventName>(event: K, listener: Listener<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit<K extends EventName>(event: K, ...args: EventMap[K] extends void ? [] : [EventMap[K]]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    const data = args[0] as EventMap[K];
    for (const fn of set) fn(data);
  }

  off<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }
}

export const events = new EventBus();
export type { EventMap, EventName };
