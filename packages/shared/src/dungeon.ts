import { CHUNK_SIZE, chunkCenter, type ChunkSource } from './chunks.js';
import type { LootEntry, MobId } from './mobs.js';
import { boxFromCenter } from './math.js';
import type { LevelBox } from './level.js';

/**
 * Подземелье.
 *
 * Устроено как **тот же мир с другим `instanceId` и другой землёй под ногами**,
 * а не как отдельный уровень. Раскладка **выводится из зерна**, как и дикие
 * земли: сервер и клиент строят одинаковые стены, ничего не пересылая. Зерно
 * лежит прямо в имени инстанса — `dungeon.7f3a`, — поэтому клиенту достаточно
 * знать, где он.
 *
 * Этажей три, и все они живут **в одном инстансе**. Это не мелочь: босс
 * открывает порталы всему забегу сразу, а группа обязана оставаться группой
 * при переходе вниз. Раздай этажи по инстансам — и то и другое пришлось бы
 * сшивать поверх изоляции, которая для того и сделана, чтобы не сшивалось.
 */

export const DUNGEON_PREFIX = 'dungeon.';

/**
 * Где подземелье лежит в координатах.
 *
 * Далеко от мира — и это **не косметика, а способ починить целый класс ошибок**.
 * Все проверки места в игре считаются по координатам: безопасная зона города,
 * расстояние до казны, показ городских построек. Инстанс изолирует сущности,
 * но не координаты, и подземелье, стоящее на месте города, наследует его
 * правила: внизу нельзя было драться, казна открывалась из зала, а посреди
 * подземелья стояла таверна.
 *
 * Уведённое подземелье делает все эти проверки верными само собой — включая
 * те, которых ещё не написали. Полагаться на расстояние надёжнее, чем на
 * память: забытую проверку не видно, она просто тихо работает неправильно.
 *
 * Мир занимает ±224 метра, так что пересечься не с чем.
 */
export const DUNGEON_ORIGIN_CHUNK = 128;

/** Сколько этажей в подземелье. Глубже — злее обитатели и богаче сундуки. */
export const DUNGEON_FLOORS = 3;

/**
 * Сколько чанков между этажами.
 *
 * Этажи стоят **в одном инстансе и рядом в координатах**, а не друг под другом:
 * поток чанков плоский, и этаж под этажом грузился бы вместе с ним — тройная
 * геометрия в кадре ради того, чего сквозь потолок не видно.
 *
 * Три чанка — это 192 метра между серединами и 128 между краями, то есть
 * заведомо больше радиуса интереса (58). Иначе обитатели соседнего этажа
 * попадали бы в снапшот и ходили бы сквозь камень на виду.
 */
export const FLOOR_STRIDE = 3;

/**
 * Сколько человек помещается в один зал.
 *
 * Из замысла: «инстанс на 12 игроков, соло и группы вместе». Подземелье не
 * личная комната — внутри флаги не действуют, и встреча с чужаком там такая же
 * часть вылазки, как нежить.
 */
export const DUNGEON_CAPACITY = 12;

/**
 * Сколько секунд зал принимает новых.
 *
 * Лобби пока нет, и это его замена: спустившиеся в одну минуту попадают вместе,
 * опоздавший получает свой зал. Без окна человек подсаживался бы к тому, кто
 * уже унёс всю добычу, и заставал пустые сундуки.
 */
export const DUNGEON_JOIN_SECONDS = 90;

/** Сколько чанков в ширину занимает один этаж. */
export const DUNGEON_RADIUS = 0;

/** Середина первого этажа в мировых координатах. */
export const DUNGEON_CENTER = {
  x: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
  z: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
};

/** Середина этажа по его номеру. Этажи выстроены вдоль X с шагом `FLOOR_STRIDE`. */
export function floorCenter(floor: number): { x: number; z: number } {
  return {
    x: (DUNGEON_ORIGIN_CHUNK + floor * FLOOR_STRIDE) * CHUNK_SIZE,
    z: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
  };
}

/**
 * На каком этаже точка.
 *
 * Нужно обеим сторонам: сервер по этому решает, куда ведёт лестница, клиент —
 * какие знаки зажечь. Считается из координаты, а не хранится полем: поле
 * пришлось бы держать в трёх местах и синхронизировать при каждом переносе.
 */
