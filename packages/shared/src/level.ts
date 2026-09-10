import { type Aabb, boxFromCenter } from './math.js';

/**
 * Содержимое стартового города. Отдельный файл, потому что город собран
 * вручную, а дикие земли вокруг генерируются процедурно (см. chunks.ts).
 *
 * Один и тот же список используют сервер (коллизии) и клиент (рендер):
 * расхождение геометрии сразу ломает предсказание, поэтому источник один.
 */

export interface LevelBox {
  kind: 'floor' | 'wall' | 'pillar' | 'platform' | 'rock' | 'ruin';
  box: Aabb;
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

  // Ступени и помост.
  { kind: 'platform', box: boxFromCenter(14, 0.25, -10, 4, 0.5, 4) },
  { kind: 'platform', box: boxFromCenter(14, 0.75, -14, 4, 1.5, 4) },
  { kind: 'platform', box: boxFromCenter(14, 1.25, -18, 4, 2.5, 4) },
];

export const SPAWN_POINT = { x: 0, y: 0.1, z: 10 };

/**
 * Совместимость с ранним кодом и тестами: полный список коллизий города.
 * Игровой код должен ходить через ChunkedWorld, который знает и дикие земли.
 */
export const TEST_LEVEL: readonly LevelBox[] = TOWN_BOXES;
export const TEST_LEVEL_COLLIDERS: readonly Aabb[] = TOWN_BOXES.map((entry) => entry.box);
