import { describe, expect, it } from 'vitest';
import type { EntitySnapshot, ProjectileSnapshot } from '@grimhold/shared';
import { createCues } from '../src/cues.js';
import type { SoundId } from '../src/sound.js';

/**
 * Звук тестом не услышать — проверяется только то, что легко сломать:
 * одно событие звучит **один раз**, сколько бы снапшотов его ни повторяли.
 */

function listen() {
  const played: SoundId[] = [];
  const cues = createCues({ play: (id) => played.push(id) });
  return { cues, played };
}

function entity(id: string, phase?: EntitySnapshot['phase']): EntitySnapshot {
  return { id, x: 0, y: 0, z: 0, yaw: 0, hp: 1, alive: true, phase };
}

function arrow(id: string, spellId?: ProjectileSnapshot['spellId']): ProjectileSnapshot {
  return { id, x: 0, y: 0, z: 0, spellId };
}

describe('звуки боя', () => {
  it('замах звучит один раз, хотя снапшоты повторяют его', () => {
    const { cues, played } = listen();
    for (let tick = 0; tick < 5; tick++) cues.entities([entity('m1', 'windup')], 'me');
    expect(played).toEqual(['swing']);
  });

  it('следующий замах звучит снова', () => {
    const { cues, played } = listen();
    cues.entities([entity('m1', 'windup')], 'me');
    cues.entities([entity('m1')], 'me');
    cues.entities([entity('m1', 'windup')], 'me');
    expect(played).toEqual(['swing', 'swing']);
  });

  it('свой замах из снапшота не звучит — он уже прозвучал по нажатию', () => {
    const { cues, played } = listen();
    cues.entities([entity('me', 'windup')], 'me');
    expect(played).toEqual([]);
  });

  it('с луком удар звучит тетивой, а не взмахом', () => {
    const { cues, played } = listen();
    cues.ownAction('attack', true);
    expect(played).toEqual([]);

    cues.projectiles([arrow('a1')]);
    cues.projectiles([arrow('a1')]);
    expect(played).toEqual(['bow']);
  });

  it('сгусток заклинания тетивой не звенит', () => {
    const { cues, played } = listen();
    cues.projectiles([arrow('s1', 'ember')]);
    expect(played).toEqual([]);
  });
});
