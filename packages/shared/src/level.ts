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
 * Фонари города.
 *
 * Раскладка лежит здесь, а не рядом с моделями, по той же причине, что и
 * здания площади: **в столб упираются**. Разъедься список с картинкой — игрок
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
  // Стоял у двери таверны. Таверну снесли под другое здание, а угол улицы
  // без огня остался бы тёмным — фонарь на прежнем месте.
  { x: -11.4, z: -7.5 },
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

/**
 * Здания площади — ратуша и городской дом, модели от владельца.
 *
 * Встали вместо двух голых стен, что делили площадь: стены были «есть за чем
 * прятаться», здания дают то же укрытие, но выглядят городом, а не полигоном.
 *
 * Дом стоит **вдоль восточной стороны северной улицы**, ратуша («церковь»)
 * перенесена владельцем к юго-востоку от точки появления; обе фасадом с дверью
 * на запад — к улице и к площади. Первым их
 * поставили к северу от точки появления фасадом на площадь — и ратуша
 * перегородила ось северных ворот: из города было не выйти, упал тест
 * движения. Ось ворот держим пустой, как и для фонарей.
 *
 * `footprint` — пятно здания в его собственных координатах, по габаритам
 * модели и чуть внутрь: крыльцо и свесы кровли не должны останавливать
 * за полметра до стены. Внутрь не войти — это коробка, а не таверна.
 * `turn` — разворот вокруг вертикали, в радианах, как у `rotation.y` в three:
 * фасад модели смотрит в +Z, −π/2 разворачивает его на −X, к улице.
 *
 * Соседи: фонарь в (10, −2) южнее, платформы с x = 12 восточнее, дорога
 * сквозных проверок к люку идёт по z = −2 — всё снаружи.
 */
export const TOWN_HOUSES: readonly {
  model: 'town_hall' | 'townhouse';
  x: number;
  z: number;
  turn: number;
  height: number;
  footprint: { minX: number; maxX: number; minZ: number; maxZ: number };
}[] = [
  {
    // Ратуша со шпилем — владелец зовёт её церковью. Место и разворот выбрал
    // он сам: к юго-востоку от точки появления, **лицом к центру площади**.
    // Угол считается от места к центру, а не вписан числом: передвинут —
    // и фасад сам повернётся за площадью.
    model: 'town_hall',
    x: 10,
    z: 15,
    turn: facing(10, 15, 0, 0),
    height: 10,
    footprint: { minX: -3.6, maxX: 3.6, minZ: -4.2, maxZ: 4.3 },
  },
  {
    model: 'townhouse',
    x: 6.9,
    z: -15.8,
    turn: -Math.PI / 2,
    height: 12,
    footprint: { minX: -2.9, maxX: 2.9, minZ: -3.0, maxZ: 4.1 },
  },
];

/**
 * Разворот, при котором фасад модели (+Z) смотрит из точки на цель.
 * Тот же угол, что у `rotation.y` в three.
 */
function facing(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/**
 * На сколько полос режется пятно здания под коробки столкновений.
 *
 * Коробки у нас выровнены по осям, а здание может стоять под любым углом.
 * Одна коробка вокруг повёрнутого пятна раздувается: ратуша под 34° к осям
 * давала коробку 11×11 м вместо 7×8.5, и у углов стояли невидимые стены
 * в полтора метра. Полосы обводят пятно ступенькой, и ступенька тем мельче,
 * чем полос больше. При развороте на четверть оборота полосы складываются
 * ровно в прямоугольник.
 */
const HOUSE_STRIPS = 8;

/**
 * Коробки здания в мире: пятно поворачивается вместе с моделью.
 *
 * Поворот тот же, что у `rotation.y` в three: x' = x·cos + z·sin,
 * z' = −x·sin + z·cos. Разверни одно без другого — и игрок упирается
 * в воздух сбоку от здания, а сквозь фасад проходит.
 */
function houseBoxes(): LevelBox[] {
  const boxes: LevelBox[] = [];
  for (const { x, z, turn, height, footprint } of TOWN_HOUSES) {
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const step = (footprint.maxZ - footprint.minZ) / HOUSE_STRIPS;

    for (let strip = 0; strip < HOUSE_STRIPS; strip++) {
      const fromZ = footprint.minZ + step * strip;
      const corners = [
        [footprint.minX, fromZ],
        [footprint.minX, fromZ + step],
        [footprint.maxX, fromZ],
        [footprint.maxX, fromZ + step],
      ].map(([cx, cz]) => ({ x: x + cx! * cos + cz! * sin, z: z - cx! * sin + cz! * cos }));
      boxes.push({
        kind: 'wall',
        hidden: true,
        box: {
          minX: Math.min(...corners.map((corner) => corner.x)),
          maxX: Math.max(...corners.map((corner) => corner.x)),
          minY: 0,
          maxY: height,
          minZ: Math.min(...corners.map((corner) => corner.z)),
          maxZ: Math.max(...corners.map((corner) => corner.z)),
        },
      });
    }
  }
  return boxes;
}

export const TOWN_BOXES: readonly LevelBox[] = [
  // Мостовая города. Верх на y = 0.
  { kind: 'floor', box: boxFromCenter(0, -0.5, 0, TOWN_SIZE, 1, TOWN_SIZE) },

  // Городские стены с воротами на все четыре стороны.
  ...wallWithGate('x', -HALF),
  ...wallWithGate('x', HALF),
  ...wallWithGate('z', -HALF),
  ...wallWithGate('z', HALF),

  // Здания площади: вид им дают модели, здесь только телесность.
  ...houseBoxes(),

  // Колоннада.
  { kind: 'pillar', box: boxFromCenter(-14, 2, 12, 1.2, 4, 1.2) },
  { kind: 'pillar', box: boxFromCenter(-10, 2, 12, 1.2, 4, 1.2) },
  { kind: 'pillar', box: boxFromCenter(-6, 2, 12, 1.2, 4, 1.2) },


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

  // Ступени с помостом у восточной стены убраны по просьбе владельца:
  // лестница из пола посреди улицы смотрелась поломкой, место ровное.
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