export function floorOf(x: number): number {
  const offset = Math.round(x / CHUNK_SIZE) - DUNGEON_ORIGIN_CHUNK;
  const floor = Math.round(offset / FLOOR_STRIDE);
  return Math.min(DUNGEON_FLOORS - 1, Math.max(0, floor));
}

/**
 * Настенных факелов в подземелье **нет**.
 *
 * Они стояли по стенам весь первый ломоть вехи и держали зал на себе: пока
 * светить было нечем, темнота читалась как поломка — ни стен, ни пола,
 * ни текстур. Факел в руке снял эту нужду, и огонь со стен убран: свет
 * в подземелье теперь приносят с собой.
 */

/** Высота зала: в потолок упираться не должно, но и неба тут нет. */
const HALL_HEIGHT = 4;
const WALL = 1;

/**
 * Комнат по стороне этажа.
 *
 * Нечётное число взято не для красоты: при нечётной сетке середина этажа —
 * это **середина комнаты**, а не шов между ними. Ниши выхода и лестниц стоят
 * ровно на середине своих стен, и при чётной сетке внутренняя стена резала бы
 * их пополам.
 */
const GRID = 3;
/** Сторона комнаты. Двадцать метров при видимости в пять — комната, а не зал. */
const CELL = CHUNK_SIZE / GRID;
/** Ширина прохода между комнатами. */
const DOOR = 4.4;

/** Где игрок появляется, войдя вниз из города. */
export const DUNGEON_ENTRY = {
  x: DUNGEON_CENTER.x,
  y: 0.1,
  z: DUNGEON_CENTER.z + 24,
};

// ---------- ниши: выход и лестницы ----------

/**
 * Ниша в краевой стене этажа: карман, у задней стенки которого что-то есть.
 *
 * Таких три вида, и все устроены одинаково: выход наверх (север первого
 * этажа), спуск глубже (восток) и подъём назад (запад). Одинаково —
 * намеренно: стена, которая расступается, читается как «здесь дверь»
 * издалека, и второй раз этому учить игрока не надо.
 */
export type NicheSide = 'north' | 'east' | 'west';

export interface Niche {
  /** Плоскость камня, на котором нарисован знак. */
  wallX: number;
  wallZ: number;
  /** Куда смотрит знак: поворот плоскости вокруг вертикали. */
  faceYaw: number;
  /** Где надо стоять, чтобы сработало «E». */
  x: number;
  z: number;
}

/** Половина стороны знака и высота его середины — на уровне глаз идущего. */
export const DUNGEON_EXIT_MARK = 1.7;
export const DUNGEON_EXIT_MARK_HEIGHT = 1.95;

/**
 * Насколько знак отходит от камня.
 *
 * Шесть сантиметров, а не один: подземелье стоит в восьми километрах от начала
 * координат, а там шаг числа с плавающей точкой — миллиметр. Сантиметрового
 * зазора не хватало, и краска спорила со стеной за пиксель.
 */
export const MARK_OFFSET = 0.06;

/** Ширина и глубина кармана ниши. */
const NICHE_WIDTH = 6.6;
const NICHE_DEPTH = 6;

/** Сколько метров от стены до точки, где стоят. */
const NICHE_STAND = 1.2;

/**
 * Ниша на стороне этажа.
 *
 * Считается **от геометрии стены**, а не числом. Это уже стоило одного захода:
 * знак, отмеренный от точки выхода, ушёл за краевую стену целиком, и в игре
 * на его месте светилось пустое пятно без рисунка. Сдвинется край этажа —
 * ниша поедет за ним.
 */
export function nicheOf(floor: number, side: NicheSide): Niche {
  const center = floorCenter(floor);
  const half = CHUNK_SIZE / 2;
  if (side === 'north') {
    const wallZ = center.z - half + WALL / 2;
    return { wallX: center.x, wallZ, faceYaw: 0, x: center.x, z: wallZ + NICHE_STAND };
  }
  if (side === 'east') {
    const wallX = center.x + half - WALL / 2;
    return {
      wallX,
      wallZ: center.z,
      faceYaw: -Math.PI / 2,
      x: wallX - NICHE_STAND,
      z: center.z,
    };
  }
  const wallX = center.x - half + WALL / 2;
  return { wallX, wallZ: center.z, faceYaw: Math.PI / 2, x: wallX + NICHE_STAND, z: center.z };
}

/**
 * Стена, на которой нарисован знак выхода первого этажа.
 *
 * Оставлено отдельным именем: на неё смотрят и клиент, и проверки, и это
 * единственное место в подземелье, где знак значит «наружу».
 */
