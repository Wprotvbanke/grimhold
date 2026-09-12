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

/** Сколько чанков в ширину занимает этаж. Один — этого хватает первому срезу. */
export const DUNGEON_RADIUS = 0;

/** Высота зала: в потолок упираться не должно, но и неба тут нет. */
const HALL_HEIGHT = 4;
const WALL = 1;

/** Где игрок появляется, войдя вниз. */
export const DUNGEON_ENTRY = { x: 0, y: 0.1, z: 24 };

/** Портал наружу. Стоит в дальнем конце: выход надо заслужить дорогой. */
export const DUNGEON_EXIT = { x: 0, z: -24 };
/** С какого расстояния портал откликается. */
export const DUNGEON_EXIT_RANGE = 2.6;

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
    if (Math.abs(cx) > DUNGEON_RADIUS || Math.abs(cz) > DUNGEON_RADIUS) return [];

    const random = mulberry32(seed ^ ((cx * 73856093) ^ (cz * 19349663)));
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

    return boxes;
  };
}
