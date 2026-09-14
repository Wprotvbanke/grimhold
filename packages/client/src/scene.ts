import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CHUNK_SIZE,
  ChunkedWorld,
  DUNGEON_EXIT,
  DUNGEON_EXIT_MARK,
  DUNGEON_EXIT_MARK_HEIGHT,
  DUNGEON_EXIT_WALL,
  MARK_OFFSET,
  floorOf,
  stairsDown,
  stairsUp,
  type Niche,
  dungeonSeed,
  generateDungeonChunk,
  isDungeon,
  MOBS,
  RACES,
  SPELLS,
  chunkKey,
  sunHeight,
  type LevelBox,
  type MobId,
  type Race,
  type SpellId,
} from '@grimhold/shared';
// Туман у земли подменяет кусочки шейдера — до того, как соберётся хоть один.
import './fog.js';
import { createBuildings } from './buildings.js';
import { createDayNight } from './daynight.js';
import { createHouses } from './houses.js';
import { createLights } from './lights.js';
import { createParticles } from './particles.js';
import { createNature, disposeNature } from './nature.js';
import { createNodes, disposeNodes, type NodeField } from './nodes.js';
import { populateTavern } from './props.js';
import { createSky } from './sky.js';

/**
 * Рендер мира. Геометрия чанков берётся из того же генератора, которым сервер
 * считает коллизии, — расхождение картинки и физики сразу ломало бы
 * предсказание, поэтому источник ровно один.
 *
 * Чанки строятся и выбрасываются по мере движения игрока: держать весь мир
 * в сцене незачем, а на большой карте — уже и нельзя.
 */

/**
 * Сколько метров мира занимает один тайл текстуры.
 *
 * Число важнее, чем кажется: слишком мелкий тайл превращает землю в рябь,
 * слишком крупный — в размазанное пятно. Два метра примерно соответствуют
 * тому, как выглядит мостовая под ногами человека.
 */
export const TILE_METERS = 2.5;

const textures = new THREE.TextureLoader();

/** Знак выхода из подземелья. Загружается один раз на всю сессию. */
let symbol: THREE.Texture | null = null;

function symbolTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  if (!symbol) {
    symbol = textures.load('/textures/exit_symbol.webp');
    symbol.colorSpace = THREE.SRGBColorSpace;
  }
  return symbol;
}

/**
 * Анизотропная фильтрация: сколько выборок делать на вытянутых по перспективе
 * пикселях.
 *
 * Земля уходит к горизонту почти плашмя, и без этого её тайлы в движении
 * рябят — на ходу это читается как дрожь всей картинки, хотя дрожит только
 * фильтрация. Число берётся у видеокарты (`renderer.capabilities`), потому что
 * потолок у разных машин разный, а платить за выборки сверх её предела нельзя.
 *
 * Значение проставляется и уже загруженным картам: материалы заводятся при
 * первом обращении к модулю, а рендерер появляется позже.
 */
let anisotropy = 4;
const loaded: THREE.Texture[] = [];

export function setAnisotropy(limit: number): void {
  anisotropy = Math.max(1, Math.floor(limit));
  for (const texture of loaded) {
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
  }
}

/**
 * Текстура поверхности. Повтор задаётся не здесь, а развёрткой каждой коробки:
 * одна общая текстура на все поверхности этого вида, иначе на каждый камень
 * пришлось бы заводить свою копию.
 *
 * Вне браузера картинок нет (тесты геометрии гоняются в Node), поэтому там
 * материал остаётся цветным. Геометрия и развёртка от этого не зависят,
 * а значит проверять их можно без графики.
 */
interface SurfaceOptions {
  /** Панели Kenney: без сглаживания пикселей. */
  pixelated?: boolean;
  /**
   * Сила рельефа. Задана — рядом с цветовой картой лежат `<имя>_normal.webp`
   * и `<имя>_arm.webp` (scripts/prepare-surfaces.ts), и поверхность получает
   * рельеф, затенение в щелях и шероховатость. Не задана — плоская, как раньше.
   */
  relief?: number;
}

function repeating(path: string): THREE.Texture {
  const texture = textures.load(path);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Анизотропия нужна полу: без неё земля вдали превращается в кашу,
  // а в движении рябит. Рельефу — тем более: рябящие нормали видны бликами.
  texture.anisotropy = anisotropy;
  loaded.push(texture);
  return texture;
}

