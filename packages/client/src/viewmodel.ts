import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  ACTIONS,
  ATTACK_COOLDOWN,
  DODGE_COOLDOWN,
  dodgeCooldown,
  dodgeCost,
  RACES,
  WALK_SPEED,
  type ActionKind,
  type ActionPhase,
  type Race,
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
  | 'bowDraw'
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
  bowDraw: ['Bow_Draw'],
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
  'bowDraw',
  'blockStart',
  'blockStop',
  'takeStart',
  'takeStop',
];

const MODEL_URL = '/models/hands.glb';

/** Топор в правом кулаке — модель от владельца, собрана prepare-weapon.ts. */
const AXE_URL = '/models/axe.glb';

const AXE = {
  /** К какой кости крепится. Имя без номера: номер меняется от сборки. */
  bone: /^DEF-palm02R/i,
  /** Длина модели в метрах — по ней считается масштаб в кадре. */
  model: 1.15,
  /**
   * Длина топора — **в предплечьях**, а не в метрах.
   *
   * Сцена видмодели не метрична: руки в ней ужаты и придвинуты к камере,
   * чтобы занять нужную долю кадра (см. anchor). Топор длиной «0.7 метра»
   * выходил в ней поперёк всего экрана. Единственная честная мерка здесь —
   * сами руки.
   *
   * Честная длина — два с половиной предплечья, но предплечье занимает
   * 0.7 высоты кадра, и такой топор не помещается на экране полтора раза.
   * Берём короче жизни, но не настолько, чтобы он смотрелся игрушкой:
   * размер подобран владельцем на кадре.
   */
  forearms: 1.9,
  /**
   * Где кулак держит топорище — вдоль оси модели, от её начала координат.
   *
   * У модели ось рукояти — Z: головка наверху (z от 0.44 до 0.80), торец
   * топорища внизу (z = −0.35). Кулак сжимает рукоять чуть выше торца.
   */
  grip: -0.17,
  /** Предмет, с которым топор виден в руке. */
  item: 'crude_axe',
};

/**
 * Доворот лезвием вперёд, от игрока.
 *
 * Внутри GLB узел уже повёрнут на −90° вокруг X (перевод Z-up в Y-up), так
 * что рукоять и без нас стоит по +Y, головка вверх, а лезвие смотрит вправо.
 * Ставить ещё один такой поворот сверху не нужно — топор от этого ложился
 * набок поперёк всего кадра. Остаётся развернуть лезвие с боку вперёд.
 */
const AXE_FACING = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI / 2,
);

/** Точка хвата в координатах модели: ось рукояти после того же поворота — +Y. */
const AXE_GRIP = new THREE.Vector3(0, -0.17, 0);

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
 * Кости правой кисти, которым ставится поза хвата: фаланги и сама кисть.
 * Кончики (`_end_`) ничего не двигают — их не трогаем.
 */
const FIST_BONES = /^DEF-(f_(index|middle|ring|pinky)0[123]R|thumb0[123]R)(?!_end)/i;

/** Куда смотрит ось трубки из сжатых пальцев, когда топор стоит прямо. */
const AXE_ALONG = new THREE.Vector3(0, 1, 0);

/** В какой доле клипа удара кулак сжат плотнее всего. */
const FIST_MOMENT = 0.35;

