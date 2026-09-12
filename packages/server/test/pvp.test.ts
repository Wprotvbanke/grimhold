import { describe, expect, it } from 'vitest';
import {
  KARMA_PER_KILL,
  KARMA_PER_MOB,
  PURPLE_SECONDS,
  TOWN_SIZE,
  attributesFor,
  fullVitals,
} from '@grimhold/shared';
import { flagFor, forgiveForMob, markAggressor, mayAttack, punishKill } from '../src/pvp.js';
import { resolveCone, resolveMelee } from '../src/combat.js';
import { createProjectile, stepProjectile } from '../src/projectile.js';
import { PositionHistory } from '../src/history.js';
import type { Combatant } from '../src/combatant.js';

/**
 * Правила PvP.
 *
 * Проверяется само правило, а не путь до него: «кто кого может бить» — чистая
 * функция, и проверять её против живого мира значит ловить вместо неё
 * стамину, шаги и расхождение позиций.
 */

const OUTSIDE = TOWN_SIZE / 2 + 5;

function makeCombatant(overrides: Partial<Combatant> = {}): Combatant {
  const attributes = overrides.attributes ?? attributesFor('human', 'warrior');
  return {
    id: 'c1',
    kind: 'player',
    karma: 0,
    purpleFor: 0,
    name: 'Кто-то',
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

describe('кто кого может бить', () => {
  it('в городе игрок игрока не трогает', () => {
    const attacker = makeCombatant({ id: 'a', pos: { x: 0, y: 0, z: 0 } });
    const target = makeCombatant({ id: 'b', pos: { x: 2, y: 0, z: 0 } });

    const verdict = mayAttack(attacker, target);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/город/i);
  });

  it('снаружи по тому, кто в городе, тоже не достать', () => {
    // Стоять за чертой и бить внутрь — самый дешёвый способ обойти правило,
    // проверяющее только бьющего.
    const attacker = makeCombatant({ id: 'a', pos: { x: 0, y: 0, z: TOWN_SIZE / 2 + 1 } });
    const target = makeCombatant({ id: 'b', pos: { x: 0, y: 0, z: TOWN_SIZE / 2 - 1 } });

    const verdict = mayAttack(attacker, target);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/защит/i);
  });

  it('за воротами дерутся', () => {
    const attacker = makeCombatant({ id: 'a', pos: { x: 0, y: 0, z: OUTSIDE } });
    const target = makeCombatant({ id: 'b', pos: { x: 1, y: 0, z: OUTSIDE } });

    expect(mayAttack(attacker, target).ok).toBe(true);
  });

  it('зверья правила не касаются даже в городе', () => {
    const player = makeCombatant({ id: 'a', pos: { x: 0, y: 0, z: 0 } });
    const beast = makeCombatant({ id: 'm', kind: 'mob', pos: { x: 1, y: 0, z: 0 } });

    expect(mayAttack(player, beast).ok).toBe(true);
    expect(mayAttack(beast, player).ok).toBe(true);
  });
});

describe('удар в безопасной зоне', () => {
  /** Бьющий смотрит в -Z, цель ставим прямо перед ним на расстоянии руки. */
  function duel(attackerZ: number, targetZ: number) {
    const attacker = makeCombatant({ id: 'a', name: 'Буян', pos: { x: 0, y: 0, z: attackerZ } });
    const target = makeCombatant({ id: 'b', name: 'Жертва', pos: { x: 0, y: 0, z: targetZ } });
    const outcome = resolveMelee(
      attacker,
      'attack',
      [attacker, target],
      new PositionHistory(),
      0,
      0,
      { id: 'blunt', level: 1 },
      10,
    );
    return { attacker, target, outcome };
  }

  it('урона нет, а причина названа', () => {
    const { target, outcome } = duel(0, -1.5);

    expect(target.vitals.health).toBe(fullVitals(target.attributes).health);
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0]?.reason).toMatch(/город/i);
  });

  it('снаружи по тому, кто внутри, — тот же отказ', () => {
    const { target, outcome } = duel(TOWN_SIZE / 2 + 1, TOWN_SIZE / 2 - 1);

    expect(target.vitals.health).toBe(fullVitals(target.attributes).health);
    expect(outcome.refusals[0]?.reason).toMatch(/защит/i);
  });

  it('за воротами удар доходит', () => {
    const { target, outcome } = duel(OUTSIDE, OUTSIDE - 1.5);

    expect(target.vitals.health).toBeLessThan(fullVitals(target.attributes).health);
    expect(outcome.refusals).toHaveLength(0);
  });
});

