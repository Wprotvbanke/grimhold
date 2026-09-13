import { type Aabb, boxFromCenter } from './math.js';

/**
 * Содержимое стартового города. Отдельный файл, потому что город собран
 * вручную, а дикие земли вокруг генерируются процедурно (см. chunks.ts).
 *
 * Один и тот же список используют сервер (коллизии) и клиент (рендер):
 * расхождение геометрии сразу ломает предсказание, поэтому источник один.
 */

export interface LevelBox {
  /**
   * Вид поверхности. От него зависит текстура на клиенте, поэтому город
   * (мостовая) и дикие земли (грунт) разделены: одинаковый пол под ногами
   * стирал бы разницу между безопасным местом и опасным.
   */
  kind:
    | 'floor'
    | 'ground'
    | 'wall'
    | 'pillar'
    | 'platform'
    | 'rock'
    | 'ruin'
    | 'timber'
    /** Фахверк: брус с побелкой. Верхние этажи построек. */
    | 'frame'
    /** Каменная кладка: цоколь, труба, очаг. */
    | 'brick'
    /** Половая доска. */
    | 'plank'
    /** Кровельная черепица. */
    | 'shingle'
    /** Окованный сундук подземелья. */
    | 'chest';
  box: Aabb;
  /**
   * Коробка ставит преграду, но не рисуется. Так стоит обстановка таверны:
   * столы и бочки показывает модель из пака, а телесность им даёт вот эта
   * невидимая коробка — иначе пришлось бы либо проходить сквозь стол, либо
   * видеть серый ящик поверх модели.
   */
  hidden?: boolean;
  /**
   * Обратное `hidden`: коробка рисуется, но пути не преграждает.
   *
   * Нужна для тонких настилов и порогов. Шага через препятствие в движении
   * нет — останавливает любая коробка, какой бы низкой ни была, — и дощатый
   * пол таверны в шесть сантиметров запирал дверь наглухо.
   */
  noCollide?: boolean;
}

export const TOWN_SIZE = 60;
const WALL_HEIGHT = 4;
const WALL_THICKNESS = 1;
const HALF = TOWN_SIZE / 2;
/** Ширина проёма в стене — через него выходят в дикие земли. */
const GATE = 8;

/** Стена с воротами посередине: два отрезка вместо одного сплошного. */
function wallWithGate(axis: 'x' | 'z', offset: number): LevelBox[] {
  const segment = (TOWN_SIZE - GATE) / 2;
  const shift = GATE / 2 + segment / 2;

  if (axis === 'x') {
    return [
      { kind: 'wall', box: boxFromCenter(-shift, WALL_HEIGHT / 2, offset, segment, WALL_HEIGHT, WALL_THICKNESS) },
      { kind: 'wall', box: boxFromCenter(shift, WALL_HEIGHT / 2, offset, segment, WALL_HEIGHT, WALL_THICKNESS) },
    ];
  }
  return [
    { kind: 'wall', box: boxFromCenter(offset, WALL_HEIGHT / 2, -shift, WALL_THICKNESS, WALL_HEIGHT, segment) },
    { kind: 'wall', box: boxFromCenter(offset, WALL_HEIGHT / 2, shift, WALL_THICKNESS, WALL_HEIGHT, segment) },
  ];
}


/**
 * Таверна. Первое здание города, в которое можно войти.
 *
 * Стоит на северо-западе, дверью к площади. Отодвинута от внутренней стены
 * города: с центром на z = -12 из двери упирались бы в неё через 0.7 метра. Габариты выбраны под игру от
 * первого лица: потолок 3.6 м не давит, дверной проём 1.8 м проходится, не
 * цепляясь плечами за косяк (радиус игрока — 0.35).
 *
 * Обстановку рисует клиент моделями из пака KayKit, а здесь у неё только
 * невидимые коробки под столкновения — см. `hidden` и client/src/props.ts.
 * Координаты общие: разъедься они, игрок упирался бы в пустоту.
 */