function surface(file: string, tint = 0xffffff, options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  if (typeof document === 'undefined') {
    return new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95 });
  }

  const map = repeating(`/textures/${file}`);
  if (options.pixelated) {
    // Панели Kenney рисованы в 64 пикселя. Сглаживание превращает их
    // в мыло: доски и камни задуманы чёткими, это часть вида.
    map.magFilter = THREE.NearestFilter;
    map.generateMipmaps = true;
  }
  map.colorSpace = THREE.SRGBColorSpace;

  if (options.relief === undefined) {
    return new THREE.MeshStandardMaterial({ map, color: tint, roughness: 0.95 });
  }

  /**
   * Рельеф, щели и шероховатость.
   *
   * Карты те же по развёртке, что и цветовая, — одна общая текстура на все
   * коробки этого вида, повтор задан самой развёрткой. Касательных у слитых
   * чанков нет, и они не нужны: без них three строит нормали по производным
   * экрана — на камне разницы не видно, а геометрия остаётся прежней.
   *
   * ARM — три карты в одной: затенение (R), шероховатость (G), металл (B).
   * Берём **только затенение, и слабо**. Первая версия брала всё как есть,
   * и владелец сразу увидел: «очень темно, и свет почти не помогает».
   *
   * - Затенение в three гасит весь рассеянный свет, а в подземелье и ночью
   *   картинка на нём и держится. Карты Poly Haven гасят его на 30–50%
   *   (у земли в среднем 0.48) — это под яркое дневное небо, не под наш мрак.
   * - Шероховатость из карты делала мостовую и доски гладкими (0.5–0.6):
   *   свет факела уходил в блики, которые видно под одним углом, вместо
   *   ровного пятна. Матовые 0.95, как было, — огонь освещает, а не бликует.
   */
  const base = file.replace(/\.[a-z]+$/, '');
  const relief = options.relief;
  return new THREE.MeshStandardMaterial({
    map,
    color: tint,
    normalMap: repeating(`/textures/${base}_normal.webp`),
    normalScale: new THREE.Vector2(relief, relief),
    roughness: 0.95,
    aoMap: repeating(`/textures/${base}_arm.webp`),
    aoMapIntensity: 0.35,
  });
}

/**
 * Текстуры: Poly Haven, лицензия CC0 — см. public/textures/LICENSE.txt.
 * Оттенки приглушены: снимки сделаны при дневном свете, а у нас сумерки.
 */
const MATERIALS: Record<LevelBox['kind'], THREE.Material> = {
  // Сила рельефа — меньше полной. Во всю силу глубокие швы кладки смотрели
  // от факела, и заметная доля стены оставалась тёмной при любом огне.
  // Земля мягче всех (она не камень), скала резче (у неё рельеф и есть вид).
  floor: surface('pavement.jpg', 0xb9b4aa, { relief: 0.7 }),
  ground: surface('ground.jpg', 0xa9a89c, { relief: 0.5 }),
  wall: surface('stone.jpg', 0xb2ac9e, { relief: 0.6 }),
  pillar: surface('stone.jpg', 0xc0b9a8, { relief: 0.6 }),
  platform: surface('pavement.jpg', 0xa8a096, { relief: 0.7 }),
  rock: surface('rock.jpg', 0x9a958b, { relief: 0.9 }),
  ruin: surface('stone.jpg', 0x9d968a, { relief: 0.6 }),
  timber: surface('planks.jpg', 0xa8998a, { relief: 0.5 }),
  // Постройки города — пак Kenney, см. docs/buildings.md.
  frame: surface('buildings/wall_timber_structure.png', 0xb0a893, { pixelated: true }),
  brick: surface('buildings/wall_brick_stone_center.png', 0x9fa0a2, { pixelated: true }),
  plank: surface('buildings/floor_wood_planks.png', 0xa08a70, { pixelated: true }),
  shingle: surface('buildings/roof_clay_grey_center.png', 0x8d99a6, { pixelated: true }),
  // Сундук окован и темнее половиц: в полумраке зала его надо узнавать
  // с десяти шагов, иначе искать добычу приходится наощупь.
  chest: surface('planks.jpg', 0x6b4f33, { relief: 0.5 }),
};

/**
 * Размер тайла для видов, у которых он не квадратный.
 *
 * Панели Kenney — это не бесшовные текстуры, а модульные куски: файл 64×128
 * это одна панель стены высотой в этаж. Растянешь её квадратом — фахверк
 * поедет, брус окажется поперёк.
 */
const TILES: Partial<Record<LevelBox['kind'], [number, number]>> = {
  // Сундук маленький: доска в метр растянулась бы на весь бок одной полосой.
  chest: [0.55, 0.55],
  frame: [2.2, 4.4],
  brick: [1.3, 2.6],
  plank: [1.6, 1.6],
  shingle: [1.1, 1.1],
};

/**
 * Растягивает развёртку коробки по её размеру в мире.
 *
 * У BoxGeometry каждая грань размечена от нуля до единицы, поэтому без этой
 * правки текстура растянулась бы на всю грань: один камень мостовой на
 * шестьдесят метров пола. Здесь развёртка пересчитывается так, чтобы тайл
 * всегда занимал TILE_METERS вне зависимости от размера коробки.
 */
