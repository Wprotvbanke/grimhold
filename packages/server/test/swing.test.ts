import { describe, expect, it } from 'vitest';
import {
  ATTACK_COOLDOWN,
  FIST_STAMINA_SCALE,
  LIGHT_ATTACK,
  attributesFor,
  fullVitals,
} from '@grimhold/shared';
import { startAttack } from '../src/combat.js';
import type { Combatant } from '../src/combatant.js';

/**
 * Тяжёлое оружие бьёт реже.
 *
 * Проверяется не ради баланса, а ради **совпадения картинки и правды**:
 * замах топора в кадре растянут ровно на фазы удара, и если сервер оставит
 * фазы кулачными, удар засчитается, пока топор в кадре ещё летит вниз.
 * Владелец увидел это сразу: «удары быстрее анимации».
 */
function fighter(): Combatant {
  const attributes = attributesFor('human', 'warrior');
  return {
    id: 'боец',
    kind: 'player',
    karma: 0,
    purpleFor: 0,
    name: 'боец',
    instanceId: 'overworld',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    radius: 0.35,
    height: 1.8,
    vitals: fullVitals(attributes),
    attributes,
    armor: 0,
    alive: true,
    action: null,
    blocking: false,
    invulnerable: 0,
    sinceStaminaUse: 99,
    exhaustedFor: 0,
    blockSkill: 0,
    evasionSkill: 0,
    riposteFor: 0,
    wardArmor: 0,
    wardRemaining: 0,
    slowFactor: 1,
    slowRemaining: 0,
    lightRemaining: 0,
    dodgeCooldown: 0,
    swingCooldown: 0,
  };
}

describe('темп удара задаёт оружие', () => {
  it('кулаком фазы обычные', () => {
    const fist = fighter();
    expect(startAttack(fist, 'attack')).toBe(true);
    expect(fist.action?.remaining).toBeCloseTo(LIGHT_ATTACK.timing.windup);
    expect(fist.action?.scale).toBeUndefined();
    expect(fist.swingCooldown).toBeCloseTo(
      ATTACK_COOLDOWN + LIGHT_ATTACK.timing.windup + LIGHT_ATTACK.timing.active,
    );
  });

  it('голыми руками удар дешевле', () => {
    const fist = fighter();
    const full = fist.vitals.stamina;
    startAttack(fist, 'attack', 1, FIST_STAMINA_SCALE);
    const cheap = full - fist.vitals.stamina;

    const armed = fighter();
    startAttack(armed, 'attack', 2);
    const costly = armed.vitals.stamina;

    expect(cheap).toBeCloseTo(LIGHT_ATTACK.staminaCost * FIST_STAMINA_SCALE);
    expect(full - costly).toBeCloseTo(LIGHT_ATTACK.staminaCost);
  });

  it('топором фазы и пауза длиннее', () => {
    const axe = fighter();
    expect(startAttack(axe, 'attack', 2)).toBe(true);
    expect(axe.action?.remaining).toBeCloseTo(LIGHT_ATTACK.timing.windup * 2);
    expect(axe.action?.scale).toBe(2);

    const fist = fighter();
    startAttack(fist, 'attack');
    expect(axe.swingCooldown).toBeGreaterThan(fist.swingCooldown);
  });
});
