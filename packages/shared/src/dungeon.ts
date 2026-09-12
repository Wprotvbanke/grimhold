import { CHUNK_SIZE, chunkCenter, type ChunkSource } from './chunks.js';
import { boxFromCenter } from './math.js';
import type { LevelBox } from './level.js';

/**
 * Подземелье.
 *
 * Устроено как **тот же мир с другим `instanceId` и другой землёй под ногами**,
 * а не как отдельный уровень. Замысел обещал «смещение в мировом пространстве»,
 * но за краем мира генератор чанков отдавал пустоту — пола там нет. Смещение
 * и не нужно: инстанс уже изолирует, поэтому подземелье занимает те же
 * координаты вокруг нуля, просто в своём инстансе.
 *
 * Раскладка **выводится из зерна**, как и дикие земли: сервер и клиент строят
 * одинаковые стены, ничего не пересылая. Зерно лежит прямо в имени инстанса —
 * `dungeon.7f3a`, — поэтому клиенту достаточно знать, где он.
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

/** Сколько чанков в ширину занимает этаж. Один — этого хватает первому срезу. */
export const DUNGEON_RADIUS = 0;

/** Середина этажа в мировых координатах. */
export const DUNGEON_CENTER = {
  x: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
  z: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
};


/**
 * Настенные факелы зала.
 *
 * Темнота — механика вехи 6, но включать её раньше переносного огня значит
 * отдать игроку чёрный экран: первый же спуск кончился тем, что зал приняли
 * за несуществующий. Пока огонь стоит по стенам, как в городе, — видно, куда
 * идти, и видно, что это подземелье, а не пустота.
 *
 * Когда появится факел в руке, этот свет станет редким и неровным: тогда
 * темнота начнёт работать на игру, а не против неё.
 */
export const DUNGEON_LAMPS: readonly { x: number; z: number }[] = [
  // Вдоль пути от входа к выходу: по ним и ориентируются.
  { x: -6, z: 22 },
  { x: 6, z: 22 },
  { x: -6, z: 8 },
  { x: 6, z: 8 },
  { x: -6, z: -8 },
  { x: 6, z: -8 },
  // У ниши с порталом.
  { x: -4, z: -22 },
  { x: 4, z: -22 },
  // По углам зала, чтобы стены читались, а не тонули.
  { x: -26, z: 26 },
  { x: 26, z: 26 },
  { x: -26, z: -26 },
  { x: 26, z: -26 },
].map((spot) => ({ x: DUNGEON_CENTER.x + spot.x, z: DUNGEON_CENTER.z + spot.z }));

/** Высота факела над полом. */
export const DUNGEON_LAMP_HEIGHT = 2.7;

/** Высота зала: в потолок упираться не должно, но и неба тут нет. */
const HALL_HEIGHT = 4;
const WALL = 1;

/** Где игрок появляется, войдя вниз. */
export const DUNGEON_ENTRY = {
  x: DUNGEON_CENTER.x,
  y: 0.1,
  z: DUNGEON_CENTER.z + 24,
};

/** Портал наружу. Стоит у дальней стены: выход надо заслужить дорогой. */
export const DUNGEON_EXIT = {
  x: DUNGEON_CENTER.x,
  z: DUNGEON_CENTER.z - 27,
};
/**
 * С какого расстояния портал откликается.
 *
 * Чуть шире самой метки: она скромная, и упираться в неё носом, чтобы нажать,
 * было бы наказанием за то, что её нашли.
 */
export const DUNGEON_EXIT_RANGE = 3.4;
/** Радиус кольца на полу — по нему же клиент ставит свет. */
export const DUNGEON_EXIT_MARK = 2.2;

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

/**
 * Один этаж: зал с колоннами и глухими стенами по краю.
 *
 * Это ещё не процедурная сборка комнат из вехи 6 — это самый тонкий ломоть,
 * на котором видно, работает ли связка «вошёл, походил, вышел». Комнаты,
 * коридоры и этажи встанут сюда же, когда связка окажется живой.
 */
