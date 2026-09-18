import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  ACTIONS,
  ATTACK_COOLDOWN,
  castTiming,
  FIST_STAMINA_SCALE,
  scaleTiming,
  isItemId,
  itemDef,
  DODGE_COOLDOWN,
  dodgeCooldown,
  dodgeCost,
  RACES,
  WALK_SPEED,
  type ActionKind,
  type ActionPhase,
  type ActionTiming,
  type Race,
  type SpellId,
} from '@grimhold/shared';

/**
 * Руки от первого лица.
 *
 * Рисуются в отдельной сцене поверх мира с очисткой буфера глубины — иначе
 * при подходе к стене руки уезжали бы внутрь геометрии.
 *
 * Анимации готовые, из модели. Раньше позы собирались кодом по костям — это
 * была вынужденная мера, пока анимаций не было, и выглядела соответственно:
 * вручную подобранное движение кисти с двумя десятками суставов получается
 * сломанным, сколько ни правь оси и углы. Возвращаться к этому не стоит.
 *
 * Главное правило осталось прежним: **удар привязан к фазам с сервера**. Клип
 * растягивается так, чтобы кулак доходил до цели ровно к концу замаха — тогда
 * картинка не врёт о том, когда засчитано попадание. Начинается анимация по
 * нажатию, не дожидаясь ответа: полпинга задержки в своих руках заметны сразу.
 */

export interface ViewModelState {
  action: ActionKind | null;
  phase: ActionPhase | null;
  blocking: boolean;
  /** Горизонтальная скорость — по ней выбирается шаг или бег. */
  speed: number;
  /** Стоит ли игрок на земле: по отрыву проигрывается прыжок. */
  onGround: boolean;
  alive: boolean;
}

/** Клипы модели под нашими именами. */
export type HandsClip =
  | 'equip'
  | 'idle'
  | 'fidget'
  | 'walk'
  | 'sprint'
  | 'punchRight'
  | 'punchLeft'
  | 'axeSwing'
  | 'staffCast'
  | 'bowShot'
  | 'blockStart'
  | 'blockLoop'
  | 'blockStop'
  | 'takeStart'
  | 'takeLoop'
  | 'takeStop';

/** Как называются клипы в модели. Первый найденный побеждает. */
const CLIP_NAMES: Record<HandsClip, string[]> = {
  equip: ['Equip'],
  idle: ['Idle'],
  fidget: ['Idle_Fidget'],
  walk: ['Walk'],
  sprint: ['Sprint_Type_1', 'Run'],
  punchRight: ['Punch_R', 'Punch'],
  punchLeft: ['Punch_L', 'Punch_2'],
  axeSwing: ['Sword_Slash'],
  staffCast: ['Staff_Shot'],
  bowShot: ['Bow_Shot'],
  blockStart: ['Block_Start'],
  blockLoop: ['Block_Loop'],
  blockStop: ['Block_Stop'],
  takeStart: ['Take_Start'],
  takeLoop: ['Take_Loop'],
  takeStop: ['Take_Stop'],
};

/** Клипы, которые играют один раз и замирают на последнем кадре. */
const ONCE: HandsClip[] = [
  'equip',
  'fidget',
  'punchRight',
  'punchLeft',
  'axeSwing',
  'staffCast',
  'bowShot',
  'blockStart',
  'blockStop',
  'takeStart',
  'takeStop',
];

const MODEL_URL = '/models/hands.glb';

/**
 * Фазы чтения, когда свиток неизвестен.
 *
 * Так бывает, когда чтение начал не игрок: сервер сообщает только
 * вид действия, без свитка. Руки всё равно обязаны отыграть жест.
 */
const CAST_FALLBACK: ActionTiming = { windup: 0.5, active: 0.1, recovery: 0.4 };

/**
 * Вещи, которые видно в правом кулаке.
 *
 * Таблица, а не константы: вещей стало две — топор и посох, — и у каждой
 * своя длина, своя точка хвата и свой доворот. Пока это были числа с именами
 * `AXE_*`, добавить вторую вещь означало продублировать весь расчёт посадки.
 *
 * Механика у всех одна и описана в docs/hands.md: размер меряется
 * **в предплечьях**, посадка считается каждый кадр, а на время замаха
 * запоминается.
 */
/** Кости одной руки, нужные хвату. */
interface Grip {
  palm: THREE.Object3D;
  hand: THREE.Bone;
  knuckles: { index: THREE.Bone; pinky: THREE.Bone };
}

interface HeldSpec {
  /** Модель, собранная `prepare-weapon.ts`. */
  url: string;
  /** Длина модели в метрах — по ней считается масштаб в кадре. */
  model: number;
  /**
   * Длина вещи — **в предплечьях**, а не в метрах.
   *
   * Сцена видмодели не метрична: руки в ней ужаты и придвинуты к камере,
   * чтобы занять нужную долю кадра (см. anchor). Топор длиной «0.7 метра»
   * выходил в ней поперёк всего экрана. Единственная честная мерка здесь —
   * сами руки.
   */
  forearms: number;
  /** Где кулак держит древко — вдоль оси модели, от её начала координат. */
  grip: THREE.Vector3;
  /** Как вещь стоит в кулаке относительно мира. */
  stand: THREE.Quaternion;
  /** Сдвиг внутрь кадра, в предплечьях: плюс — вправо. */
  shift: number;
  /**
   * Осадка вниз по кадру, в предплечьях.
   *
   * Отдельно от точки хвата: `grip` — про то, где кулак держит древко,
   * а это — про то, как высоко вещь стоит в кадре. Смешаешь их, и правка
   * «опусти пониже» начнёт менять место хвата в кулаке.
   */
  drop?: number;
  /**
   * Сдвиг к экрану, в предплечьях.
   *
   * Кость ладони — не точка хвата: у посоха древко выходило чуть впереди
   * кулака, будто рука держит воздух. Плюс тянет вещь к зрителю.
   */
  pull?: number;
  /** Насколько притушить материал: у вещей текстуры темнее кожи. */
  tint: number;
  /**
   * Какая рука держит. По умолчанию правая — топор и посох; лук держит
   * левая, правая у него тянет тетиву. Хват, кость и поза пальцев берутся
   * по этой стороне (см. `grips` и `fists`).
   */
  hand?: Side;
  /**
   * Насколько на замахе свести плечо держащей руки к центру — в долях
   * разведения рук (`HANDS_SPREAD`): 1 снимает разведение, больше — тянет
   * внутрь. У лука клип владельца уводит правую за край кадра.
   */
  swingPull?: number;
  /**
   * Чем вещь машет в бою и при чтении свитка.
   *
   * У вещи, а не у действия: топор рубит и читать им нечего, посох
   * бьёт свитком и не машет в ударе. Чего нет — играет обычное:
   * кулак в ударе, стойка в чтении.
   */
  swings?: HandsClip;
  cast?: HandsClip;
}

/**
 * Ось вещи в её координатах: рукоять стоит по +Y.
 *
 * Внутри GLB узел уже повёрнут на −90° вокруг X (перевод Z-up в Y-up).
 * Ставить ещё один такой поворот сверху не нужно — топор от этого ложился
 * набок поперёк всего кадра.
 */
const ALONG = new THREE.Vector3(0, 1, 0);

/** Куда смотрит лезвие топора в его координатах. */
const AXE_EDGE = new THREE.Vector3(0, 0, -1);

/**
 * Доворот лезвия: владелец просил, чтобы оно смотрело чуть левее прямого.
 * Число подобрано им на кадре.
 */
const AXE_YAW = Math.PI / 7;

/**
 * Как топор стоит в кулаке: рукоять по вертикали, лезвие наружу от игрока.
 * Базис + доворот вокруг рукояти.
 */