/** Насколько притушен топор в руке — см. загрузку модели. */
const AXE_TINT = 0.8;

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
   * Поза кулака для правой руки: поворот каждой фаланги.
   *
   * Снимается **из клипа удара**, а не подбирается углами: в ударе кисть
   * уже сжата так, как её задумал автор модели, и своя поза из двух десятков
   * суставов рядом с ней выглядит сломанной — на этом уже обожглись
   * (см. docs/hands.md, «Тупики»).
   */
  private readonly fist = new Map<THREE.Bone, THREE.Quaternion>();

  /** Кости плеч: ими руки разводятся в стороны поверх анимации. */
  private shoulders: { bone: THREE.Bone; axis: THREE.Vector3 }[] = [];
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
  private dodgeCooldown = 0;
  /** Уровень уклонения — приходит с прокачкой, см. `setEvasion`. */
  private evasion = 0;
  /** Лук в руке: с ним выстрел отыгрывается своим клипом, а не ударом. */
  private bow = false;
  /** Кость ладони правой руки: к ней крепится топор. */
  private palm: THREE.Object3D | null = null;
  /** Модель топора. Грузится один раз, дальше только показывается и прячется. */
  private axe: THREE.Object3D | null = null;
  private axeLoading = false;
  /** Рабочий поворот: чтобы не заводить новый объект каждый кадр. */
  private readonly spin = new THREE.Quaternion();

  /** Длина предплечья в сцене после посадки — мерка размера для того, что в руке. */
  private forearm = 0;

  /** Черновики под пересчёт посадки топора — чтобы не сорить мусором в кадре. */
  private readonly size = new THREE.Vector3();

  private readonly reach = new THREE.Vector3();

  private readonly turn = new THREE.Quaternion();

  /** Кисть целиком: её доворачиваем под рукоять. */
  private hand: THREE.Bone | null = null;

  /** Основания указательного и мизинца — по ним считается трубка кулака. */
  private knuckles: { index: THREE.Bone; pinky: THREE.Bone } | null = null;

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
  beginAction(kind: ActionKind): boolean {
    if (!this.canBegin(kind)) return false;

    if (kind === 'attack' || kind === 'heavy') {
      this.swing++;
      const timing = ACTIONS[kind].timing;
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

  /** Хватает ли стамины: те же числа, по которым решает сервер. */
  static staminaCost(kind: 'attack' | 'heavy' | 'dodge', evasion = 0): number {
    return kind === 'dodge' ? dodgeCost(evasion) : ACTIONS[kind].staminaCost;
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
    this.bow = defId === 'hunting_bow';

    const axe = defId === AXE.item;
    if (this.axe) this.axe.visible = axe;
    if (axe && !this.axe && !this.axeLoading) void this.loadAxe();
  }

  /** Подвешивает топор к ладони. Кости ещё нет — дождёмся рига, он придёт. */
  private async loadAxe(): Promise<void> {
    if (typeof document === 'undefined') return;
    this.axeLoading = true;
    try {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('/draco/');
      loader.setDRACOLoader(draco);
      const gltf = await loader.loadAsync(AXE_URL);
      const model = gltf.scene;
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        /**
         * Притушено слабее, чем руки.
         *
         * Кожа в модели почти белая, и её гасят до трети, иначе ладони в кадре
         * светятся. У топора текстура своя, тёмная: та же треть превращала его
         * в чёрный силуэт, неотличимый от столба за спиной.
         */
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const standard = material as THREE.MeshStandardMaterial;
          if (standard.color) standard.color.multiplyScalar(AXE_TINT);
        }
      });
      this.axe = model;
      this.attachAxe();
    } catch (error) {
      console.warn('[руки] топор не загрузился:', error);
    } finally {
      this.axeLoading = false;
    }
  }

  /** Вешает топор на кость ладони. Размер и посадку считает holdAxe в кадре. */
  private attachAxe(): void {
    const palm = this.palm;
    const axe = this.axe;
    if (!palm || !axe) return;
    palm.add(axe);
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
  private holdAxe(): void {
    const axe = this.axe;
    const palm = this.palm;
    const hand = this.hand;
    const knuckles = this.knuckles;
    if (!axe || !palm || !axe.visible || this.forearm <= 0) return;

    // Пальцы сжимаем **до** всего остального: поза кисти двигает и ладонь.
    for (const [bone, pose] of this.fist) bone.quaternion.copy(pose);

    /**
     * Разворот кисти под рукоять.
     *
     * Сжатые пальцы образуют трубку, и ось этой трубки идёт **поперёк
     * ладони** — от основания указательного к основанию мизинца, а не вдоль
     * пальцев. Топор стоит прямо по миру, значит доворачивать надо кисть:
     * ищем поворот, который кладёт ось трубки на вертикаль, и досылаем его
     * кисти в пространстве её родителя.
     */
    if (hand && knuckles) {
      this.rig?.updateMatrixWorld(true);
      const from = knuckles.index.getWorldPosition(this.size);
      const to = knuckles.pinky.getWorldPosition(this.reach);
      const along = to.sub(from).normalize();
      if (along.lengthSq() > 0) {
        this.spin.setFromUnitVectors(along, AXE_ALONG);
        const parent = hand.parent?.getWorldQuaternion(this.turn) ?? this.turn.identity();
        hand.quaternion.premultiply(parent.clone().invert().multiply(this.spin).multiply(parent));
      }
    }

    this.rig?.updateMatrixWorld(true);

    const world = palm.getWorldScale(this.size).x || 1;
    const scale = (AXE.forearms * this.forearm) / (AXE.model * world);
    axe.scale.setScalar(scale);

    palm.getWorldQuaternion(this.spin).invert();
    axe.quaternion.copy(this.spin).multiply(AXE_FACING);

    /**
     * Рукоять ложится в середину трубки, а не в точку кости.
     *
     * Кость ладони лежит у её края, и топор, посаженный прямо в неё, проходил
     * мимо сжатых пальцев. Середину считаем **мировыми точками** и переводим
     * в систему ладони: локальные `position` костей с разными родителями
     * несравнимы — на этом уже теряли меч.
     */
    if (knuckles) {
      const from = knuckles.index.getWorldPosition(this.size);
      const to = knuckles.pinky.getWorldPosition(this.reach);
      palm.worldToLocal(from.add(to).multiplyScalar(0.5));
      axe.position.copy(from);
    } else {
      axe.position.set(0, 0, 0);
    }
    this.size.copy(AXE_GRIP).multiplyScalar(-scale).applyQuaternion(axe.quaternion);
    axe.position.add(this.size);
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

    // Микшер обязан писать в чистую кость, поэтому добавку снимаем до него
    // и возвращаем после.
    this.unspreadArms();
    this.mixer.update(dt);
    this.spreadArms();
    // Топор садится в кулак после микшера: микшер только что переписал
    // позы костей, в том числе кисть, к которой он подвешен.
    this.holdAxe();
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
    for (const { bone, axis } of this.shoulders) {
      bone.position.addScaledVector(axis, HANDS_SPREAD);
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
    for (const { bone, axis } of this.shoulders) {
      bone.position.addScaledVector(axis, -HANDS_SPREAD);
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
      if (this.localAction.elapsed > totalDuration(this.localAction.kind)) {
        this.localAction = null;
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
     * Выстрел из лука — своё движение, а не удар кулаком.
     *
     * Клип перенесён с чужого скелета Mixamo и **пока сырой**: что с ним
     * не так и что с этим делать — отдельный разбор в docs/bow.md. В игре
     * он остаётся: лучше видеть то, что правишь.
     *
     * Условие `has('bowDraw')` обязательно: клип живёт в модели, а модель
     * пересобирается скриптами. Пропал клип — руки просто машут, как раньше,
     * и бой от этого не ломается.
     */
    if ((action === 'attack' || action === 'heavy') && this.bow && this.actions.has('bowDraw')) {
      return 'bowDraw';
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
    const quick = clip === 'punchRight' || clip === 'punchLeft';
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
    if (quick) {
      const kind = this.localAction?.kind === 'heavy' ? 'heavy' : 'attack';
      const timing = ACTIONS[kind].timing;
      next.timeScale = next.getClip().duration / (timing.windup + timing.active);
    }

    next.reset().fadeIn(fade).play();
    previous?.fadeOut(fade);

    this.current = clip;
    // Одноразовые клипы держим до конца, чтобы их не перебило на полпути.
    this.holdFor = ONCE.includes(clip) ? this.lengthOf(clip) : 0;
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
      this.shoulders.push({ bone: found, axis });
    }

    // Кость ладони правой руки — точка подвеса топора. Имя без номера:
    // экспортёр дописывает номер, и он меняется от сборки к сборке.
    this.palm = null;
    this.hand = null;
    let index: THREE.Bone | null = null;
    let pinky: THREE.Bone | null = null;
    rig.traverse((node) => {
      if (!this.palm && AXE.bone.test(node.name)) this.palm = node;
      const bone = node as THREE.Bone;
      if (!bone.isBone) return;
      // Имена без номеров: у Rigify номер кости меняется от сборки к сборке.
      if (!this.hand && /^DEF-handR/i.test(bone.name)) this.hand = bone;
      if (!index && /^DEF-f_index01R/i.test(bone.name)) index = bone;
      if (!pinky && /^DEF-f_pinky01R/i.test(bone.name)) pinky = bone;
    });
    this.knuckles = index && pinky ? { index, pinky } : null;
    if (this.axe) this.attachAxe();

    this.learnFist(rig);
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
   * Зато в клипе удара кисть уже сжата так, как её слепил автор модели:
   * берём её оттуда целиком.
   *
   * Замер идёт тем же порядком, что и посадка рук: остановить микшер,
   * проиграть нужный клип в нужный миг, снять кости, вернуть, что играло.
   */
  private learnFist(rig: THREE.Object3D): void {
    const punch = this.actions.get('punchRight');
    if (!punch || !this.mixer) return;

    const wasPlaying = this.current;
    this.unspreadArms();
    this.mixer.stopAllAction();
    punch.reset().play();
    this.mixer.setTime(punch.getClip().duration * FIST_MOMENT);
    rig.updateMatrixWorld(true);

    this.fist.clear();
    rig.traverse((node) => {
      const bone = node as THREE.Bone;
      if (bone.isBone && FIST_BONES.test(bone.name)) this.fist.set(bone, bone.quaternion.clone());
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

function totalDuration(kind: ActionKind): number {
  const timing = timingFor(kind);
  return timing.windup + timing.active + timing.recovery;
}

function timingFor(kind: ActionKind) {
  if (kind === 'attack') return ACTIONS.attack.timing;
  if (kind === 'heavy') return ACTIONS.heavy.timing;
  if (kind === 'dodge') return ACTIONS.dodge.timing;
  // Блок и каст держатся сервером; для рук хватает короткого цикла.
  return { windup: 0.5, active: 0.1, recovery: 0.4 };
}
