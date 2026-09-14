import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  LAMP_HEIGHT,
  TAVERN,
  TOWN_LAMPS,
} from '@grimhold/shared';

/**
 * Искусственный свет: фонари, факелы, костры, очаг таверны.
 *
 * Весь рукотворный огонь мира заведён здесь — в одном месте, потому что
 * у него общие правила: он мерцает, он греет картинку тёплым, и он **гаснет
 * днём**. Разложи это по модулям — и половина ламп однажды останется гореть
 * в полдень.
 *
 * Небесный свет сюда не относится: солнце, луна и заполняющий свет живут
 * в daynight.ts.
 */

/** Модели фонаря и костра. Один файл: и то и другое нужно сразу по всему городу. */
const MODEL_URL = '/models/lights.glb';


/**
 * Настенный факел — модель от владельца (выгрузка Sketchfab), лежит как есть:
 * 68 КБ, текстуры 256 пикселей, пламя качается на двух костях.
 *
 * Кронштейн у модели смотрит в −X — по нему модель и разворачивается к стене.
 */
const TORCH_URL = '/models/torch.glb';
/** Высота факела от острия рукояти до верха пламени, м. */
const TORCH_HEIGHT = 0.8;
/** На какой высоте верх пламени: там же горел прежний огонёк без модели. */
const TORCH_TOP = 2.95;
/** Как далеко от грани ждёт ореол, пока модель не приехала, м. */
const TORCH_REACH = 0.3;
/** Кости пламени. Днём сжимаются в ноль: пламя уходит в рукоять. */
const FLAME_BONES = /^Torch[01]_0[12]$/;
/**
 * Яркость пламени — выше белого: только такое постобработка считает огнём.
 * Текстура свечения в модели тёмная везде, кроме самого пламени.
 */
const TORCH_GLOW = 2.5;

/** Поставленная модель факела: своя анимация и кости пламени. */
interface WallTorch {
  mixer: THREE.AnimationMixer;
  bones: { bone: THREE.Object3D; rest: THREE.Vector3 }[];
  /** Под крышей: пламя и свечение не гаснут днём. */
  indoor: boolean;
}

/**
 * Огонь как **данные**, а не как лампа.
 *
 * Ламп в сцене ровно `LIGHT_POOL` штук, и они переезжают к ближайшим огням.
 * Причина жёсткая: в прямом рендере three все источники живут в массивах
 * шейдера, и стоит их числу измениться — перекомпилируются **все** материалы
 * сцены. Гасили лампы на рассвете видимостью и получали фриз на полсекунды
 * каждый рассвет и закат. Плюс каждый лишний источник считается для каждого
 * пикселя, а их тут было полтора десятка.
 */
interface Flame {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Дальность затухания. */
  range: number;
  /** Видимое пламя: мерцает вместе со светом. */
  glow: THREE.Object3D | null;
  base: number;
  phase: number;
  /**
   * Гаснет ли днём.
   *
   * Уличный огонь — да: горящий в полдень фонарь выглядит бутафорией и вдобавок
   * зря съедает лимит источников. Огонь под крышей — нет: в таверне полумрак
   * круглые сутки, ради него она и нужна.
   */
  outdoor: boolean;
}

/**
 * Настенные факелы: колоннада и глухие простенки.
 *
 * Ставятся **на грань**, а не в середину того, к чему крепятся. Колонны здесь
 * толщиной 1.2 м, и факел по их координатам оказывался внутри камня: света
 * не видно, огонька не видно, и непонятно, что вообще не так.
 *
 * Точка лежит ровно на грани, `face` — наружу от неё. Пока факел был огоньком
 * без модели, точка висела в воздухе перед гранью; модели нужен сам камень:
 * кронштейн упирается в него, пламя выносится на площадь.
 */