const AXE_STAND = new THREE.Quaternion()
  .setFromAxisAngle(ALONG, AXE_YAW)
  .multiply(
    new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(AXE_EDGE, ALONG, new THREE.Vector3(1, 0, 0)),
    ),
  );

/**
 * Доворот посоха вокруг древка, влево.
 *
 * Сперва решили, что вокруг своей оси у посоха крутить нечего: лезвия нет.
 * Оказалось, что есть — древко витое, а кристалл наверху сидит с одной
 * стороны, и разворот виден. Владелец довернул его влево, глядя в кадр.
 */
const STAFF_YAW = THREE.MathUtils.degToRad(15);

/**
 * Насколько посох наклонён верхушкой вперёд, от экрана.
 *
 * Строго вертикальный посох читался палкой, приставленной к глазам: владелец
 * просил дать верхушке уйти вперёд. Наклон **в мировых осях**, а не вокруг
 * древка: вокруг своей оси у посоха нет лезвия, и такой поворот на вид
 * не влияет вовсе.
 */
const STAFF_TILT = THREE.MathUtils.degToRad(5);

/**
 * Посох стоит почти вертикально, с наклоном вперёд.
 *
 * Наклон домножается **слева**: `stand` — это мировая ориентация вещи
 * (в кадре она получается как поворот ладони, погашенный и заменённый этим),
 * поэтому доворот вокруг мировой X кладёт верхушку вперёд, в −Z.
 */
const STAFF_STAND = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -STAFF_TILT)
  .multiply(new THREE.Quaternion().setFromAxisAngle(ALONG, STAFF_YAW))
  .multiply(
    new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), ALONG, new THREE.Vector3(1, 0, 0)),
    ),
  );

/**
 * Как стоит лук: плечи по вертикали, тетива к стрелку.
 *
 * В модели тетива лежит по +X в 18 см от рукояти (высота базы настоящего
 * лука), рукоять в начале координат. К стрелку — это +Z кадра, поэтому
 * X модели ложится на +Z, а толщина (Z модели) — поперёк, на −X.
 */
const BOW_STAND = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), ALONG, new THREE.Vector3(-1, 0, 0)),
);

const HELD: Record<string, HeldSpec> = {
  crude_axe: {
    url: '/models/axe.glb',
    model: 1.15,
    /**
     * Честная длина — два с половиной предплечья, но предплечье занимает
     * 0.7 высоты кадра, и такой топор не помещается на экране полтора раза.
     * Размер подобран владельцем на кадре.
     */
    forearms: 2.0,
    /**
     * Кулак сжимает рукоять **ровно посередине** (между торцом и началом
     * головки), а не за конец: так решил владелец, и топор от этого садится
     * ниже в кадре.
     */
    grip: new THREE.Vector3(0, 0.05, 0),
    stand: AXE_STAND,
    /** Сдвиг внутрь кадра: без него топор режется правым краем экрана. */
    shift: -0.1,
    /**
     * Притушено слабее рук: кожу гасят до трети, иначе ладони светятся,
     * а у топора текстура своя, тёмная — та же треть делала его чёрным
     * силуэтом, неотличимым от столба за спиной.
     */
    tint: 0.8,
    /** Рубит клипом владельца. Читать топором нечего. */
    swings: 'axeSwing',
  },
  mage_staff: {
    url: '/models/staff.glb',
    model: 0.99,
    /** Посох выше топора: он в рост человека, и в кадре это видно. */
    forearms: 3.0,
    /** Держат ниже середины, как держат посох при ходьбе. */
    grip: new THREE.Vector3(0, -0.15, 0),
    stand: STAFF_STAND,
    /** Чуть правее топора: владелец сдвинул его, глядя в кадр. */
    shift: -0.09,
    /** Ниже топора: владелец опустил его, глядя в кадр. */
    drop: 0.3,
    /** И чуть ближе к экрану: древко стояло впереди кулака. */
    pull: 0.06,
    tint: 0.85,
    /**
     * Два клипа на два нажатия, и это решение владельца.
     *
     * Свиток — выстрел посохом (`Staff_Shot`), ЛКМ — тот же замах, что
     * у топора: посохом бьют, а не тычут, и мах кулаком с палкой в руке
     * выглядел бы потерей оружия. Клип один на оба: он про руку, а не
     * про топор — темп всё равно задаёт само оружие (`swing` у предмета).
     */
    swings: 'axeSwing',
    cast: 'staffCast',
  },
  hunting_bow: {
    url: '/models/bow.glb',
    model: 1.18,
    /** В рост посоха: лук чуть длиннее, но в кадре держат его на вытянутой. */
    forearms: 3.0,
    /** Рукоять в начале координат модели — держат её середину. */
    grip: new THREE.Vector3(0, 0, 0),
    stand: BOW_STAND,
    /** Сдвиг внутрь кадра, как у топора. Первая проба. */
    shift: -0.1,
    tint: 0.85,
    /**
     * Правая — так сказал владелец, посмотрев кадр с луком в левой.
     * Разбор клипа читался иначе (левая поднимается от пояса к плечу),
     * но чья рука что держит, решает автор клипа, а не разбор.
     */
    hand: 'R',
    /** ЛКМ — выстрел клипом владельца; читать луком нечего. */
    swings: 'bowShot',
    /** На выстреле правая шла слишком вправо — владелец просил к центру. Первая проба. */
    swingPull: 4,
  },
};

/**
 * Наш «вперёд» — это -Z, а модель выгружена лицом в +Z: без разворота кулак
 * при ударе летит в камеру, а не от неё.
 */
const MODEL_YAW = Math.PI;

/**
 * Куда ставить кисти относительно глаз и насколько крупно.
 *
 * Модель выгружена в координатах мира — руки стоят на высоте пояса живого
 * человека, и в кадре от первого лица они оказываются далеко и мелко.
 * Поэтому и место, и размер считаются: руки переносятся на нужное расстояние
 * от глаз и масштабируются так, чтобы занять заданную долю ширины кадра.
 *
 * Держим близко к глазам и широко разведёнными: так руки видно крупно, а
 * середина кадра остаётся свободной — обзор загораживают не крупные руки,
 * а сведённые к центру. Ориентир: кулаки у самых краёв (около ±0.77 по ширине
 * кадра), чуть ниже середины по высоте (−0.25), между ними широкий просвет.
 */
const HANDS_DISTANCE = 0.26;
const HANDS_DROP = 0.085;
/**
 * Какую часть высоты кадра занимает предплечье в стойке.
 *
 * Меряем по длине руки, а не по промежутку между кулаками: в стойке они
 * сведены, и подгонка «по промежутку» раздувала модель вдвое, лишь бы
 * растянуть эти двадцать пять сантиметров на пол-экрана. Руки получались
 * гигантскими, а кисти всё равно сходились в центре — промежуток-то задан
 * позой, и масштабом его не изменить.
 */
const HANDS_SCREEN_HEIGHT = 0.7;

/**
 * Насколько притушить руки.
 *
 * Модель сделана для светлой сцены, а у нас мрачное средневековье: как есть
 * руки светятся ярче всего вокруг и перетягивают взгляд. Тушим сам материал,
 * а не свет видмодели, — так они одинаково темнее и днём, и в подземелье.
 *
 * Множитель линейный, а глаз видит sRGB: 0.35 на экране выглядит примерно
 * как две трети прежней яркости, а не как треть.
 */
const HANDS_TINT = 0.35;

/**
 * Кости правой кисти, которым ставится поза хвата: пясти и фаланги.
 * Кончики (`_end_`) ничего не двигают — их не трогаем.
 *
 * Сама кисть (`DEF-handR`) в список **не входит**: её поворот из клипа держит
 * оружие по-своему, и топор уходил наискось через весь кадр. Обхват берём
 * у владельца, а кисть доворачиваем под рукоять сами — см. holdAxe.
 */
