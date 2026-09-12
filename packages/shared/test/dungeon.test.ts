import { describe, expect, it } from 'vitest';
import {
  DUNGEON_ENTRY,
  DUNGEON_EXIT,
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
    const a = generateDungeonChunk(42)(0, 0);
    const b = generateDungeonChunk(42)(0, 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('разные зёрна — разные залы', () => {
    const a = generateDungeonChunk(1)(0, 0);
    const b = generateDungeonChunk(2)(0, 0);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('есть пол под ногами и потолок над головой', () => {
    const boxes = generateDungeonChunk(7)(0, 0);
    const floor = boxes.find((entry) => entry.box.maxY <= 0.01 && entry.box.minY < 0);
    const ceiling = boxes.find((entry) => entry.box.minY > 3);

    expect(floor).toBeDefined();
    expect(ceiling).toBeDefined();
  });

  it('вход и портал стоят на полу этажа', () => {
    const boxes = generateDungeonChunk(7)(0, 0);
    const floor = boxes.find((entry) => entry.box.maxY <= 0.01 && entry.box.minY < 0)!;

    for (const point of [DUNGEON_ENTRY, DUNGEON_EXIT]) {
      expect(point.x).toBeGreaterThan(floor.box.minX);
      expect(point.x).toBeLessThan(floor.box.maxX);
      expect(point.z).toBeGreaterThan(floor.box.minZ);
      expect(point.z).toBeLessThan(floor.box.maxZ);
    }
  });

  it('за краем этажа пусто — туда не выйти', () => {
    expect(generateDungeonChunk(7)(2, 0)).toHaveLength(0);
    expect(generateDungeonChunk(7)(0, -3)).toHaveLength(0);
  });
});