export const TAVERN = {
  centerX: -14,
  centerZ: -14,
  /** Внутренние размеры, без учёта толщины стен. */
  width: 12,
  depth: 9,
  height: 3.6,
  wall: 0.4,
  /** Высота каменного цоколя: выше него идёт фахверк. */
  stone: 1.3,
  /** Проём в южной стене — той, что смотрит на площадь. */
  doorWidth: 1.8,
} as const;

function tavernBoxes(): LevelBox[] {
  const { centerX, centerZ, width, depth, height, wall, doorWidth, stone } = TAVERN;
  const halfW = width / 2;
  const halfD = depth / 2;
  const outerW = width + wall * 2;
  const outerD = depth + wall * 2;

  // Южная стена с проёмом: два отрезка вместо сплошного.
  const side = (width - doorWidth) / 2;
  const shift = doorWidth / 2 + side / 2;

  /**
   * Стена в два яруса: каменный цоколь и фахверк над ним.
   *
   * Так строили и так выглядит образец из пака: низ держит сырость, верх
   * лёгкий. Для нас это ещё и способ прочесть высоту — по линии камня сразу
   * видно, где пол, а где этаж.
   */
  const twoTier = (x: number, z: number, w: number, d: number): LevelBox[] => [
    { kind: 'brick', box: boxFromCenter(x, stone / 2, z, w, stone, d) },
    { kind: 'frame', box: boxFromCenter(x, (stone + height) / 2, z, w, height - stone, d) },
  ];

  return [
    // Дощатый настил поверх мостовой. Только вид: держит игрока мостовая
    // под ним, а сам настил слишком низок, чтобы через него шагать.
    {
      kind: 'plank',
      noCollide: true,
      box: boxFromCenter(centerX, 0.03, centerZ, width, 0.06, depth),
    },

    // Задняя и боковые стены.
    ...twoTier(centerX, centerZ - halfD - wall / 2, outerW, wall),
    ...twoTier(centerX - halfW - wall / 2, centerZ, wall, depth),
    ...twoTier(centerX + halfW + wall / 2, centerZ, wall, depth),

    // Фасад с дверью.
    ...twoTier(centerX - shift, centerZ + halfD + wall / 2, side, wall),
    ...twoTier(centerX + shift, centerZ + halfD + wall / 2, side, wall),
    // Перемычка над дверью: проём не должен доходить до крыши.
    {
      kind: 'frame',
      box: boxFromCenter(centerX, height - 0.55, centerZ + halfD + wall / 2, doorWidth, 1.1, wall),
    },

    // Потолок. Без него внутри не было бы полумрака, ради которого таверна
    // и нужна. Скат крыши поверх него рисует клиент — коробкой его не сделать.
    { kind: 'plank', box: boxFromCenter(centerX, height + 0.15, centerZ, outerW, 0.3, outerD) },

    // Очаг в северо-восточном углу: каменный портал, внутри горит огонь.
    // Боковины и задняя стенка телесны, сама топка открыта — в неё видно.
    { kind: 'brick', box: boxFromCenter(centerX + halfW - 2.1, 0.75, centerZ - halfD + 1.2, 0.5, 1.5, 1.9) },
    { kind: 'brick', box: boxFromCenter(centerX + halfW - 0.1, 0.75, centerZ - halfD + 1.2, 0.5, 1.5, 1.9) },
    // Перемычка над топкой и труба над ней.
    { kind: 'brick', box: boxFromCenter(centerX + halfW - 1.1, 1.65, centerZ - halfD + 1.2, 2.5, 0.3, 1.9) },
    { kind: 'brick', box: boxFromCenter(centerX + halfW - 1.1, (1.8 + height + 1.6) / 2, centerZ - halfD + 1.2, 1.3, height + 1.6 - 1.8, 1.3) },

    // Обстановка: телесность есть, вида нет — его дают модели на клиенте.
    // Барная стойка вдоль задней стены.
    { kind: 'timber', hidden: true, box: boxFromCenter(centerX - 2.4, 0.55, centerZ - halfD + 1.0, 5.2, 1.1, 0.8) },
    // Два длинных стола с лавками по центру зала.
    { kind: 'timber', hidden: true, box: boxFromCenter(centerX - 3, 0.39, centerZ + 1.2, 1.2, 0.78, 2.4) },
    { kind: 'timber', hidden: true, box: boxFromCenter(centerX + 3, 0.39, centerZ + 1.2, 1.2, 0.78, 2.4) },
    // Бочки и ящики по углам.
    { kind: 'timber', hidden: true, box: boxFromCenter(centerX - halfW + 0.9, 0.48, centerZ + halfD - 1.1, 1.1, 0.95, 1.1) },
    { kind: 'timber', hidden: true, box: boxFromCenter(centerX - halfW + 0.7, 0.85, centerZ - halfD + 1.1, 1.3, 1.7, 1.3) },
  ];
}