const TORCHES: {
  x: number;
  z: number;
  face: { x: number; z: number };
  /** Под крышей огонь днём не гаснет: в зале полумрак круглые сутки. */
  indoor?: boolean;
  /** Высота верха пламени, если не общая: в зале потолок ниже уличной стены. */
  top?: number;
}[] = [
  // Таверна снаружи: у двери на крыльце и на стене крыла, что смотрит на крыльцо.
  { x: TAVERN.x + 2.25, z: TAVERN.z + 2.5, face: { x: 1, z: 0 } },
  { x: TAVERN.x + 3.2, z: TAVERN.z - 0.1, face: { x: 0, z: 1 } },
  // Таверна внутри: две на западной стене зала и одна в крыле.
  { x: TAVERN.x - 4.0, z: TAVERN.z - 1.5, face: { x: 1, z: 0 }, indoor: true, top: 2.6 },
  { x: TAVERN.x - 4.0, z: TAVERN.z + 3.0, face: { x: 1, z: 0 }, indoor: true, top: 2.6 },
  { x: TAVERN.x + 3.1, z: TAVERN.z - 5.35, face: { x: 0, z: 1 }, indoor: true, top: 2.6 },
];

/** Свечи зала таверны — над столами и на стойке. Без ореола: это свет, а не маяк. */
const TAVERN_CANDLES: { x: number; y: number; z: number; color: number; intensity: number }[] = [
  { x: -2.4, y: 1.9, z: 0.8, color: 0xffc98a, intensity: 5 },
  { x: -2.4, y: 1.9, z: 3.6, color: 0xffc98a, intensity: 5 },
  { x: -1.8, y: 1.5, z: -4.3, color: 0xffb066, intensity: 6 },
];

/**
 * Сколько ламп держим в сцене одновременно.
 *
 * В городе пятнадцать уличных огней, а ламп было шесть — и это и была
 * разгадка жалобы «свет виден, только когда подойдёшь». Свет **появлялся**
 * при подходе: лампа доставалась огню, когда он входил в шестёрку ближайших,
 * и в этот миг вспыхивала на полную. Отсюда и «мерцание» на ходу — это
 * лампы перебегали от огня к огню.
 *
 * Восемь — столько, сколько в прямом рендере не жалко: каждый источник
 * считается для каждого пикселя, и число это вшито в шейдеры, поэтому
 * меняется только здесь и только вместе с замером кадра.
 */
const LIGHT_POOL = 8;

/**
 * За сколько секунд лампа разгорается и гаснет при переходе к другому огню.
 *
 * Переход обязан быть плавным: мгновенная передача — это и есть та вспышка,
 * которую видно как «свет включился». Полсекунды глаз читает как разгорающийся
 * огонь, а не как щелчок выключателя.
 */
const HANDOVER = 0.5;

/**
 * Затухание света с расстоянием.
 *
 * Физически верное — квадратичное (2): на трёх метрах от факела остаётся
 * девятая часть яркости, на шести — тридцать шестая. Для тёмного города это
 * честно и бесполезно — игрок видит чёрное поле с точками огня.
 *
 * Полтора было полумерой: пятно под фонарём стало шире, но на пятнадцати
 * метрах от него оставалась одна шестидесятая — после тональной компрессии
 * это ноль. Единица — свет спадает вдвое на каждом удвоении расстояния,
 * и дальний фонарь виден как фонарь, а не как искра в темноте.
 *
 * Это не физика, это освещение сцены. Цена — светлее вблизи, поэтому яркости
 * подобраны заново, а не оставлены прежними.
 */
const LIGHT_DECAY = 1;

/**
 * Дальность огня — та, на которой его свет обязан быть виден.
 *
 * Не декоративное число: в шейдере оно ещё и обрезает свет окном
 * `(1 − (d/дальность)⁴)²`. Последняя пятая часть дальности поэтому почти
 * не светит — и если хочешь свет на двадцати метрах, дальность ставь сорок,
 * а не двадцать пять.
 */
const STREET_RANGE = 40;

/**
 * Фора тому, кто уже держит лампу.
 *
 * Новый претендент должен быть заметно нужнее, а не на волос — иначе набор
 * дёргается от малейшего шага в сторону. Треть разницы глаз не замечает,
 * а мигание прекращает.
 */
const KEEP_BONUS = 2;