export function generateDungeonChunk(seed: number): ChunkSource {
  return (cx: number, cz: number): LevelBox[] => {
    // Этаж один и конечен: за его пределами ничего нет, и туда не выйти —
    // край закрыт стеной, как и край мира.
    const dx = cx - DUNGEON_ORIGIN_CHUNK;
    const dz = cz - DUNGEON_ORIGIN_CHUNK;
    if (Math.abs(dx) > DUNGEON_RADIUS || Math.abs(dz) > DUNGEON_RADIUS) return [];

    const random = mulberry32(seed ^ ((dx * 73856093) ^ (dz * 19349663)));
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
    for (const [dx, dz, w, d] of [
      [0, -half, CHUNK_SIZE, WALL],
      [0, half, CHUNK_SIZE, WALL],
      [-half, 0, WALL, CHUNK_SIZE],
      [half, 0, WALL, CHUNK_SIZE],
    ] as const) {
      boxes.push({
        kind: 'brick',
        box: boxFromCenter(originX + dx, HALL_HEIGHT / 2, originZ + dz, w, HALL_HEIGHT, d),
      });
    }

    // Колонны: укрытия и ориентиры. Без них зал — пустая коробка, в которой
    // некуда спрятаться и не за что зацепиться глазом.
    const pillars = 8 + Math.floor(random() * 6);
    for (let i = 0; i < pillars; i++) {
      const width = 1.4 + random() * 1.2;
      boxes.push({
        kind: 'pillar',
        box: boxFromCenter(
          originX + (random() - 0.5) * (CHUNK_SIZE - 12),
          HALL_HEIGHT / 2,
          originZ + (random() - 0.5) * (CHUNK_SIZE - 12),
          width,
          HALL_HEIGHT,
          width,
        ),
      });
    }

    addExitMark(boxes);
    return boxes;
  };
}

/**
 * Метка выхода: ниша в стене и кольцо на полу.
 *
 * Портал был невидим — просто точка на полу, — и игрок в первом же забеге
 * заблудился в собственном зале. Ниша нужна не для красоты: стена, которая
 * расступается, читается как выход издалека, а кольцо говорит, где именно
 * встать. Свет над кольцом ставит клиент.
 */
function addExitMark(boxes: LevelBox[]): void {
  const { x, z } = DUNGEON_EXIT;

  // Ниша: пол и потолок уходят за линию стены, образуя карман.
  boxes.push({
    kind: 'brick',
    box: boxFromCenter(x, -0.5, z - 2.5, DUNGEON_EXIT_MARK * 3, 1, 6),
  });
  boxes.push({
    kind: 'brick',
    box: boxFromCenter(x, HALL_HEIGHT + 0.5, z - 2.5, DUNGEON_EXIT_MARK * 3, 1, 6),
  });
  // Боковины кармана, чтобы он был карманом, а не дырой в стене.
  for (const side of [-1, 1]) {
    boxes.push({
      kind: 'brick',
      box: boxFromCenter(
        x + side * DUNGEON_EXIT_MARK * 1.5,
        HALL_HEIGHT / 2,
        z - 2.5,
        WALL,
        HALL_HEIGHT,
        6,
      ),
    });
  }
  // Задняя стенка кармана: сквозь портал не проходят, в него входят.
  boxes.push({
    kind: 'brick',
    box: boxFromCenter(x, HALL_HEIGHT / 2, z - 5.5, DUNGEON_EXIT_MARK * 3, HALL_HEIGHT, WALL),
  });

  // Кольцо на полу. Низкое и непреграждающее: по нему ходят, а не спотыкаются.
  boxes.push({
    kind: 'ruin',
    noCollide: true,
    box: boxFromCenter(x, 0.06, z, DUNGEON_EXIT_MARK * 2, 0.12, DUNGEON_EXIT_MARK * 2),
  });
}