export const DUNGEON_EXIT_WALL = DUNGEON_CENTER.z - CHUNK_SIZE / 2 + WALL / 2;

/**
 * Портал наружу — у самого знака, в шаге от стены.
 *
 * Стоял в четырёх с половиной метрах, и вместе с широким откликом это значило,
 * что «E» срабатывало ещё на подходе: игрок выходил наверх, так и не дойдя
 * до знака. Выход — последнее действие вылазки, и он обязан случиться **там,
 * где нарисовано**.
 */
export const DUNGEON_EXIT = {
  x: DUNGEON_CENTER.x,
  z: DUNGEON_EXIT_WALL + NICHE_STAND,
};

/**
 * С какого расстояния портал и лестницы откликаются.
 *
 * Чуть шире самой метки: упираться в неё носом, чтобы нажать, было бы
 * наказанием за то, что её нашли. Но и не шире ниши — иначе переход снова
 * начнёт срабатывать на подходе.
 */
export const DUNGEON_EXIT_RANGE = 2;

/** Лестница вниз есть на всех этажах, кроме последнего. */
export function stairsDown(floor: number): Niche | null {
  return floor < DUNGEON_FLOORS - 1 ? nicheOf(floor, 'east') : null;
}

/** Лестница вверх — на всех, кроме первого: с первого уходят порталом. */
export function stairsUp(floor: number): Niche | null {
  return floor > 0 ? nicheOf(floor, 'west') : null;
}

/**
 * Где игрок оказывается, попав на этаж.
 *
 * На первом — у люка, на остальных — **у лестницы вверх**: пришёл сверху,
 * значит стоишь на том, по чему вернёшься. Обратную дорогу искать не надо,
 * её надо помнить.
 */
export function floorArrival(floor: number): { x: number; y: number; z: number } {
  if (floor <= 0) return { ...DUNGEON_ENTRY };
  const niche = nicheOf(floor, 'west');
  return { x: niche.x, y: 0.1, z: niche.z };
}

export function isDungeon(instanceId: string): boolean {
  return instanceId.startsWith(DUNGEON_PREFIX);
}

/** Имя нового подземелья. Зерно в имени — значит оно есть и у клиента. */
export function dungeonInstance(seed: number): string {
  return `${DUNGEON_PREFIX}${(seed >>> 0).toString(36)}`;
}

export function dungeonSeed(instanceId: string): number {
  return parseInt(instanceId.slice(DUNGEON_PREFIX.length), 36) >>> 0;
}

/** То же зерно, что у чанков: одинаковые числа на обеих сторонах. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- геометрия этажа ----------

/**
 * Земля подземелья: три этажа, каждый в своём чанке.
 *
 * За их пределами пусто, и туда не выйти — край каждого этажа закрыт стеной,
 * как и край мира.
 */
export function generateDungeonChunk(seed: number): ChunkSource {
  return (cx: number, cz: number): LevelBox[] => {
    if (cz !== DUNGEON_ORIGIN_CHUNK) return [];
    const offset = cx - DUNGEON_ORIGIN_CHUNK;
    if (offset % FLOOR_STRIDE !== 0) return [];
    const floor = offset / FLOOR_STRIDE;
    if (floor < 0 || floor >= DUNGEON_FLOORS) return [];

    const { x: originX, z: originZ } = chunkCenter(cx, cz);
    const half = CHUNK_SIZE / 2;
    const boxes: LevelBox[] = [];

    // Пол и потолок. Потолок нужен не для красоты: без него сверху светит
    // небо, и подземелье перестаёт быть подземельем.
    boxes.push({
      kind: 'brick',
      box: boxFromCenter(originX, -0.5, originZ, CHUNK_SIZE, 1, CHUNK_SIZE),
    });
    boxes.push({
      kind: 'brick',
      box: boxFromCenter(originX, HALL_HEIGHT + 0.5, originZ, CHUNK_SIZE, 1, CHUNK_SIZE),
    });

    // Стены по краю этажа.
    for (const [wx, wz, w, d] of [
      [0, -half, CHUNK_SIZE, WALL],
      [0, half, CHUNK_SIZE, WALL],
      [-half, 0, WALL, CHUNK_SIZE],
      [half, 0, WALL, CHUNK_SIZE],
    ] as const) {
      boxes.push({
        kind: 'brick',
        box: boxFromCenter(originX + wx, HALL_HEIGHT / 2, originZ + wz, w, HALL_HEIGHT, d),
      });
    }

    const layout = floorLayout(seed, floor);

    // Перегородки между комнатами. Проход там, где комнаты связаны; глухая
    // стена там, где нет. Связность даёт остов лабиринта — см. `roomLinks`.
    for (const wall of layout.walls) {
      boxes.push({
        kind: 'wall',
        box: boxFromCenter(wall.x, HALL_HEIGHT / 2, wall.z, wall.width, HALL_HEIGHT, wall.depth),
      });
    }

    // Колонны: укрытия и ориентиры. Без них комната — пустая коробка,
    // в которой некуда спрятаться и не за что зацепиться глазом.
    for (const pillar of layout.pillars) {
      boxes.push({
        kind: 'pillar',
        box: boxFromCenter(
          pillar.x,
          HALL_HEIGHT / 2,
          pillar.z,
          pillar.width,
          HALL_HEIGHT,
          pillar.width,
        ),
      });
    }

    // Сундуки стоят прямо в геометрии этажа: так они и видны, и телесны,
    // и приходят на обе стороны одним генератором — пересылать нечего.
    for (const chest of layout.chests) {
      boxes.push({
        kind: 'chest',
        box: boxFromCenter(chest.x, CHEST_HEIGHT / 2, chest.z, CHEST_SIZE, CHEST_HEIGHT, CHEST_SIZE),
      });
    }

    if (floor === 0) addNiche(boxes, floor, 'north');
    if (stairsDown(floor)) addNiche(boxes, floor, 'east');
    if (stairsUp(floor)) addNiche(boxes, floor, 'west');
    return boxes;
  };
}

