import { describe, expect, it } from 'vitest';
import { ChunkedWorld } from '../src/chunks.js';
import { isSafe } from '../src/level.js';
import {
  DUNGEON_CENTER,
  DUNGEON_ENTRY,
  DUNGEON_EXIT,
  DUNGEON_ORIGIN_CHUNK,
  dungeonInstance,
  dungeonSeed,
  generateDungeonChunk,
  isDungeon,
} from '../src/dungeon.js';

/**
 * Подземелье.
 *
 * Главное здесь — раскладка **выводится из имени инстанса**, а не едет по сети.
 * Разойдись сервер и клиент хоть на одну стену — игрок упрётся в пустоту или
 * провалится сквозь пол, и понять это по логам будет нечем.
 */

describe('имя инстанса несёт зерно', () => {
  it('туда и обратно', () => {
    const name = dungeonInstance(123456);
    expect(isDungeon(name)).toBe(true);
    expect(dungeonSeed(name)).toBe(123456);
  });

  it('обычный мир подземельем не считается', () => {
    expect(isDungeon('overworld')).toBe(false);
  });
});

describe('этаж', () => {
  it('одно зерно — один и тот же зал', () => {
    const a = generateDungeonChunk(42)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const b = generateDungeonChunk(42)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('разные зёрна — разные залы', () => {
    const a = generateDungeonChunk(1)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const b = generateDungeonChunk(2)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('есть пол под ногами и потолок над головой', () => {
    const boxes = generateDungeonChunk(7)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const floor = boxes.find((entry) => entry.box.maxY <= 0.01 && entry.box.minY < 0);
    const ceiling = boxes.find((entry) => entry.box.minY > 3);

    expect(floor).toBeDefined();
    expect(ceiling).toBeDefined();
  });

  it('вход и портал стоят на полу этажа', () => {
    const boxes = generateDungeonChunk(7)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const floor = boxes.find((entry) => entry.box.maxY <= 0.01 && entry.box.minY < 0)!;

    for (const point of [DUNGEON_ENTRY, DUNGEON_EXIT]) {
      expect(point.x).toBeGreaterThan(floor.box.minX);
      expect(point.x).toBeLessThan(floor.box.maxX);
      expect(point.z).toBeGreaterThan(floor.box.minZ);
      expect(point.z).toBeLessThan(floor.box.maxZ);
    }
  });

  it('за краем этажа пусто — туда не выйти', () => {
    expect(generateDungeonChunk(7)(DUNGEON_ORIGIN_CHUNK + 2, DUNGEON_ORIGIN_CHUNK)).toHaveLength(0);
    expect(generateDungeonChunk(7)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK - 3)).toHaveLength(0);
  });
});

describe('подземелье стоит в стороне от мира', () => {
  /**
   * Это не косметика. Все проверки места в игре считаются по координатам, и
   * подземелье на месте города наследовало его правила: внизу нельзя было
   * драться, казна открывалась из зала, посреди подземелья стояла таверна.
   */
  it('вход и портал вне безопасной зоны города', () => {
    expect(isSafe(DUNGEON_ENTRY.x, DUNGEON_ENTRY.z)).toBe(false);
    expect(isSafe(DUNGEON_EXIT.x, DUNGEON_EXIT.z)).toBe(false);
  });

  it('и далеко от нуля, где стоит весь город', () => {
    // Мир занимает ±224 метра: пересечься не с чем.
    expect(Math.hypot(DUNGEON_CENTER.x, DUNGEON_CENTER.z)).toBeGreaterThan(1000);
  });

  it('зал строится вокруг своего начала, а не вокруг нуля', () => {
    const source = generateDungeonChunk(7);
    expect(source(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK).length).toBeGreaterThan(0);
    expect(source(0, 0)).toHaveLength(0);
  });

  it('у портала есть метка, через которую можно пройти', () => {
    const boxes = generateDungeonChunk(7)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const ring = boxes.find((entry) => entry.noCollide);

    expect(ring).toBeDefined();
    expect(ring!.box.minX).toBeLessThan(DUNGEON_EXIT.x);
    expect(ring!.box.maxX).toBeGreaterThan(DUNGEON_EXIT.x);
  });
});

describe('поток чанков не знает о границах мира', () => {
  /**
   * Здесь стояла проверка `isInsideWorld` — правило **обычного** мира,
   * попавшее в общий поток чанков. Подземелье уехало за его край и осталось
   * без единого чанка: у клиента не было ни пола, ни стен, он проваливался
   * в пустоту и видел небо. Сервер при этом стоял твёрдо — расходились
   * только предсказание и правда, и выглядело это как «инстанса нет».
   */
  it('вокруг подземелья чанки есть', () => {
    const around = ChunkedWorld.chunksAround(DUNGEON_ENTRY.x, DUNGEON_ENTRY.z);
    expect(around.length).toBeGreaterThan(0);
    expect(around).toContainEqual({ cx: DUNGEON_ORIGIN_CHUNK, cz: DUNGEON_ORIGIN_CHUNK });
  });

  it('и земля под ними настоящая', () => {
    const terrain = new ChunkedWorld(generateDungeonChunk(11));
    const colliders = terrain.collidersAt(DUNGEON_ENTRY.x, DUNGEON_ENTRY.z);

    // Пол должен оказаться прямо под точкой входа, иначе игрок падает.
    const under = colliders.find(
      (box) =>
        box.minX <= DUNGEON_ENTRY.x &&
        box.maxX >= DUNGEON_ENTRY.x &&
        box.minZ <= DUNGEON_ENTRY.z &&
        box.maxZ >= DUNGEON_ENTRY.z &&
        box.maxY <= DUNGEON_ENTRY.y + 0.01,
    );
    expect(under).toBeDefined();
  });
});
