import { describe, expect, it } from 'vitest';
import { createSteps } from '../src/steps.js';
import type { SoundId } from '../src/sound.js';

/**
 * Шаги считаются по расстоянию, а не по таймеру. Проверяется это правило,
 * а не звук: стоящий молчит, бегущий шагает чаще идущего, крупный — реже.
 */

const FRAME = 1 / 60;

function listen() {
  const played: SoundId[] = [];
  const steps = createSteps({ play: (id) => played.push(id) });
  return { steps, played };
}

/** Сколько шагов прозвучит за секунды при такой скорости и таком росте. */
function walk(seconds: number, speed: number, height: number): number {
  const { steps, played } = listen();
  for (let t = 0; t < seconds; t += FRAME) {
    steps.others(FRAME, [{ id: 'w', x: 0, y: 0, z: 0, speed, height }], 'stone');
  }
  return played.length;
}

describe('шаги', () => {
  it('стоящий не шагает', () => {
    const { steps, played } = listen();
    for (let frame = 0; frame < 120; frame++) steps.own(FRAME, 0, true, 1.8, 'stone');
    expect(played).toEqual([]);
  });

  it('в прыжке шагов нет', () => {
    const { steps, played } = listen();
    for (let frame = 0; frame < 120; frame++) steps.own(FRAME, 5, false, 1.8, 'stone');
    expect(played).toEqual([]);
  });

  it('бегущий шагает чаще идущего', () => {
    expect(walk(3, 6, 1.8)).toBeGreaterThan(walk(3, 3, 1.8));
  });

  it('крупный при той же скорости шагает реже', () => {
    expect(walk(3, 4, 2.6)).toBeLessThan(walk(3, 4, 0.9));
  });

  it('поверхность решает звук', () => {
    const { steps, played } = listen();
    for (let frame = 0; frame < 120; frame++) steps.own(FRAME, 4, true, 1.8, 'grass');
    expect(played.length).toBeGreaterThan(0);
    expect(new Set(played)).toEqual(new Set(['stepGrass']));
  });
});