/**
 * Карман ниши: боковины, упирающиеся в краевую стену.
 *
 * Своего пола, потолка и задней стенки у ниши нет. Они были — и в точности
 * повторяли пол и потолок зала, слой в слой. Две совпадающие поверхности
 * в одном месте — это дрожание текстуры: видеокарта на каждом кадре выбирает
 * между ними заново, и у самого знака камень «кипел». Заднюю стенку закрывает
 * краевая стена этажа: карман упирается в неё раньше, чем кончается сам.
 */
function addNiche(boxes: LevelBox[], floor: number, side: NicheSide): void {
  const niche = nicheOf(floor, side);
  const inward = side === 'east' ? -1 : 1;

  for (const shift of [-1, 1]) {
    if (side === 'north') {
      boxes.push({
        kind: 'brick',
        box: boxFromCenter(
          niche.wallX + shift * (NICHE_WIDTH / 2),
          HALL_HEIGHT / 2,
          niche.wallZ + inward * (NICHE_DEPTH / 2),
          WALL,
          HALL_HEIGHT,
          NICHE_DEPTH,
        ),
      });
    } else {
      boxes.push({
        kind: 'brick',
        box: boxFromCenter(
          niche.wallX + inward * (NICHE_DEPTH / 2),
          HALL_HEIGHT / 2,
          niche.wallZ + shift * (NICHE_WIDTH / 2),
          NICHE_DEPTH,
          HALL_HEIGHT,
          WALL,
        ),
      });
    }
  }
}

// ---------- сундуки ----------

/**
 * Сундук: то, ради чего вниз и идут.
 *
 * Устроен как ресурсная нода, а не как предмет мира: раскладка выводится из
 * зерна инстанса, сервер хранит только **вскрытые**. Нетронутый сундук не
 * занимает ни байта ни в памяти, ни в сети — его знают обе стороны, потому
 * что обе считают его одним генератором.
 */
export interface DungeonChest {
  /** Устойчивое имя вида `chest.этаж.номер`: по нему сервер находит сундук. */
  id: string;
  x: number;
  z: number;
  floor: number;
}

/** Сторона сундука и его высота: по ним же строится коробка в зале. */
export const CHEST_SIZE = 1.1;
export const CHEST_HEIGHT = 0.85;

/** С какого расстояния сундук поддаётся. Та же мерка, что у нод. */
export const CHEST_RANGE = 3.2;

/**
 * Сколько секунд вскрывается сундук.
 *
 * Заметно дольше любой добычи, и это главное в нём: замысел вехи обещал
 * «уязвим и слышен». Пока идёт полоса, игрок стоит на месте спиной к залу —
 * и чужая жадность становится чужой ошибкой.
 */
export const CHEST_TIME = 5;