export function scaleBoxUv(
  geometry: THREE.BoxGeometry,
  width: number,
  height: number,
  depth: number,
  tile: [number, number] = [TILE_METERS, TILE_METERS],
): void {
  const uv = geometry.attributes.uv as THREE.BufferAttribute;

  // Порядок граней в BoxGeometry: +X, -X, +Y, -Y, +Z, -Z, по четыре вершины.
  const faces: [number, number][] = [
    [depth, height],
    [depth, height],
    [width, depth],
    [width, depth],
    [width, height],
    [width, height],
  ];

  for (let face = 0; face < faces.length; face++) {
    const [u, v] = faces[face]!;
    const repeatU = Math.max(u / tile[0], 0.05);
    const repeatV = Math.max(v / tile[1], 0.05);

    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) * repeatU, uv.getY(index) * repeatV);
    }
  }

  uv.needsUpdate = true;
}

export interface World3D {
  scene: THREE.Scene;
  /** Коллизии вокруг точки — тот же источник, что и у сервера. */
  collidersAt(x: number, z: number): ReturnType<ChunkedWorld['collidersAt']>;
  /** Подгружает и выгружает чанки вокруг наблюдателя. */
  streamChunks(x: number, z: number): void;
  /**
   * Переехать в другой инстанс: сменить землю под ногами.
   *
   * Геометрия не приходит по сети — она выводится из имени инстанса тем же
   * генератором, что и у сервера. Клиенту достаточно знать, где он.
   */
  setInstance(instanceId: string): void;
  /**
   * Живая часть картинки: ход солнца, мерцание огня, свет в окнах.
   *
   * `worldTime` — время суток из общих часов (0 — полночь). Оно приходит
   * из номера тика сервера, а не считается локально: ночь обязана наступать
   * у всех одновременно.
   */
  update(elapsed: number, worldTime: number, camera: THREE.Camera): void;
  /**
   * Игрок зажёг или погасил свой огонь.
   *
   * Нужно мгле: она отступает перед факелом. Говорит об этом тот, кто знает
   * про надетое, — сцена сама в рюкзак не смотрит.
   */
  setTorch(lit: boolean): void;
  /** Ресурсные ноды: вид, выбор цели и состояние с сервера. */
  readonly nodes: NodeField;
  loadedChunks: number;
}

/**
 * Мгла у знака выхода.
 *
 * Общий туман сцены одинаков везде — он не умеет быть гуще в одном месте.
 * Поэтому густота у ниши делается тем же способом, каким её делают все:
 * несколько мягких пятен, всегда повёрнутых к игроку, с очень низкой
 * непрозрачностью. Накладываясь друг на друга, они дают ощущение стоячего
 * воздуха, а по отдельности их не разглядеть — в этом и смысл.
 *
 * Пятен намеренно мало. Каждое — большой прозрачный прямоугольник во весь
 * экран вблизи, а это плата за заполнение: десяток таких стоит дороже, чем
 * вся геометрия зала.
 *
 * Цвет — тёплый тёмный, не серый: мглу подсвечивает красный огонь портала,
 * и серая на его фоне читается как грязное стекло.
 */
interface ExitHaze {
  readonly group: THREE.Group;
  /** `breath` — то же дыхание, что у знака: мгла живёт вместе с ним. */
  update(elapsed: number, breath: number): void;
}

function createExitHaze(): ExitHaze {
  const group = new THREE.Group();
  group.visible = false;

  const texture = hazeTexture();
  const clouds: { sprite: THREE.Sprite; home: THREE.Vector3; drift: number; size: number }[] = [];

  /**
   * Раскладка: гуще всего у самой стены, реже — к выходу из ниши.
   *
   * Числа смещений от знака, а не мировые: ниша считается от стены, и мгла
   * обязана переехать вместе с ней.
   */
  const spots: { x: number; y: number; z: number; size: number }[] = [
    { x: 0, y: 1.3, z: 0.8, size: 7 },
    { x: -1.9, y: 1, z: 1.6, size: 6 },
    { x: 1.9, y: 1.1, z: 1.5, size: 6 },
    { x: -0.8, y: 0.7, z: 3, size: 6.5 },
    { x: 1, y: 0.8, z: 3.4, size: 6.5 },
    { x: 0, y: 1.6, z: 5, size: 7 },
  ];

  for (const [index, spot] of spots.entries()) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        color: 0x4a2a22,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        // Туман сцены мглу трогает: вдали она обязана растворяться в нём,
        // иначе у входа в нишу видно её край.
        fog: true,
      }),
    );
    sprite.scale.setScalar(spot.size);
    const home = new THREE.Vector3(
      DUNGEON_EXIT.x + spot.x,
      spot.y,
      DUNGEON_EXIT_WALL + spot.z,
    );
    sprite.position.copy(home);
    group.add(sprite);
    clouds.push({ sprite, home, drift: index * 1.7, size: spot.size });
  }

  return {
    group,
    update(elapsed, breath) {
      for (const cloud of clouds) {
        // Медленное дыхание воздуха: два несинхронных синуса, как у пламени.
        // Случайности тут не нужно — рывок мглы читается как подёргивание.
        const sway = Math.sin(elapsed * 0.13 + cloud.drift);
        const lift = Math.sin(elapsed * 0.09 + cloud.drift * 1.7);

        cloud.sprite.position.set(
          cloud.home.x + sway * 0.5,
          cloud.home.y + lift * 0.25,
          cloud.home.z + lift * 0.4,
        );
        cloud.sprite.scale.setScalar(cloud.size * (1 + sway * 0.06));
        // Чем ближе к стене, тем плотнее — и всё вместе тлеет вместе со знаком.
        const material = cloud.sprite.material as THREE.SpriteMaterial;
        material.opacity = 0.22 * (0.7 + breath * 0.5);
      }
    },
  };
}