export interface WorldLights {
  /**
   * Весь огонь одной группой.
   *
   * Он весь городской, а город выгружается вместе со своим чанком. Спрятав
   * группу, разом гасим и лампы: источники в невидимой группе не попадают
   * в отрисовку, а лимит их на пиксель в WebGL не резиновый.
   */
  readonly group: THREE.Group;
  /**
   * `daylight` — насколько сейчас светло снаружи, 0..1. Уличный огонь гаснет
   * по этому числу, а не по признаку «день/ночь»: щелчок на рассвете было бы
   * видно.
   */
  update(elapsed: number, daylight: number, camera: THREE.Camera): void;
  /**
   * Уличный огонь — фонари и настенные факелы. У них ночью вьётся мошкара
   * (particles.ts). Список растёт, когда догружаются модели фонарей.
   */
  readonly lamps: readonly { x: number; y: number; z: number }[];
}

export function createLights(scene: THREE.Scene): WorldLights {
  const flames: Flame[] = [];
  const group = new THREE.Group();
  scene.add(group);

  // Пул ламп. Заводится один раз и живёт, не меняя ни числа, ни видимости.
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < LIGHT_POOL; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 20, LIGHT_DECAY);
    group.add(light);
    pool.push(light);
  }

  const torchFlames = TORCHES.map((spot, index) => makeTorch(group, spot, index));
  flames.push(...torchFlames);
  /** Модели факелов: догружаются позже огня и встают под его ореол. */
  const torches: WallTorch[] = [];
  const torchMaterials = new Set<THREE.MeshStandardMaterial>();
  let torchClock = 0;

  // Свечи зала таверны: огонь под крышей, днём не гаснет.
  for (const [index, candle] of TAVERN_CANDLES.entries()) {
    flames.push({
      x: TAVERN.x + candle.x,
      y: candle.y,
      z: TAVERN.z + candle.z,
      color: candle.color,
      range: 24,
      glow: null,
      base: candle.intensity * 0.42,
      phase: index * 2.1,
      outdoor: false,
    });
  }

  // Постоянного огня в подземелье нет: свет туда приносят в руке.
  // Городские огни отсюда всё равно не видны — до города восемь километров,
  // и в отбор ближайших он не попадает никогда.

  void loadModels(group, flames);
  void loadTorches(group, torchFlames, torches, torchMaterials);

  /**
   * Отбор ближайших огней. Записи переиспользуются, а не создаются заново:
   * это кадр за кадром, и мусор отсюда потом аукается рывками сборки.
   *
   * Растёт по месту: список огней пополняется асинхронно, когда приезжают
   * модели фонарей и костров. Выделенный «сразу на всех» массив оказывался
   * коротким, и первый же кадр после загрузки падал.
   */
  const lit: { flame: Flame; power: number; weight: number }[] = [];
  let litCount = 0;
  const eye = new THREE.Vector3();
  /** Кто держал лампу в прошлом кадре — за это полагается фора. */
  let holding = new Set<Flame>();
  let nextHolding = new Set<Flame>();

  /**
   * Что держит каждая лампа и насколько она разгорелась.
   *
   * Лампа не перепрыгивает с огня на огонь мгновенно: сперва гаснет на своём
   * старом месте, потом разгорается на новом. Без этого переход виден как
   * вспышка — и именно он читался как «свет включился, когда я подошёл».
   */
  const slots = pool.map(() => ({ flame: null as Flame | null, level: 0 }));
  let previous = 0;

  /**
   * Уличные огни пересобираются, только когда их стало больше: модели фонарей
   * приезжают позже факелов, а каждый кадр фильтровать незачем.
   */
  let lamps: Flame[] = [];
  let counted = -1;

  return {
    group,
    get lamps() {
      if (counted !== flames.length) {
        counted = flames.length;
        lamps = flames.filter((flame) => flame.outdoor);
      }
      return lamps;
    },
    update(elapsed, daylight, camera) {
      // Днём уличный огонь не просто тускнеет, а гаснет совсем: горящий
      // в полдень фонарь читается как ошибка.
      const outdoorScale = Math.max(0, 1 - daylight * 1.4);
      camera.getWorldPosition(eye);
      litCount = 0;

      /**
       * Факелы: пламя качается, а днём гаснет вместе со светом.
       *
       * Кости пламени сперва возвращаются в покой, потом их двигает анимация,
       * и только потом они сжимаются по свету. Иначе сжатие копилось бы
       * от кадра к кадру — клип может не трогать масштаб, и пламя однажды
       * схлопнулось бы насовсем.
       */
      const torchStep = Math.min(0.1, Math.max(0, elapsed - torchClock));
      torchClock = elapsed;
      const flameSize = Math.max(0.001, outdoorScale);
      for (const torch of torches) {
        for (const { bone, rest } of torch.bones) bone.scale.copy(rest);
        torch.mixer.update(torchStep);
        for (const { bone } of torch.bones) bone.scale.multiplyScalar(torch.indoor ? 1 : flameSize);
      }
      for (const material of torchMaterials) material.emissiveIntensity = TORCH_GLOW * outdoorScale;

      for (const flame of flames) {
        const flame_flicker = flicker(elapsed, flame.phase);

        // Ровная яркость, без мерцания: по ней решается, кому достанется
        // лампа. Само мерцание идёт поверх, уже выбранному источнику.
        const steady = flame.base * (flame.outdoor ? outdoorScale : 1);
        const power = steady * flame_flicker;

        if (flame.glow) {
          flame.glow.visible = steady > 0.01;
          flame.glow.scale.setScalar(0.9 + flame_flicker * 0.18);
        }
        if (steady <= 0.01) continue;

        const dx = eye.x - flame.x;
        const dy = eye.y - flame.y;
        const dz = eye.z - flame.z;
        const squared = dx * dx + dy * dy + dz * dz;

        // Дальше своей дальности затухания источник не освещает ничего.
        // Такие в отбор не пускаем вовсе: иначе они занимают лампы, ничего
        // не давая, и вытесняют те, что реально видно.
        if (squared > flame.range * flame.range) continue;

        /**
         * Вес: чем ярче и ближе, тем нужнее. Квадрат расстояния — потому что
         * так же спадает и сам свет.
         *
         * Считается по **ровной** яркости и с форой тому, кто держал лампу
         * в прошлом кадре. Без этого два огня на схожем расстоянии менялись
         * местами по десять раз в секунду, и издали это выглядело как
         * включение и выключение фонарика. Вблизи ближний побеждал с запасом,
         * и мигание пропадало — отсюда и было ощущение, что дело в дистанции.
         */
        const slot = (lit[litCount] ??= { flame, power: 0, weight: 0 });
        litCount++;
        slot.flame = flame;
        slot.power = power;
        slot.weight = (steady / Math.max(0.25, squared)) * (holding.has(flame) ? KEEP_BONUS : 1);
      }

      // Сортируем только заполненную часть: хвост — это записи прошлого кадра.
      const chosenLights = lit.slice(0, litCount).sort((a, b) => b.weight - a.weight);

      // Меняем местами наборы, а не создаём новый: это кадр за кадром.
      nextHolding.clear();
      for (let i = 0; i < pool.length && i < chosenLights.length; i++) {
        nextHolding.add(chosenLights[i]!.flame);
      }
      const swap = holding;
      holding = nextHolding;
      nextHolding = swap;

      // Шаг времени берём из самих кадров: отдельного dt сюда не передают,
      // а привязывать разгорание к частоте кадров нельзя — на ста восьмидесяти
      // герцах переход вышел бы втрое быстрее, чем на шестидесяти.
      const dt = Math.min(0.1, Math.max(0, elapsed - previous));
      previous = elapsed;
      const step = HANDOVER > 0 ? dt / HANDOVER : 1;

      /**
       * Раздача ламп.
       *
       * Сперва оставляем при своих тех, кто и так горит нужным огнём: лампа
       * не должна менять хозяина только потому, что порядок в списке сместился.
       * Потом гаснущие освобождают место, и свободные лампы разбирают
       * оставшихся.
       */
      const wanted = chosenLights.slice(0, pool.length);
      const taken = new Set<Flame>();
      for (const slot of slots) {
        if (slot.flame && wanted.some((entry) => entry.flame === slot.flame)) {
          taken.add(slot.flame);
        } else {
          // Чужой огонь — сперва погаснуть, и только потом взять новый.
          slot.level = Math.max(0, slot.level - step);
          if (slot.level === 0) slot.flame = null;
        }
      }

      for (const entry of wanted) {
        if (taken.has(entry.flame)) continue;
        const free = slots.find((slot) => slot.flame === null);
        if (!free) break;
        free.flame = entry.flame;
        taken.add(entry.flame);
      }

      for (const [index, light] of pool.entries()) {
        const slot = slots[index]!;
        const chosen = slot.flame
          ? (chosenLights.find((entry) => entry.flame === slot.flame) ?? null)
          : null;

        if (chosen) slot.level = Math.min(1, slot.level + step);

        if (!slot.flame || slot.level <= 0) {
          // Лишние лампы не выключаем, а обнуляем: пропавший источник меняет
          // число света в шейдере, и это стоит перекомпиляции всей сцены.
          light.intensity = 0;
          continue;
        }

        light.position.set(slot.flame.x, slot.flame.y, slot.flame.z);
        light.color.setHex(slot.flame.color);
        light.distance = slot.flame.range;
        // Гаснущий огонь светит своей ровной яркостью — мерцание остаётся
        // тому, кто разгорелся: дрожь на угасании читалась бы как сбой.
        light.intensity = (chosen ? chosen.power : slot.flame.base) * slot.level;
      }
    },
  };
}