/** Сколько сундуков на первом этаже. Каждый следующий добавляет по одному. */
const CHESTS_MIN = 4;
const CHESTS_MAX = 5;

/**
 * Что лежит в сундуках.
 *
 * Свитки рецептов падают **здесь**, а не с умертвия: замысел с самого начала
 * привязывал рецептурный ярус к подземельям. Теперь у похода вниз есть причина,
 * которой нет наверху.
 */
export const CHEST_LOOT: readonly LootEntry[] = [
  { itemId: 'coin', name: 'Монеты', chance: 0.9, min: 12, max: 60 },
  { itemId: 'grave_silver', name: 'Могильное серебро', chance: 0.45, min: 1, max: 4 },
  { itemId: 'crude_ingot', name: 'Грубый слиток', chance: 0.35, min: 1, max: 3 },
  { itemId: 'health_potion', name: 'Зелье здоровья', chance: 0.3, min: 1, max: 2 },
  { itemId: 'recipe_scrap', name: 'Обрывок рецепта', chance: 0.25, min: 1, max: 2 },
  // Свитки трёх ремёсел: выпавший чужой прочесть нельзя, и это не досада,
  // а повод торговать.
  { itemId: 'scroll_iron_sword', name: 'Свиток: железный меч', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_iron_helm', name: 'Свиток: железный шлем', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_hunting_bow', name: 'Свиток: охотничий лук', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_leather_cap', name: 'Свиток: кожаный шлем', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_health_potion', name: 'Свиток: зелье здоровья', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_stamina_draught', name: 'Свиток: настой сил', chance: 0.09, min: 1, max: 1 },
];

/**
 * Чем глубже, тем богаче.
 *
 * Награда растёт **вместе с риском и путём назад**: на третьем этаже игрок
 * далеко от портала, и вынести добытое труднее, чем добыть. Множителем,
 * а не отдельной таблицей на этаж: таблицу забудут поправить, когда добавят
 * предмет, а множитель применится сам.
 */
export function chestLoot(floor: number): LootEntry[] {
  const richer = 1 + 0.3 * floor;
  return CHEST_LOOT.map((entry) => ({
    ...entry,
    chance: Math.min(0.95, entry.chance * richer),
    min: Math.max(1, Math.round(entry.min * richer)),
    max: Math.max(1, Math.round(entry.max * richer)),
  }));
}

// ---------- обитатели ----------

/**
 * Кто живёт на этаже.
 *
 * Мало и тяжело, а не много и тяжело. Первый состав был из шести элитных
 * нежитей, и проверка это показала прямо: одиночка не доходил до портала
 * ни разу. Разойтись в комнатах негде, поэтому риск задаётся качеством
 * противника, а не количеством; толпа здесь читается не как опасность,
 * а как запертая дверь.
 *
 * Глубина меняет состав, а не число: на первом этаже скелеты, на третьем
 * умертвия и огры. Это и есть обещание вехи — «глубже злее».
 */
export function mobsForDungeon(seed: number, floor = 0): MobId[] {
  const random = mulberry32((seed ^ 0x5bf03635) + floor * 0x9e3779b1);
  const roster: MobId[] = [];
  const extra: MobId[] = [];

  if (floor === 0) {
    roster.push('skeleton', 'skeleton', 'ghoul');
    extra.push('skeleton', 'ghoul', 'ghoul', 'wight');
  } else if (floor === 1) {
    roster.push('skeleton', 'ghoul', 'ghoul', 'wight');
    extra.push('wight', 'wight', 'ogre');
  } else {
    roster.push('ghoul', 'wight', 'wight', 'ogre');
    extra.push('ogre', 'wight', 'ogre');
  }

  roster.push(extra[Math.floor(random() * extra.length)]!);
  return roster;
}

/**
 * Хозяин глубины: один на забег.
 *
 * Пока он жив, порталы закрыты всему инстансу — поэтому он и не «ещё один
 * тяжёлый моб», а условие возвращения. Ставится не раскладкой, а отдельно:
 * босс один, и знать про него надо не только геометрии.
 */
export const DUNGEON_BOSS: MobId = 'crypt_lord';

/**
 * На каком этаже он ждёт. **Пока первый, а не дно** — так решил владелец:
 * играем один этаж, к системе этажей вернёмся позже.
 *
 * Раньше он стоял на дне (`DUNGEON_FLOORS - 1`), и вылазка требовала пройти
 * три этажа: искавший его на первом не находил никого, а выход в город
 * оставался заперт — непонятно, чем его отпирать. Число здесь одно на всех:
 * и сервер ставит босса по нему, и проверки ищут его там же.
 */
export const BOSS_FLOOR = 0;

/**
 * Сколько секунд порталы открыты после его смерти.
 *
 * Две с половиной минуты — это «беги», а не «собирайся». Вылазка кончается
 * гонкой: все в инстансе получают один и тот же сигнал и бегут к одним и тем
 * же порталам с полными карманами, и вот тут-то внизу и вспоминают, что флаги
 * не действуют.
 */
export const PORTAL_SECONDS = 150;

// ---------- раскладка этажа ----------

interface RoomWall {
  x: number;
  z: number;
  width: number;
  depth: number;
}

interface FloorLayout {
  walls: RoomWall[];
  pillars: { x: number; z: number; width: number }[];
  chests: DungeonChest[];
  /** Какие комнаты соединены проходами. Нужно не только стенам — см. `routeOn`. */
  links: Set<string>;
}

/**
 * Разобранные раскладки: генератор зовут каждый кадр прицеливания.
 *
 * Список ограничен, потому что зерно у каждого забега своё: без предела
 * сервер за сутки накопил бы раскладку каждого подземелья, которое когда-либо
 * заводили. Старые вытесняются — заново собрать их всё равно дёшево.
 */
const layouts = new Map<string, FloorLayout>();
const LAYOUT_CACHE = 32;

/** Середина комнаты по её номеру в ряду, считая от края этажа. */
function cellCenter(index: number): number {
  return -CHUNK_SIZE / 2 + CELL * (index + 0.5);
}

/** Имя связи между двумя комнатами — одинаковое с обеих сторон. */
function linkKey(ac: number, ar: number, bc: number, br: number): string {
  return ac < bc || ar < br ? `${ac}:${ar}|${bc}:${br}` : `${bc}:${br}|${ac}:${ar}`;
}

/**
 * Остов лабиринта: какие комнаты соединены проходами.
 *
 * Обход в глубину даёт **дерево**, то есть связность без петель: из любой
 * комнаты есть путь в любую, и ровно один. Потом пара лишних проходов
 * пробивается наугад — этаж без петель читается как коридор с тупиками,
 * а в подземелье, где за тобой гонятся, тупик это смерть без выбора.
 */
function roomLinks(random: () => number): Set<string> {
  const open = new Set<string>();
  const visited = new Set<string>(['1:1']);
  const stack: [number, number][] = [[1, 1]];

  while (stack.length > 0) {
    const [col, row] = stack[stack.length - 1]!;
    const neighbours: [number, number][] = [];
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= GRID || nr >= GRID) continue;
      if (visited.has(`${nc}:${nr}`)) continue;
      neighbours.push([nc, nr]);
    }

    if (neighbours.length === 0) {
      stack.pop();
      continue;
    }

    const [nc, nr] = neighbours[Math.floor(random() * neighbours.length)]!;
    open.add(linkKey(col, row, nc, nr));
    visited.add(`${nc}:${nr}`);
    stack.push([nc, nr]);
  }

  // Петли: без них этаж — дерево коридоров, и всякая погоня кончается углом.
  for (let i = 0; i < 2; i++) {
    const a = Math.floor(random() * (GRID - 1));
    const b = Math.floor(random() * GRID);
    open.add(random() < 0.5 ? linkKey(a, b, a + 1, b) : linkKey(b, a, b, a + 1));
  }

  return open;
}

