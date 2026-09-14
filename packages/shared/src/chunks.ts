import { type Aabb, boxFromCenter } from './math.js';
import { TOWN_BOXES, TOWN_CLEARANCE, TOWN_SIZE, insideTown, type LevelBox } from './level.js';
import { generateNature } from './nature.js';
import { NODES, generateNodes } from './nodes.js';

/**
 * Чанковый мир.
 *
 * Мир нарезан на квадраты фиксированного размера. Сервер держит коллизии только
 * тех чанков, что рядом с игроком, а клиент строит и выбрасывает меши по мере
 * движения — иначе большой мир пришлось бы целиком держать в памяти и в кадре.
 *
 * Содержимое чанка выводится из его координат детерминированно, поэтому сервер
 * и клиент получают одинаковую геометрию, ничего не пересылая по сети.
 * Позже сюда встанет загрузка из данных зоны — интерфейс не изменится.
 */

export const CHUNK_SIZE = 64;
/** Сколько чанков от центра в каждую сторону. 3 → мир 7×7 чанков, 448 м. */
export const WORLD_CHUNK_RADIUS = 3;
/** Сколько колец чанков держать загруженными вокруг наблюдателя. */
export const CHUNK_LOAD_RADIUS = 1;

export interface ChunkCoord {
  cx: number;
  cz: number;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

export function worldToChunk(x: number, z: number): ChunkCoord {
  return {
    cx: Math.round(x / CHUNK_SIZE),
    cz: Math.round(z / CHUNK_SIZE),
  };
}

export function chunkCenter(cx: number, cz: number): { x: number; z: number } {
  return { x: cx * CHUNK_SIZE, z: cz * CHUNK_SIZE };
}

export function isInsideWorld(cx: number, cz: number): boolean {
  return Math.abs(cx) <= WORLD_CHUNK_RADIUS && Math.abs(cz) <= WORLD_CHUNK_RADIUS;
}

/**
 * Детерминированный генератор. Одни и те же координаты всегда дают один и тот
 * же чанк — на сервере, на клиенте и после перезапуска.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(cx: number, cz: number): number {
  // Смешиваем координаты так, чтобы соседние чанки не были похожи.
  return Math.imul(cx + 0x9e37, 0x85ebca6b) ^ Math.imul(cz + 0x79b9, 0xc2b2ae35);
}

/** Содержимое чанка: город в центре, дикие земли вокруг. */
export function generateChunk(cx: number, cz: number): LevelBox[] {
  if (!isInsideWorld(cx, cz)) return [];
  if (cx === 0 && cz === 0) return townChunk();
  return wildernessChunk(cx, cz);
}

function townChunk(): LevelBox[] {
  const boxes = [...TOWN_BOXES];

  // Кольцо мостовой вокруг города, чтобы у ворот не было обрыва.
  const ring = (CHUNK_SIZE - TOWN_SIZE) / 2;
  if (ring > 0) {
    const half = CHUNK_SIZE / 2;
    const offset = TOWN_SIZE / 2 + ring / 2;
    boxes.push(
      { kind: 'floor', box: boxFromCenter(0, -0.5, -offset, CHUNK_SIZE, 1, ring) },
      { kind: 'floor', box: boxFromCenter(0, -0.5, offset, CHUNK_SIZE, 1, ring) },
      { kind: 'floor', box: boxFromCenter(-offset, -0.5, 0, ring, 1, TOWN_SIZE) },
      { kind: 'floor', box: boxFromCenter(offset, -0.5, 0, ring, 1, TOWN_SIZE) },
    );
    void half;
  }

  return boxes;
}

/**
 * Грунт чанка без того, что занял город: до четырёх полос вокруг городского
 * квадрата. Чанк, до города не достающий, получает грунт целиком.
 */
function groundAroundTown(originX: number, originZ: number): LevelBox[] {
  const half = CHUNK_SIZE / 2;
  const town = TOWN_SIZE / 2;
  const minX = originX - half;
  const maxX = originX + half;
  const minZ = originZ - half;
  const maxZ = originZ + half;

  const cutMinX = Math.max(minX, -town);
  const cutMaxX = Math.min(maxX, town);
  const cutMinZ = Math.max(minZ, -town);
  const cutMaxZ = Math.min(maxZ, town);
  if (cutMinX >= cutMaxX || cutMinZ >= cutMaxZ) {
    return [{ kind: 'ground', box: boxFromCenter(originX, -0.5, originZ, CHUNK_SIZE, 1, CHUNK_SIZE) }];
  }

  const strips: LevelBox[] = [];
  const strip = (fromX: number, toX: number, fromZ: number, toZ: number): void => {
    if (toX - fromX < 0.01 || toZ - fromZ < 0.01) return;
    strips.push({ kind: 'ground', box: { minX: fromX, maxX: toX, minY: -1, maxY: 0, minZ: fromZ, maxZ: toZ } });
  };
  strip(minX, maxX, minZ, cutMinZ);
  strip(minX, maxX, cutMaxZ, maxZ);
  strip(minX, cutMinX, cutMinZ, cutMaxZ);
  strip(cutMaxX, maxX, cutMinZ, cutMaxZ);
  return strips;
}

function wildernessChunk(cx: number, cz: number): LevelBox[] {
  const random = mulberry32(seedOf(cx, cz));
  const { x: originX, z: originZ } = chunkCenter(cx, cz);
  const boxes: LevelBox[] = [];

  // Земля чанка: грунт, а не городская мостовая. Город вышел за свой чанк,
  // и под ним грунт вырезается: лёг бы в одну плоскость с мостовой и мерцал.
  boxes.push(...groundAroundTown(originX, originZ));

  // Валуны: разбросаны, разного размера, дают укрытия и ориентиры.
  // Числа тянутся как раньше и у тех, что попали в город, — иначе сдвинулась
  // бы раскладка всего остального чанка.
  const rocks = 6 + Math.floor(random() * 7);
  for (let i = 0; i < rocks; i++) {
    const width = 1.5 + random() * 4;
    const height = 1 + random() * 3.5;
    const depth = 1.5 + random() * 4;
    const x = originX + (random() - 0.5) * (CHUNK_SIZE - width - 4);
    const z = originZ + (random() - 0.5) * (CHUNK_SIZE - depth - 4);
    if (insideTown(x, z, TOWN_CLEARANCE + Math.max(width, depth) / 2)) continue;
    boxes.push({ kind: 'rock', box: boxFromCenter(x, height / 2, z, width, height, depth) });
  }

  /**
   * Стволы деревьев и валуны из растительности.
   *
   * Сами растения рисует клиент (client/src/nature.ts), но раскладка общая,
   * поэтому телесность им можно дать прямо здесь — невидимыми коробками.
   * Иначе лес был бы нарисован на стекле: деревья видно, а пройти сквозь них
   * можно насквозь.
   */
  for (const plant of generateNature(cx, cz)) {
    if (plant.solid <= 0) continue;
    const width = plant.solid * 2 * plant.scale;
    boxes.push({
      kind: 'rock',
      hidden: true,
      box: boxFromCenter(plant.x, 1.2, plant.z, width, 2.4, width),
    });
  }

  /**
   * Ресурсные ноды — то же самое: вид на клиенте, телесность здесь.
   *
   * Телесны только крупные: дерево, жила, осыпь, глиняный выход. Травы и куст
   * сквозные — упираться в то, что срезают ножом, было бы издевательством.
   *
   * Коробка не исчезает у истощённой ноды: пень и выработанная жила никуда
   * не деваются, да и зависеть столкновения от состояния сервера не должны —
   * иначе клиент предсказывал бы движение по другой геометрии.
   */
  for (const node of generateNodes(cx, cz)) {
    const profile = NODES[node.nodeId];
    if (profile.solid <= 0) continue;
    const width = profile.solid * 2 * node.scale;
    boxes.push({
      kind: 'rock',
      hidden: true,
      box: boxFromCenter(node.x, profile.height / 2, node.z, width, profile.height, width),
    });
  }

  // Руины: в трети чанков — обломок стены, будущая точка интереса.
  if (random() < 0.35) {
    const length = 8 + random() * 12;
    const along = random() < 0.5;
    const rx = originX + (random() - 0.5) * 30;
    const rz = originZ + (random() - 0.5) * 30;
    if (!insideTown(rx, rz, TOWN_CLEARANCE + length)) boxes.push({
      kind: 'ruin',
      box: boxFromCenter(rx, 1.6, rz, along ? length : 1, 3.2, along ? 1 : length),
    });
    if (!insideTown(rx, rz, TOWN_CLEARANCE + length)) boxes.push({
      kind: 'ruin',
      box: boxFromCenter(
        rx + (along ? length / 2 : 0),
        1.1,
        rz + (along ? 0 : length / 2),
        1.4,
        2.2,
        1.4,
      ),
    });
  }

  // Край мира: глухая стена, чтобы игрок не улетел в пустоту.
  const edgeHeight = 8;
  if (cx === WORLD_CHUNK_RADIUS) {
    boxes.push({ kind: 'wall', box: boxFromCenter(originX + CHUNK_SIZE / 2, edgeHeight / 2, originZ, 1, edgeHeight, CHUNK_SIZE) });
  }
  if (cx === -WORLD_CHUNK_RADIUS) {
    boxes.push({ kind: 'wall', box: boxFromCenter(originX - CHUNK_SIZE / 2, edgeHeight / 2, originZ, 1, edgeHeight, CHUNK_SIZE) });
  }
  if (cz === WORLD_CHUNK_RADIUS) {
    boxes.push({ kind: 'wall', box: boxFromCenter(originX, edgeHeight / 2, originZ + CHUNK_SIZE / 2, CHUNK_SIZE, edgeHeight, 1) });
  }
  if (cz === -WORLD_CHUNK_RADIUS) {
    boxes.push({ kind: 'wall', box: boxFromCenter(originX, edgeHeight / 2, originZ - CHUNK_SIZE / 2, CHUNK_SIZE, edgeHeight, 1) });
  }

  return boxes;
}

/**
 * Кэш чанков с выдачей коллизий вокруг точки.
 * Одна и та же реализация работает и на сервере, и в предсказании клиента —
 * иначе физика разошлась бы на границах чанков.
 */
/**
 * Откуда берётся содержимое чанка.
 *
 * Подземелье — это тот же мир с другим `instanceId` и другой землёй под
 * ногами. Раньше генератор был вшит намертво, и у любого инстанса получались
 * одни и те же дикие земли; теперь источник подставляется снаружи, а всё
 * остальное — кэш, коллизии, поток чанков — работает как работало.
 */
export type ChunkSource = (cx: number, cz: number) => LevelBox[];

export class ChunkedWorld {
  private readonly chunks = new Map<string, LevelBox[]>();
  /** Кэш массива коллизий для последнего запрошенного набора чанков. */
  private lastKey = '';
  private lastColliders: Aabb[] = [];