/** Пятно мглы: то же мягкое облако, что у огня, но с ещё более пологим краем. */
let haze: THREE.Texture | null = null;

function hazeTexture(): THREE.Texture | null {
  // Вне браузера картинок нет: геометрию гоняют в Node, и рисовать там нечем.
  if (typeof document === 'undefined') return null;
  if (haze) return haze;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const paint = canvas.getContext('2d')!;
  const gradient = paint.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Край обязан сходить на нет задолго до границы картинки: иначе у пятна
  // видно квадрат, и вся мгла превращается в набор прозрачных карточек.
  gradient.addColorStop(0, 'rgba(255,255,255,0.75)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  paint.fillStyle = gradient;
  paint.fillRect(0, 0, size, size);

  haze = new THREE.CanvasTexture(canvas);
  haze.colorSpace = THREE.SRGBColorSpace;
  return haze;
}

export function createScene(): World3D {
  const scene = new THREE.Scene();

  // Небо, свет и туман — одним куском: порознь они разъезжаются.
  const sky = createSky(scene);
  const daynight = createDayNight(scene, sky);
  const lights = createLights(scene);
  // Пыль в свете своего огня и мошкара у фонарей — см. particles.ts.
  const particles = createParticles(scene);
  const buildings = createBuildings(scene);
  // Ратуша и дом на площади — модели целиком, см. houses.ts.
  const houses = createHouses(scene);
  const nature = createNature();
  const nodes = createNodes();
  // Обстановка таверны: мебель приезжает отдельными моделями, а не коробками.
  const furniture = populateTavern(scene);

  /**
   * Свет над кольцом портала.
   *
   * Заводится сразу и навсегда, гасится силой, а не удалением: число источников
   * вшито в шейдер, и добавить лампу посреди игры — значит пересобрать все
   * материалы сцены разом. На этом уже спотыкались, см. performance.md.
   */
  const portalLight = new THREE.PointLight(0xff4426, 0, 20, 1.6);
  // Свет стоит перед знаком, а не в точке выхода: он подсвечивает краску
  // и стену вокруг неё, иначе в нише светится пустой камень.
  portalLight.position.set(DUNGEON_EXIT.x, DUNGEON_EXIT_MARK_HEIGHT, DUNGEON_EXIT_WALL + 1.2);
  scene.add(portalLight);

  /**
   * Знак выхода — краской по стене ниши.
   *
   * Не коробка и не модель: прозрачный прямоугольник на камне. Он светится
   * сам — цвета складываются со стеной, как у огня, и в полумраке знак виден
   * насквозь темноты.
   *
   * На полу он был вдвое больше и всё равно терялся: идущий смотрит вперёд,
   * а не под ноги. На стене он оказывается на линии взгляда и читается через
   * весь зал — то же самое пятно краски, но там, куда смотрят.
   *
   * Геометрии он не касается: сервер о краске ничего не знает, стена под ней
   * обычная.
   */
  function createMark(color: number): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(DUNGEON_EXIT_MARK * 2, DUNGEON_EXIT_MARK * 2),
      new THREE.MeshBasicMaterial({
        map: symbolTexture(),
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Глубину не пишем и слегка приподнимаем: краска на камне не должна
        // спорить с полом за один и тот же пиксель.
        depthWrite: false,
        fog: false,
      }),
    );
  }

  const exitMark = createMark(0xff2a1e);

  /**
   * Знаки лестниц: тот же рисунок, другой цвет.
   *
   * Цветом, а не рисунком, потому что решение принимается на бегу и издалека:
   * красный — наружу, янтарный — глубже, голубой — назад наверх. Форму на
   * пяти метрах видимости не разобрать, цвет видно сразу.
   *
   * Живут они целиком на клиенте, как и знак выхода: серверу о краске знать
   * нечего, камень под ней обычный.
   */
  const downMark = createMark(0xffa32a);
  const upMark = createMark(0x66c6ff);
  for (const mark of [downMark, upMark]) {
    mark.visible = false;
    scene.add(mark);
  }

  /** Этаж, под который уже расставлены знаки. −1 — ещё ни под какой. */
  let markedFloor = -1;

  /** Ставит знак на камень ниши и разворачивает лицом в зал. */
  function placeMark(mark: THREE.Mesh, niche: Niche): void {
    const inward = niche.faceYaw === 0 ? 1 : niche.faceYaw > 0 ? 1 : -1;
    mark.position.set(
      niche.faceYaw === 0 ? niche.wallX : niche.wallX + inward * MARK_OFFSET,
      DUNGEON_EXIT_MARK_HEIGHT,
      niche.faceYaw === 0 ? niche.wallZ + MARK_OFFSET : niche.wallZ,
    );
    mark.rotation.y = niche.faceYaw;
  }

  /**
   * Знаки этажа, на котором стоит игрок.
   *
   * Этажи лежат в одном инстансе и рядом в координатах, поэтому «где я»
   * выводится из положения камеры, а не приходит по сети: то же число, что
   * считает сервер, тем же кодом.
   */
  function markFloor(floor: number): void {
    if (floor === markedFloor) return;
    markedFloor = floor;

    exitMark.visible = floor === 0;
    exitHaze.group.visible = floor === 0;

    const down = stairsDown(floor);
    downMark.visible = down !== null;
    if (down) placeMark(downMark, down);

    const up = stairsUp(floor);
    upMark.visible = up !== null;
    if (up) placeMark(upMark, up);
  }
  /**
   * Плоскость смотрит в зал: поворачивать не нужно, у неё и так лицо на +Z.
   *
   * Отступ от камня — шесть сантиметров, а не один. Подземелье стоит в восьми
   * километрах от начала координат, а там шаг числа с плавающей точкой —
   * миллиметр: сантиметрового зазора не хватало, и краска спорила со стеной
   * за пиксель.
   */
  exitMark.position.set(DUNGEON_EXIT.x, DUNGEON_EXIT_MARK_HEIGHT, DUNGEON_EXIT_WALL + MARK_OFFSET);
  exitMark.visible = false;
  scene.add(exitMark);

  const exitHaze = createExitHaze();
  scene.add(exitHaze.group);

  let instanceId = 'overworld';
  /** Метка прошлого кадра — из неё выводится шаг времени для плавностей. */
  let lastFrame = 0;
  let underground = false;
  let terrain = new ChunkedWorld();
  const loaded = new Map<string, THREE.Group>();

  /** Снимает всё построенное: при переезде старая земля не нужна. */
  function dropChunks(): void {
    for (const [key, group] of loaded) {
      const [cx, cz] = key.split(':').map(Number);
      nodes.forget(cx!, cz!);
      scene.remove(group);
      disposeGroup(group);
    }
    loaded.clear();
  }

  const api: World3D = {
    scene,
    nodes,
    loadedChunks: 0,

    collidersAt: (x, z) => terrain.collidersAt(x, z),

    setInstance(next) {
      if (next === instanceId) return;

      instanceId = next;
      underground = isDungeon(next);
      // Небо, солнце и туман переключаются вместе с землёй: светило сквозь
      // потолок — это тени ниоткуда и туман цвета неба, которого не видно.
      daynight.underground = underground;
      sky.mesh.visible = !underground;
      // Портал светится только там, где он есть.
      portalLight.intensity = underground ? 9 : 0;
      if (!underground) {
        for (const mark of [exitMark, downMark, upMark]) mark.visible = false;
        exitHaze.group.visible = false;
      }
      // Знаки расставит первый же кадр под землёй: этаж известен по камере.
      markedFloor = -1;
      terrain = new ChunkedWorld(
        underground ? generateDungeonChunk(dungeonSeed(next)) : undefined,
      );
      dropChunks();
      api.loadedChunks = 0;
    },

    streamChunks(x, z) {
      const needed = ChunkedWorld.chunksAround(x, z);
      const keep = new Set(needed.map((c) => chunkKey(c.cx, c.cz)));

      /**
       * За кадр собираем **один** чанк.
       *
       * Чанк это сотни коробок и десяток пачек растительности, и строить их
       * все разом — это заметный рывок каждый раз, когда пересекаешь границу,
       * а на входе в мир и вовсе девять штук подряд. Ждать соседний чанк
       * лишние пару кадров не страшно: игрок в это время только подходит
       * к его краю.
       */
      for (const { cx, cz } of needed) {
        const key = chunkKey(cx, cz);
        if (loaded.has(key)) continue;

        const group = buildChunkMesh(scene, terrain.getChunk(cx, cz));
        // Под землёй не растёт ни леса, ни руды: раскладка диких земель
        // к подземелью отношения не имеет, и строить её там — деревья
        // посреди зала.
        if (!underground) {
          // Растительность живёт и выгружается вместе с чанком: раскладка
          // у неё общая с сервером, а вот меши — забота клиента.
          group.add(nature.build(cx, cz));
          // Ресурсные ноды — там же: раскладка общая, меши наши.
          group.add(nodes.build(cx, cz));
        }
        loaded.set(key, group);
        break;
      }

      for (const [key, group] of loaded) {
        if (keep.has(key)) continue;
        const [cx, cz] = key.split(':').map(Number);
        nodes.forget(cx!, cz!);
        scene.remove(group);
        disposeGroup(group);
        loaded.delete(key);
      }

      api.loadedChunks = loaded.size;
    },

    setTorch(lit) {
      daynight.torch = lit;
    },

    update(elapsed, worldTime, camera) {
      // Шаг времени берём из самих кадров: отдельного dt сюда не передают,
      // а привязывать плавность к частоте кадров нельзя.
      const dt = Math.min(0.1, Math.max(0, elapsed - lastFrame));
      lastFrame = elapsed;
      daynight.update(worldTime, dt, camera);

      if (underground) {
        markFloor(floorOf(camera.position.x));

        // Знак дышит: неподвижное пятно на стене глаз принимает за текстуру,
        // а медленно разгорающееся — за живое место.
        const breath = 0.78 + 0.22 * Math.sin(elapsed * 1.6);
        for (const mark of [exitMark, downMark, upMark]) {
          if (mark.visible) (mark.material as THREE.MeshBasicMaterial).opacity = breath;
        }

        /**
         * Лампа у знака одна на все три.
         *
         * Число источников вшито в шейдер, и завести по лампе на знак значило
         * бы пересобрать материалы сцены — см. performance.md. Поэтому
         * единственная переезжает к ближайшему знаку: дальние всё равно
         * за мглой, а вблизи горит ровно тот, к которому подошли.
         */
        let nearest: THREE.Mesh | null = null;
        let best = Infinity;
        for (const mark of [exitMark, downMark, upMark]) {
          if (!mark.visible) continue;
          const reach = mark.position.distanceTo(camera.position);
          if (reach < best) {
            best = reach;
            nearest = mark;
          }
        }
        if (nearest) {
          portalLight.color.set((nearest.material as THREE.MeshBasicMaterial).color);
          portalLight.position.set(
            nearest.position.x + Math.sin(nearest.rotation.y) * 1.2,
            DUNGEON_EXIT_MARK_HEIGHT,
            nearest.position.z + Math.cos(nearest.rotation.y) * 1.2,
          );
          portalLight.intensity = 7 + breath * 4;
        } else {
          portalLight.intensity = 0;
        }

        // Мгла у ниши дышит вместе со знаком: это его мгла, а не сырость.
        if (exitHaze.group.visible) exitHaze.update(elapsed, breath);
      }

      /**
       * Город показываем, только пока он рядом.
       *
       * Его коробки выгружаются вместе с чанком, а всё, что построено моделями
       * — кровля, мебель, фонари, — живёт в сцене всю сессию. Без этой проверки
       * они оставались висеть в воздухе над пустым местом, да ещё и считались
       * каждый кадр.
       */
      const nearTown = Math.hypot(camera.position.x, camera.position.z) < CHUNK_SIZE;
      buildings.group.visible = nearTown;
      houses.group.visible = nearTown;
      furniture.visible = nearTown;
      /**
       * Огонь нужен и в городе, и под землёй — значит группу не прячем там,
       * где он есть. Городские факелы при этом не мешают: пул выбирает
       * ближайшие, а город из подземелья за восемь километров.
       */
      lights.group.visible = nearTown || underground;

      // Насколько светло снаружи: по этому числу гаснет уличный огонь
      // и загорается свет в окнах. Плавно, а не щелчком на рассвете.
      const daylight = Math.max(0, Math.min(1, sunHeight(worldTime) * 3));
      lights.update(elapsed, daylight, camera);
      buildings.update(daylight);
      particles.update(dt, elapsed, camera, {
        underground,
        lit: daynight.torch,
        daylight,
        lamps: lights.lamps,
      });
    },
  };

  return api;
}

