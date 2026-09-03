export interface AssetEntry {
  type: 'ppu' | 'bitmap' | 'palette' | 'tileset' | 'tilemap' | 'spritemap' | 'music' | 'label' | 'jump';
  data?: string;
  meta: Record<string, number | boolean>;
}

export interface SceneDef {
  id: number;
  description: string;
  assets: AssetEntry[];
}

export interface GroupDef {
  prefix: string;
  scenes: Record<string, SceneDef>;
}

export interface PayloadManifest {
  game: string;
  groups: Record<string, GroupDef>;
}

export interface SceneEntry {
  group: string;
  name: string;
  id: number;
  description: string;
}

/**
 * Parse manifest.json from the payload ZIP.
 */
export function parseManifest(data: Uint8Array): PayloadManifest {
  const text = new TextDecoder().decode(data);
  return JSON.parse(text) as PayloadManifest;
}

/**
 * Build a flat list of all scenes for the selector dropdown.
 * Scenes are grouped together, sorted by ID within each group,
 * and groups are ordered by their lowest scene ID.
 */
export function getSceneList(manifest: PayloadManifest): SceneEntry[] {
  const grouped = new Map<string, SceneEntry[]>();

  for (const [groupName, group] of Object.entries(manifest.groups)) {
    const entries: SceneEntry[] = [];
    for (const [sceneName, scene] of Object.entries(group.scenes)) {
      entries.push({
        group: groupName,
        name: sceneName,
        id: scene.id,
        description: scene.description,
      });
    }
    entries.sort((a, b) => a.id - b.id);
    grouped.set(groupName, entries);
  }

  const sortedGroups = [...grouped.entries()].sort(
    ([, a], [, b]) => a[0].id - b[0].id,
  );

  return sortedGroups.flatMap(([, entries]) => entries);
}

/**
 * Get asset list for a specific scene.
 */
export function getSceneAssets(manifest: PayloadManifest, group: string, scene: string): AssetEntry[] {
  return manifest.groups[group]?.scenes[scene]?.assets ?? [];
}