/**
 * Как выглядит огонь в руке.
 *
 * Цвет и мерцание — те же, что у настенного факела, и это не совпадение:
 * огонь в городе и огонь в руке один и тот же. Разойдись они — в подземелье
 * горел бы фонарик, а не факел, и вся картинка мрака рассыпалась бы об это.
 *
 * А вот затухание своё, мягче городского (0.8 против 1). Причина не в красоте:
 * свет обязан доставать **до границы мглы и немного за неё**. Ровно там
 * проходит вся польза факела — если круг света кончается раньше тумана,
 * носитель видит ту же стену мрака, что и без него, только светлее под ногами.
 */
export const TORCH_LIGHT = { color: 0xff9a3c, range: 24, base: 13, decay: 0.8 };

/**
 * Мерцание пламени: два несинхронных синуса разной частоты.
 *
 * Отдано наружу, потому что мерцать обязан **любой** огонь. Случайных скачков
 * нет намеренно: шум на свету читается как моргание сломанной лампы, а не
 * как живое пламя.
 */
export function flicker(elapsed: number, phase: number): number {
  return (
    0.82 + 0.12 * Math.sin(elapsed * 11 + phase) + 0.06 * Math.sin(elapsed * 23.5 + phase * 2.3)
  );
}

/** Сколько чужих огней освещают мир одновременно. */
const CARRIED_LIGHTS = 3;