/**
 * Собирает чанк, сливая коробки по виду поверхности.
 *
 * Отдельным мешем на коробку выходило по полсотни вызовов отрисовки на чанк
 * и под три сотни на девять загруженных — а рисуется при этом один и тот же
 * камень одним и тем же материалом. После слияния чанк стоит столько вызовов,
 * сколько в нём разных поверхностей: обычно три-четыре.
 *
 * Развёртка считается до слияния, поэтому текстура на каждой коробке остаётся
 * своего размера — `scaleBoxUv` запекает повторы прямо в вершины.
 */
function buildChunkMesh(scene: THREE.Scene, boxes: LevelBox[]): THREE.Group {
  const group = new THREE.Group();
  const byKind = new Map<LevelBox['kind'], THREE.BufferGeometry[]>();

  for (const entry of boxes) {
    // Невидимые коробки только преграждают путь: их вид дают модели
    // обстановки, см. props.ts.
    if (entry.hidden) continue;

    const { box } = entry;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    const depth = box.maxZ - box.minZ;

    const geometry = new THREE.BoxGeometry(width, height, depth);
    scaleBoxUv(geometry, width, height, depth, TILES[entry.kind]);
    geometry.translate(
      (box.minX + box.maxX) / 2,
      (box.minY + box.maxY) / 2,
      (box.minZ + box.maxZ) / 2,
    );

    const list = byKind.get(entry.kind) ?? [];
    list.push(geometry);
    byKind.set(entry.kind, list);
  }

  for (const [kind, pieces] of byKind) {
    const merged = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
    if (!merged) continue;
    for (const piece of pieces) if (piece !== merged) piece.dispose();

    const mesh = new THREE.Mesh(merged, MATERIALS[kind]);
    mesh.receiveShadow = true;
    // Пол тени не отбрасывает: он и так лежит, а в проходе теней стоит как все.
    mesh.castShadow = kind !== 'floor';
    group.add(mesh);
  }

  scene.add(group);
  return group;
}

