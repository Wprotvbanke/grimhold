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
  /**
   * Срез верхов, герцы: выше этой частоты звук глохнет.
   *
   * Резкость звука живёт в верхах — щелчок подошвы, скрип. Срез делает
   * звук мягче, не меняя его сути, и не требует искать новый файл.
   */
  lowpass?: number;
}

/** Срез выше слышимого — фильтр есть, но звук не трогает. */
const OPEN_FILTER = 20000;

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
    files: ['swish_1.wav', 'swish_3.wav', 'swish_5.wav', 'swish_10.wav'],
    volume: 0.45,
    positional: true,
    near: 2,
    far: 18,
    detune: 0.1,
  },
  /**
   * Своё заклинание: шёпот-заговор вместе с замахом посоха.
   *
   * Три отрывка ритуального пения (OwlishMedia, CC0) по секунде — были
   * по 1.7 с под самый долгий замах, владелец попросил короче. Тихо и через срез верхов: заговор бормочут себе
   * под нос, а не поют на площадь. Чужой каст слышен на тридцать метров —
   * так просил владелец: в снапшоте у сущности есть `action: 'cast'`,
   * и по нему чужой замах звучит шёпотом, а не взмахом.
   */
  castWhisper: {
    // Первый отрывок владелец отдал под «нет маны» (см. manaEmpty).
    files: ['spell_whisper_2.wav', 'spell_whisper_3.wav'],
    // Было 0.5; владелец послушал и попросил на пятую часть тише.
    volume: 0.4,
    positional: true,
    near: 3,
    far: 30,
    detune: 0.06,
    lowpass: 3800,
  },
  /**
   * Маны нет, а свиток жмут снова — так решил владелец: первый из трёх
   * отрывков заговора звучит **отказом**, а не чтением. Своё и плоское:
   * это не заклинание, а бормотание в пустоту, соседям слышать нечего.
   */
  manaEmpty: { files: ['spell_whisper_1.wav'], volume: 0.4, positional: false, detune: 0.04 },
  /** Попадание — удар кулака. Вдвое тише первоначального 0.8: глушил бой. */
  hit: { files: five('impactPunch_medium'), volume: 0.4, positional: true, near: 2, far: 25, detune: 0.08 },

  /**
   * Хозяин глубины — король крыс. Рёв слышен далеко: на дне этажа он и есть
   * предупреждение. Звучит редко (cues.ts) — трёхсекундный рёв на каждом
   * замахе превратился бы в постоянный шум.
   */
  bossRoar: { files: ['boss_roar.ogg'], volume: 0.75, positional: true, near: 4, far: 40, detune: 0.05 },
  /** Писк замаха: крысиный, но ниже — крыса большая. */
  bossAttack: { files: ['rat_attack.ogg'], volume: 0.7, positional: true, near: 3, far: 28, detune: 0.06 },
  bossPain: { files: ['rat_pain.ogg'], volume: 0.6, positional: true, near: 3, far: 25, detune: 0.08 },
  bossDeath: { files: ['rat_death.ogg'], volume: 0.9, positional: true, near: 4, far: 40 },
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
  /**
   * Лечение — человеческий вздох облегчения.
   *
   * Был интерфейсный «щелчок подтверждения», и владелец назвал его противным:
   * бип в мрачном средневековье слышен как чужой. Теперь выдох — тот самый
   * звук, который издаёт человек, когда отпустило. Слышен недалеко: это
   * не объявление на весь этаж, а то, что различает стоящий рядом.
   */
  heal: {
    files: ['sigh_relief.wav'],
    volume: 0.5,
    positional: true,
    near: 2,
    far: 14,
    detune: 0.07,
  },
  /**
   * Спуск тетивы. Звучит, когда стрела появилась, — у своего выстрела тоже.
   *
   * Был интерфейсный «щипок» Kenney, владелец забраковал: «совсем не
   * подходит». Теперь настоящие выстрелы из английского лонгбоу и скифского
   * лука (Medieval SFX — Weapon Textures, CC0), четыре дубля по 0.6 с.
   */
  bow: {
    files: ['bow_shot_1.wav', 'bow_shot_2.wav', 'bow_shot_3.wav', 'bow_shot_4.wav'],
    volume: 0.7,
    positional: true,
    near: 2,
    far: 25,
    detune: 0.05,
  },
  /**
   * Натяжка тетивы — своя, в начале выстрела: скрип дерева и жил под
   * нагрузкой, пока клип тянет стрелу. Плоский и тихий: это звук у самого
   * уха стрелка, соседям слышен только спуск.
   */
  bowDraw: {
    files: ['bow_draw_1.wav', 'bow_draw_2.wav'],
    volume: 0.35,
    positional: false,
    detune: 0.05,
  },

  /**
   * Шаги по камню: подземелье и мостовая города.
   *
   * Слышны на двадцать метров — дальше, чем видно во мгле. Это и есть смысл:
   * шаги за стеной предупреждают раньше, чем из темноты выйдет тот, кто идёт.
   *
   * Сначала звучал шаг по бетону — жёсткий щелчок подошвы, на слух «грубо».
   * Теперь мягкий кожаный шаг из RPG-пакета с десятью вариантами и срезанными
   * верхами: шаг глухой, как в сапогах по камню, а не каблуком по плитке.
   */
  stepStone: {
    files: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => `footstep0${index}.ogg`),
    volume: 0.175,
    positional: true,
    near: 1.5,
    far: 20,
    detune: 0.08,
    lowpass: 1800,
  },
  /** Шаги по траве и грунту диких земель. Втрое тише первоначального и без верхов. */
  stepGrass: {
    files: five('footstep_grass'),
    volume: 0.175,
    positional: true,
    near: 1.5,
    far: 20,
    detune: 0.08,
    lowpass: 2400,
  },

  /**
   * Хозяин глубины пал.
   *
   * Плоский, а не из точки: сигнал один на весь забег, и слышать его обязан
   * каждый — и тот, кто рубил, и тот, кто тремя этажами выше роется в сундуке.
   */
  gong: { files: five('impactBell_heavy'), volume: 0.9, positional: false },
  /** Порталы закрылись по времени — тяжёлый скрип. Опоздавшему остаётся смерть. */
  portalClose: { files: ['creak1.ogg', 'creak2.ogg', 'creak3.ogg'], volume: 0.7, positional: false },
  /**
   * Люк: спуск, лестница, портал, воскрешение — и казна.
   *
   * Казна звучит тем же люком намеренно: это тоже тяжёлая крышка, за которой
   * лежит твоё, и владелец хочет слышать её так же.
   */
  transition: { files: ['doorOpen_1.ogg', 'doorOpen_2.ogg'], volume: 0.6, positional: false },
  /**
   * Сундук поддался — крышка открылась.
   *
   * Тот же люк, но из точки: откинутую крышку слышит и сосед, щелчки замка
   * без неё обрывались ничем, и не было понятно, вскрыт ли сундук.
   */
  chestOpen: {
    files: ['doorOpen_1.ogg', 'doorOpen_2.ogg'],
    // На 60% тише первоначального 0.7: крышка над ухом звучала громче удара.
    volume: 0.28,
    positional: true,
    near: 2,
    far: 26,
    detune: 0.05,
  },
  /**
   * Вещь выброшена из рюкзака — короткий стук упавшего на пол.
   *
   * Первым стоял глухой мягкий удар (`impactSoft_heavy`, тот же, что у падения
   * тела) на громкости 0.22 — владелец послушал и сказал: не подходит и тихо.
   * Теперь лёгкий деревянный стук в четверть секунды и вдвое громче: вещь
   * **упала**, и это слышно сразу. Верхи почти не срезаны — без них стук
   * превращался в глухой ком без места и веса.
   */
  dropItem: {
    files: five('impactWood_light'),
    volume: 0.5,
    positional: false,
    detune: 0.1,
    lowpass: 6000,
  },
  /** Рюкзак открыли — кожаный ремень. Закрытие молчит: оно всегда за открытием. */
  backpack: { files: ['clothBelt.ogg', 'clothBelt2.ogg'], volume: 0.4, positional: false, detune: 0.06 },
  /** Выдохся — отдышка. Слышно раньше, чем заметно по ногам. */
  breath: { files: ['breathing_tired.ogg'], volume: 0.6, positional: false },
  /**
   * Свой огонь в руке — ровное пламя петлёй, пока горит.
   *
   * Сначала стоял короткий треск в пару секунд: петля повторяла одни и те же
   * резкие щелчки без конца, и на слух огонь «хрустел» часто и громко.
   * Теперь это десять секунд спокойного очага, тихо: огонь в руке должен
   * быть фоном, а не событием.
   */
  torch: { files: ['torch_fire.wav'], volume: 0.18, positional: false },

  /** Фон подземелья: гул и капель. Петлёй, на своей громкости. */
  ambDungeon: { files: ['dungeon_ambient.ogg'], volume: 0.7, positional: false },
  /** Фон диких земель: ветер. Тише подземелья — открытое место. */
  ambWild: { files: ['wind_loop.ogg'], volume: 0.35, positional: false },

  /** Работа у ноды — удары, пока идёт полоса. Своя плоская, чужая из точки. */
  chop: { files: ['chop.ogg'], volume: 0.7, positional: true, near: 2, far: 22, detune: 0.1 },
  mine: { files: five('impactMining'), volume: 0.7, positional: true, near: 2, far: 22, detune: 0.06 },
  gather: {
    files: ['handleSmallLeather.ogg', 'handleSmallLeather2.ogg'],
    volume: 0.55,
    positional: true,
    near: 2,
    far: 16,
    detune: 0.1,
  },
  /**
   * Вскрытие сундука — щелчки замка.
   *
   * Слышно дальше прочей работы: замысел обещал «уязвим и слышен», и сосед
   * обязан узнать сундук по звуку раньше, чем увидит того, кто его вскрывает.
   */
  lockpick: {
    files: ['metalClick.ogg', 'metalLatch.ogg'],
    volume: 0.7,
    positional: true,
    near: 2,
    far: 26,
    detune: 0.08,
  },
  /** Ремесло — только своё, чужого не видно и не слышно. */
  craft: { files: five('impactWood_light'), volume: 0.55, positional: false, detune: 0.1 },
  /** Добыча попала к тебе: монеты звенят, остальное шуршит. */
  coins: { files: ['handleCoins.ogg', 'handleCoins2.ogg'], volume: 0.6, positional: false },
  pickup: { files: ['handleSmallLeather.ogg', 'handleSmallLeather2.ogg'], volume: 0.5, positional: false },
  /**
   * Навык вырос — клинок выходит из ножен.
   *
   * Сначала стоял интерфейсный «писк», и после каждой победы он звучал как
   * тетрис: чужой миру звук там, где игрок сильнее всего слушает. Звук роста
   * обязан быть из того же мира, что и удар.
   */
  skillUp: { files: ['drawKnife1.ogg', 'drawKnife2.ogg', 'drawKnife3.ogg'], volume: 0.4, positional: false },
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
 *
 * Петли и фон — **в своих голосах**, отдельно от коротких звуков: иначе
 * треск факела однажды забрал бы голос у удара, а удар — у треска.
 */