export interface CarriedLights {
  /** Зовётся каждый кадр со списком тех, кто несёт огонь. */
  update(elapsed: number, list: readonly { x: number; y: number; z: number }[]): void;
}

/**
 * Лампы для факелов в чужих руках.
 *
 * Отдельный пул, а не общий с городским: тот отбирает **ближайшие
 * неподвижные** огни, а эти ходят. Число постоянное, как везде: источник,
 * появившийся в сцене по ходу игры, стоит перекомпиляции всех материалов.
 *
 * Трёх хватает: чужих с факелами в кадре бывает один-два, а дальше их свет
 * всё равно сливается.
 */
export function createCarriedLights(scene: THREE.Scene): CarriedLights {
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < CARRIED_LIGHTS; i++) {
    const light = new THREE.PointLight(
      TORCH_LIGHT.color,
      0,
      TORCH_LIGHT.range,
      TORCH_LIGHT.decay,
    );
    scene.add(light);
    pool.push(light);
  }

  return {
    update(elapsed, list) {
      for (const [index, light] of pool.entries()) {
        const carrier = list[index];
        if (!carrier) {
          light.intensity = 0;
          continue;
        }
        // Огонь в руке, а не над головой: свет ложится под ноги несущему.
        light.position.set(carrier.x, carrier.y + 1.1, carrier.z);
        // Фаза от порядкового номера: два факела рядом не должны мигать в такт.
        light.intensity = TORCH_LIGHT.base * flicker(elapsed, index * 2.3);
      }
    },
  };
}