/** Геометрию выгруженного чанка надо освобождать явно — иначе течёт видеопамять. */
function disposeGroup(group: THREE.Group): void {
  // Растительность освобождается отдельно: геометрия у неё общая на весь мир
  // и принадлежит библиотеке, а не этому чанку.
  disposeNature(group);
  disposeNodes(group);
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && !(node as THREE.InstancedMesh).isInstancedMesh) mesh.geometry.dispose();
  });
}

/**
 * Заглушка тела для рас без модели. Габариты берутся из профиля расы —
 * тех же чисел, по которым сервер считает коллизии.
 */
export function createAvatar(race: Race): THREE.Group {
  const profile = RACES[race];
  const group = new THREE.Group();

  const { radius, cylinder } = capsuleFor(profile.radius, profile.height);
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, cylinder, 4, 12),
    new THREE.MeshStandardMaterial({ color: profile.color, roughness: 0.8 }),
  );
  body.position.y = profile.height / 2;
  body.castShadow = true;
  group.add(body);

  return group;
}

/** Высота, на которой висит подпись над телом. */
export function tagHeight(race: Race): number {
  return RACES[race].height + 0.35;
}

/**
 * Заглушка моба. Блокаут, но силуэты разные: крыса стелется по земле,
 * огр возвышается — по одному взгляду понятно, с кем имеешь дело.
 * Габариты те же, по которым сервер считает попадание.
 */
