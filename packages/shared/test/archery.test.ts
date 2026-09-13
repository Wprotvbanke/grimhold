import { describe, expect, it } from 'vitest';
import {
  ARROW_FAR_SCALE,
  ARROW_FULL_RANGE,
  AOI_RADIUS,
  BOW_RANGE,
  arrowFalloff,
} from '../src/index.js';

/**
 * Стрельба из лука.
 *
 * Главное правило здесь не про урон, а про сеть: дальность выстрела обязана
 * оставаться **внутри радиуса интереса**. Стрелять дальше — значит стрелять
 * в того, кого сервер тебе не присылает.
 */

describe('дальность лука', () => {
  it('не доходит до границы видимости', () => {
    // С запасом: цель должна быть видна раньше, чем войдёт в дальность.
    expect(BOW_RANGE).toBeLessThan(AOI_RADIUS - 5);
  });
});

describe('урон стрелы падает с расстоянием', () => {
  it('вблизи бьёт в полную силу', () => {
    expect(arrowFalloff(0)).toBe(1);
    expect(arrowFalloff(ARROW_FULL_RANGE)).toBe(1);
  });

  it('на пределе — доля от полного', () => {
    expect(arrowFalloff(BOW_RANGE)).toBeCloseTo(ARROW_FAR_SCALE, 5);
  });

  it('и спадает ровно, без ступеней', () => {
    const middle = arrowFalloff((ARROW_FULL_RANGE + BOW_RANGE) / 2);
    expect(middle).toBeLessThan(1);
    expect(middle).toBeGreaterThan(ARROW_FAR_SCALE);
  });

  it('за пределом дальности ниже не падает', () => {
    // Снаряд туда и не долетит, но формула не должна уходить в минус.
    expect(arrowFalloff(BOW_RANGE * 3)).toBeCloseTo(ARROW_FAR_SCALE, 5);
  });
});
