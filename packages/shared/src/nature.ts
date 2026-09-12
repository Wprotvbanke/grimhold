/**
 * Растительность диких земель.
 *
 * Раскладка считается **здесь**, а не на клиенте, ровно по той же причине,
 * по которой здесь лежат коробки уровня: у дерева есть ствол, в который
 * упираются. Разъедься картинка и столкновения — игрок обходил бы пустоту
 * и застревал в воздухе.
 *
 * Генератор детерминированный: одни и те же координаты чанка всегда дают
 * один и тот же лес — и на сервере, и на клиенте, и после перезапуска.
 *
 * Подробности и правила расстановки — docs/nature.md.
 */

import { CHUNK_SIZE, chunkCenter, isInsideWorld } from './chunks.js';
import { TOWN_SIZE } from './level.js';

/** Что можно поставить. Имена — узлы в `public/models/nature.glb`. */
export type PlantId =
  | 'commontree_1' | 'commontree_2' | 'commontree_3' | 'commontree_4' | 'commontree_5'
  | 'pine_1' | 'pine_2' | 'pine_3' | 'pine_4' | 'pine_5'
  | 'deadtree_1' | 'deadtree_2' | 'deadtree_3' | 'deadtree_4' | 'deadtree_5'
  | 'twistedtree_1' | 'twistedtree_2' | 'twistedtree_3' | 'twistedtree_4' | 'twistedtree_5'
  | 'bush_common' | 'bush_common_flowers'
  | 'plant_1' | 'plant_1_big' | 'plant_7' | 'plant_7_big' | 'fern_1'
  | 'grass_common_short' | 'grass_common_tall' | 'grass_wispy_short' | 'grass_wispy_tall'
  | 'clover_1' | 'clover_2'
  | 'flower_3_group' | 'flower_3_single' | 'flower_4_group' | 'flower_4_single'
  | 'petal_1' | 'petal_2' | 'petal_3' | 'petal_4' | 'petal_5'
  | 'mushroom_common' | 'mushroom_laetiporus'
  | 'rock_medium_1' | 'rock_medium_2' | 'rock_medium_3'
  | 'pebble_round_1' | 'pebble_round_2' | 'pebble_round_3' | 'pebble_round_4' | 'pebble_round_5'
  | 'pebble_square_1' | 'pebble_square_2' | 'pebble_square_3'
  | 'rockpath_round_small_1' | 'rockpath_round_small_2' | 'rockpath_round_wide'
  | 'rockpath_square_small_1' | 'rockpath_square_small_2' | 'rockpath_square_wide';

export interface Plant {
  id: PlantId;
  x: number;
  z: number;
  /** Поворот вокруг вертикали, радианы: одинаково стоящий лес выглядит обоями. */
  yaw: number;
  /** Множитель размера: одинаковые деревья видно сразу. */
  scale: number;
  /**
   * Радиус ствола для столкновений. Ноль — сквозное: трава, цветы, мелочь.
   *
   * Телесность есть только у стволов и валунов. Упираться в папоротник —
   * худшее, что можно сделать с лесом: игрок теряет управление там, где
   * ничего не должно мешать.
   */
  solid: number;
  /**
   * Отбрасывает ли тень.
   *
   * Только крупное. Тень от травинки на экране не видна, а карту теней
   * пересчитывают каждый кадр и платят за неё полной ценой.
   */
  shadow: boolean;
}

/**
 * Ярусы леса.
 *
 * Красота дикого места держится на трёх вещах: крупные силуэты задают
 * рисунок, средний ярус прячет стык земли со стволом, мелочь убивает
 * «пустой пол». Все три обязаны быть — без мелочи лес выглядит декорацией,
 * без крупного — пустырём.
 */
interface Layer {
  /** Сколько штук на чанк: от и до. */
  min: number;
  max: number;
  /** Из чего выбирать. */
  pick: PlantId[];
  /**
   * Сколько видов из этого списка попадёт в один чанк.
   *
   * Не для красоты, а ради кадра: клиент рисует растения пачками, по вызову
   * отрисовки на вид. Брать всю россыпь целиком значило под сорок вызовов
   * на чанк и триста пятьдесят на девять загруженных. Три вида на ярус
   * в пределах одной поляны глаз и не отличит, а разнообразие остаётся —
   * просто оно между чанками, а не внутри.
   */
  variety: number;
  scale: [number, number];
  solid: number;
  shadow: boolean;
}

/**
 * Рощи по видам, а не вперемешку.
 *
 * Чанк получает свой характер: сосняк, сухостой, кривой лес. Это и рисунок
 * даёт, и работает как ориентир — по виду леса понятно, где ты.
 */
const GROVES: PlantId[][] = [
  ['commontree_1', 'commontree_2', 'commontree_3', 'commontree_4', 'commontree_5'],
  ['pine_1', 'pine_2', 'pine_3', 'pine_4', 'pine_5'],
  ['deadtree_1', 'deadtree_2', 'deadtree_3', 'deadtree_4', 'deadtree_5'],
  ['twistedtree_1', 'twistedtree_2', 'twistedtree_3', 'twistedtree_4', 'twistedtree_5'],
];

const UNDERGROWTH: Layer = {
  min: 10,
  max: 18,
  pick: ['bush_common', 'bush_common_flowers', 'plant_1_big', 'plant_7_big', 'fern_1'],
  variety: 3,
  scale: [0.8, 1.4],
  solid: 0,
  shadow: true,
};

const GROUND: Layer = {
  min: 44,
  max: 70,
  pick: [
    'grass_common_short',
    'grass_common_tall',
    'grass_wispy_short',
    'grass_wispy_tall',
    'clover_1',
    'clover_2',
    'plant_1',
    'plant_7',
  ],
  variety: 3,
  scale: [0.7, 1.5],
  solid: 0,
  shadow: false,
};