export function createMobMesh(mobId: MobId): THREE.Group {
  const profile = MOBS[mobId];
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: profile.color, roughness: 0.9 });

  const { radius, cylinder } = capsuleFor(profile.radius, profile.height);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius, cylinder, 4, 10), material);
  body.position.y = profile.height / 2;
  body.castShadow = true;
  group.add(body);

  // Метка направления взгляда: без неё непонятно, куда моб замахивается.
  // Держится внутри радиуса тела — силуэт не должен обещать досягаемость,
  // которой нет в хитбоксе на сервере.
  const snout = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.45, radius * 0.5, 6), material);
  snout.rotation.x = -Math.PI / 2;
  snout.position.set(0, profile.height * 0.72, -radius * 0.7);
  group.add(snout);

  return group;
}

/**
 * Размеры капсулы, у которой полная высота равна росту существа.
 *
 * Капсула в three.js имеет высоту `длина + 2 × радиус`. У приземистых существ
 * (крыса: рост 0.5 при радиусе 0.3) наивный расчёт даёт капсулу выше самого
 * существа, и она уходит под землю. Поэтому радиус ограничивается половиной
 * роста, а цилиндр добирает остаток.
 */
function capsuleFor(radius: number, height: number): { radius: number; cylinder: number } {
  const capped = Math.min(radius, height / 2);
  return { radius: capped, cylinder: Math.max(height - capped * 2, 0.001) };
}

export function mobTagHeight(mobId: MobId): number {
  return MOBS[mobId].height + 0.3;
}

const SPELL_COLORS: Record<SpellId, number> = {
  ember: 0xff7a30,
  frostbite: 0x7fd4ff,
  lightning: 0xc8b6ff,
  mend: 0x86c98a,
  wardskin: 0xb9a97e,
  lantern: 0xffe9a8,
};

/**
 * Снаряд заклинания: светящийся шар, видимый издалека.
 *
 * Своего источника света у снаряда **нет**. Он был, и это оказалось дорого
 * не силой света, а самим фактом: в прямом рендере three число источников
 * зашито в шейдер, и появление снаряда перекомпилировало все материалы сцены.
 * В бою заклинаниями это давало рывок на каждый выстрел и на каждое попадание.
 * Светят снарядам лампы из пула — см. `createProjectileLights`.
 */
export function createProjectileMesh(spellId?: SpellId): THREE.Object3D {
  const group = new THREE.Group();

  /**
   * Стрела — не сгусток.
   *
   * Без заклинания это выстрел из лука: тонкое древко вместо шара, и оно
   * не светится само. Иначе стрела читалась бы как магия, а разница между
   * ними — половина смысла дальнего боя.
   */
  if (!spellId) {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.7, 5),
      new THREE.MeshStandardMaterial({ color: 0x6b5335, roughness: 1 }),
    );
    // Лежит вдоль полёта: цилиндр рождается стоймя, кладём его набок.
    shaft.rotation.x = Math.PI / 2;
    group.add(shaft);
    return group;
  }

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    // Шар светится сам: ему свет и не нужен, он сам себе источник картинки.
    // Ярче белого — чтобы постобработка дала шару ореол, как огню.
    new THREE.MeshBasicMaterial({ color: new THREE.Color(SPELL_COLORS[spellId] ?? 0xffffff).multiplyScalar(2.5) }),
  );
  group.add(core);
  return group;
}