describe('флаги', () => {
  function pair() {
    const attacker = makeCombatant({ id: 'a', name: 'Буян', pos: { x: 0, y: 0, z: OUTSIDE } });
    const target = makeCombatant({ id: 'b', name: 'Мирный', pos: { x: 1, y: 0, z: OUTSIDE } });
    return { attacker, target };
  }

  it('поднял руку на мирного — стал фиолетовым', () => {
    const { attacker, target } = pair();
    expect(flagFor(attacker)).toBe('white');

    markAggressor(attacker, target);
    expect(flagFor(attacker)).toBe('purple');
    expect(attacker.purpleFor).toBe(PURPLE_SECONDS);
  });

  it('ответ мирного его не красит', () => {
    // Иначе защищаться было бы так же наказуемо, как нападать, и первый удар
    // решал бы всё.
    const { attacker, target } = pair();
    markAggressor(attacker, target);

    markAggressor(target, attacker);
    expect(flagFor(target)).toBe('white');
  });

  it('убил мирного — покраснел', () => {
    const { attacker, target } = pair();

    punishKill(attacker, target);
    expect(attacker.karma).toBe(KARMA_PER_KILL);
    expect(flagFor(attacker)).toBe('red');
  });

  it('за фиолетового кармы нет', () => {
    const { attacker, target } = pair();
    target.purpleFor = PURPLE_SECONDS;

    punishKill(attacker, target);
    expect(attacker.karma).toBe(0);
    expect(flagFor(attacker)).toBe('white');
  });

  it('зверьё кармой не считается', () => {
    const { attacker } = pair();
    const beast = makeCombatant({ id: 'm', kind: 'mob', pos: { x: 1, y: 0, z: OUTSIDE } });

    markAggressor(attacker, beast);
    punishKill(attacker, beast);
    expect(flagFor(attacker)).toBe('white');
  });

  it('убитый зверь замаливает часть кармы', () => {
    const { attacker } = pair();
    attacker.karma = KARMA_PER_KILL;

    forgiveForMob(attacker);
    expect(attacker.karma).toBe(KARMA_PER_KILL - KARMA_PER_MOB);
  });

  it('карма не уходит в минус', () => {
    const { attacker } = pair();
    attacker.karma = 2;

    forgiveForMob(attacker);
    expect(attacker.karma).toBe(0);
    expect(flagFor(attacker)).toBe('white');
  });
});

describe('заклинания слушаются тех же правил', () => {
  /** Заклинатель смотрит в -Z, цель прямо перед ним. */
  function duel(casterZ: number, targetZ: number) {
    const caster = makeCombatant({ id: 'a', name: 'Маг', pos: { x: 0, y: 0, z: casterZ } });
    const target = makeCombatant({ id: 'b', name: 'Прохожий', pos: { x: 0, y: 0, z: targetZ } });
    return { caster, target };
  }

  it('стужа в городе не берёт', () => {
    // Дыра, на которую уже наступили: конусные заклинания шли мимо правила,
    // и в городе нельзя было ударить мечом, но можно было заморозить.
    const { caster, target } = duel(0, -2);

    const outcome = resolveCone(caster, 'frostbite', [caster, target], 1);
    expect(target.vitals.health).toBe(fullVitals(target.attributes).health);
    expect(outcome.refusals[0]?.reason).toMatch(/город/i);
  });

  it('за воротами стужа работает', () => {
    const { caster, target } = duel(OUTSIDE, OUTSIDE - 2);

    resolveCone(caster, 'frostbite', [caster, target], 1);
    expect(target.vitals.health).toBeLessThan(fullVitals(target.attributes).health);
  });

  it('снаряд в городе не долетает', () => {
    const { caster, target } = duel(0, -3);
    const bolt = createProjectile('p1', caster, 'ember', 0, 1);

    // Даём снаряду дойти: он не должен ни попасть, ни ранить.
    for (let i = 0; i < 20; i++) stepProjectile(bolt, 1 / 20, [caster, target], []);
    expect(target.vitals.health).toBe(fullVitals(target.attributes).health);
  });

  it('за воротами снаряд попадает', () => {
    const { caster, target } = duel(OUTSIDE, OUTSIDE - 3);
    const bolt = createProjectile('p1', caster, 'ember', 0, 1);

    let hit = false;
    for (let i = 0; i < 20 && !hit; i++) {
      hit = stepProjectile(bolt, 1 / 20, [caster, target], []) !== null;
    }
    expect(target.vitals.health).toBeLessThan(fullVitals(target.attributes).health);
  });
});