const DETAIL: Layer = {
  min: 14,
  max: 24,
  pick: [
    'flower_3_group',
    'flower_3_single',
    'flower_4_group',
    'flower_4_single',
    'petal_1',
    'petal_2',
    'petal_3',
    'petal_4',
    'petal_5',
    'mushroom_common',
    'mushroom_laetiporus',
    'pebble_round_1',
    'pebble_round_2',
    'pebble_round_3',
    'pebble_round_4',
    'pebble_round_5',
    'pebble_square_1',
    'pebble_square_2',
    'pebble_square_3',
  ],
  variety: 4,
  scale: [0.7, 1.3],
  solid: 0,
  shadow: false,
};

const STONES: Layer = {
  min: 2,
  max: 5,
  pick: ['rock_medium_1', 'rock_medium_2', 'rock_medium_3'],
  variety: 2,
  scale: [0.5, 1.1],
  solid: 0.7,
  shadow: true,
};

/**
 * Плиты тропы у городских ворот: вытоптанная дорожка вместо голой земли.
 *
 * Только мелкие. Широкие плиты в этом паке — это целые куски мостовой по две
 * и три тысячи треугольников, и четыре дорожки из них стоили под семьдесят
 * тысяч на ровном месте, лёжа при этом под ногами.
 */
const PATH: PlantId[] = [
  'rockpath_round_small_1',
  'rockpath_round_small_2',
  'rockpath_square_small_1',
  'rockpath_square_small_2',
];

/** Свой генератор со своим зерном: лес не должен сдвигаться от правок камней. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ствол дерева — единственное, во что в лесу упираются. */
const TRUNK_RADIUS = 0.45;

/**
 * Растительность чанка.
 *
 * В городском чанке (0,0) её нет: там мостовая и постройки, а трава,
 * растущая сквозь камень, выглядит ошибкой. Тропу за воротами ставим
 * отдельно — см. `townEdgePath`.
 */
export function generateNature(cx: number, cz: number): Plant[] {
  if (!isInsideWorld(cx, cz)) return [];
  if (cx === 0 && cz === 0) return townEdgePath();

  const random = mulberry32(Math.imul(cx + 0x51ed, 0x27d4eb2f) ^ Math.imul(cz + 0x2f19, 0x165667b1));
  const { x: originX, z: originZ } = chunkCenter(cx, cz);
  const plants: Plant[] = [];

  const spread = CHUNK_SIZE / 2 - 2;
  const at = (): { x: number; z: number } => ({
    x: originX + (random() * 2 - 1) * spread,
    z: originZ + (random() * 2 - 1) * spread,
  });

  const put = (id: PlantId, scale: [number, number], solid: number, shadow: boolean): void => {
    const { x, z } = at();
    plants.push({
      id,
      x,
      z,
      yaw: random() * Math.PI * 2,
      scale: scale[0] + random() * (scale[1] - scale[0]),
      solid,
      shadow,
    });
  };

  /**
   * Отбор видов на этот чанк.
   *
   * Берём из списка сколько сказано, без повторов. Вид, выпавший чанку,
   * встретится в нём много раз — и это ровно то, что нужно: чем меньше разных
   * видов на поляне, тем меньше пачек и тем дешевле кадр.
   */
  const choose = (from: readonly PlantId[], howMany: number): PlantId[] => {
    const rest = [...from];
    const taken: PlantId[] = [];
    for (let i = 0; i < howMany && rest.length > 0; i++) {
      taken.push(rest.splice(Math.floor(random() * rest.length), 1)[0]!);
    }
    return taken;
  };

  // Деревья: своя роща на чанк, плотность тоже своя — от редколесья до чащи.
  // Верхнюю границу держим в узде: дерево тут самое дорогое, что есть,
  // и чаща из двух десятков разом съедала кадр.
  const grove = choose(GROVES[Math.floor(random() * GROVES.length)]!, 3);
  const trees = 4 + Math.floor(random() * 9);
  for (let i = 0; i < trees; i++) {
    put(grove[Math.floor(random() * grove.length)]!, [0.55, 1.05], TRUNK_RADIUS, true);
  }

  for (const layer of [UNDERGROWTH, GROUND, DETAIL, STONES]) {
    const kinds = choose(layer.pick, layer.variety);
    const count = layer.min + Math.floor(random() * (layer.max - layer.min + 1));
    for (let i = 0; i < count; i++) {
      put(kinds[Math.floor(random() * kinds.length)]!, layer.scale, layer.solid, layer.shadow);
    }
  }

  return plants;
}

/**
 * Тропинки за воротами города.
 *
 * Чистая декорация и единственная растительность в городском чанке: плиты
 * лежат в проёмах стен, чтобы выход в дикие земли не начинался с обрыва
 * мостовой в голую землю.
 */
function townEdgePath(): Plant[] {
  const random = mulberry32(0x6f61d);
  const plants: Plant[] = [];
  const edge = TOWN_SIZE / 2;

  for (const [dx, dz] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    for (let step = 0; step < 8; step++) {
      const along = edge + 1.5 + step * 1.4;
      const jitter = (random() - 0.5) * 2.2;
      plants.push({
        id: PATH[Math.floor(random() * PATH.length)]!,
        x: dx * along + dz * jitter,
        z: dz * along + dx * jitter,
        yaw: random() * Math.PI * 2,
        scale: 0.9 + random() * 0.5,
        solid: 0,
        shadow: false,
      });
    }
  }

  return plants;
}
