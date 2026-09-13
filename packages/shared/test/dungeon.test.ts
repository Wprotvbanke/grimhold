import { describe, expect, it } from 'vitest';
import { ChunkedWorld } from '../src/chunks.js';
import { isSafe } from '../src/level.js';
import {
  DUNGEON_CENTER,
  DUNGEON_ENTRY,
  DUNGEON_EXIT,
  DUNGEON_ORIGIN_CHUNK,
  dungeonChests,
  dungeonInstance,
  dungeonSeed,
  findChest,
  hallLayout,
  mobsForDungeon,
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

  it('к порталу можно подойти: на его месте ничего не преграждает путь', () => {
    /**
     * Знак выхода нарисован краской и живёт на клиенте — в геометрии его нет
     * вовсе. Раз так, проверять надо не метку, а то, ради чего она стоит:
     * что до точки выхода можно дойти ногами.
     */
    const boxes = generateDungeonChunk(7)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const { x, z } = DUNGEON_EXIT;

    const blocking = boxes.filter(
      (entry) =>
        !entry.noCollide &&
        entry.box.minX <= x &&
        entry.box.maxX >= x &&
        entry.box.minZ <= z &&
        entry.box.maxZ >= z &&
        entry.box.maxY > 0.2 &&
        entry.box.minY < 2,
    );

    expect(blocking).toHaveLength(0);
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

describe('сундуки', () => {
  /**
   * Сундук — единственная причина спускаться, и раскладку его клиент строит
   * сам, из зерна. Разойдись она с серверной — игрок вскрывал бы воздух,
   * а настоящий сундук стоял бы там, где его не видно.
   */
  it('одно зерно — те же сундуки', () => {
    expect(dungeonChests(2024)).toEqual(dungeonChests(2024));
  });

  it('разные зёрна — разная раскладка', () => {
    expect(dungeonChests(1)).not.toEqual(dungeonChests(2));
  });

  it('их несколько, и каждый со своим именем', () => {
    const chests = dungeonChests(99);
    expect(chests.length).toBeGreaterThanOrEqual(4);
    expect(new Set(chests.map((chest) => chest.id)).size).toBe(chests.length);
  });

  it('находятся по имени, как ноды', () => {
    const chest = dungeonChests(5)[0]!;
    expect(findChest(5, chest.id)).toEqual(chest);
    expect(findChest(5, 'chest.999')).toBeNull();
  });

  it('ни один не стоит внутри колонны', () => {
    // Раскладка потому и считается одним потоком чисел: два независимых
    // генератора рано или поздно ставят сундук в колонну, и вскрыть его
    // становится неоткуда.
    for (const seed of [1, 17, 2024, 777777]) {
      const { pillars, chests } = hallLayout(seed);
      for (const chest of chests) {
        for (const pillar of pillars) {
          expect(Math.hypot(chest.x - pillar.x, chest.z - pillar.z)).toBeGreaterThan(
            pillar.width / 2,
          );
        }
      }
    }
  });

  it('не лежат ни у входа, ни у портала', () => {
    // Добычу надо унести, а не подобрать с порога: весь риск между этими
    // двумя точками.
    for (const chest of dungeonChests(31337)) {
      expect(Math.hypot(chest.x - DUNGEON_ENTRY.x, chest.z - DUNGEON_ENTRY.z)).toBeGreaterThan(8);
      expect(Math.hypot(chest.x - DUNGEON_EXIT.x, chest.z - DUNGEON_EXIT.z)).toBeGreaterThan(6);
    }
  });

  it('стоят в зале телесно — в них упираются', () => {
    const boxes = generateDungeonChunk(2024)(DUNGEON_ORIGIN_CHUNK, DUNGEON_ORIGIN_CHUNK);
    const crates = boxes.filter((entry) => entry.kind === 'chest');
    expect(crates).toHaveLength(dungeonChests(2024).length);
    expect(crates.every((entry) => !entry.noCollide)).toBe(true);
  });
});

describe('обитатели зала', () => {
  it('состав выводится из зерна и не пуст', () => {
    expect(mobsForDungeon(8)).toEqual(mobsForDungeon(8));
    expect(mobsForDungeon(8).length).toBeGreaterThanOrEqual(3);
  });

  it('наверху такой компании не собрать', () => {
    // Крыс и волков внизу нет: спуск обязан быть страшнее прогулки за околицу.
    expect(mobsForDungeon(12)).not.toContain('rat');
    expect(mobsForDungeon(12)).not.toContain('wolf');
  });
});