/**
 * Мешок с добычей: от павшего игрока и от каждого убитого зверя.
 *
 * Модель одна на всех и грузится один раз: мешков в кадре бывает несколько,
 * а клонирование готового дерева стоит копейки против загрузки.
 *
 * Пока модель едет, на её месте стоит заглушка — мешковина примитивами.
 * Мешок обязан быть виден сразу: он появляется ровно в тот момент, когда
 * игрок смотрит на убитого, и «подожди секунду» здесь читается как «ничего
 * не выпало».
 */
let bagModel: THREE.Object3D | null = null;
let bagPending: Promise<void> | null = null;

export function createBagMesh(): THREE.Object3D {
  const group = new THREE.Group();
  const stub = sackStub();
  group.add(stub);

  if (bagModel) {
    group.remove(stub);
    group.add(bagModel.clone(true));
    return group;
  }

  bagPending ??= loadBag();
  void bagPending.then(() => {
    if (!bagModel || !group.parent) return;
    group.remove(stub);
    group.add(bagModel.clone(true));
  });

  return group;
}

async function loadBag(): Promise<void> {
  if (typeof document === 'undefined') return;
  try {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);

    const gltf = await loader.loadAsync('/models/loot_bag.glb');
    const model = gltf.scene;

    // Под рост мешка, а не под размер, в котором его смоделировали: на земле
    // он должен читаться как поклажа, а не как валун.
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const height = bounds.max.y - bounds.min.y;
    const scale = height > 0 ? BAG_HEIGHT / height : 1;
    model.scale.setScalar(scale);
    /**
     * Ставим **основанием в ноль и серединой на точку**.
     *
     * Сервер присылает точку на полу, а модель приезжает как её собрали:
     * у фотограмметрии начало координат вообще где попало. Без поправки по
     * X и Z мешок лежит рядом со своим местом — наводишься на него, а сервер
     * говорит «далеко».
     */
    model.position.set(
      -((bounds.min.x + bounds.max.x) / 2) * scale,
      -bounds.min.y * scale,
      -((bounds.min.z + bounds.max.z) / 2) * scale,
    );
    model.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) node.castShadow = true;
    });

    bagModel = model;
  } catch (error) {
    console.warn('[мешок] модель не загрузилась, остаётся заглушка:', error);
  }
}

/**
 * Высота мешка в мире.
 *
 * Полметра с небольшим. Числа шли снизу вверх: тридцать — честный кисет,
 * но на мостовой его не замечали; тридцать семь — всё ещё мимо. Победила
 * заметность: добыча, которую не видно, — это добыча, которую не подберут.
 *
 * Выше идти не стоит: мешок перестанет быть мешком и станет поклажей. Если
 * и этого мало, дальше не размер, а метка — свечение или подсветка контура,
 * которую видно сквозь мглу.
 */
const BAG_HEIGHT = 0.55;

/** Заглушка на время загрузки: мешковина, перетянутая верёвкой. */
function sackStub(): THREE.Object3D {
  const group = new THREE.Group();

  const cloth = new THREE.MeshStandardMaterial({ color: 0x7a6a4f, roughness: 1 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), cloth);
  body.scale.set(1, 0.85, 1);
  body.position.y = 0.2;
  body.castShadow = true;
  group.add(body);

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.13, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: 0x5f5238, roughness: 1 }),
  );
  neck.position.y = 0.42;
  group.add(neck);

  return group;
}

/** Сколько снарядов освещают мир одновременно. */
const PROJECTILE_LIGHTS = 3;

export interface ProjectileLights {
  /** Зовётся каждый кадр со списком живых снарядов. */
  update(list: readonly { x: number; y: number; z: number; spellId?: SpellId }[]): void;
}

/**
 * Лампы для снарядов: постоянный пул, переезжающий к ближайшим.
 *
 * Число ламп в сцене не меняется никогда — в этом весь смысл. Трёх хватает:
 * летящих одновременно снарядов в кадре обычно один-два, а их свет всё равно
 * перекрывается.
 */
export function createProjectileLights(scene: THREE.Scene): ProjectileLights {
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < PROJECTILE_LIGHTS; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 9, 2);
    scene.add(light);
    pool.push(light);
  }

  return {
    update(list) {
      for (const [index, light] of pool.entries()) {
        const projectile = list[index];
        if (!projectile) {
          // Гасим силой, а не видимостью: исчезнувший источник — это опять
          // перекомпиляция всей сцены.
          light.intensity = 0;
          continue;
        }
        // Стрела не светит: это деревяшка, а не сгусток огня.
        if (!projectile.spellId) {
          light.intensity = 0;
          continue;
        }
        light.position.set(projectile.x, projectile.y, projectile.z);
        light.color.setHex(SPELL_COLORS[projectile.spellId] ?? 0xffffff);
        light.intensity = SPELLS[projectile.spellId].power * 0.5;
      }
    },
  };
}

export { CHUNK_SIZE };
