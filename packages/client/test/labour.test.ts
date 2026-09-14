import { describe, expect, it } from 'vitest';
import { createLabour, labourForWork } from '../src/labour.js';
import type { SoundId } from '../src/sound.js';

/**
 * Работа звучит ударами, пока идёт полоса. Проверяется ритм и главное
 * обещание: чужой сундук слышно.
 */

const FRAME = 1 / 60;

function listen() {
  const heard: { id: SoundId; placed: boolean }[] = [];
  const labour = createLabour({ play: (id, at) => heard.push({ id, placed: at !== undefined }) });
  return { labour, heard };
}

describe('звук работы', () => {
  it('первый удар сразу, дальше ритмом, и замолкает с концом работы', () => {
    const { labour, heard } = listen();
    labour.begin('chop');
    expect(heard).toHaveLength(1);

    for (let t = 0; t < 2; t += FRAME) labour.tick(FRAME, []);
    const during = heard.length;
    expect(during).toBeGreaterThan(1);

    labour.end();
    for (let t = 0; t < 2; t += FRAME) labour.tick(FRAME, []);
    expect(heard).toHaveLength(during);
  });

  it('повторное сообщение о той же работе не бьёт лишний раз', () => {
    const { labour, heard } = listen();
    labour.begin('mine');
    labour.begin('mine');
    expect(heard).toHaveLength(1);
  });

  it('чужой сундук слышно — из того места, где его вскрывают', () => {
    const { labour, heard } = listen();
    labour.tick(FRAME, [{ id: 'p2', x: 3, y: 0, z: 0, work: 'chest' }]);
    expect(heard).toEqual([{ id: 'lockpick', placed: true }]);
  });

  it('сундук узнаётся по имени', () => {
    expect(labourForWork('chest.0.3')).toBe('lockpick');
  });
});
