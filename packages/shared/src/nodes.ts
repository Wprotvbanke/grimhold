import { CHUNK_SIZE, chunkCenter, isInsideWorld } from './chunks.js';
import type { ItemId, ToolKind } from './items.js';

/**
 * Ресурсные ноды: то, что в мире добывают.
 *
 * Раскладка лежит здесь, а не на сервере и не на клиенте, по той же причине,
 * что и растительность: в дерево упираются, по нему бьют, и картинка со
 * столкновениями обязана совпадать. Генератор детерминированный — одни и те же
 * координаты чанка всегда дают одни и те же ноды, и сервер может проверить
 * чужой запрос, ничего не храня.
 *
 * Сервер держит только **исключения**: сколько зарядов осталось у тронутых нод
 * и когда они восстановятся. Нетронутая нода не занимает ни байта.
 *
 * Подробности — docs/nodes.md.
 */

export type NodeId =
  | 'deadfall'
  | 'tree'
  | 'ore_vein'
  | 'stone_pile'
  | 'clay_bank'
  | 'herb_patch'
  | 'fiber_bush';

export interface NodeProfile {
  id: NodeId;
  name: string;
  /**
   * Чем добывают. `null` — голыми руками.
   *
   * Инструмент нужен в руке, а не в рюкзаке: это и есть цена — рука занята
   * киркой, а не мечом. Ради того сетка предметов и заводилась.
   */
  tool: ToolKind | null;
  /** Ярус инструмента: нода не поддаётся тому, что слабее. */
  toolTier: number;
  itemId: ItemId;
  /** Сколько падает за один удар. */
  min: number;
  max: number;
  /** Сколько ударов держит, прежде чем истощиться. */
  charges: number;
  /** Через сколько секунд восстановится после истощения. */
  respawn: number;
  /** Радиус столкновения. Ноль — сквозная: травы и кусты не преграда. */
  solid: number;
  /**
   * Высота коробки столкновений.
   *
   * Низкая у всех, даже у дерева: истощённая нода оседает в пень, а коробка
   * остаётся прежней. Меняться она не может — столкновения считает и клиент
   * в предсказании, и зависеть они от состояния сервера не должны.
   */
  height: number;
  /** Узлы модели в `nature.glb`, из которых выбирается вид. */
  models: string[];
  /**
   * Подкраска модели.
   *
   * Руда, камень и глина рисуются одним и тем же валуном, и различать их
   * приходится цветом — иначе игрок бьёт киркой по глине и не понимает,
   * почему не выходит руда.
   */
  tint: number;
  /**
   * Сколько секунд идёт одна добыча.
   *
   * Добыча — работа, а не нажатие: полоса растёт, и её видно. Раньше ресурс
   * падал в рюкзак мгновенно, а пауза шла молча — со стороны это выглядело
   * как случайный отказ кнопки, а не как труд.
   */
  time: number;
  /** Сколько штук ставить в чанк: от и до. */
  min_per_chunk: number;
  max_per_chunk: number;
}

