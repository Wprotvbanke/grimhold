import { describe, expect, it } from 'vitest';
import { SPELLS, attributesFor, fullVitals, spellDamage } from '@grimhold/shared';
import { createProjectile, stepProjectile } from '../src/projectile.js';
import type { Combatant } from '../src/combatant.js';

/**
 * Снаряды заклинаний.
 *
 * Здесь закреплены два бага, найденные при разборе кода:
 *  1. урон считался по атрибутам ЦЕЛИ вместо атрибутов заклинателя —
 *     умный маг бил слабо по глупому мобу и наоборот;
 *  2. быстрый снаряд проскакивал сквозь цель, потому что за один тик
 *     проходил больше её ширины.
 */

function makeCombatant(overrides: Partial<Combatant> = {}): Combatant {
  const attributes = overrides.attributes ?? attributesFor('human', 'warrior');
  return {
    id: 'c1',
    kind: 'player',
    karma: 0,
    purpleFor: 0,
    name: 'Цель',
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
    wardArmor: 0,
    wardRemaining: 0,
    slowFactor: 1,
    slowRemaining: 0,
    lightRemaining: 0,
    dodgeCooldown: 0,
    swingCooldown: 0,
    ...overrides,
  };
}

/**
 * Заклинатель смотрит в -Z, цель ставим прямо перед ним.
 *
 * Дуэль уносим подальше от города: в безопасной зоне снаряд между игроками
 * не долетает, и это правильно — но проверяем мы тут не её, а урон.
 */
const DUEL_Z = -120;

function scenario(casterClass: 'mage' | 'warrior', targetDistance: number) {
  const caster = makeCombatant({
    id: 'caster',
    name: 'Маг',
    attributes: attributesFor('elf', casterClass),
    pos: { x: 0, y: 0, z: DUEL_Z },
  });
  const target = makeCombatant({
    id: 'target',
    pos: { x: 0, y: 0, z: DUEL_Z - targetDistance },
    attributes: attributesFor('dwarf', 'warrior'),
  });
  return { caster, target };
}

describe('урон снаряда', () => {
  it('считается по атрибутам заклинателя, а не цели', () => {
    const smart = scenario('mage', 6);
    const dull = scenario('warrior', 6);

    const smartBolt = createProjectile('x1', smart.caster, 'ember', 0, 0);
    const dullBolt = createProjectile('x2', dull.caster, 'ember', 0, 0);

    const smartHit = fly(smartBolt, [smart.caster, smart.target]);
    const dullHit = fly(dullBolt, [dull.caster, dull.target]);

    expect(smartHit).not.toBeNull();
    expect(dullHit).not.toBeNull();
    // Цели у обоих одинаковые: разница может идти только от заклинателя.
    expect(smartHit!.event.amount).toBeGreaterThan(dullHit!.event.amount);
  });

  it('сила заклинания фиксируется на вылете', () => {
    const { caster, target } = scenario('mage', 6);
    const bolt = createProjectile('x1', caster, 'ember', 0, 0);

    // Заклинатель гибнет, пока снаряд летит — урон не должен обнулиться.
    caster.alive = false;
    const hit = fly(bolt, [caster, target]);

    expect(hit?.event.kind).toBe('hit');
    const expected = spellDamage(caster.attributes, SPELLS.ember.power, 0);
    expect(hit!.event.amount).toBeCloseTo(Math.round(expected), 0);
  });
});

describe('пробитие цели насквозь', () => {
  it('«Разряд» не проскакивает сквозь человека за один тик', () => {
    // 42 м/с при тике 20 Гц — это 2.1 метра за шаг, вдвое шире цели.
    const { caster, target } = scenario('mage', 5);
    const bolt = createProjectile('x1', caster, 'lightning', 0, 0);

    const hit = fly(bolt, [caster, target], 1 / 20);

    expect(hit, 'снаряд пролетел сквозь цель').not.toBeNull();
    expect(hit!.event.targetId).toBe('target');
  });

  it('«Уголёк» тоже попадает', () => {
    const { caster, target } = scenario('mage', 5);
    const bolt = createProjectile('x1', caster, 'ember', 0, 0);
    expect(fly(bolt, [caster, target], 1 / 20)?.event.targetId).toBe('target');
  });

  it('пролетает мимо, если цели нет на пути', () => {
    const { caster, target } = scenario('mage', 5);
    target.pos = { x: 20, y: 0, z: DUEL_Z - 5 };

    const bolt = createProjectile('x1', caster, 'ember', 0, 0);
    expect(fly(bolt, [caster, target], 1 / 20)).toBeNull();
  });

  it('гаснет о стену, не задев того, кто за ней', () => {
    const { caster, target } = scenario('mage', 8);
    const wall = { minX: -5, maxX: 5, minY: 0, maxY: 4, minZ: DUEL_Z - 4.5, maxZ: DUEL_Z - 3.5 };

    const bolt = createProjectile('x1', caster, 'lightning', 0, 0);
    const hit = fly(bolt, [caster, target], 1 / 20, [wall]);

    expect(hit?.event.kind).toBe('miss');
    expect(target.vitals.health).toBe(fullVitals(target.attributes).health);
  });
});

/** Гоняет снаряд до попадания или до конца жизни. */
function fly(
  projectile: ReturnType<typeof createProjectile>,
  combatants: Combatant[],
  dt = 1 / 20,
  colliders: Parameters<typeof stepProjectile>[3] = [],
) {
  for (let i = 0; i < 200; i++) {
    const hit = stepProjectile(projectile, dt, combatants, colliders);
    if (hit) return hit;
    if (projectile.lifetime <= 0) return null;
  }
  return null;
}