const fistBones = (side: Side): RegExp =>
  new RegExp(`^DEF-(palm0[1234]${side}|f_(index|middle|ring|pinky)0[123]${side}|thumb0[123]${side})(?!_end)`, 'i');

type Side = 'L' | 'R';

/**
 * Откуда берётся хват каждой руки: клип владельца и доля клипа.
 *
 * Правая — стойка с мечом посередине. Левая — первый кадр выстрела из лука:
 * это единственный клип, где левая что-то держит, и держит она там как раз лук.
 */
const GRIP_SOURCE: Record<Side, { clip: string; moment: number }> = {
  R: { clip: 'Sword_Idle', moment: 0.5 },
  L: { clip: 'Bow_Shot', moment: 0 },
};

/** В какой доле замаха топор внизу — там и заминка удара. */
const SWING_HIT = 0.72;

/** Насколько замирает топор внизу, чтобы удар чувствовался. */
const SWING_PAUSE = 0.12;

/** Как быстро гаснет и возвращается добавка хвата, долей в секунду. */
const GRIP_FADE = 6;

/**
 * На сколько развести руки в стороны, в единицах модели.
 *
 * В анимации кисти сведены почти к центру кадра, а нам нужен свободный обзор
 * посередине. Масштабом этого не добиться — промежуток задан позой.
 *
 * Плечо **сдвигается вбок**, а не доворачивается. Доворот пробовали первым,
 * и он оказался неуправляемым: поворот вокруг вертикали уводит кисть не только
 * вбок, но и по глубине, поэтому на одних углах руки разъезжались, на соседних
 * скрещивались, а посадка то и дело улетала за край кадра. Сдвиг же линеен:
 * прибавка превращается в предсказуемую долю кадра.
 */
const HANDS_SPREAD = 0.034;

/** Со скольки метров в секунду считаем, что игрок бежит, а не идёт. */
const RUN_SPEED = WALK_SPEED * 1.25;

