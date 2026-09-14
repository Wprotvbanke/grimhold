import * as THREE from 'three';

/**
 * Звук.
 *
 * **Это картинка для ушей, и живёт он целиком на клиенте** — как руки и свет.
 * Сервер о звуках не знает: клиент выводит их из событий боя, из снапшота
 * и из своих же действий. Так правило «клиент шлёт намерения» не задевается
 * ни одним байтом, а новый звук не требует нового сообщения.
 *
 * Про устройство и ловушки — docs/sound.md.
 */

/** Точка в мире, откуда слышен звук. */
export interface Place {
  x: number;
  y: number;
  z: number;
}

interface SoundDef {
  /** Файлы-варианты: каждый раз берётся случайный — иначе звучит как пулемёт. */
  files: readonly string[];
  volume: number;
  /**
   * Позиционный звук слышен из точки в мире и тише с расстоянием; плоский —
   * «в голове»: свои руки, свои вещи, окно интерфейса.
   */
  positional: boolean;
  /** До этого расстояния звук в полную силу. */
  near?: number;
  /** Дальше этого не слышен вовсе — и голоса не просит. */
  far?: number;
  /** Разброс высоты, доля: 0.08 — плюс-минус восемь процентов. */
  detune?: number;
}

/** Пять вариантов одного звука: `name_000.ogg` … `name_004.ogg`, как у Kenney. */
function five(name: string): string[] {
  return [0, 1, 2, 3, 4].map((index) => `${name}_00${index}.ogg`);
}

