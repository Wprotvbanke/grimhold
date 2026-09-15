import { describe, expect, it } from 'vitest';
import { aabbOverlap, dungeonInstance, playerAabb } from '@grimhold/shared';
import { World } from '../src/world.js';

/**
 * Обитатель не должен стоять в камне.
 *
 * Проверка базового поведения, а не чисел: место под спавн ищется вслепую
 * случайными бросками, и стоит перекрытию оказаться сильнее, чем найдётся
 * свободное место, как моб встаёт в стену. Заметить это глазами можно
 * только случайно — а тут видно сразу и на многих зёрнах.
 */
describe('спавн обитателей', () => {
  it('ни один обитатель подземелья не стоит в камне', () => {
    for (const seed of [1, 7, 2024, 31337, 90210]) {
      const world = new World();
      const instanceId = dungeonInstance(seed);
      world.populateDungeon(instanceId);
      for (const mob of world.mobs.get(instanceId) ?? []) {
        const body = playerAabb(mob.pos, { radius: mob.profile.radius, height: mob.profile.height });
        const stuck = world
          .collidersAt(instanceId, mob.pos.x, mob.pos.z)
          .find((box) => box.maxY > 0.05 && aabbOverlap(body, box));
        expect(stuck, `${mob.profile.id} в камне на зерне ${seed}: ${mob.pos.x.toFixed(1)}, ${mob.pos.z.toFixed(1)}`).toBeUndefined();
      }
    }
  });
});