/**
 * Раскладка этажа: перегородки, колонны и сундуки **из одного потока чисел**.
 *
 * Порознь их считать нельзя: два независимых генератора рано или поздно
 * поставят сундук внутрь колонны, и вскрыть его будет неоткуда. Здесь сундуки
 * расставляются последними и знают про всё остальное.
 */
export function floorLayout(seed: number, floor = 0): FloorLayout {
  const key = `${seed}:${floor}`;
  const cached = layouts.get(key);
  if (cached) return cached;

  const random = mulberry32((seed + floor * 0x7f4a7c15) >>> 0);
  const { x: originX, z: originZ } = floorCenter(floor);

  const open = roomLinks(random);
  const walls: RoomWall[] = [];

  // Перегородки поперёк X: они делят этаж на столбцы комнат.
  for (let col = 1; col < GRID; col++) {
    const x = originX - CHUNK_SIZE / 2 + CELL * col;
    for (let row = 0; row < GRID; row++) {
      const middle = originZ + cellCenter(row);
      if (open.has(linkKey(col - 1, row, col, row))) {
        pushSegment(walls, x, middle - CELL / 2, middle - DOOR / 2, 'z');
        pushSegment(walls, x, middle + DOOR / 2, middle + CELL / 2, 'z');
      } else {
        pushSegment(walls, x, middle - CELL / 2, middle + CELL / 2, 'z');
      }
    }
  }

  // Перегородки поперёк Z.
  for (let row = 1; row < GRID; row++) {
    const z = originZ - CHUNK_SIZE / 2 + CELL * row;
    for (let col = 0; col < GRID; col++) {
      const middle = originX + cellCenter(col);
      if (open.has(linkKey(col, row - 1, col, row))) {
        pushSegment(walls, z, middle - CELL / 2, middle - DOOR / 2, 'x');
        pushSegment(walls, z, middle + DOOR / 2, middle + CELL / 2, 'x');
      } else {
        pushSegment(walls, z, middle - CELL / 2, middle + CELL / 2, 'x');
      }
    }
  }

  // По колонне на комнату: укрытие и ориентир, но не лабиринт внутри комнаты.
  const pillars: FloorLayout['pillars'] = [];
  const reach = CELL / 2 - 6;
  for (let col = 0; col < GRID; col++) {
    for (let row = 0; row < GRID; row++) {
      pillars.push({
        x: originX + cellCenter(col) + (random() - 0.5) * 2 * reach,
        z: originZ + cellCenter(row) + (random() - 0.5) * 2 * reach,
        width: 1.3 + random() * 1.1,
      });
    }
  }

  // У лестниц, у люка и у портала сундуков нет: добычу надо унести, а не
  // подобрать с порога. Между ними и лежит весь риск.
  const away: { x: number; z: number }[] = [floorArrival(floor)];
  for (const stairs of [stairsDown(floor), stairsUp(floor)]) {
    if (stairs) away.push({ x: stairs.x, z: stairs.z });
  }
  if (floor === 0) away.push(DUNGEON_EXIT);

  const chests: DungeonChest[] = [];
  const wanted = CHESTS_MIN + floor + Math.floor(random() * (CHESTS_MAX - CHESTS_MIN + 1));
  const room = CELL / 2 - 4;

  for (let attempt = 0; attempt < 300 && chests.length < wanted; attempt++) {
    const col = Math.floor(random() * GRID);
    const row = Math.floor(random() * GRID);
    const x = originX + cellCenter(col) + (random() * 2 - 1) * room;
    const z = originZ + cellCenter(row) + (random() * 2 - 1) * room;

    if (away.some((point) => Math.hypot(x - point.x, z - point.z) < 10)) continue;

    const blocked =
      pillars.some((p) => Math.hypot(x - p.x, z - p.z) < p.width / 2 + CHEST_SIZE) ||
      chests.some((c) => Math.hypot(x - c.x, z - c.z) < CHEST_RANGE * 2);
    if (blocked) continue;

    chests.push({ id: `chest.${floor}.${chests.length}`, x, z, floor });
  }

  const layout: FloorLayout = { walls, pillars, chests, links: open };
  if (layouts.size >= LAYOUT_CACHE) layouts.delete(layouts.keys().next().value as string);
  layouts.set(key, layout);
  return layout;
}