export const SOUNDS = {
  /** Громкость в F1 отпустили — слышно, на что поставил. */
  confirm: { files: ['confirmation_001.ogg'], volume: 0.5, positional: false },

  /**
   * Взмах: свой — сразу, как дёрнулись руки; чужой — в начале замаха.
   *
   * Замах чужого — главное, что стоит услышать: по нему решают, отходить или
   * ставить щит, а во мгле его не видно.
   */
  swing: {
    files: ['knifeSlice.ogg', 'knifeSlice2.ogg'],
    volume: 0.45,
    positional: true,
    near: 2,
    far: 18,
    detune: 0.1,
  },
  hit: { files: five('impactPunch_medium'), volume: 0.8, positional: true, near: 2, far: 25, detune: 0.08 },
  /** Удар в щит звенит металлом — его не спутать с попаданием. */
  blocked: { files: five('impactPlate_medium'), volume: 0.75, positional: true, near: 2, far: 25, detune: 0.06 },
  /** Уход рывком — шорох одежды: неуязвимость слышна, а не только видна. */
  dodge: {
    files: ['cloth1.ogg', 'cloth2.ogg', 'cloth3.ogg', 'cloth4.ogg'],
    volume: 0.5,
    positional: true,
    near: 1.5,
    far: 14,
    detune: 0.1,
  },
  death: { files: five('impactSoft_heavy'), volume: 0.9, positional: true, near: 3, far: 30, detune: 0.05 },
  heal: { files: ['confirmation_002.ogg'], volume: 0.45, positional: true, near: 2, far: 15 },
  /** Тетива. Звучит, когда стрела появилась, — у своего выстрела тоже. */
  bow: {
    files: ['pluck_001.ogg', 'pluck_002.ogg'],
    volume: 0.6,
    positional: true,
    near: 2,
    far: 25,
    detune: 0.06,
  },
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUNDS;

/** Где лежат файлы. Все звуки — CC0, источники в docs/assets.md. */
const ROOT = '/sounds/';

/**
 * Сколько голосов звучит одновременно.
 *
 * Голоса заводятся **один раз и навсегда** — то же правило, что у ламп
 * (docs/performance.md): узел панорамы на каждое событие стоит процессора,
 * а толпа мобов рядом дала бы их сотню. Заняты все — забирается самый старый:
 * он уже отзвучал больше других.
 */
const POSITIONAL_VOICES = 16;
const FLAT_VOICES = 4;

/**
 * Пул голосов. Без WebAudio: голос тут — что угодно, лишь бы знать, свободен ли.
 *
 * Логика вынесена отдельно ради проверки: сам звук тестом не услышать, а вот
 * «голосов не больше предела» и «забирается самый старый» — вполне.
 */
export class VoicePool<V> {
  private readonly slots: { voice: V; startedAt: number }[];

  constructor(
    size: number,
    create: () => V,
    private readonly isFree: (voice: V) => boolean,
  ) {
    this.slots = Array.from({ length: size }, () => ({ voice: create(), startedAt: -Infinity }));
  }

  /** Свободный голос, а если свободных нет — самый давно начатый. */
  take(now: number): V {
    let chosen = this.slots[0]!;
    for (const slot of this.slots) {
      if (this.isFree(slot.voice)) {
        chosen = slot;
        break;
      }
      if (slot.startedAt < chosen.startedAt) chosen = slot;
    }
    chosen.startedAt = now;
    return chosen.voice;
  }

  get size(): number {
    return this.slots.length;
  }

  each(visit: (voice: V) => void): void {
    for (const slot of this.slots) visit(slot.voice);
  }
}

/**
 * Слышно ли место оттуда, где стоит слушатель.
 *
 * Проверка **до** того, как просить голос: иначе каждый удар в другом конце
 * радиуса интереса отнимал бы голос у шагов за спиной, а слышно его всё
 * равно не было бы.
 */
export function withinHearing(listener: Place, at: Place, far: number): boolean {
  const dx = at.x - listener.x;
  const dy = at.y - listener.y;
  const dz = at.z - listener.z;
  return dx * dx + dy * dy + dz * dz <= far * far;
}

export interface SoundApi {
  play(id: SoundId, at?: Place): void;
  setVolumes(settings: { volume: number; ambience: number }): void;
}

export function createSound(camera: THREE.Camera, scene: THREE.Scene): SoundApi {
  const listener = new THREE.AudioListener();
  camera.add(listener);
  const context = listener.context;

  /**
   * Браузер держит звук выключенным, пока человек ничего не нажал.
   *
   * Возобновлять можно на любом жесте после первого, поэтому слушаем все
   * нажатия, а не одно: первый клик мог прийти раньше, чем игра успела
   * завести звук. Скрытая вкладка при этом не будится — см. ниже.
   */
  const wake = () => {
    if (context.state === 'suspended' && !document.hidden) void context.resume();
  };
  addEventListener('pointerdown', wake);
  addEventListener('keydown', wake);

  /**
   * Свёрнутая вкладка молчит.
   *
   * Иначе фон подземелья звучит из свёрнутого браузера, а шаги мобов у ворот
   * пугают человека, который давно смотрит другое окно.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void context.suspend();
    else wake();
  });

  const buffers = new Map<string, AudioBuffer>();
  const loader = new THREE.AudioLoader();
  for (const def of Object.values(SOUNDS) as SoundDef[]) {
    for (const file of def.files) {
      if (buffers.has(file)) continue;
      loader.load(
        ROOT + file,
        (buffer) => buffers.set(file, buffer),
        undefined,
        // Пропавший файл — это тишина, а не упавшая игра. Скажем один раз.
        () => console.warn(`[звук] не загрузился ${file}`),
      );
    }
  }

  const flat = new VoicePool(FLAT_VOICES, () => new THREE.Audio(listener), (v) => !v.isPlaying);
  const positional = new VoicePool(
    POSITIONAL_VOICES,
    () => {
      const voice = new THREE.PositionalAudio(listener);
      // Линейное затухание доходит до нуля ровно на дальности: так проверка
      // «слышно ли» и то, что слышно на самом деле, говорят одно и то же.
      voice.setDistanceModel('linear');
      scene.add(voice);
      return voice;
    },
    (v) => !v.isPlaying,
  );

  const heard = new THREE.Vector3();

  return {
    play(id, at) {
      const def: SoundDef = SOUNDS[id];
      const variants = def.files.filter((file) => buffers.has(file));
      if (variants.length === 0) return;
      const buffer = buffers.get(variants[Math.floor(Math.random() * variants.length)]!)!;

      let voice: THREE.Audio<GainNode | PannerNode>;
      if (def.positional && at) {
        camera.getWorldPosition(heard);
        const far = def.far ?? 30;
        if (!withinHearing(heard, at, far)) return;
        const spot = positional.take(performance.now());
        spot.setRefDistance(def.near ?? 2);
        spot.setMaxDistance(far);
        spot.position.set(at.x, at.y, at.z);
        voice = spot;
      } else {
        voice = flat.take(performance.now());
      }

      if (voice.isPlaying) voice.stop();
      voice.setBuffer(buffer);
      voice.setVolume(def.volume);
      const detune = def.detune ?? 0;
      voice.setPlaybackRate(1 + (Math.random() * 2 - 1) * detune);
      voice.play();
    },

    setVolumes({ volume }) {
      listener.setMasterVolume(volume);
    },
  };
}
