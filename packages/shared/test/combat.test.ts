import { describe, expect, it } from 'vitest';
import {
  BACKSTAB_ARC,
  HEAVY_ATTACK,
  LIGHT_ATTACK,
  MAX_SKILL_LEVEL,
  advanceAction,
  applyArmor,
  attributesFor,
  beginAction,
  experienceForLevel,
  gainExperience,
  inAttackCone,
  isBackstab,
  maxHealth,
  meleeDamage,
  type ActionState,
} from '../src/index.js';

describe('атрибуты', () => {
  it('раса и класс складываются', () => {
    const dwarfWarrior = attributesFor('dwarf', 'warrior');
    const elfMage = attributesFor('elf', 'mage');

    expect(dwarfWarrior.strength).toBeGreaterThan(elfMage.strength);
    expect(elfMage.intellect).toBeGreaterThan(dwarfWarrior.intellect);
    expect(dwarfWarrior.endurance).toBeGreaterThan(elfMage.endurance);
  });

  it('дворф крепче эльфа', () => {
    expect(maxHealth(attributesFor('dwarf', 'warrior'))).toBeGreaterThan(
      maxHealth(attributesFor('elf', 'mage')),
    );
  });
});

describe('фазы действия', () => {
  it('замах переходит в удар, затем в восстановление и заканчивается', () => {
    const timing = LIGHT_ATTACK.timing;
    let state: ActionState | null = beginAction(LIGHT_ATTACK);
    const seen: string[] = [state.phase];

    for (let i = 0; i < 200 && state; i++) {
      state = advanceAction(state, timing, 1 / 60);
      if (state && seen[seen.length - 1] !== state.phase) seen.push(state.phase);
    }

    expect(seen).toEqual(['windup', 'active', 'recovery']);
    expect(state).toBeNull();
  });

  it('длинный шаг не проскакивает фазу удара молча', () => {
    const timing = LIGHT_ATTACK.timing;
    const total = timing.windup + timing.active + timing.recovery;
    const state = advanceAction(beginAction(LIGHT_ATTACK), timing, total + 1);
    expect(state).toBeNull();
  });

  it('у тяжёлого удара замах заметно длиннее — его успевают увидеть', () => {
    expect(HEAVY_ATTACK.timing.windup).toBeGreaterThan(LIGHT_ATTACK.timing.windup * 2);
    expect(HEAVY_ATTACK.damageScale).toBeGreaterThan(LIGHT_ATTACK.damageScale);
  });
});

describe('геометрия попадания', () => {
  const attacker = { x: 0, y: 0, z: 0 };
  // При yaw = 0 взгляд направлен в -Z.
  const yaw = 0;

  it('попадает по цели прямо перед собой', () => {
    const target = { x: 0, y: 0, z: -2 };
    expect(inAttackCone(attacker, yaw, target, LIGHT_ATTACK.range, LIGHT_ATTACK.arc, 0.35)).toBe(true);
  });

  it('не достаёт цель за пределом дальности', () => {
    const target = { x: 0, y: 0, z: -10 };
    expect(inAttackCone(attacker, yaw, target, LIGHT_ATTACK.range, LIGHT_ATTACK.arc, 0.35)).toBe(false);
  });

  it('не попадает за спину', () => {
    const target = { x: 0, y: 0, z: 2 };
    expect(inAttackCone(attacker, yaw, target, LIGHT_ATTACK.range, LIGHT_ATTACK.arc, 0.35)).toBe(false);
  });

  it('крупная цель прощает промах по углу', () => {
    const target = { x: 1.4, y: 0, z: -1.4 };
    const small = inAttackCone(attacker, yaw, target, 3, Math.PI / 8, 0.3);
    const large = inAttackCone(attacker, yaw, target, 3, Math.PI / 8, 1.2);
    expect(small).toBe(false);
    expect(large).toBe(true);
  });

  it('в упор попадает независимо от угла', () => {
    const target = { x: 0.1, y: 0, z: 0.1 };
    expect(inAttackCone(attacker, yaw, target, 2, 0.01, 0.3)).toBe(true);
  });
});

describe('удар в спину', () => {
  it('срабатывает, когда цель смотрит в ту же сторону', () => {
    // Цель смотрит в -Z, атакующий стоит у неё за спиной, в +Z.
    expect(isBackstab({ x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: 0 }, 0)).toBe(true);
  });

  it('не срабатывает в лоб', () => {
    expect(isBackstab({ x: 0, y: 0, z: -2 }, { x: 0, y: 0, z: 0 }, 0)).toBe(false);
  });

  it('не срабатывает сбоку за пределом дуги', () => {
    const sideAngle = BACKSTAB_ARC + 0.2;
    const position = { x: Math.sin(sideAngle) * 2, y: 0, z: Math.cos(sideAngle) * 2 };
    expect(isBackstab(position, { x: 0, y: 0, z: 0 }, 0)).toBe(false);
  });
});

describe('формулы урона', () => {
  it('навык усиливает удар, но не решает исход', () => {
    const attributes = attributesFor('human', 'warrior');
    const novice = meleeDamage(attributes, 10, 0, 1);
    const veteran = meleeDamage(attributes, 10, MAX_SKILL_LEVEL, 1);

    expect(veteran).toBeGreaterThan(novice);
    // Разрыв должен быть вдвое, а не вдесятеро: новичку есть что ловить.
    expect(veteran / novice).toBeLessThan(2);
  });

  it('броня режет урон по убывающей', () => {
    expect(applyArmor(100, 0)).toBeCloseTo(100, 5);
    expect(applyArmor(100, 50)).toBeCloseTo(50, 5);
    expect(applyArmor(100, 150)).toBeCloseTo(25, 5);
  });

  it('броня никогда не обнуляет урон полностью', () => {
    expect(applyArmor(100, 100000)).toBeGreaterThan(0);
  });
});

describe('рост навыков', () => {
  it('опыт поднимает уровень', () => {
    const result = gainExperience({ level: 0, experience: 0 }, experienceForLevel(0));
    expect(result.levelsGained).toBe(1);
    expect(result.progress.level).toBe(1);
  });

  it('каждый следующий уровень дороже предыдущего', () => {
    expect(experienceForLevel(50)).toBeGreaterThan(experienceForLevel(10) * 3);
  });

  it('первые уровни даются быстро', () => {
    let progress = { level: 0, experience: 0 };
    let hits = 0;
    while (progress.level < 5 && hits < 1000) {
      progress = gainExperience(progress, 3).progress;
      hits++;
    }
    expect(progress.level).toBe(5);
    // Пять уровней — это десятки ударов, а не тысячи.
    expect(hits).toBeLessThan(300);
  });

  it('на потолке опыт больше не копится', () => {
    const capped = gainExperience({ level: MAX_SKILL_LEVEL, experience: 0 }, 100000);
    expect(capped.progress.level).toBe(MAX_SKILL_LEVEL);
    expect(capped.levelsGained).toBe(0);
  });
});