/** Как редко руки «переминаются» в покое, секунды. */
const FIDGET_MIN = 9;
const FIDGET_MAX = 20;

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);

  private mixer: THREE.AnimationMixer | null = null;
  /** Риг держим отдельно: посадку приходится пересчитывать при смене кадра. */
  private rig: THREE.Object3D | null = null;
  /**
   * Поза хвата для правой руки: поворот кисти, пястей и фаланг.
   *
   * Снимается **из клипа удара**, а не подбирается углами: в ударе кисть
   * уже сжата так, как её задумал автор модели, и своя поза из двух десятков
   * суставов рядом с ней выглядит сломанной — на этом уже обожглись
   * (см. docs/hands.md, «Тупики»).
   */
  /** Поза хвата каждой руки: пясти и фаланги из клипа владельца. */
  private readonly fists: Record<Side, Map<THREE.Bone, THREE.Quaternion>> = { L: new Map(), R: new Map() };

  /** Кости плеч: ими руки разводятся в стороны поверх анимации. */
  private shoulders: { bone: THREE.Bone; axis: THREE.Vector3; side: Side; applied: number }[] = [];
  /**
   * Насколько плечо держащей руки сведено к центру: 0 — как всегда,
   * 1 — на полную `swingPull` вещи. Растёт на клипе замаха и гаснет после,
   * плавно, тем же темпом, что хват (`GRIP_FADE`).
   */
  private pullBlend = 0;
  /** Лежит ли сейчас на плечах наша добавка. Снимается перед каждым микшером. */
  private spreadApplied = false;
  /** Посадка ещё не считалась при известном соотношении сторон. */
  private needsAnchor = false;
  private readonly actions = new Map<HandsClip, THREE.AnimationAction>();
  private current: HandsClip | null = null;

  /** Сколько ещё длится клип, который нельзя перебивать раньше времени. */
  private holdFor = 0;
  /** Что показать, когда текущий клип доиграет. */
  private queued: HandsClip | null = null;

  /** Локальная фаза действия: анимация стартует по клику, не дожидаясь сервера. */
  private localAction: { kind: ActionKind; elapsed: number } | null = null;
  private lastServerAction: ActionKind | null = null;
  /** Серия ударов чередует руки, иначе выглядит механической. */
  private swing = 0;
  /**
   * Сколько ещё нельзя бить и уклоняться.
   *
   * Те же паузы, что у сервера. Без них руки махали на каждое нажатие, хотя
   * сервер такие удары отбрасывает: получался спам анимации без урона и без
   * траты стамины — картинка обещала бой, которого нет.
   */
  private swingCooldown = 0;

  /** Во сколько раз удар в руке длиннее удара кулаком: топор тяжёл. */
  private swingScale = 1;

  /** Во сколько раз он дешевле по стамине: голыми руками — вдвое. */
  private staminaScale = FIST_STAMINA_SCALE;
  private dodgeCooldown = 0;
  /** Уровень уклонения — приходит с прокачкой, см. `setEvasion`. */
  private evasion = 0;
  /** Лук в руке: с ним выстрел отыгрывается своим клипом, а не ударом. */
  /** Кости хвата обеих рук: ладонь (подвес), кисть (доворот), костяшки (трубка). */
  private readonly grips: Record<Side, Grip | null> = { L: null, R: null };
  /** Ладонь той руки, что держит вещь сейчас. */
  private get palm(): THREE.Object3D | null {
    return this.grips[this.side]?.palm ?? null;
  }
  /** Какая рука держит текущую вещь. */
  private get side(): Side {
    return this.heldSpec?.hand ?? 'R';
  }
  /** Модель вещи в кулаке — топора или посоха. Одна за раз. */
  private held: THREE.Object3D | null = null;

  /**
   * Фазы начатого чтения: у каждого свитка свой замах.
   *
   * А если чтение пришло с сервера — свиток неизвестен, и остаётся
   * короткий цикл: руки всё равно должны что-то сделать.
   */
  private casting: ActionTiming | null = null;
  /** Чья это модель: по ней считаются размер, посадка и доворот. */
  private heldSpec: HeldSpec | null = null;
  private heldLoading = false;
  /** Рабочий поворот: чтобы не заводить новый объект каждый кадр. */
  private readonly spin = new THREE.Quaternion();

  /** Длина предплечья в сцене после посадки — мерка размера для того, что в руке. */
  private forearm = 0;

  /** Черновики под пересчёт посадки топора — чтобы не сорить мусором в кадре. */
  private readonly size = new THREE.Vector3();

  private readonly reach = new THREE.Vector3();

  private readonly turn = new THREE.Quaternion();

  private readonly along = new THREE.Vector3();

  private readonly edge = new THREE.Vector3();

  private readonly cross = new THREE.Vector3();

  private readonly basis = new THREE.Matrix4();

  private readonly wrist = new THREE.Quaternion();

  /**
   * Посадка топора в стойке: как он сидит относительно ладони.
   *
   * В замахе она не пересчитывается, а повторяется — так топор летит вместе
   * с кистью, а не висит вертикально, пока рука махает мимо.
   */
  private readonly seat = { quaternion: new THREE.Quaternion(), position: new THREE.Vector3() };

  private seated = false;

  /** Насколько сейчас лежит наша добавка хвата: 1 — стойка, 0 — замах. */
  private gripBlend = 1;

  /** Заминка внизу: сделана ли она в этом замахе и сколько ещё длится. */
  private swingHit = false;

  private swingPause = 0;


  /** Был ли игрок на земле в прошлом кадре — по смене ловим прыжок. */
  private grounded = true;
  /** Сколько ещё отыгрывать взмах руками в прыжке. */
  private airborne = 0;

  /** Блок держится, пока игрок жмёт кнопку: вход, петля, выход. */
  private blocking = false;
  /** Подбор вещи: старт, петля, завершение. */
  private taking = 0;
  private fidgetIn = FIDGET_MIN;

  /** Свет видмодели: его приходится приглушать к ночи. */
  private readonly lamps: THREE.Light[];
  private readonly lampBase: number[];

  constructor(private readonly race: Race) {
    const fill = new THREE.AmbientLight(0xffffff, 1.4);
    this.scene.add(fill);
    const key = new THREE.DirectionalLight(0xffe6c4, 2.1);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb0d8, 0.9);
    rim.position.set(0.8, 0.2, -0.6);
    this.scene.add(rim);

    this.lamps = [fill, key, rim];
    this.lampBase = this.lamps.map((light) => light.intensity);

    void this.load(race);
  }

  /**
   * Начать анимацию немедленно по нажатию — до ответа сервера.
   *
   * Возвращает false, если действие всё равно не пройдёт: идёт другое или
   * не вышла пауза. Тогда не стоит ни махать руками, ни слать намерение.
   */
  beginAction(kind: ActionKind, spellId?: SpellId): boolean {
    if (!this.canBegin(kind)) return false;

    /**
     * Чтение длится столько, сколько сказано в самом свитке.
     *
     * Фазы те же, что у сервера (`castTiming`): считай их клиент по-своему,
     * и посох бил бы раньше или позже, чем вылетает снаряд.
     */
    if (kind === 'cast') this.casting = spellId ? castTiming(spellId) : null;

    if (kind === 'attack' || kind === 'heavy') {
      this.swing++;
      const timing = scaleTiming(ACTIONS[kind].timing, this.swingScale);
      this.swingCooldown = ATTACK_COOLDOWN + timing.windup + timing.active;
    }
    if (kind === 'dodge') this.dodgeCooldown = dodgeCooldown(this.evasion);

    this.localAction = { kind, elapsed: 0 };
    return true;
  }

  /** Пройдёт ли действие прямо сейчас — по тем же правилам, что у сервера. */
  canBegin(kind: ActionKind): boolean {
    // Начатое доигрывается целиком: на сервере действие тоже нельзя прервать.
    if (this.localAction) return false;
    if ((kind === 'attack' || kind === 'heavy') && this.swingCooldown > 0) return false;
    if (kind === 'dodge' && this.dodgeCooldown > 0) return false;
    return true;
  }

  /**
   * Подгоняет освещение рук под время суток.
   *
   * У видмодели свой свет — мировой на неё не действует, иначе руки резались
   * бы тенями от того, чего в их сцене нет. Но и жить своей жизнью он не
   * должен: ночью ярко освещённые руки светились посреди тёмного города,
   * будто их подсвечивают изнутри.
   */
  setAmbience(daylight: number): void {
    const level = 0.4 + Math.max(0, Math.min(1, daylight)) * 0.6;
    for (const [index, light] of this.lamps.entries()) {
      light.intensity = this.lampBase[index]! * level;
    }
  }

  /** Игрок поднял вещь — руки тянутся и забирают её. */
  playTake(): void {
    this.taking = this.lengthOf('takeStart') + this.lengthOf('takeLoop');
  }

  /**
   * Началась работа: рубка ноды или изготовление.
   *
   * Тот же клип из трёх частей, что и у подбора, только петля тянется столько,
   * сколько идёт работа. Конец назначает сервер, поэтому берём с запасом —
   * `endWork` оборвёт петлю ровно тогда, когда придёт его слово. Без запаса
   * руки замирали бы на последних кадрах, пока полоса ещё ползёт.
   */
  beginWork(seconds: number): void {
    this.taking = Math.max(this.taking, seconds + 1);
  }

  /** Работа кончилась или брошена — руки доигрывают выход. */
  endWork(): void {
    this.taking = 0;
  }

  /**
   * Хватает ли стамины: те же числа, по которым решает сервер.
   *
   * Цена удара зависит от того, что в руке: голыми руками бьют вдвое дешевле.
   * Знай клиент другую цену — руки отказывались бы бить там, где сервер
   * разрешает, или наоборот.
   */
  static staminaCost(
    kind: 'attack' | 'heavy' | 'dodge',
    evasion = 0,
    staminaScale = 1,
  ): number {
    return kind === 'dodge' ? dodgeCost(evasion) : ACTIONS[kind].staminaCost * staminaScale;
  }

  /** Во сколько раз дешевле удар тем, что сейчас в руке. */
  get handCost(): number {
    return this.staminaScale;
  }

  /**
   * Уровень уклонения: от него зависят откат рывка и его цена.
   *
   * Клиенту он нужен, чтобы **отказывать по тем же правилам, что и сервер**.
   * Знай он меньше сервера — руки отказывались бы делать рывок, который
   * сервер разрешает, и наоборот: жмёшь, а ничего не происходит.
   */
  setEvasion(level: number): void {
    this.evasion = level;
  }

  /** Что в основной руке: лук отыгрывается своим клипом, топор виден в кулаке. */
  setWeapon(defId: string | null): void {
    // Темп удара задаёт оружие — тот же множитель, что у сервера.
    this.swingScale = defId && isItemId(defId) ? (itemDef(defId).swing ?? 1) : 1;
    // И цена: голыми руками бьют дешевле.
    this.staminaScale = defId ? 1 : FIST_STAMINA_SCALE;

    /**
     * Что из этого видно в кулаке.
     *
     * Держим **одну** вещь за раз: сменил топор на посох — прежняя модель
     * снимается с кости и забывается. Держать обе и прятать лишнюю значило бы
     * копить в кости оружие, которого у игрока нет.
     */
    const spec = defId ? HELD[defId] : undefined;
    if (spec !== this.heldSpec) {
      if (this.held) {
        this.held.removeFromParent();
        this.held = null;
      }
      this.heldSpec = spec ?? null;
      this.seated = false;
      if (spec) void this.loadHeld(spec);
    }
  }

  /** Подвешивает вещь к ладони. Кости ещё нет — дождёмся рига, он придёт. */
  private async loadHeld(spec: HeldSpec): Promise<void> {
    if (typeof document === 'undefined') return;
    this.heldLoading = true;
    try {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('/draco/');
      loader.setDRACOLoader(draco);
      const gltf = await loader.loadAsync(spec.url);
      const model = gltf.scene;
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        // Притушено слабее рук: почему — см. `tint` у вещи.
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const standard = material as THREE.MeshStandardMaterial;
          if (standard.color) standard.color.multiplyScalar(spec.tint);
        }
      });
      // Пока модель ехала, игрок мог сменить вещь — тогда эта уже не нужна.
      if (this.heldSpec !== spec) return;
      this.held = model;
      this.attachHeld();
    } catch (error) {
      console.warn(`[руки] не загрузилась ${spec.url}:`, error);
    } finally {
      this.heldLoading = false;
    }
  }

  /** Вешает вещь на кость ладони. Размер и посадку считает holdWeapon в кадре. */
  private attachHeld(): void {
    const palm = this.palm;
    const held = this.held;
    if (!palm || !held) return;
    palm.add(held);
  }

  /**
   * Держит топор в кулаке и прямо **относительно мира**, а не кисти.
   *
   * Три вещи разом, и все — каждый кадр:
   *
   * - **размер** — от длины предплечья, поделённой на масштаб кости.
   *   Считать его один раз при подвеске нельзя: риг подгоняется под ширину
   *   кадра уже после того, как модель повисла на кости, и топор выходил
   *   вдесятеро больше кулака.
   * - **поворот**: гасим поворот кисти и ставим рукоять по вертикали —
   *   владелец просил, чтобы топор стоял прямо.
   * - **сдвиг**: кость — это середина хвата, а не начало координат модели.
   *   Без сдвига топор висит серединой топорища в кулаке и уезжает из кадра.
   *
   * После микшера: он переписывает позы костей каждый кадр.
   */
  private holdWeapon(dt: number): void {
    const held = this.held;
    const spec = this.heldSpec;
    const grip = spec ? this.grips[spec.hand ?? 'R'] : null;
    if (!held || !spec || !grip || this.forearm <= 0) return;
    const { palm, hand, knuckles } = grip;
    const fist = this.fists[spec.hand ?? 'R'];

    /**
     * В замахе рукой распоряжается клип, а не мы.
     *
     * В стойке топор держится прямо: пальцы сжаты позой хвата, кисть довёрнута
     * под рукоять. В замахе всё это надо отпустить — иначе мы держим кисть
     * вертикально, пока клип пытается ею махнуть, и удар разваливается.
     * Поэтому добавка гаснет и возвращается **плавно**: мгновенное снятие
     * дёргает кисть на первом кадре удара.
     */
    // Отпускаем на клипе замаха этой вещи: у топора и посоха это рубка,
    // у лука — выстрел, где левая кисть живёт по клипу владельца.
    const wanted = this.current === spec.swings ? 0 : 1;
    this.gripBlend += Math.sign(wanted - this.gripBlend) * Math.min(dt * GRIP_FADE, 1);
    this.gripBlend = Math.min(1, Math.max(0, this.gripBlend));
    const blend = this.gripBlend;

    if (blend > 0) {
      for (const [bone, pose] of fist) bone.quaternion.slerp(pose, blend);
      this.rig?.updateMatrixWorld(true);

      /**
       * Разворот кисти под рукоять.
       *
       * Сжатые пальцы образуют трубку, и её ось идёт поперёк ладони — от
       * основания указательного к основанию мизинца. Топор стоит прямо,
       * значит доворачивать надо кисть: ищем поворот, который кладёт ось
       * трубки на вертикаль, и досылаем его кисти в пространстве родителя.
       */
      {
        const start = knuckles.index.getWorldPosition(this.size);
        const end = knuckles.pinky.getWorldPosition(this.reach);
        const line = this.along.copy(end).sub(start).normalize();
        if (line.y < 0) line.negate();
        this.turn.setFromUnitVectors(line, ALONG);
        const parent = hand.parent?.getWorldQuaternion(this.spin) ?? this.spin.identity();
        this.wrist.copy(parent).invert().multiply(this.turn).multiply(parent);
        // Добавка тоже гаснет: иначе кисть в начале удара прыгает.
        hand.quaternion.premultiply(this.spin.identity().slerp(this.wrist, blend));
      }
    }
    this.rig?.updateMatrixWorld(true);

    const world = palm.getWorldScale(this.size).x || 1;
    const scale = (spec.forearms * this.forearm) / (spec.model * world);
    held.scale.setScalar(scale);

    /**
     * Пока держим стойку — считаем посадку заново и запоминаем её.
     *
     * В замахе топор садится **той же** посадкой: он жёстко связан с кистью
     * и летит вместе с ней. Считать вертикаль в замахе нельзя — топор
     * висел бы в воздухе, пока рука machет мимо.
     */
    if (blend > 0.999) {
      palm.getWorldQuaternion(this.spin).invert();
      held.quaternion.copy(this.spin).multiply(spec.stand);

      /**
       * Рукоять садится в середину трубки, а не в точку кости.
       *
       * Кость ладони лежит у края, и топор, посаженный прямо в неё, проходил
       * мимо пальцев. Середина считается **мировыми точками** и переводится
       * в систему ладони: локальные `position` костей с разными родителями
       * несравнимы — на этом уже теряли меч.
       */
      const from = knuckles.index.getWorldPosition(this.size);
      const to = knuckles.pinky.getWorldPosition(this.reach);
      palm.worldToLocal(from.add(to).multiplyScalar(0.5));
      held.position.copy(from);

      // Хват модели — не её начало координат: без этого топор висит в кулаке
      // серединой топорища.
      held.position.add(
        this.edge.copy(spec.grip).multiplyScalar(-scale).applyQuaternion(held.quaternion),
      );

      // Сдвиг внутрь кадра. Считается в мире и переводится в систему ладони:
      // у ладони свой поворот и свой масштаб.
      held.position.add(
        this.edge
          .set(
            (spec.shift * this.forearm) / world,
            (-(spec.drop ?? 0) * this.forearm) / world,
            ((spec.pull ?? 0) * this.forearm) / world,
          )
          .applyQuaternion(this.spin),
      );

      this.seat.quaternion.copy(held.quaternion);
      this.seat.position.copy(held.position);
      this.seated = true;
    } else if (this.seated) {
      held.quaternion.copy(this.seat.quaternion);
      held.position.copy(this.seat.position);
    }
  }

  /**
   * Заминка удара: внизу топор на миг замирает.
   *
   * Без неё замах — ровное движение, и удара не чувствуется: тяжёлое железо
   * обязано «вязнуть» в том, во что попало. Замирает **только замах**,
   * остальные клипы идут своим ходом.
   */
  private hitch(dt: number): void {
    const swing = this.actions.get('axeSwing');
    if (!swing || this.current !== 'axeSwing') return;

    if (this.swingPause > 0) {
      this.swingPause -= dt;
      swing.paused = this.swingPause > 0;
      return;
    }
    if (!this.swingHit && swing.time >= swing.getClip().duration * SWING_HIT) {
      this.swingHit = true;
      this.swingPause = SWING_PAUSE;
      swing.paused = true;
    }
  }

  /** Какой клип идёт прямо сейчас — по нему удобно проверять поведение. */
  get playing(): HandsClip | null {
    return this.current;
  }

  /** Действие клипа: по нему видно, с какой скоростью он растянут. */
  actionFor(clip: HandsClip): THREE.AnimationAction | null {
    return this.actions.get(clip) ?? null;
  }

  update(dt: number, state: ViewModelState): void {
    this.advanceAction(dt, state);

    this.scene.visible = state.alive;
    if (!this.mixer) return;

    this.holdFor = Math.max(0, this.holdFor - dt);
    this.taking = Math.max(0, this.taking - dt);

    const wanted = this.choose(dt, state);
    if (wanted) this.play(wanted);

    // Сведение плеча к центру на замахе — плавно, как хват.
    const pullWanted = this.heldSpec?.swingPull && this.current === this.heldSpec.swings ? 1 : 0;
    this.pullBlend += Math.sign(pullWanted - this.pullBlend) * Math.min(dt * GRIP_FADE, 1);
    this.pullBlend = Math.min(1, Math.max(0, this.pullBlend));

    // Микшер обязан писать в чистую кость, поэтому добавку снимаем до него
    // и возвращаем после.
    this.unspreadArms();
    this.hitch(dt);
    this.mixer.update(dt);
    this.spreadArms();
    // Топор садится в кулак после микшера: микшер только что переписал
    // позы костей, в том числе кисть, к которой он подвешен.
    this.holdWeapon(dt);
  }

  /**
   * Разводит руки в стороны поверх анимации — сдвигом плеча наружу.
   *
   * Сдвигаем, а не подменяем позу плеча. Когда сюда ставилась поза покоя,
   * весь размах удара пропадал: в клипе руку выносит плечо, и от удара
   * оставалось одно доразгибание локтя — кулак задирался к лицу вместо
   * выпада вперёд.
   *
   * Добавка **снимается перед микшером и возвращается после** — см.
   * `unspreadArms`. Пара обязательна, поэтому обе стороны защищены флагом:
   * повторный вызов ничего не делает, и накопить сдвиг нельзя.
   */
  private spreadArms(): void {
    if (this.spreadApplied) return;
    const spec = this.heldSpec;
    for (const shoulder of this.shoulders) {
      // Плечо держащей руки на замахе сводится к центру: у лука клип уводит
      // его вправо за кадр, и владелец просил держать ближе к середине.
      const pull =
        spec?.swingPull && shoulder.side === (spec.hand ?? 'R') ? spec.swingPull * this.pullBlend : 0;
      shoulder.applied = HANDS_SPREAD * (1 - pull);
      shoulder.bone.position.addScaledVector(shoulder.axis, shoulder.applied);
    }
    this.spreadApplied = true;
  }

  /**
   * Снимает разведение, чтобы микшер писал в чистую кость.
   *
   * Без этого руки **уползали за край экрана**, и тем быстрее, чем дольше
   * стоишь. Причина в том, что микшер трогает только те свойства, у которых
   * в клипе есть дорожка: позицию плеча двигают удар, блок и подбор вещи,
   * а стойка и ходьба — нет. Пока добавка считалась от «позы, которую выставил
   * микшер», в стойке этой позой оказывалась уже сдвинутая кость, и сдвиг
   * ложился поверх себя кадр за кадром. Заодно объясняется и то, что руки
   * возвращались в кадр, стоило ударить: удар переписывал позицию и обнулял
   * накопленное.
   */
  private unspreadArms(): void {
    if (!this.spreadApplied) return;
    // Снимаем ровно столько, сколько положили: на замахе добавка другая.
    for (const shoulder of this.shoulders) {
      shoulder.bone.position.addScaledVector(shoulder.axis, -shoulder.applied);
    }
    this.spreadApplied = false;
  }

  /** Рисует руки поверх мира, очистив глубину, чтобы они не резались стенами. */
  render(renderer: THREE.WebGLRenderer, aspect: number): void {
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);
      this.needsAnchor = true;
    }

    // Размер и разведение рук считаются от ширины кадра, а она известна
    // только здесь: на момент загрузки камера ещё квадратная, и посадка,
    // посчитанная тогда, в широком окне даёт заметно более узкие руки.
    // Флагом, а не прямым вызовом: модель может приехать и до первого кадра,
    // и после него — порядок не должен влиять на то, где окажутся руки.
    if (this.needsAnchor && this.rig) {
      this.anchor(this.rig, this.race);
      this.needsAnchor = false;
    }
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }

  /**
   * Локальное действие живёт своей жизнью, а сервер лишь подтверждает его.
   *
   * К моменту, когда сервер сообщает «бью», анимация уже идёт, а когда она
   * кончилась — он всё ещё может сообщать о том же ударе. Поэтому реагируем
   * на смену действия, а не на его наличие: иначе руки махали бы дважды.
   */
  private advanceAction(dt: number, state: ViewModelState): void {
    this.swingCooldown = Math.max(0, this.swingCooldown - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.airborne = Math.max(0, this.airborne - dt);

    // Прыжок ловим по отрыву от земли, а не по нажатию: так взмах руками
    // совпадает с моментом, когда игрока действительно оторвало — падение
    // с уступа выглядит так же, как прыжок.
    if (this.grounded && !state.onGround) this.airborne = this.lengthOf('equip');
    this.grounded = state.onGround;

    if (this.localAction) {
      this.localAction.elapsed += dt;
      if (this.localAction.elapsed > this.durationOf(this.localAction.kind)) {
        this.localAction = null;
        this.casting = null;
      }
    }

    if (state.action !== this.lastServerAction) {
      // Сервер подтвердил действие, о котором мы ещё не знали — например,
      // его начал не игрок, а оглушение или чужая механика.
      if (state.action && !this.localAction) this.beginAction(state.action);
      this.lastServerAction = state.action;
    }
  }

  /**
   * Что показывать сейчас. Порядок важен: удар перебивает всё, блок держится
   * до отпускания, подбор вещи доигрывает до конца, и только потом остаётся
   * движение или покой.
   */
  private choose(dt: number, state: ViewModelState): HandsClip | null {
    const action = this.localAction?.kind ?? null;

    /**
     * Чтение свитка посохом — клип владельца вместо стойки.
     *
     * Клип берётся у того, что в руке: с топором и с пустой ладонью
     * свиток читают без замаха. Махать посохом на любой каст нельзя:
     * медитация и гашение света идут тем же нажатием, но замаха в них нет —
     * о этом решает вызывающий код (`beginCast`).
     */
    const cast = this.heldSpec?.cast;
    if (action === 'cast' && cast && this.actions.has(cast)) return cast;

    /**
     * Замах топором — клип владельца вместо маха кулаком.
     *
     * Условие `has(...)` обязательно по той же причине, что у лука:
     * клип живёт в модели, а модель пересобирается скриптами. Пропал —
     * бьём кулаком, и бой не ломается.
     */
    const swings = this.heldSpec?.swings;
    if ((action === 'attack' || action === 'heavy') && swings && this.actions.has(swings)) {
      return swings;
    }

    // Удар. Правая и левая чередуются, тяжёлый всегда правой — он размашистее.
    if (action === 'attack' || action === 'heavy') {
      if (action === 'heavy') return 'punchRight';
      return this.swing % 2 === 0 ? 'punchRight' : 'punchLeft';
    }

    // Прыжок: короткий взмах руками. Уступает удару, но перебивает ходьбу —
    // в воздухе шаг выглядит нелепо.
    if (this.airborne > 0 && this.actions.has('equip')) return 'equip';

    // Блок: вход играется один раз, дальше петля, на отпускании — выход.
    if (state.blocking) {
      if (!this.blocking) {
        this.blocking = true;
        this.queued = 'blockLoop';
        return 'blockStart';
      }
      if (this.holdFor > 0) return null;
      // Петля пошла — очередь своё отработала.
      this.queued = null;
      return 'blockLoop';
    }
    if (this.blocking) {
      this.blocking = false;
      return 'blockStop';
    }

    // Подбор вещи — тоже из трёх частей.
    if (this.taking > 0) {
      if (this.current !== 'takeStart' && this.current !== 'takeLoop') {
        this.queued = 'takeLoop';
        return 'takeStart';
      }
      if (this.holdFor > 0) return null;
      this.queued = null;
      return 'takeLoop';
    }
    if (this.current === 'takeLoop') return 'takeStop';

    /**
     * Клип, который нельзя обрывать, доигрывает: это удар, вход в блок,
     * выход из него и завершение работы.
     *
     * Очередь тут обязана быть пустой. Когда её забывали очистить при входе
     * в петлю, она всплывала уже после выхода: руки закрывали работу и тут же
     * начинали её заново, и так по кругу.
     */
    if (this.holdFor > 0) return null;
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      return next;
    }

    if (state.speed >= RUN_SPEED) return 'sprint';
    if (state.speed > 0.2) return 'walk';

    // Стоя руки изредка переминаются — иначе картинка выглядит замершей.
    this.fidgetIn -= dt;
    if (this.fidgetIn <= 0 && this.actions.has('fidget')) {
      this.fidgetIn = FIDGET_MIN + Math.random() * (FIDGET_MAX - FIDGET_MIN);
      return 'fidget';
    }
    return 'idle';
  }

  private play(clip: HandsClip): void {
    if (clip === this.current) return;

    const next = this.actions.get(clip);
    if (!next) return;

    const previous = this.current ? this.actions.get(this.current) : null;
    // Удар начинается рывком, остальное перетекает плавно.
    const quick = clip === 'punchRight' || clip === 'punchLeft' || clip === 'axeSwing';
    const fade = quick ? 0.04 : 0.14;

    /**
     * Темп удара задаётся не рукой, а видом удара.
     *
     * Правая и левая — просто два замаха одной серии, и идти они обязаны
     * одинаково. Скорость берётся из фаз действия: кулак должен доходить
     * до цели ровно к концу замаха, а замах у лёгкого и тяжёлого разный.
     * Пока скорость была привязана к клипу, левая рука била вдвое быстрее
     * правой — просто потому, что её растянули под лёгкий удар, а правую
     * под тяжёлый.
     */
    /**
     * Замах посоха растягивается на фазы свитка.
     *
     * Своёго темпа у клипа быть не должно: он трёхсекундный, а самый
     * быстрый свиток читается полсекунды — посох бы ещё только поднимался,
     * когда снаряд уже летит.
     */
    if (clip === this.heldSpec?.cast) {
      const timing = this.casting ?? CAST_FALLBACK;
      next.timeScale = next.getClip().duration / (timing.windup + timing.active);
    }

    if (quick) {
      const kind = this.localAction?.kind === 'heavy' ? 'heavy' : 'attack';
      // Замах растягивается ровно на фазы удара — те же, что считает сервер.
      // Темп задаёт оружие: у топора фазы вдвое длиннее, и клип идёт медленнее
      // сам собой, без отдельного множителя.
      const timing = scaleTiming(ACTIONS[kind].timing, this.swingScale);
      next.timeScale = next.getClip().duration / (timing.windup + timing.active);
    }

    next.reset().fadeIn(fade).play();
    if (clip === 'axeSwing') {
      // Заминка удара считается заново на каждый замах.
      next.paused = false;
      this.swingHit = false;
      this.swingPause = 0;
    }
    previous?.fadeOut(fade);

    this.current = clip;
    // Одноразовые клипы держим до конца, чтобы их не перебило на полпути.
    this.holdFor = ONCE.includes(clip) ? this.lengthOf(clip) : 0;
    // Заминку внизу клип обязан пережить: иначе его перебьёт стойкой.
    if (clip === 'axeSwing') this.holdFor += SWING_PAUSE;
  }

  /**
   * Сколько длится начатое действие.
   *
   * У чтения фазы свои у каждого свитка, поэтому методом, а не таблицей:
   * с одной длительностью на все свитки долгое чтение обрывалось бы
   * стойкой на полпути.
   */
  private durationOf(kind: ActionKind): number {
    if (kind === 'cast') {
      const timing = this.casting ?? CAST_FALLBACK;
      return timing.windup + timing.active + timing.recovery;
    }
    return totalDuration(kind, this.swingScale);
  }

  private lengthOf(clip: HandsClip): number {
    const action = this.actions.get(clip);
    if (!action) return 0;
    const scale = action.timeScale === 0 ? 1 : Math.abs(action.timeScale);
    return action.getClip().duration / scale;
  }

  private async load(race: Race): Promise<void> {
    // Вне браузера грузить неоткуда: относительный путь там не разрешается.
    // Тесты подставляют риг сами через useRig.
    if (typeof document === 'undefined') return;

    try {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('/draco/');
      loader.setDRACOLoader(draco);

      const gltf = await loader.loadAsync(MODEL_URL);
      this.useRig(gltf.scene, gltf.animations, race);
    } catch (error) {
      console.warn('[руки] модель не загрузилась:', error);
    }
  }

  /**
   * Ставит руки перед камерой и заводит клипы.
   *
   * Отдельно от загрузки, потому что этим же путём риг подставляют тесты:
   * проверять надо посадку и выбор анимаций, а не то, докачался ли файл.
   */
  useRig(rig: THREE.Object3D, clips: THREE.AnimationClip[], race: Race): void {
    rig.rotation.y = MODEL_YAW;

    rig.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;

      mesh.frustumCulled = false;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.color) standard.color.multiplyScalar(HANDS_TINT);
      }
    });

    this.scene.add(rig);
    this.rig = rig;
    this.mixer = new THREE.AnimationMixer(rig);

    for (const [name, candidates] of Object.entries(CLIP_NAMES) as [HandsClip, string[]][]) {
      const clip = candidates
        .map((candidate) => findClip(clips, candidate))
        .find((found): found is THREE.AnimationClip => found !== null);
      if (!clip) continue;

      const action = this.mixer.clipAction(clip);
      if (ONCE.includes(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }

    /**
     * Плечи: по ним руки разводятся в стороны.
     *
     * Ось — «наружу по экрану», то есть мировая горизонталь, переведённая
     * в пространство родителя кости. Знак не угадывается, а **проверяется**:
     * пробный сдвиг показывает, в какую сторону кисть уезжает от середины.
     * Угадывать тут нечего — риг развёрнут на пол-оборота, а названия L и R
     * в нём даны с точки зрения зрителя, и любое предположение о знаке
     * оказывалось обратным.
     */
    this.shoulders = [];
    rig.updateMatrixWorld(true);

    for (const side of ['L', 'R'] as const) {
      let bone: THREE.Bone | null = null;
      rig.traverse((node) => {
        const candidate = node as THREE.Bone;
        if (!bone && candidate.isBone && new RegExp(`^DEF-upper_arm${side}`, 'i').test(candidate.name)) {
          bone = candidate;
        }
      });
      if (!bone) continue;

      const found = bone as THREE.Bone;
      let fist: THREE.Object3D | null = null;
      found.traverse((node) => {
        if (!fist && new RegExp(`^DEF-hand${side}`, 'i').test(node.name)) fist = node;
      });
      if (!fist) continue;

      const hand = fist as THREE.Object3D;
      const parentWorld = new THREE.Quaternion();
      (found.parent ?? found).getWorldQuaternion(parentWorld);
      const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(parentWorld.invert()).normalize();

      const rest = found.position.clone();
      const before = Math.abs(hand.getWorldPosition(new THREE.Vector3()).x);
      found.position.copy(rest).addScaledVector(axis, 0.1);
      rig.updateMatrixWorld(true);
      const after = Math.abs(hand.getWorldPosition(new THREE.Vector3()).x);
      found.position.copy(rest);
      rig.updateMatrixWorld(true);

      if (after < before) axis.negate();
      this.shoulders.push({ bone: found, axis, side, applied: 0 });
    }

    /**
     * Кости хвата обеих рук: ладонь — подвес, кисть — доворот под рукоять,
     * костяшки — трубка кулака. Имена без номеров: экспортёр дописывает
     * номер, и он меняется от сборки к сборке.
     */
    for (const side of ['L', 'R'] as const) {
      let palm: THREE.Object3D | null = null;
      let hand: THREE.Bone | null = null;
      let index: THREE.Bone | null = null;
      let pinky: THREE.Bone | null = null;
      rig.traverse((node) => {
        if (!palm && new RegExp(`^DEF-palm02${side}`, 'i').test(node.name)) palm = node;
        const bone = node as THREE.Bone;
        if (!bone.isBone) return;
        if (!hand && new RegExp(`^DEF-hand${side}`, 'i').test(bone.name)) hand = bone;
        if (!index && new RegExp(`^DEF-f_index01${side}`, 'i').test(bone.name)) index = bone;
        if (!pinky && new RegExp(`^DEF-f_pinky01${side}`, 'i').test(bone.name)) pinky = bone;
      });
      this.grips[side] = palm && hand && index && pinky ? { palm, hand, knuckles: { index, pinky } } : null;
    }
    if (this.held) this.attachHeld();

    for (const side of ['L', 'R'] as const) this.learnFist(rig, clips, side);
    this.anchor(rig, this.race);
    this.needsAnchor = true;

    // Входим в мир с доставанием рук, если такой клип есть.
    if (this.actions.has('equip')) this.play('equip');

    // Сразу применяем первый кадр: иначе между загрузкой и первым обновлением
    // руки успевают мелькнуть в позе, в которой лежат в файле.
    this.unspreadArms();
    this.mixer.update(0);
    this.spreadArms();
  }

  /**
   * Ставит руки перед камерой: нужное расстояние, высота и размер в кадре.
   *
   * Модель выгружена в координатах мира — кисти стоят на высоте пояса живого
   * человека, и как есть выглядят далёкими и мелкими. Поэтому размер считается
   * от кадра: на выбранном расстоянии руки должны занимать заданную долю его
   * ширины. Подбирать это руками пришлось бы заново после каждой замены модели.
   */
  /**
   * Снимает позу кулака с клипа удара и запоминает её.
   *
   * Владелец просил, чтобы рукоять была зажата в кулаке, а не проходила
   * сквозь раскрытую ладонь. Своя поза пальцев числами не подбирается —
   * двадцать суставов, и каждый круг правок выглядит сломанной кистью.
   * Берётся **готовый хват из клипа владельца** `Sword_Idle`: он сделан
   * на нашем же риге, то есть это ровно та кисть, которой автор держит
   * оружие. Поза кулака из удара, которой это делалось сперва, держала
   * рукоять не так — кисть в ударе сжата, но развёрнута иначе.
   *
   * Замер идёт тем же порядком, что и посадка рук: остановить микшер,
   * проиграть нужный клип в нужный миг, снять кости, вернуть, что играло.
   */
  private learnFist(rig: THREE.Object3D, clips: THREE.AnimationClip[], side: Side): void {
    const source = GRIP_SOURCE[side];
    const clip = findClip(clips, source.clip);
    if (!clip || !this.mixer) return;
    const grip = this.mixer.clipAction(clip);

    const wasPlaying = this.current;
    this.unspreadArms();
    this.mixer.stopAllAction();
    grip.reset().play();
    this.mixer.setTime(clip.duration * source.moment);
    rig.updateMatrixWorld(true);

    const fist = this.fists[side];
    const bones = fistBones(side);
    fist.clear();
    rig.traverse((node) => {
      const bone = node as THREE.Bone;
      if (bone.isBone && bones.test(bone.name)) fist.set(bone, bone.quaternion.clone());
    });

    this.mixer.stopAllAction();
    this.current = 'idle';
    if (wasPlaying && wasPlaying !== 'idle') this.play(wasPlaying);
    this.unspreadArms();
    this.mixer.update(0);
    this.spreadArms();
  }

  private anchor(rig: THREE.Object3D, race: Race): void {
    const idle = this.actions.get('idle');
    if (!idle || !this.mixer) return;

    // Считаем от исходного положения: посадку повторяют при смене кадра,
    // и накапливать поправки поверх прежних нельзя.
    rig.position.set(0, 0, 0);
    rig.scale.setScalar(1);
    rig.updateMatrixWorld(true);

    /**
     * Мерим по чистой стойке.
     *
     * Посадка считается и повторно — когда становится известен кадр, — а к
     * тому времени уже идёт другой клип. Если просто добавить стойку поверх,
     * микшер смешает позы, и кулаки окажутся не там: в игре руки от этого
     * выходили вдвое крупнее и сведёнными к центру.
     */
    const wasPlaying = this.current;
    this.unspreadArms();
    this.mixer.stopAllAction();
    idle.reset().play();
    this.mixer.setTime(0);

    /**
     * Меряем по кулакам, а не по всему мешу: предплечья уходят далеко назад,
     * и подгонка «по габаритам» раздувала руки вдвое шире экрана, заодно
     * утаскивая их вниз за край кадра.
     */
    const fists: THREE.Object3D[] = [];
    const elbows: THREE.Object3D[] = [];
    rig.traverse((node) => {
      if (/^DEF-hand[LR]/i.test(node.name)) fists.push(node);
      if (/^DEF-forearm[LR]/i.test(node.name)) elbows.push(node);
    });
    if (fists.length < 2 || elbows.length < 2) return;

    const measure = (): { centre: THREE.Vector3; forearm: number } => {
      // Меряем ту же позу, которая будет на экране, — уже с разведёнными
      // плечами. Без этого посадка считалась по сведённой стойке, а рисовались
      // руки развёрнутыми: кулаки уезжали к самой камере, за край кадра.
      this.spreadArms();
      rig.updateMatrixWorld(true);
      const points = fists.map((fist) => fist.getWorldPosition(new THREE.Vector3()));
      const centre = points
        .reduce((sum, point) => sum.add(point), new THREE.Vector3())
        .divideScalar(points.length);
      const forearm = elbows[0]!
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(points[0]!);
      return { centre, forearm };
    };

    const before = measure();
    if (before.forearm <= 0) return;

    // Высота кадра на том расстоянии, где будут руки.
    const frameHeight = 2 * HANDS_DISTANCE * Math.tan((this.camera.fov * Math.PI) / 360);
    // Рост расы поверх общего размера: у дворфа руки короче, у эльфа длиннее.
    rig.scale.multiplyScalar(
      ((frameHeight * HANDS_SCREEN_HEIGHT) / before.forearm) * (RACES[race].height / 1.8),
    );

    const after = measure();
    // Той же меркой меряется всё, что кладётся в руку: сцена не метрична.
    this.forearm = after.forearm;
    rig.position.add(new THREE.Vector3(0, -HANDS_DROP, -HANDS_DISTANCE).sub(after.centre));
    rig.updateMatrixWorld(true);

    /**
     * Довод по экрану, а не по трёхмерной середине.
     *
     * В стойке одна рука выдвинута ближе другой, поэтому одинаковые отступы
     * в пространстве дают на экране разные: ближний кулак уезжает к краю,
     * дальний жмётся к центру. Двигаем риг вбок, пока кулаки не встанут
     * симметрично относительно прицела.
     */
    this.camera.updateMatrixWorld(true);
    for (let pass = 0; pass < 3; pass++) {
      const onScreen = fists.map((fist) =>
        fist.getWorldPosition(new THREE.Vector3()).project(this.camera),
      );
      const offset = (onScreen[0]!.x + onScreen[1]!.x) / 2;
      if (Math.abs(offset) < 0.01) break;

      // Насколько метров сдвинуть, чтобы съесть эту долю экрана.
      const halfWidth =
        HANDS_DISTANCE *
        Math.tan((this.camera.fov * Math.PI) / 360) *
        Math.max(this.camera.aspect, 1);
      rig.position.x -= offset * halfWidth;
      rig.updateMatrixWorld(true);
    }

    // Возвращаем то, что играло: анимация не должна сбиваться из-за замера.
    // Клип при этом не глушим — после stop кости встают в позу из файла,
    // и до первого обновления микшера руки видно именно в ней.
    this.current = 'idle';
    if (wasPlaying && wasPlaying !== 'idle') this.play(wasPlaying);
    this.unspreadArms();
    this.mixer.update(0);
    this.spreadArms();
  }
}

/** Клип по имени: у экспортёров оно бывает с приставкой вроде `rig|Idle`. */
function findClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip | null {
  const exact = THREE.AnimationClip.findByName(clips, name);
  if (exact) return exact;

  const wanted = name.toLowerCase();
  return (
    clips.find((clip) => (clip.name.split('|').pop() ?? clip.name).toLowerCase() === wanted) ?? null
  );
}

function totalDuration(kind: ActionKind, scale = 1): number {
  const timing = scaleTiming(timingFor(kind), scale);
  return timing.windup + timing.active + timing.recovery;
}

function timingFor(kind: ActionKind) {
  if (kind === 'attack') return ACTIONS.attack.timing;
  if (kind === 'heavy') return ACTIONS.heavy.timing;
  if (kind === 'dodge') return ACTIONS.dodge.timing;
  // Блок держится сервером; для рук хватает короткого цикла.
  return CAST_FALLBACK;
}