/** Отрезок перегородки. Короткие куски отбрасываются: они только мусорят. */
function pushSegment(
  walls: RoomWall[],
  fixed: number,
  from: number,
  to: number,
  along: 'x' | 'z',
): void {
  const length = to - from;
  if (length < 0.2) return;
  const middle = (from + to) / 2;
  if (along === 'z') {
    walls.push({ x: fixed, z: middle, width: WALL, depth: length });
  } else {
    walls.push({ x: middle, z: fixed, width: length, depth: WALL });
  }
}

// ---------- дорога по комнатам ----------

/** В какой комнате точка. Номера столбца и ряда, считая от края этажа. */
export function roomOf(floor: number, x: number, z: number): { col: number; row: number } {
  const { x: originX, z: originZ } = floorCenter(floor);
  const clamp = (value: number) => Math.min(GRID - 1, Math.max(0, value));
  return {
    col: clamp(Math.floor((x - originX + CHUNK_SIZE / 2) / CELL)),
    row: clamp(Math.floor((z - originZ + CHUNK_SIZE / 2) / CELL)),
  };
}

/**
 * Дорога от точки до точки по этажу: середины проходов, через которые идти.
 *
 * Этаж — это комнаты с проходами, и прямая между двумя точками почти всегда
 * упирается в перегородку. Обход в ширину по связям комнат даёт **список
 * дверей**, а не путь по метрам: между дверями идти уже можно напрямую,
 * комната пуста.
 *
 * Живёт в общем коде, потому что связи комнат знает генератор, а не тот, кто
 * идёт. Зерно забега приходит снаружи: раскладка у каждого своя.
 *
 * Ею ходят и сквозные проверки, и мобы: `World.mobGuide` подставляет её
 * в `decideMob`, и моб целится в середину ближайшей двери, а не в игрока
 * за перегородкой.
 */