/**
 * Ореол вокруг огня.
 *
 * Сам источник света издалека не виден вовсе: освещённая им стена — да,
 * а огонёк в двенадцать сантиметров превращается в пиксель. Отсюда и было
 * ощущение, что свет «пропадает через два-три метра»: пропадал не свет,
 * пропадал **вид** огня.
 *
 * Ореол — картинка, всегда повёрнутая к игроку, с мягким спадом к краям
 * и сложением цветов. Она не освещает ничего, она только показывает, что здесь
 * горит, — и видна с другого конца площади.
 */
export function makeHalo(color: number, size: number): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTexture(),
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Туман ореол не трогает: он и нужен, чтобы его было видно сквозь мглу.
      fog: false,
    }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

/** Картинка ореола: мягкое пятно. Рисуется кодом — файла ради этого не нужно. */
let halo: THREE.Texture | null = null;

function haloTexture(): THREE.Texture {
  if (halo) return halo;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const paint = canvas.getContext('2d')!;
  const gradient = paint.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Спад крутой, почти до нуля к середине радиуса. С постобработкой ореол
  // складывается в линейном свете до тонмаппинга, и пологий хвост, незаметный
  // на экране, там вырастал в светлый диск с краем.
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.2, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  paint.fillStyle = gradient;
  paint.fillRect(0, 0, size, size);

  halo = new THREE.CanvasTexture(canvas);
  halo.colorSpace = THREE.SRGBColorSpace;
  return halo;
}

/**
 * Факел-заглушка: кронштейн и огонёк примитивами.
 *
 * Модели у настенного факела нет, и она не нужна: на стене он читается
 * пятном света, а не силуэтом.
 */
function makeTorch(group: THREE.Group, spot: (typeof TORCHES)[number], index: number): Flame {
  // Пока модель не приехала — только ореол там, где будет пламя: огонь виден
  // сразу, а модель встанет под него, как догрузится (loadTorches).
  const x = spot.x + spot.face.x * TORCH_REACH;
  const y = (spot.top ?? TORCH_TOP) - TORCH_HEIGHT * 0.2;
  const z = spot.z + spot.face.z * TORCH_REACH;
  const glow = new THREE.Group();
  glow.add(makeHalo(0xffb257, 1.2));
  glow.position.set(x, y, z);
  group.add(glow);

  // Дальность и яркость подобраны под мягкое затухание: факел должен
  // освещать стену в пятнадцати метрах, а не гаснуть в двух шагах.
  return {
    x,
    y,
    z,
    color: 0xff9a3c,
    range: STREET_RANGE,
    glow,
    base: 14,
    phase: index * 1.7,
    outdoor: !spot.indoor,
  };
}

/**
 * Ставит модель: приводит к нужной высоте и опускает основанием на землю.
 *
 * Матрицы обновляются до замера: у свежего клона они не посчитаны, и габариты
 * выходят произвольными — на этом уже обжигались с моделями мобов.
 */
function place(source: THREE.Object3D, height: number): THREE.Object3D {
  const model = source.clone(true);

  /**
   * Своё смещение узла обнуляем до замера.
   *
   * В файле у модели есть собственное смещение, и масштаб его **не трогает**:
   * содержимое ужимается в десять раз, а сдвиг остаётся прежним. Костёр от
   * этого расползался на два метра мимо своей точки. Поэтому и низ, и середину
   * считаем сами и ставим уже в масштабе.
   */
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.max.y - bounds.min.y;
  const scale = size > 0 ? height / size : 1;
  const base = footprint(model, bounds);

  model.scale.setScalar(scale);
  model.position.set(-base.x * scale, -bounds.min.y * scale, -base.z * scale);

  const holder = new THREE.Group();
  holder.add(model);
  holder.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  return holder;
}

/**
 * Где у фонаря плафон — середина его верхушки в мировых координатах.
 *
 * Считается по вершинам верхнего слоя, как основание — по нижнему: габариты
 * тут врут ровно так же. Кронштейн уводит плафон в сторону, и середина
 * коробки приходится на пустоту между ним и столбом.
 */
