/**
 * Настройки картинки и меню паузы.
 *
 * Всё, что здесь есть, существует ради одного: **ровного кадра**. Дрожание
 * картинки в движении чаще всего не про математику, а про то, что кадры
 * ложатся на развёртку монитора неровно — и лечится это со стороны игрока,
 * а не кода: предел кадров, разрешение, цена теней.
 *
 * Настройки живут в браузере игрока (`localStorage`): это его машина и его
 * монитор, и на другой машине они ничего не значат.
 */

export type Shadows = 'every' | 'half' | 'off';

export interface Settings {
  /** Предел кадров в секунду. Ноль — без предела. */
  fpsCap: number;
  /** Множитель разрешения. `auto` — подстраивается сам, см. quality.ts. */
  resolution: 'auto' | number;
  shadows: Shadows;
}

const STORAGE_KEY = 'grimhold.settings';

const DEFAULTS: Settings = {
  fpsCap: 0,
  resolution: 'auto',
  shadows: 'half',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`нет элемента #${id}`);
  return node as T;
}

function load(): Settings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { ...DEFAULTS };
    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      fpsCap: typeof parsed.fpsCap === 'number' ? parsed.fpsCap : DEFAULTS.fpsCap,
      resolution:
        parsed.resolution === 'auto' || typeof parsed.resolution === 'number'
          ? parsed.resolution
          : DEFAULTS.resolution,
      shadows:
        parsed.shadows === 'every' || parsed.shadows === 'half' || parsed.shadows === 'off'
          ? parsed.shadows
          : DEFAULTS.shadows,
    };
  } catch {
    // Хранилище может быть недоступно (приватное окно) — это не повод падать.
    return { ...DEFAULTS };
  }
}

export interface SettingsUi {
  readonly current: Settings;
  /** Открыто ли меню: пока открыто, мир не ловит клавиши. */
  readonly open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /** Строка замера под настройками — обновляется на ходу. */
  setReadout(text: string): void;
}

export function createSettings(
  onChange: (settings: Settings) => void,
  onResume: () => void,
): SettingsUi {
  const current = load();

  const panel = el<HTMLDivElement>('settings');
  const fps = el<HTMLSelectElement>('setFps');
  const resolution = el<HTMLSelectElement>('setRes');
  const shadows = el<HTMLSelectElement>('setShadow');
  const readout = el<HTMLParagraphElement>('setStats');

  fps.value = String(current.fpsCap);
  resolution.value = String(current.resolution);
  shadows.value = current.shadows;

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // Не сохранилось — настройки всё равно уже применены к текущей сессии.
    }
    onChange(current);
  }

  fps.addEventListener('change', () => {
    current.fpsCap = Number(fps.value);
    save();
  });
  resolution.addEventListener('change', () => {
    current.resolution = resolution.value === 'auto' ? 'auto' : Number(resolution.value);
    save();
  });
  shadows.addEventListener('change', () => {
    current.shadows = shadows.value as Shadows;
    save();
  });

  el<HTMLButtonElement>('setResume').addEventListener('click', () => {
    api.hide();
    onResume();
  });

  const api: SettingsUi = {
    current,
    get open() {
      return !panel.hidden;
    },
    show() {
      panel.hidden = false;
    },
    hide() {
      panel.hidden = true;
    },
    toggle() {
      if (panel.hidden) api.show();
      else api.hide();
    },
    setReadout(text) {
      if (!panel.hidden) readout.textContent = text;
    },
  };

  // Применяем сохранённое сразу: игрок выставил предел в прошлый раз не для
  // того, чтобы включать его заново каждый вход.
  onChange(current);
  return api;
}
