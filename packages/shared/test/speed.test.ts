import { describe, expect, it } from 'vitest';
import {
  BLOCK_SPEED_SCALE,
  DODGE_COOLDOWN,
  DODGE_SPEED_SCALE,
  SPRINT_SPEED_SCALE,
  attributesFor,
  canDashAtWeight,
  carryCapacity,
  movementSpeedFactor,
  weightSpeedFactor,
  type SpeedModifiers,
} from '../src/index.js';

/**
 * Множитель скорости движения.
 *
 * Эту формулу считают обе стороны: сервер по авторитетному состоянию, клиент
 * по своему намерению. Пока раскладка модификаторов совпадает, предсказание
 * сходится; расхождение здесь означает, что игрока будет дёргать назад при
 * каждом поднятом щите. Поэтому правила закреплены тестами.
 */

const NEUTRAL: SpeedModifiers = {
  blocking: false,
  dashing: false,
  gliding: false,
  sprinting: false,
  acting: false,
  slowFactor: 1,
  weightFactor: 1,
};

describe('множитель скорости', () => {
  it('в покое равен единице', () => {
    expect(movementSpeedFactor(NEUTRAL)).toBe(1);
  });

  it('бег ускоряет', () => {
    expect(movementSpeedFactor({ ...NEUTRAL, sprinting: true })).toBeCloseTo(
      SPRINT_SPEED_SCALE,
      5,
    );
  });

  it('щит замедляет', () => {
    expect(movementSpeedFactor({ ...NEUTRAL, blocking: true })).toBeCloseTo(
      BLOCK_SPEED_SCALE,
      5,
    );
  });

  it('со щитом не побежать', () => {
    // Иначе бег отменял бы цену защиты, а щит перестал бы быть выбором.
    const shielded = movementSpeedFactor({ ...NEUTRAL, blocking: true, sprinting: true });
    expect(shielded).toBeCloseTo(BLOCK_SPEED_SCALE, 5);
  });

  it('рывок перебивает всё остальное', () => {
    const dashing = movementSpeedFactor({
      ...NEUTRAL,
      dashing: true,
      blocking: true,
      acting: true,
    });
    expect(dashing).toBeCloseTo(DODGE_SPEED_SCALE, 5);
  });

  it('замах сковывает', () => {
    const acting = movementSpeedFactor({ ...NEUTRAL, acting: true });
    expect(acting).toBeLessThan(0.5);
    expect(acting).toBeGreaterThan(0);
  });

  it('бежать во время замаха нельзя', () => {
    const both = movementSpeedFactor({ ...NEUTRAL, acting: true, sprinting: true });
    const justActing = movementSpeedFactor({ ...NEUTRAL, acting: true });
    // Бег ускорил бы, но замах всё равно применяется поверх — итог медленнее шага.
    expect(both).toBeLessThan(SPRINT_SPEED_SCALE);
    expect(both).toBeGreaterThan(justActing);
  });

  it('перегруз и стужа складываются с остальным', () => {
    const burdened = movementSpeedFactor({ ...NEUTRAL, weightFactor: 0.5, slowFactor: 0.5 });
    expect(burdened).toBeCloseTo(0.25, 5);
  });

  it('перегруз не отменяется бегом полностью', () => {
    const heavy = movementSpeedFactor({ ...NEUTRAL, weightFactor: 0.3, sprinting: true });
    expect(heavy).toBeLessThan(1);
  });

  it('рывок на перезарядке — это заметная пауза, а не формальность', () => {
    // Полсекунды не чувствуются; полторы заставляют выбирать момент.
    expect(DODGE_COOLDOWN).toBeGreaterThan(1);
  });

  /**
   * Вес обязан быть выбором, а не штрафом. Значит терять надо по порядку:
   * сначала рывок, и только потом скорость. Если рывок пропадёт вместе
   * со скоростью или позже неё, цена жадности снова уедет в дорогу, где её
   * легко перетерпеть, вместо боя, где решение и принимают.
   */
  it('рывок теряется раньше скорости', () => {
    const attributes = attributesFor('human', 'warrior');
    const capacity = carryCapacity(attributes);

    const light = capacity * 0.5;
    expect(canDashAtWeight(attributes, light), 'налегке рывок есть').toBe(true);
    expect(weightSpeedFactor(attributes, light)).toBe(1);

    // Тяжело, но ещё не перегруз: рывка уже нет, скорость ещё цела.
    const heavy = capacity * 0.95;
    expect(canDashAtWeight(attributes, heavy), 'под грузом рывок пропал').toBe(false);
    expect(weightSpeedFactor(attributes, heavy), 'скорость ещё не тронута').toBe(1);

    // И только за пределом начинает падать скорость.
    expect(weightSpeedFactor(attributes, capacity * 1.5)).toBeLessThan(1);
  });
});
