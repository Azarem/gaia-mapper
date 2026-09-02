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
 */
export function getSceneList(manifest: PayloadManifest): SceneEntry[] {
  const scenes: SceneEntry[] = [];

  for (const [groupName, group] of Object.entries(manifest.groups)) {
    for (const [sceneName, scene] of Object.entries(group.scenes)) {
      scenes.push({
        group: groupName,
        name: sceneName,
        id: scene.id,
        description: scene.description,
      });
    }
  }

  scenes.sort((a, b) => a.id - b.id);
  return scenes;
}

/**
 * Get asset list for a specific scene.
 */
export function getSceneAssets(manifest: PayloadManifest, group: string, scene: string): AssetEntry[] {
  return manifest.groups[group]?.scenes[scene]?.assets ?? [];
}
