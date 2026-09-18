import { describe, expect, it } from 'vitest';
import { advanceAction, beginAction, HOLD_LIMIT, LIGHT_ATTACK, releaseAction } from '../src/combat.js';

/** Лук: замах полторы секунды с удержанием на секунде. */
const BOW = { windup: 1.5, active: 0.1, recovery: 0.4, hold: 1.0 };

function tick(state: ReturnType<typeof beginAction>, seconds: number, step = 0.05) {
  let current: ReturnType<typeof beginAction> | null = state;
  for (let t = 0; t < seconds - 1e-9 && current; t += step) current = advanceAction(current, BOW, step);
  return current;
}

describe('удержание лука', () => {
  it('замах стоит на точке удержания, пока кнопку не отпустили', () => {
    const start = { ...beginAction(LIGHT_ATTACK, undefined, 1, BOW), remaining: BOW.windup };
    const held = tick(start, 3);
    expect(held?.phase).toBe('windup');
    expect(held?.remaining).toBeCloseTo(BOW.windup - BOW.hold, 5);
  });

  it('после отпускания стрела сходит через остаток замаха', () => {
    const start = { ...beginAction(LIGHT_ATTACK, undefined, 1, BOW), remaining: BOW.windup };
    const held = tick(start, 2)!;
    const released = tick(releaseAction(held), 0.55);
    expect(released?.phase).toBe('active');
  });

  it('удержание отпускается само по пределу', () => {
    const start = { ...beginAction(LIGHT_ATTACK, undefined, 1, BOW), remaining: BOW.windup };
    const done = tick(start, BOW.hold + HOLD_LIMIT + 1);
    expect(done === null || done.phase !== 'windup').toBe(true);
  });
});