  constructor(private readonly source: ChunkSource = generateChunk) {}

  getChunk(cx: number, cz: number): LevelBox[] {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = this.source(cx, cz);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Коллизии чанка под точкой и всех соседних — этого хватает любому шагу. */
  collidersAt(x: number, z: number): readonly Aabb[] {
    const { cx, cz } = worldToChunk(x, z);
    const key = chunkKey(cx, cz);
    if (key === this.lastKey) return this.lastColliders;

    const colliders: Aabb[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const entry of this.getChunk(cx + dx, cz + dz)) {
          // Декоративные коробки в столкновениях не участвуют.
          if (entry.noCollide) continue;
          colliders.push(entry.box);
        }
      }
    }

    this.lastKey = key;
    this.lastColliders = colliders;
    return colliders;
  }

  /** Координаты чанков, которые должны быть загружены вокруг точки. */
  /**
   * Какие чанки держать загруженными вокруг точки.
   *
   * Никаких правил о границах здесь нет и быть не может: где земля кончается,
   * знает **источник**, а не поток. Однажды тут стояла проверка `isInsideWorld`
   * — правило обычного мира, — и подземелье, уехавшее за его край, осталось
   * без единого чанка: ни пола, ни стен. Игрок падал в пустоту и видел небо,
   * а выглядело это как «инстанса вообще нет».
   *
   * Пустой чанк обходится в пустую группу и ничего не стоит.
   */
  static chunksAround(x: number, z: number, radius = CHUNK_LOAD_RADIUS): ChunkCoord[] {
    const { cx, cz } = worldToChunk(x, z);
    const result: ChunkCoord[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        result.push({ cx: cx + dx, cz: cz + dz });
      }
    }
    return result;
  }
}
