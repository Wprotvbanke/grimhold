import { describe, expect, it } from 'vitest';
import { segmentHitsAabb } from '@grimhold/shared';

/**
 * Видно ли одно из другого.
 *
 * Проверкой пользуется облачко реплик: плоский DOM поверх кадра не знает
 * глубины сцены, и без неё дворф кричал на весь город сквозь три дома.
 */
const HOUSE = { minX: -2, maxX: 2, minY: 0, maxY: 6, minZ: -2, maxZ: 2 };

describe('отрезок и коробка', () => {
  it('стена между собеседниками закрывает вид', () => {
    const hit = segmentHitsAabb({ x: -10, y: 1.7, z: 0 }, { x: 10, y: 1.7, z: 0 }, HOUSE);
    expect(hit).toBe(true);
  });

  it('мимо дома видно', () => {
    const hit = segmentHitsAabb({ x: -10, y: 1.7, z: 8 }, { x: 10, y: 1.7, z: 8 }, HOUSE);
    expect(hit).toBe(false);
  });

  it('поверх крыши тоже видно', () => {
    const hit = segmentHitsAabb({ x: -10, y: 9, z: 0 }, { x: 10, y: 9, z: 0 }, HOUSE);
    expect(hit).toBe(false);
  });

  it('отрезок, кончающийся до стены, её не задевает', () => {
    // Иначе облачко пряталось бы за домом, который стоит за спиной говорящего.
    const hit = segmentHitsAabb({ x: -10, y: 1.7, z: 0 }, { x: -6, y: 1.7, z: 0 }, HOUSE);
    expect(hit).toBe(false);
  });
});
