import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, DUNGEON_BOSS, dungeonInstance, floorCenter } from '@grimhold/shared';
import { World } from '../src/world.js';
import { decideMob, type Mob, type MobTarget } from '../src/mob.js';

/**
 * Моб обходит перегородки, а не трётся о них.
 *
 * Проверяется базовое: из соседней комнаты моб **доходит** до цели. Как
 * именно — через какую дверь и сколько раз шагнул вбок — дело его; важно,
 * что стена между ними перестала быть непреодолимой.
 */
const TICK = 0.05;

function chase(seconds: number, world: World, mob: Mob, target: MobTarget): number {
  let closest = Infinity;
  for (let t = 0; t < seconds; t += TICK) {
    const decision = decideMob(mob, [target], TICK, world.mobGuide);
    world.stepMob(mob, decision.input, TICK);
    closest = Math.min(closest, Math.hypot(mob.pos.x - target.pos.x, mob.pos.z - target.pos.z));
  }
  return closest;
}

describe('обход стен', () => {
  it('хозяин глубины доходит до цели в соседней комнате', () => {
    const world = new World();
    const instanceId = dungeonInstance(2024);
    world.populateDungeon(instanceId);

    const boss = (world.mobs.get(instanceId) ?? []).find((mob) => mob.mobId === DUNGEON_BOSS);
    expect(boss, 'босс должен быть в подземелье').toBeDefined();
    if (!boss) return;

    // Цель — в комнате наискось от босса: между ними заведомо есть перегородки.
    const center = floorCenter(0);
    const room = CHUNK_SIZE / 3;
    const away = {
      x: boss.pos.x > center.x ? boss.pos.x - room : boss.pos.x + room,
      y: 0.1,
      z: boss.pos.z > center.z ? boss.pos.z - room : boss.pos.z + room,
    };
    const target: MobTarget = { id: 'p', pos: away, alive: true };

    // Ярость держит его на цели: броски кости на отставание тут только шумят.
    boss.targetId = 'p';
    boss.rageFor = 1000;

    const closest = chase(40, world, boss, target);
    expect(closest, `подошёл только на ${closest.toFixed(1)} м`).toBeLessThan(4);
  });
});
