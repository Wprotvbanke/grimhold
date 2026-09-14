import { describe, expect, it } from 'vitest';
import {
  EXPERIENCE_PER_RIPOSTE,
  RIPOSTE_SECONDS,
  TOWN_SIZE,
  attributesFor,
  fullVitals,
} from '@grimhold/shared';
import { resolveMelee } from '../src/combat.js';
import { PositionHistory } from '../src/history.js';
import type { Combatant } from '../src/combatant.js';

/**
 * Уклонение учится уходом **с ответом**.
 *
 * Пока навык рос от самого ухода, тренировкой было «прыгай в сторону рядом
 * с крысой»: рывок делают и просто так, а опыт капал. Теперь надо уйти
 * от настоящего удара и тут же достать foeа.
 */

/**
 * За городской стеной — там, где драться можно. От размера города, а не числом:
 * город вырос вдвое, и прежние −60 оказались ровно на линии новой стены,
 * то есть ещё под защитой.
 */
const OUTSIDE = -(TOWN_SIZE / 2 + 10);

function fighter(id: string, z: number): Combatant {
  const attributes = attributesFor('human', 'warrior');
  return {
    id,
    kind: 'player',
    karma: 0,
    purpleFor: 0,
    name: id,
    instanceId: 'overworld',
    pos: { x: 0, y: 0, z },
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

/** Бьющий смотрит в −Z, цель — прямо перед ним на расстоянии руки. */
function strike(attacker: Combatant, target: Combatant) {
  return resolveMelee(
    attacker,
    'attack',
    [attacker, target],
    new PositionHistory(),
    0,
    0,
    { id: 'blade', level: 1 },
    10,
  );
}

function evasionFrom(outcome: ReturnType<typeof strike>, id: string): number {
  return outcome.experience
    .filter((gain) => gain.combatantId === id && gain.skill === 'evasion')
    .reduce((sum, gain) => sum + gain.amount, 0);
}

describe('уклонение учится уходом с ответом', () => {
  it('сам уход опыта не даёт — только открывает окно', () => {
    const attacker = fighter('a', OUTSIDE);
    const dodger = fighter('b', OUTSIDE - 1.5);
    // Рывок: в активной фазе fighterOnly неуязвим, это и есть уход.
    dodger.invulnerable = 0.2;

    const outcome = strike(attacker, dodger);

    expect(evasionFrom(outcome, dodger.id)).toBe(0);
    expect(dodger.riposteFor).toBe(RIPOSTE_SECONDS);
  });

  it('а ответ после ухода — даёт', () => {
    const dodger = fighter('b', OUTSIDE);
    const foe = fighter('a', OUTSIDE - 1.5);
    dodger.riposteFor = RIPOSTE_SECONDS;

    const outcome = strike(dodger, foe);

    expect(evasionFrom(outcome, dodger.id)).toBe(EXPERIENCE_PER_RIPOSTE);
    // Окно закрылось: за один уход платят один раз, а не за всю серию.
    expect(dodger.riposteFor).toBe(0);
  });

  it('удар без ухода не учит уклонению', () => {
    const fighterOnly = fighter('b', OUTSIDE);
    const foe = fighter('a', OUTSIDE - 1.5);

    expect(evasionFrom(strike(fighterOnly, foe), fighterOnly.id)).toBe(0);
  });

  it('промах после ухода тоже не учит', () => {
    // Окно остаётся открытым: не дотянулся — попробуй ещё, пока не вышло время.
    const dodger = fighter('b', OUTSIDE);
    const far = fighter('a', OUTSIDE - 12);
    dodger.riposteFor = RIPOSTE_SECONDS;

    expect(evasionFrom(strike(dodger, far), dodger.id)).toBe(0);
    expect(dodger.riposteFor).toBe(RIPOSTE_SECONDS);
  });
});