const POSITIONAL_VOICES = 16;
const FLAT_VOICES = 4;
const LOOP_VOICES = 2;
/** Два голоса фона: старый уходит, новый приходит, и они звучат вместе. */
const AMBIENCE_VOICES = 2;

/** За сколько секунд фон уходит и приходит при смене места. */
const AMBIENCE_FADE = 1.5;

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
  /**
   * Сыграть звук. Без места — плоский, «в голове».
   *
   * `gain` — множитель громкости поверх табличной: крыса и огр ступают одним
   * звуком, но звучат по-разному.
   */
  play(id: SoundId, at?: Place, gain?: number): void;
  /** Зациклить плоский звук под именем. Уже звучит под этим именем — ничего. */
  startLoop(key: string, id: SoundId): void;
  stopLoop(key: string): void;
  /** Сменить фон. `null` — тишина. Тот же фон — ничего не происходит. */
  setAmbience(id: SoundId | null): void;
  /**
   * Второй фоновый слой поверх фона места — звук того, что рядом, а не того,
   * где стоишь: из люка слышно подземелье. `gain` — доля табличной громкости,
   * 0 — слой уходит в тишину. Идёт через ту же шину фона и тот же ползунок.
   */
  setNearby(id: SoundId, gain: number): void;
  setVolumes(settings: { volume: number; ambience: number; music: number }): void;
  /** Контекст и шина музыки: музыка играет потоком и живёт в music.ts. */
  readonly context: AudioContext;
  readonly musicBus: AudioNode;
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

  /**
   * Своя шина у фона.
   *
   * Громкость фона в F1 отдельная от общей, и держится она не на каждом
   * голосе, а одним узлом, через который фон идёт к слушателю.
   */
  const ambienceBus = context.createGain();
  ambienceBus.connect(listener.getInput());
  /** Своя шина и у музыки — по той же причине: свой ползунок в F1. */
  const musicBus = context.createGain();
  musicBus.connect(listener.getInput());

  const buffers = new Map<string, AudioBuffer>();

  /**
   * Каждому короткому голосу — свой срез верхов, заведённый вместе с голосом.
   *
   * Голос играет то шаг, то удар, поэтому фильтр не ставится и не снимается,
   * а только двигается его частота: у звуков без среза она выше слышимого.
   */
  function filtered<V extends THREE.Audio<GainNode | PannerNode>>(voice: V): V {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = OPEN_FILTER;
    voice.setFilter(filter);
    return voice;
  }

  const flat = new VoicePool(FLAT_VOICES, () => filtered(new THREE.Audio(listener)), (v) => !v.isPlaying);
  const positional = new VoicePool(
    POSITIONAL_VOICES,
    () => {
      const voice = filtered(new THREE.PositionalAudio(listener));
      // Линейное затухание доходит до нуля ровно на дальности: так проверка
      // «слышно ли» и то, что слышно на самом деле, говорят одно и то же.
      voice.setDistanceModel('linear');
      scene.add(voice);
      return voice;
    },
    (v) => !v.isPlaying,
  );
  const loopVoices = Array.from({ length: LOOP_VOICES }, () => new THREE.Audio(listener));
  const loops = new Map<string, THREE.Audio>();
  const ambienceVoices = Array.from({ length: AMBIENCE_VOICES }, () => {
    const voice = new THREE.Audio(listener);
    voice.gain.disconnect();
    voice.gain.connect(ambienceBus);
    return voice;
  });

  /** Какой фон хотят и какой голос его играет. */
  let ambience: SoundId | null = null;
  let ambienceVoice: THREE.Audio | null = null;

  /** Голос слоя «рядом» — свой, чтобы не спорить с фоном места за голоса. */
  const nearbyVoice = new THREE.Audio(listener);
  nearbyVoice.gain.disconnect();
  nearbyVoice.gain.connect(ambienceBus);
  let nearbyId: SoundId | null = null;
  let nearbyGain = 0;

  const heard = new THREE.Vector3();

  function pick(id: SoundId): AudioBuffer | null {
    const def: SoundDef = SOUNDS[id];
    const variants = def.files.filter((file) => buffers.has(file));
    if (variants.length === 0) return null;
    return buffers.get(variants[Math.floor(Math.random() * variants.length)]!)!;
  }

  /**
   * Запускает фон, который хотят сейчас.
   *
   * Зовётся и из `setAmbience`, и когда доехал файл: место спрашивают
   * на первом же кадре, а файл фона самый тяжёлый и приезжает последним.
   * Не запусти его по приезде — будет тишина до следующей смены места.
   */
  function startAmbience(): void {
    if (!ambience || ambienceVoice) return;
    const buffer = pick(ambience);
    if (!buffer) return;
    const voice = ambienceVoices.find((candidate) => !candidate.isPlaying) ?? ambienceVoices[0]!;
    if (voice.isPlaying) voice.stop();
    voice.setBuffer(buffer);
    voice.setLoop(true);
    voice.setVolume(0);
    voice.play();
    voice.gain.gain.setTargetAtTime(SOUNDS[ambience].volume, context.currentTime, AMBIENCE_FADE / 3);
    ambienceVoice = voice;
  }

  const loader = new THREE.AudioLoader();
  for (const def of Object.values(SOUNDS) as SoundDef[]) {
    for (const file of def.files) {
      if (buffers.has(file)) continue;
      loader.load(
        ROOT + file,
        (buffer) => {
          buffers.set(file, buffer);
          startAmbience();
        },
        undefined,
        // Пропавший файл — это тишина, а не упавшая игра. Скажем один раз.
        () => console.warn(`[звук] не загрузился ${file}`),
      );
    }
  }

  return {
    play(id, at, gain = 1) {
      const def: SoundDef = SOUNDS[id];
      const buffer = pick(id);
      if (!buffer) return;

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
      voice.setVolume(def.volume * gain);
      (voice.getFilter() as BiquadFilterNode).frequency.value = def.lowpass ?? OPEN_FILTER;
      const detune = def.detune ?? 0;
      voice.setPlaybackRate(1 + (Math.random() * 2 - 1) * detune);
      voice.play();
    },

    startLoop(key, id) {
      if (loops.has(key)) return;
      const buffer = pick(id);
      if (!buffer) return;
      // Голосов петель мало намеренно: занятые — значит новая петля молчит,
      // а не отнимает голос у той, что уже звучит.
      const voice = loopVoices.find((candidate) => !candidate.isPlaying);
      if (!voice) return;
      voice.setBuffer(buffer);
      voice.setLoop(true);
      voice.setVolume(SOUNDS[id].volume);
      voice.play();
      loops.set(key, voice);
    },

    stopLoop(key) {
      const voice = loops.get(key);
      if (!voice) return;
      if (voice.isPlaying) voice.stop();
      loops.delete(key);
    },

    setAmbience(id) {
      if (id === ambience) return;
      ambience = id;

      /**
       * Старый фон уходит плавно, а не обрывается.
       *
       * Щелчок смены фона на границе ворот читается как поломка звука;
       * полторы секунды наложения — как перемена места.
       */
      const leaving = ambienceVoice;
      ambienceVoice = null;
      if (leaving) {
        leaving.gain.gain.setTargetAtTime(0, context.currentTime, AMBIENCE_FADE / 3);
        setTimeout(() => {
          if (leaving !== ambienceVoice && leaving.isPlaying) leaving.stop();
        }, AMBIENCE_FADE * 1000 * 1.5);
      }
      startAmbience();
    },

    setNearby(id, gain) {
      // Громкость меняется каждый кадр по шагу игрока — сглаживаем, чтобы
      // не было ступенек, и не трогаем узел, пока ничего не изменилось.
      if (gain <= 0 && !nearbyVoice.isPlaying) return;
      if (nearbyId !== id || !nearbyVoice.isPlaying) {
        const buffer = pick(id);
        if (!buffer) return;
        if (nearbyVoice.isPlaying) nearbyVoice.stop();
        nearbyVoice.setBuffer(buffer);
        nearbyVoice.setLoop(true);
        nearbyVoice.setVolume(0);
        nearbyVoice.play();
        nearbyId = id;
        nearbyGain = 0;
      }
      if (Math.abs(gain - nearbyGain) < 0.005) return;
      nearbyGain = gain;
      nearbyVoice.gain.gain.setTargetAtTime(SOUNDS[id].volume * gain, context.currentTime, 0.15);
      if (gain <= 0) {
        // Ушёл из радиуса — голос гаснет и освобождается, а не крутит петлю в ноль.
        setTimeout(() => {
          if (nearbyGain <= 0 && nearbyVoice.isPlaying) nearbyVoice.stop();
        }, 1000);
      }
    },

    setVolumes({ volume, ambience: level, music }) {
      listener.setMasterVolume(volume);
      ambienceBus.gain.value = level;
      musicBus.gain.value = music;
    },

    context,
    musicBus,
  };
}