export function routeFor(
  seed: number,
  floor: number,
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number }[] {
  return routeThrough(floorLayout(seed, floor).links, floor, from, to);
}

function routeThrough(
  links: Set<string>,
  floor: number,
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number }[] {
  const start = roomOf(floor, from.x, from.z);
  const goal = roomOf(floor, to.x, to.z);
  const { x: originX, z: originZ } = floorCenter(floor);

  const key = (col: number, row: number) => `${col}:${row}`;
  const cameFrom = new Map<string, string>();
  const queue: [number, number][] = [[start.col, start.row]];
  const seen = new Set([key(start.col, start.row)]);

  while (queue.length > 0) {
    const [col, row] = queue.shift()!;
    if (col === goal.col && row === goal.row) break;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= GRID || nr >= GRID) continue;
      if (!links.has(linkKey(col, row, nc, nr))) continue;
      if (seen.has(key(nc, nr))) continue;
      seen.add(key(nc, nr));
      cameFrom.set(key(nc, nr), key(col, row));
      queue.push([nc, nr]);
    }
  }

  // Дороги нет — идём напрямую и упираемся честно: врать о пути хуже, чем
  // не знать его.
  if (!seen.has(key(goal.col, goal.row))) return [{ x: to.x, z: to.z }];

  const chain: [number, number][] = [];
  for (let at = key(goal.col, goal.row); ; ) {
    const [col, row] = at.split(':').map(Number) as [number, number];
    chain.unshift([col, row]);
    const previous = cameFrom.get(at);
    if (!previous) break;
    at = previous;
  }

  const doors: { x: number; z: number }[] = [];
  for (let i = 1; i < chain.length; i++) {
    const [pc, pr] = chain[i - 1]!;
    const [nc, nr] = chain[i]!;
    if (pc === nc) {
      // Проход в перегородке поперёк Z: середина общей границы рядов.
      doors.push({
        x: originX + cellCenter(pc),
        z: originZ - CHUNK_SIZE / 2 + CELL * Math.max(pr, nr),
      });
    } else {
      doors.push({
        x: originX - CHUNK_SIZE / 2 + CELL * Math.max(pc, nc),
        z: originZ + cellCenter(pr),
      });
    }
  }

  doors.push({ x: to.x, z: to.z });
  return doors;
}

/** Раскладка первого этажа. Оставлено для краткости в проверках. */
export function hallLayout(seed: number): FloorLayout {
  return floorLayout(seed, 0);
}

/** Все сундуки подземелья, со всех этажей сразу. */
export function dungeonChests(seed: number): DungeonChest[] {
  const all: DungeonChest[] = [];
  for (let floor = 0; floor < DUNGEON_FLOORS; floor++) {
    all.push(...floorLayout(seed, floor).chests);
  }
  return all;
}

/** Сундук по имени — как `findNode` у ресурсных нод: ничего не храня. */
export function findChest(seed: number, id: string): DungeonChest | null {
  return dungeonChests(seed).find((chest) => chest.id === id) ?? null;
}

// ---------- мешок павшего ----------

/**
 * Сколько секунд мешок лежит на полу.
 *
 * Три минуты — это «успей дойти», а не «вернись потом». Убийце должно хватить
 * времени обыскать павшего, но забег не должен превращаться в склад: мешок,
 * лежащий вечно, отменяет саму ставку подземелья.
 *
 * Мешки давно лежат не только внизу: добыча с убитого зверя и выброшенное
 * из рюкзака падают мешком и наверху. Число живёт здесь по старой памяти —
 * первым мешком был мешок павшего в подземелье.
 */
export const BAG_SECONDS = 180;

/** С какого расстояния мешок обыскивают. Та же мерка, что у сундука. */
export const BAG_RANGE = 3.2;
