import { describe, expect, it } from 'vitest';
import { MOBS } from '@grimhold/shared';
import { alertMob, createMob, decideMob } from '../src/mob.js';

/**
 * Зверь узнаёт, что его ударили.
 *
 * До этого стрела с дальней дистанции не значила для него ничего: цели он
 * ищет сам и только в пределах зрения — и стоял столбом, пока его
 * расстреливают. Реакция зависит от **тяжести попадания**, а не от того, чем
 * ударили: слабому одна стрела стоит половины жизни, сильному — десятой части.
 */

const HOME = { x: 0, y: 0, z: 0 };
const DT = 0.05;

/** Точка, откуда стреляли: далеко за пределами зрения. */
const SHOOTER = { x: 0, y: 0, z: 30 };

/** Куда зверь на самом деле шагнёт. При forward = 1 это (−sin yaw, −cos yaw). */
function heading(input: { forward: number; yaw: number }): { x: number; z: number } {
  return { x: -Math.sin(input.yaw) * input.forward, z: -Math.cos(input.yaw) * input.forward };
}

describe('реакция на удар издалека', () => {
  it('тяжёлое попадание гонит прочь от выстрела', () => {
    const mob = createMob('m1', 'rat', HOME, 'overworld');
    alertMob(mob, 'p1', SHOOTER, MOBS.rat.health);

    const decision = decideMob(mob, [], DT);
    expect(mob.phase).toBe('flee');
    // Стреляли с +Z — значит бежать надо в −Z, прочь от выстрела.
    expect(heading(decision.input).z).toBeLessThan(0);
  });

  it('лёгкое — наоборот, на обидчика', () => {
    const mob = createMob('m2', 'wight', HOME, 'overworld');
    alertMob(mob, 'p1', SHOOTER, MOBS.wight.health * 0.05);

    expect(mob.phase).toBe('chase');
    expect(mob.targetId).toBe('p1');
  });

  it('и догоняет даже того, кого не видит', () => {
    /**
     * Главное в ярости: обычная проверка «цель дальше поля зрения — забыть»
     * не даёт догнать стрелка с сорока метров. Он просто вне зрения.
     */
    const mob = createMob('m3', 'wight', HOME, 'overworld');
    alertMob(mob, 'p1', SHOOTER, 1);

    const far = [{ id: 'p1', pos: SHOOTER, alive: true }];
    const decision = decideMob(mob, far, DT);

    expect(mob.phase).toBe('chase');
    // Идёт на стрелка: тот стоял в +Z.
    expect(heading(decision.input).z).toBeGreaterThan(0);
  });

  it('а без цели идёт туда, откуда прилетело', () => {
    // Стрелок скрылся: зверь приходит на место выстрела и осматривается.
    const mob = createMob('m4', 'wight', HOME, 'overworld');
    alertMob(mob, 'ушёл', SHOOTER, 1);

    const decision = decideMob(mob, [], DT);
    expect(mob.phase).toBe('chase');
    expect(heading(decision.input).z).toBeGreaterThan(0);
  });

  it('мёртвому уже всё равно', () => {
    const mob = createMob('m5', 'rat', HOME, 'overworld');
    mob.alive = false;
    alertMob(mob, 'p1', SHOOTER, 999);

    expect(mob.phase).not.toBe('flee');
  });
});
