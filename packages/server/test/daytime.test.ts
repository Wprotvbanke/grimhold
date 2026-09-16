import { describe, expect, it } from 'vitest';
import { TICK_RATE, timeOfDay } from '@grimhold/shared';
import { World } from '../src/world.js';

/**
 * Перевод стрелок попадает туда, куда просили, **сколько бы раз его
 * ни повторяли**.
 *
 * Первый перевод работал всегда, а второй промахивался на величину прежнего
 * сдвига: «полдень» давал то утро, то вечер. Нашлось это не в бою, а когда
 * снимок неба несколько раз подряд переводил часы и получал не то время.
 */
describe('перевод стрелок', () => {
  const now = (world: World) => timeOfDay(world.tick, TICK_RATE, world.daytimeShift);

  it('ставит заданное время', () => {
    const world = new World();
    world.setDaytime(0.5);
    expect(now(world)).toBeCloseTo(0.5, 3);
  });

  it('и попадает так же со второго и третьего раза', () => {
    const world = new World();
    world.setDaytime(0.75);
    world.setDaytime(0.25);
    expect(now(world)).toBeCloseTo(0.25, 3);

    world.setDaytime(0);
    expect(now(world)).toBeCloseTo(0, 3);
  });
});
