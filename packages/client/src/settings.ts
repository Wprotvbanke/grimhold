/**
 * Настройки картинки и звука и меню паузы.
 *
 * Настройки картинки существуют ради одного: **ровного кадра**. Дрожание
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
  /**
   * Сглаживание краёв.
   *
   * Дорого не вычислениями, а заполнением: на высокой частоте кадров, где
   * на кадр отведено пять миллисекунд, это заметная доля. Применяется при
   * создании рендерера, то есть после обновления страницы, — поменять его
   * на ходу нельзя.
   */
  antialias: boolean;
  /** Множитель разрешения. `auto` — подстраивается сам, см. quality.ts. */
  resolution: 'auto' | number;
  shadows: Shadows;
  /** Общая громкость, 0..1. */
  volume: number;
  /**
   * Громкость фона, 0..1: ветер, гул подземелья.
   *
   * Отдельно от общей, потому что фон мешает первым: человек, которому надоел
   * гул, не должен ради тишины терять шаги за спиной.
   */
  ambience: number;
  /** Громкость музыки, 0..1. Отдельно: музыку выключают первой, звук — никогда. */
  music: number;
  /** Постобработка: свечение огня, цвет, тёмные края кадра. См. post.ts. */
  effects: 'on' | 'off';
  /**
   * Кинескоп — картинка как на старом телевизоре, двух видов. См. docs/crt.md.
   *
   * По умолчанию выключен и включаться всем не должен: у людей с тонким
   * зрением от строк и мерцания болит голова. Это выбор игрока.
   */
  crt: CrtKind;
}

export type CrtKind = 'off' | 'newpixie' | 'lottes' | 'moire' | 'lottes2' | 'geom' | 'hyllian';

const CRT_KINDS: readonly CrtKind[] = ['off', 'newpixie', 'lottes', 'moire', 'lottes2', 'geom', 'hyllian'];

/** Что в хранилище считать видом кинескопа. `on` — со времён, когда вид был один. */
function crtKind(value: unknown): CrtKind {
  if (value === 'on') return 'newpixie';
  return CRT_KINDS.find((kind) => kind === value) ?? 'off';
}

const STORAGE_KEY = 'grimhold.settings';

const DEFAULTS: Settings = {
  fpsCap: 0,
  antialias: true,
  resolution: 'auto',
  shadows: 'half',
  volume: 0.8,
  ambience: 0.6,
  music: 0.5,
  effects: 'on',
  crt: 'off',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`нет элемента #${id}`);
  return node as T;
}

/** Громкость из хранилища: число в 0..1, всё остальное — значение по умолчанию. */
function level(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

/**
 * Читает настройки без интерфейса.
 *
 * Нужно потому, что сглаживание краёв задаётся при создании рендерера —
 * до того, как появится сама панель.
 */
export function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { ...DEFAULTS };
    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      fpsCap: typeof parsed.fpsCap === 'number' ? parsed.fpsCap : DEFAULTS.fpsCap,
      antialias: typeof parsed.antialias === 'boolean' ? parsed.antialias : DEFAULTS.antialias,
      resolution:
        parsed.resolution === 'auto' || typeof parsed.resolution === 'number'
          ? parsed.resolution
          : DEFAULTS.resolution,
      shadows:
        parsed.shadows === 'every' || parsed.shadows === 'half' || parsed.shadows === 'off'
          ? parsed.shadows
          : DEFAULTS.shadows,
      volume: level(parsed.volume, DEFAULTS.volume),
      ambience: level(parsed.ambience, DEFAULTS.ambience),
      music: level(parsed.music, DEFAULTS.music),
      effects: parsed.effects === 'on' || parsed.effects === 'off' ? parsed.effects : DEFAULTS.effects,
      crt: crtKind(parsed.crt),
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
  /** Громкость отпустили — дать услышать, на что поставили. */
  onSoundSet: () => void = () => {},
): SettingsUi {
  const current = loadSettings();

  const panel = el<HTMLDivElement>('settings');
  const fps = el<HTMLSelectElement>('setFps');
  const resolution = el<HTMLSelectElement>('setRes');
  const shadows = el<HTMLSelectElement>('setShadow');
  const smoothing = el<HTMLSelectElement>('setAa');
  const volume = el<HTMLInputElement>('setVolume');
  const ambience = el<HTMLInputElement>('setAmbience');
  const music = el<HTMLInputElement>('setMusic');
  const effects = el<HTMLSelectElement>('setFx');
  const crt = el<HTMLSelectElement>('setCrt');
  const readout = el<HTMLParagraphElement>('setStats');

  fps.value = String(current.fpsCap);
  resolution.value = String(current.resolution);
  shadows.value = current.shadows;
  smoothing.value = current.antialias ? 'on' : 'off';
  effects.value = current.effects;
  crt.value = current.crt;
  volume.value = String(Math.round(current.volume * 100));
  ambience.value = String(Math.round(current.ambience * 100));
  music.value = String(Math.round(current.music * 100));

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
  smoothing.addEventListener('change', () => {
    current.antialias = smoothing.value === 'on';
    save();
    // Менять на ходу нечего: сглаживание задаётся при создании рендерера.
    readout.textContent = 'Сглаживание краёв применится после обновления страницы (F5).';
  });
  effects.addEventListener('change', () => {
    current.effects = effects.value === 'off' ? 'off' : 'on';
    save();
  });
  crt.addEventListener('change', () => {
    current.crt = crtKind(crt.value);
    save();
    // Кинескоп — проход постобработки: без неё ему негде рисоваться.
    if (current.crt !== 'off' && current.effects === 'off') {
      readout.textContent = 'Старый телевизор работает только при включённых эффектах.';
    }
  });

  /**
   * Ползунок громкости слушается на ходу, а пишется по отпусканию.
   *
   * На ходу — чтобы менять громкость, слыша игру. По отпусканию — чтобы
   * не писать хранилище на каждый пиксель движения мыши, и чтобы короткий
   * звук-образец прозвучал один раз, а не очередью.
   */
  for (const [slider, key] of [
    [volume, 'volume'],
    [ambience, 'ambience'],
    [music, 'music'],
  ] as const) {
    slider.addEventListener('input', () => {
      current[key] = Number(slider.value) / 100;
      onChange(current);
    });
    slider.addEventListener('change', () => {
      current[key] = Number(slider.value) / 100;
      save();
      onSoundSet();
    });
  }

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
