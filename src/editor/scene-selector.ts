import { getSceneList, type PayloadManifest, type SceneEntry } from '../data/manifest';

export class SceneSelector {
  private select: HTMLSelectElement;
  private scenes: SceneEntry[];
  private callback: ((entry: SceneEntry) => void) | null = null;

  constructor(select: HTMLSelectElement, manifest: PayloadManifest) {
    this.select = select;
    this.scenes = getSceneList(manifest);
    this.populate();

    this.select.addEventListener('change', () => {
      const idx = parseInt(this.select.value, 10);
      if (!isNaN(idx) && this.callback) {
        this.callback(this.scenes[idx]);
      }
    });
  }

  private populate(): void {
    this.select.innerHTML = '';
    this.select.disabled = false;

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '-- Select Scene --';
    this.select.appendChild(defaultOpt);

    let currentGroup = '';
    let optgroup: HTMLOptGroupElement | null = null;

    for (let i = 0; i < this.scenes.length; i++) {
      const scene = this.scenes[i];

      if (scene.group !== currentGroup) {
        currentGroup = scene.group;
        optgroup = document.createElement('optgroup');
        optgroup.label = formatGroupName(scene.group);
        this.select.appendChild(optgroup);
      }

      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `#${scene.id.toString().padStart(3, '0')} ${scene.description}`;
      (optgroup ?? this.select).appendChild(opt);
    }
  }

  onSelect(callback: (entry: SceneEntry) => void): void {
    this.callback = callback;
  }
}

function formatGroupName(name: string): string {
  return name
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