/**
 * Фонари города.
 *
 * Раскладка лежит здесь, а не рядом с моделями, по той же причине, что и
 * мебель таверны: **в столб упираются**. Разъедься список с картинкой — игрок
 * упирался бы в пустоту или проходил сквозь фонарь.
 *
 * Ни один не стоит на оси ворот: через них ходят, а столб посреди прохода —
 * это стена. Один такой однажды оказался вмурован в стену рынка, и заметили
 * это только когда стали считать столкновения.
 */
export const TOWN_LAMPS: readonly { x: number; z: number }[] = [
  // По бокам ворот, а не в самом проёме.
  { x: 3.2, z: 24 },
  { x: -3.2, z: 24 },
  { x: 3.2, z: -24 },
  { x: -3.2, z: -24 },
  // Вдоль улиц.
  { x: -6, z: 6 },
  { x: 9, z: 6 },
  { x: -6, z: -4 },
  { x: 10, z: -2 },
  { x: -18, z: 2 },
  { x: 18, z: 10 },
  { x: -24, z: -6 },
  { x: 20, z: -20 },
  // На площади.
  { x: -1.8, z: 7.2 },
  // У входа в таверну: дверь должна быть видна ночью издалека.
  { x: TAVERN.centerX + 2.6, z: TAVERN.centerZ + TAVERN.depth / 2 + 2 },
];

/** Столб фонаря: тонкий, но телесный. */
const LAMP_RADIUS = 0.18;
/** Высота столба. Клиент приводит модель ровно к ней. */
export const LAMP_HEIGHT = 3.4;
function lightBoxes(): LevelBox[] {
  const boxes: LevelBox[] = [];

  for (const lamp of TOWN_LAMPS) {
    boxes.push({
      kind: 'pillar',
      hidden: true,
      box: boxFromCenter(lamp.x, LAMP_HEIGHT / 2, lamp.z, LAMP_RADIUS * 2, LAMP_HEIGHT, LAMP_RADIUS * 2),
    });
  }

  return boxes;
}

/**
 * Городская казна — единственное безопасное хранилище в игре.
 *
 * Стоит на площади, у всех на виду и близко к точке входа: банк нужен чаще
 * всего сразу после возвращения из диких земель, и заставлять искать его по
 * городу значило бы наказывать за осторожность.
 *
 * Хранилище общее на аккаунт, а не на персонажа: вещи кладёт тот, кто дошёл,
 * а забирает любой свой — так дворф-кузнец снабжает эльфа-травника, не
 * встречаясь с ним в мире.
 */
export const BANK = {
  x: -4,
  z: 2,
  /** С какого расстояния открывается сундук. */
  range: 3,
  width: 2.2,
  depth: 1.2,
  height: 1.1,
} as const;

/**
 * Спуск в подземелье — люк на городской площади.
 *
 * Стоит в городе намеренно: вход всегда доступен, и бесплатный стартовый набор
 * делает его доступным даже тому, кто всё потерял. Искать вход по диким землям
 * значило бы наказывать за неудачу прошлого забега.
 */