function lampHead(holder: THREE.Object3D): THREE.Vector3 {
  holder.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(holder);
  const height = bounds.max.y - bounds.min.y;
  /**
   * Пояс, в котором висит плафон: от крюка под балкой до низа стекла.
   *
   * Сначала брался верхний слой вершин — а верхний слой у фонаря это балка
   * **от столба до плафона**. Середина балки лежит между ними, и ореол
   * вылезал из-за стекла в сторону столба: владелец заметил на площади.
   */
  const top = bounds.max.y - height * 0.08;
  const bottom = bounds.max.y - height * 0.38;
  /** Ось столба: фонарь поставлен основанием в точку своей группы. */
  const axisX = holder.position.x;
  const axisZ = holder.position.z;
  /**
   * Плафон — самое дальнее от столба в этом поясе. Ближе к оси там же
   * проходят столб и подпорка, их отсекаем: берём вершины не дальше ширины
   * плафона от самой дальней.
   */
  const LAMP_WIDTH = 0.35;

  const point = new THREE.Vector3();
  const band: THREE.Vector3[] = [];
  let farthest = 0;

  holder.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;

    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
      if (point.y > top || point.y < bottom) continue;
      band.push(point.clone());
      farthest = Math.max(farthest, Math.hypot(point.x - axisX, point.z - axisZ));
    }
  });

  let count = 0;
  const sum = new THREE.Vector3();
  for (const vertex of band) {
    if (Math.hypot(vertex.x - axisX, vertex.z - axisZ) < farthest - LAMP_WIDTH) continue;
    sum.add(vertex);
    count++;
  }

  if (count === 0) return bounds.getCenter(new THREE.Vector3());
  // Под колпаком, а не на нём: огонь у фонаря горит в нижней половине
  // плафона, и ореол по верхушке выглядел шапкой поверх стекла.
  return sum.divideScalar(count).setY(bounds.max.y - height * 0.22);
}

/**
 * Где модель **стоит** — середина её основания, а не середина габаритов.
 *
 * У фонаря плафон вынесен на кронштейн в сторону, и по габаритам столб
 * оказывался в полуметре от своей точки: коробка столкновений в одном месте,
 * видимый столб в другом, и игрок упирался в воздух. Считаем по нижнему слою
 * вершин — это и есть то, чем вещь касается земли.
 */
function footprint(model: THREE.Object3D, bounds: THREE.Box3): { x: number; z: number } {
  const height = bounds.max.y - bounds.min.y;
  const ceiling = bounds.min.y + Math.max(height * 0.15, 0.001);

  let count = 0;
  let x = 0;
  let z = 0;
  const point = new THREE.Vector3();

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;

    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
      if (point.y > ceiling) continue;
      x += point.x;
      z += point.z;
      count++;
    }
  });

  // Ни одной вершины у земли не бывает, но если так — габариты не хуже.
  if (count === 0) {
    return { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
  }
  return { x: x / count, z: z / count };
}

/**
 * Середина пламени — по вершинам верхней трети, **со скином**.
 *
 * У модели со скелетом вершины в файле лежат в позе привязки и в своих
 * единицах: брать их как есть — значит искать пламя в сотне метров от факела.
 * `getVertexPosition` у такой сетки сам прогоняет вершину через кости.
 */
function flameCenter(holder: THREE.Object3D): THREE.Vector3 {
  holder.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(holder);
  const floor = bounds.max.y - (bounds.max.y - bounds.min.y) * 0.35;

  let count = 0;
  const sum = new THREE.Vector3();
  const point = new THREE.Vector3();
  holder.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
      if (point.y < floor) continue;
      sum.add(point);
      count++;
    }
  });
  return count > 0 ? sum.divideScalar(count) : bounds.getCenter(new THREE.Vector3());
}

/**
 * Ставит модели факелов к стенам.
 *
 * Модель клонируется вместе со скелетом (`SkeletonUtils`): обычный клон
 * делит кости с исходником, и все факелы качались бы одним пламенем — или
 * не качались вовсе.
 *
 * Размер и точка крепления считаются по габаритам в покое: рост приводится
 * к `TORCH_HEIGHT`, самая дальняя по −X точка (конец кронштейна) прижимается
 * к грани, верх пламени встаёт на `TORCH_TOP`. Потом разворот кронштейном
 * в стену — и свет с ореолом переезжают в пламя модели.
 */
