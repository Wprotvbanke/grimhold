import { describe, expect, it } from 'vitest';
import { CORPSE_SECONDS, MOBS } from '@grimhold/shared';
import { createMob, decideMob, isCorpseVisible, killMob, tickRespawn } from '../src/mob.js';

/**
 * Поведение мобов: жизненный цикл смерти и работа автомата.
 *
 * Отдельно закреплено, что тело не исчезает мгновенно — раньше моб пропадал
 * из снапшота в тот же тик, и игрок не понимал, добил он его или тот убежал.
 */

const HOME = { x: 0, y: 0, z: 0 };
const DT = 1 / 20;

function advance(mob: ReturnType<typeof createMob>, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) tickRespawn(mob, DT);
}

describe('смерть моба', () => {
  it('тело остаётся видимым сразу после смерти', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    killMob(mob);

    expect(mob.alive).toBe(false);
    expect(isCorpseVisible(mob)).toBe(true);
  });

  it('тело видно всё время анимации падения', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    killMob(mob);

    advance(mob, CORPSE_SECONDS * 0.8);
    expect(isCorpseVisible(mob), 'тело исчезло до конца анимации').toBe(true);
  });

  it('тело растворяется после отведённого времени', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    killMob(mob);

    advance(mob, CORPSE_SECONDS + 0.5);
    expect(isCorpseVisible(mob)).toBe(false);
    expect(mob.alive).toBe(false);
  });

  it('моб воскресает дома с полным здоровьем', () => {
    const mob = createMob('m1', 'wolf', { x: 12, y: 0, z: -5 }, 'overworld');
    mob.pos = { x: 40, y: 0, z: 40 };
    mob.vitals.health = 1;
    killMob(mob);

    advance(mob, 50);

    expect(mob.alive).toBe(true);
    expect(mob.vitals.health).toBe(MOBS.wolf.health);
    expect(mob.pos.x).toBeCloseTo(12, 5);
    expect(mob.pos.z).toBeCloseTo(-5, 5);
  });
});

describe('автомат моба', () => {
  it('дремлет, пока никого нет рядом', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    decideMob(mob, [], DT);
    expect(mob.phase).toBe('idle');
    expect(mob.targetId).toBeNull();
  });

  it('замечает игрока в радиусе обнаружения и идёт к нему', () => {
    const mob = createMob('m1', 'wolf', HOME, 'overworld');
    const decision = decideMob(
      mob,
      [{ id: 'p1', pos: { x: 0, y: 0, z: -10 }, alive: true }],
      DT,
    );

    expect(mob.phase).toBe('chase');
    expect(mob.targetId).toBe('p1');
    expect(decision.input.forward).toBe(1);
  });

  it('не замечает того, кто дальше радиуса обнаружения', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    decideMob(mob, [{ id: 'p1', pos: { x: 0, y: 0, z: -40 }, alive: true }], DT);
    expect(mob.targetId).toBeNull();
  });

  it('не гонится за мёртвым', () => {
    const mob = createMob('m1', 'wolf', HOME, 'overworld');
    decideMob(mob, [{ id: 'p1', pos: { x: 0, y: 0, z: -5 }, alive: false }], DT);
    expect(mob.targetId).toBeNull();
  });

  it('замахивается вплотную и бьёт только после замаха', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    const target = [{ id: 'p1', pos: { x: 0, y: 0, z: -1 }, alive: true }];

    // Первый шаг: заметил и подошёл вплотную — начинается замах.
    decideMob(mob, target, DT);
    decideMob(mob, target, DT);
    expect(mob.phase).toBe('attack');
    expect(mob.windupRemaining).toBeGreaterThan(0);

    // Пока идёт замах, удара нет: за это время игрок и уходит.
    let struck = false;
    for (let i = 0; i < 40 && !struck; i++) {
      struck = decideMob(mob, target, DT).strike;
    }
    expect(struck).toBe(true);
  });

  it('возвращается домой, если увели слишком далеко', () => {
    const mob = createMob('m1', 'wolf', HOME, 'overworld');
    mob.pos = { x: 0, y: 0, z: -MOBS.wolf.leash - 5 };

    decideMob(mob, [{ id: 'p1', pos: mob.pos, alive: true }], DT);
    expect(mob.phase).toBe('return');
    expect(mob.targetId).toBeNull();
  });
});