export const DUNGEON_GATE = {
  x: 8,
  z: 2,
  /** С какого расстояния открывается спуск. */
  range: 3,
  width: 2.6,
  depth: 2.6,
  height: 0.6,
} as const;

export const TOWN_BOXES: readonly LevelBox[] = [
  // Мостовая города. Верх на y = 0.
  { kind: 'floor', box: boxFromCenter(0, -0.5, 0, TOWN_SIZE, 1, TOWN_SIZE) },

  // Городские стены с воротами на все четыре стороны.
  ...wallWithGate('x', -HALF),
  ...wallWithGate('x', HALF),
  ...wallWithGate('z', -HALF),
  ...wallWithGate('z', HALF),

  // Внутренние постройки — есть за чем прятаться.
  { kind: 'wall', box: boxFromCenter(-8, 1.5, -6, 12, 3, 0.8) },
  { kind: 'wall', box: boxFromCenter(6, 1.5, 8, 0.8, 3, 14) },

  // Колоннада.
  { kind: 'pillar', box: boxFromCenter(-14, 2, 12, 1.2, 4, 1.2) },
  { kind: 'pillar', box: boxFromCenter(-10, 2, 12, 1.2, 4, 1.2) },
  { kind: 'pillar', box: boxFromCenter(-6, 2, 12, 1.2, 4, 1.2) },

  // Таверна — единственное здание, внутрь которого можно зайти.
  ...tavernBoxes(),

  // Фонари: вид им даёт клиент, здесь только телесность.
  ...lightBoxes(),

  // Городская казна: каменный ларь на площади, кладка его и рисует.
  {
    kind: 'brick',
    box: boxFromCenter(BANK.x, BANK.height / 2, BANK.z, BANK.width, BANK.height, BANK.depth),
  },

  // Спуск в подземелье: низкий каменный оклад люка.
  {
    kind: 'brick',
    box: boxFromCenter(
      DUNGEON_GATE.x,
      DUNGEON_GATE.height / 2,
      DUNGEON_GATE.z,
      DUNGEON_GATE.width,
      DUNGEON_GATE.height,
      DUNGEON_GATE.depth,
    ),
  },

  // Ступени и помост.
  { kind: 'platform', box: boxFromCenter(14, 0.25, -10, 4, 0.5, 4) },
  { kind: 'platform', box: boxFromCenter(14, 0.75, -14, 4, 1.5, 4) },
  { kind: 'platform', box: boxFromCenter(14, 1.25, -18, 4, 2.5, 4) },
];

/**
 * Безопасная зона — город внутри стен.
 *
 * Здесь нельзя поднять руку на другого игрока: сервер отклоняет и удар,
 * и снаряд. Город — место, куда возвращаются с добычей, и торг у казны не
 * должен кончаться ножом в спину, пока человек разбирает рюкзак с отпущенным
 * курсором.
 *
 * Мобов это не касается: за стены их и так не пускают.
 *
 * Граница совпадает со стенами, а не проходит где-то рядом: игрок должен
 * видеть, где кончается защита. Проверяются **оба** участника — иначе
 * стрелять можно было бы из ворот по тем, кто внутри.
 */
export function isSafe(x: number, z: number): boolean {
  return Math.abs(x) <= HALF && Math.abs(z) <= HALF;
}

export const SPAWN_POINT = { x: 0, y: 0.1, z: 10 };

/**
 * Совместимость с ранним кодом и тестами: полный список коллизий города.
 * Игровой код должен ходить через ChunkedWorld, который знает и дикие земли.
 */
export const TEST_LEVEL: readonly LevelBox[] = TOWN_BOXES;
export const TEST_LEVEL_COLLIDERS: readonly Aabb[] = TOWN_BOXES.filter(
  (entry) => !entry.noCollide,
).map((entry) => entry.box);