async function loadTorches(
  group: THREE.Group,
  flames: readonly Flame[],
  torches: WallTorch[],
  materials: Set<THREE.MeshStandardMaterial>,
): Promise<void> {
  if (typeof document === 'undefined') return;

  try {
    const gltf = await new GLTFLoader().loadAsync(TORCH_URL);
    const clip = gltf.animations[0] ?? null;

    for (const [index, spot] of TORCHES.entries()) {
      const flame = flames[index];
      if (!flame) continue;

      const model = cloneSkinned(gltf.scene);
      model.position.set(0, 0, 0);
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const height = bounds.max.y - bounds.min.y;
      const scale = height > 0 ? TORCH_HEIGHT / height : 1;
      model.scale.setScalar(scale);
      model.position.set(
        -bounds.min.x * scale,
        -bounds.max.y * scale,
        (-(bounds.min.z + bounds.max.z) / 2) * scale,
      );

      const holder = new THREE.Group();
      holder.add(model);
      holder.position.set(spot.x, spot.top ?? TORCH_TOP, spot.z);
      // Кронштейн (−X модели) — в стену, то есть против нормали грани.
      holder.rotation.y = Math.atan2(-spot.face.z, spot.face.x);
      group.add(holder);

      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Тонкая палка с пламенем: тень от неё не видна, а в проход теней
        // она попадала бы наравне со стенами.
        mesh.castShadow = false;
        const material = mesh.material as THREE.MeshStandardMaterial;
        if (!material.emissive) return;
        if (spot.indoor) {
          // Материал у клонов общий, а общий гаснет днём — у факела под
          // крышей свой, горящий всегда.
          const own = material.clone();
          own.emissiveIntensity = TORCH_GLOW;
          mesh.material = own;
        } else {
          materials.add(material);
        }
      });

      const head = flameCenter(holder);
      flame.x = head.x;
      flame.y = head.y;
      flame.z = head.z;
      flame.glow?.position.copy(head);

      const mixer = new THREE.AnimationMixer(model);
      if (clip) {
        const action = mixer.clipAction(clip);
        action.play();
        // Вразнобой: пять факелов, качающихся в такт, читаются как один механизм.
        action.time = (index * 0.37) % clip.duration;
      }
      const bones: WallTorch['bones'] = [];
      model.traverse((node) => {
        if ((node as THREE.Bone).isBone && FLAME_BONES.test(node.name)) {
          bones.push({ bone: node, rest: node.scale.clone() });
        }
      });
      torches.push({ mixer, bones, indoor: spot.indoor === true });
    }
  } catch (error) {
    // Без модели остаётся ореол: огонь на месте, просто без рукояти.
    console.warn(`[свет] не загрузился ${TORCH_URL}`, error);
  }
}

async function loadModels(group: THREE.Group, flames: Flame[]): Promise<void> {
  if (typeof document === 'undefined') return;

  try {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);

    const gltf = await loader.loadAsync(MODEL_URL);
    const lamp = gltf.scene.getObjectByName('streetlight');

    if (lamp) {
      for (const [index, spot] of TOWN_LAMPS.entries()) {
        const model = place(lamp, LAMP_HEIGHT);
        model.position.x = spot.x;
        model.position.z = spot.z;
        group.add(model);

        /**
         * Огонь — в плафоне, а не над столбом.
         *
         * Модель ставится **основанием**: в точке фонаря стоит столб, а плафон
         * вынесен кронштейном в сторону и назад. Ореол по координатам фонаря
         * оказывался поэтому на самом столбе — светящаяся палка посреди улицы.
         * Ищем плафон в модели, а не гадаем по числам: кронштейн у неё свой.
         */
        const head = lampHead(model);

        // Ореол чуть шире плафона, а не вдвое: при метре с лишним он торчал
        // из-за стекла пучком. Издалека огонь теперь держит ещё и свечение
        // постобработки, так что широкий ореол больше не нужен.
        const lampGlow = makeHalo(0xffc27a, 0.8);
        lampGlow.position.copy(head);
        group.add(lampGlow);

        flames.push({
          x: head.x,
          y: head.y,
          z: head.z,
          color: 0xffc27a,
          range: STREET_RANGE,
          glow: lampGlow,
          base: 13,
          phase: index * 0.9,
          outdoor: true,
        });
      }
    }
  } catch (error) {
    console.warn('[свет] модели не загрузились:', error);
  }
}