export const NODES: Record<NodeId, NodeProfile> = {
  /**
   * Сухостой — нулевой ярус добычи и единственный выход из голых рук.
   *
   * Без него круг не размыкался: камень лежал за киркой, кирка — за камнем,
   * а топор и нож упирались в то же самое. Новичок жил на выданном топоре
   * и, потеряв его, не мог сделать новый.
   *
   * Сухое дерево читается само: с живого рубят бревно, с мёртвого ломают
   * ветки. Ради этой ясности сухостой изъят из декоративных рощ — в мире
   * нет ни одного, который нельзя обломать.
   */
  deadfall: {
    id: 'deadfall',
    name: 'Сухостой',
    tool: null,
    toolTier: 0,
    itemId: 'branch',
    min: 1,
    max: 2,
    charges: 3,
    time: 1.0,
    respawn: 120,
    solid: 0.4,
    height: 1.6,
    models: ['deadtree_1', 'deadtree_2', 'deadtree_3', 'deadtree_4', 'deadtree_5'],
    tint: 0xffffff,
    min_per_chunk: 4,
    max_per_chunk: 7,
  },
  tree: {
    id: 'tree',
    name: 'Дерево',
    tool: 'axe',
    toolTier: 1,
    itemId: 'log',
    min: 1,
    max: 2,
    charges: 3,
    time: 2.0,
    respawn: 180,
    solid: 0.5,
    height: 1.6,
    models: ['commontree_1', 'commontree_2', 'commontree_3', 'commontree_4', 'commontree_5'],
    tint: 0xffffff,
    min_per_chunk: 4,
    max_per_chunk: 8,
  },
  ore_vein: {
    id: 'ore_vein',
    name: 'Рудная жила',
    tool: 'pick',
    toolTier: 1,
    itemId: 'ore',
    min: 1,
    max: 2,
    charges: 3,
    time: 2.6,
    respawn: 240,
    solid: 0.6,
    height: 1.6,
    models: ['rock_medium_1'],
    tint: 0x8fa6bd,
    min_per_chunk: 2,
    max_per_chunk: 4,
  },
  /**
   * Камень с осыпи берётся руками: он там уже лежит расколотым, и кирка для
   * этого не нужна. Кирку это не обесценивает — руда остаётся только за ней.
   */
  stone_pile: {
    id: 'stone_pile',
    name: 'Каменная осыпь',
    tool: null,
    toolTier: 0,
    itemId: 'stone',
    min: 1,
    max: 3,
    charges: 4,
    time: 1.4,
    respawn: 120,
    solid: 0.6,
    height: 1.4,
    models: ['rock_medium_3'],
    tint: 0xcfd3d6,
    min_per_chunk: 3,
    max_per_chunk: 5,
  },
  clay_bank: {
    id: 'clay_bank',
    name: 'Глиняный выход',
    tool: null,
    toolTier: 0,
    itemId: 'clay',
    min: 1,
    max: 2,
    charges: 4,
    time: 1.2,
    respawn: 120,
    solid: 0.6,
    height: 1.2,
    models: ['rock_medium_2'],
    tint: 0xc08a5a,
    min_per_chunk: 2,
    max_per_chunk: 3,
  },
  herb_patch: {
    id: 'herb_patch',
    name: 'Травы',
    tool: 'knife',
    toolTier: 1,
    itemId: 'herb',
    min: 1,
    max: 3,
    charges: 2,
    time: 0.8,
    respawn: 90,
    solid: 0,
    height: 0,
    models: ['plant_1_big', 'plant_7_big'],
    tint: 0xd8e0a8,
    min_per_chunk: 4,
    max_per_chunk: 7,
  },
  /**
   * Волокно надирается руками. Нож от этого не лишний: травы — его работа,
   * а без трав нет зелий.
   */
  fiber_bush: {
    id: 'fiber_bush',
    name: 'Волокнистый куст',
    tool: null,
    toolTier: 0,
    itemId: 'plant_fiber',
    min: 2,
    max: 4,
    charges: 3,
    time: 0.9,
    respawn: 90,
    solid: 0,
    height: 0,
    models: ['bush_common_flowers'],
    tint: 0xffffff,
    min_per_chunk: 4,
    max_per_chunk: 7,
  },
};

export interface ResourceNode {
  /** Устойчивое имя вида `cx.cz.номер` — по нему сервер находит ноду заново. */
  id: string;
  nodeId: NodeId;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** Какая из моделей профиля досталась этой ноде. */
  model: string;
}

/** С какого расстояния можно ударить по ноде, метры. */
export const HARVEST_RANGE = 3.2;

/** До какой доли роста оседает истощённая нода: пень, выработка, вытоптанная трава. */
export const DEPLETED_SCALE = 0.3;

/** Своё зерно: правка расстановки камней не должна сдвигать весь лес и ноды. */
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
 * Ноды чанка.
 *
 * В городе их нет: там мостовая, и рубить дрова посреди площади незачем.
 */
export function generateNodes(cx: number, cz: number): ResourceNode[] {
  if (!isInsideWorld(cx, cz)) return [];
  if (cx === 0 && cz === 0) return [];

  const random = mulberry32(Math.imul(cx + 0x1d7f, 0x9e3779b1) ^ Math.imul(cz + 0x53a1, 0x85ebca6b));
  const { x: originX, z: originZ } = chunkCenter(cx, cz);
  const spread = CHUNK_SIZE / 2 - 3;
  const nodes: ResourceNode[] = [];

  for (const profile of Object.values(NODES)) {
    const span = profile.max_per_chunk - profile.min_per_chunk + 1;
    const count = profile.min_per_chunk + Math.floor(random() * span);

    for (let i = 0; i < count; i++) {
      nodes.push({
        id: `${cx}.${cz}.${nodes.length}`,
        nodeId: profile.id,
        x: originX + (random() * 2 - 1) * spread,
        z: originZ + (random() * 2 - 1) * spread,
        yaw: random() * Math.PI * 2,
        scale: 0.85 + random() * 0.35,
        model: profile.models[Math.floor(random() * profile.models.length)]!,
      });
    }
  }

  return nodes;
}

/**
 * Нода по её имени — без перебора всего мира.
 *
 * Сервер получает от клиента только имя, и восстанавливать по нему ноду надо
 * дёшево: из имени читаются координаты чанка, чанк пересобирается генератором,
 * и нода берётся по номеру. Ничего не хранится и ничего не ищется.
 */
export function findNode(id: string): ResourceNode | null {
  const parts = id.split('.');
  if (parts.length !== 3) return null;

  const cx = Number(parts[0]);
  const cz = Number(parts[1]);
  const index = Number(parts[2]);
  if (!Number.isInteger(cx) || !Number.isInteger(cz) || !Number.isInteger(index)) return null;

  return generateNodes(cx, cz)[index] ?? null;
}
