import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_LEVEL,
  MOBS,
  addProgress,
  attributesFor,
  emptyProgress,
  pointCost,
  spendPoint,
  experienceFor,
  experienceForLevel,
  gainExperience,
  maxHealth,
  maxMana,
  maxStamina,
} from '../src/index.js';

/**
 * Прокачка.
 *
 * Глобального уровня в игре нет: растут навыки, и от них же крепнет тело.
 * Здесь закреплено то, что нельзя увидеть глазами за разумное время —
 * форма кривой и цена противников.
 */

describe('цена победы зависит от противника', () => {
  it('чем опаснее, тем больше учит', () => {
    // Плоский опыт делал выгодным бить крыс у ворот: они слабее всех
    // и давали столько же, сколько огр.
    expect(experienceFor(MOBS.rat)).toBeLessThan(experienceFor(MOBS.wolf));
    expect(experienceFor(MOBS.wolf)).toBeLessThan(experienceFor(MOBS.wight));
    expect(experienceFor(MOBS.wight)).toBeLessThan(experienceFor(MOBS.ogre));
  });

  it('и даже слабейший чему-то учит', () => {
    expect(experienceFor(MOBS.rat)).toBeGreaterThan(0);
  });
});

describe('кривая опыта', () => {
  it('каждый следующий уровень дороже предыдущего', () => {
    for (const level of [0, 1, 10, 50, 98]) {
      expect(experienceForLevel(level + 1)).toBeGreaterThan(experienceForLevel(level));
    }
  });

  it('первый уровень даётся за пару боёв, сотый — нет', () => {
    const first = experienceForLevel(0);
    expect(first).toBeLessThanOrEqual(experienceFor(MOBS.wolf) * 3);
    expect(experienceForLevel(99)).toBeGreaterThan(first * 50);
  });

  it('выше потолка навык не растёт', () => {
    const capped = gainExperience({ level: MAX_SKILL_LEVEL, experience: 0 }, 100000);
    expect(capped.progress.level).toBe(MAX_SKILL_LEVEL);
    expect(capped.levelsGained).toBe(0);
  });

  it('большая награда поднимает сразу несколько уровней', () => {
    const jump = gainExperience({ level: 0, experience: 0 }, 1000);
    expect(jump.levelsGained).toBeGreaterThan(1);
  });
});

describe('тело растёт вложенными очками', () => {
  const attributes = attributesFor('human', 'warrior');

  it('вложенное очко прибавляет, невложенное — нет', () => {
    const green = maxHealth(attributes);
    const spent = maxHealth(attributes, { health: 10, stamina: 0, mana: 0 });

    expect(spent).toBeGreaterThan(green);
    // Очки в другое здоровья не прибавляют: выбор должен быть настоящим.
    expect(maxHealth(attributes, { health: 0, stamina: 10, mana: 10 })).toBe(green);
  });

  it('и ветеран крепче новичка, но не вдвое', () => {
    const green = maxHealth(attributes);
    const veteran = maxHealth(attributes, { health: 10, stamina: 0, mana: 0 });
    expect(veteran).toBeLessThan(green * 1.5);
  });

  it('растут все три предела', () => {
    expect(maxStamina(attributes, { health: 0, stamina: 5, mana: 0 })).toBeGreaterThan(
      maxStamina(attributes),
    );
    expect(maxMana(attributes, { health: 0, stamina: 0, mana: 5 })).toBeGreaterThan(
      maxMana(attributes),
    );
  });
});

describe('очки персонажа', () => {
  it('первое даётся за несколько боёв, десятое — за сотни', () => {
    expect(pointCost(0)).toBeLessThan(experienceFor(MOBS.wight) * 6);
    expect(pointCost(9)).toBeGreaterThan(pointCost(0) * 5);
  });

  it('каждое следующее дороже предыдущего', () => {
    for (const earned of [0, 1, 5, 20, 49]) {
      expect(pointCost(earned + 1)).toBeGreaterThan(pointCost(earned));
    }
  });

  it('опыт копится и превращается в очки', () => {
    const fresh = emptyProgress();
    const little = addProgress(fresh, pointCost(0) - 1);
    expect(little.gained).toBe(0);
    expect(little.progress.points).toBe(0);

    const enough = addProgress(little.progress, 1);
    expect(enough.gained).toBe(1);
    expect(enough.progress.pool).toBe(0);
  });

  it('крупная награда даёт сразу несколько очков', () => {
    const rich = addProgress(emptyProgress(), pointCost(0) + pointCost(1) + pointCost(2));
    expect(rich.gained).toBe(3);
  });

  it('цена растёт и от уже вложенных очков', () => {
    // Иначе вложил — и следующее снова дёшево: счёт надо вести по всем очкам.
    const veteran = { pool: 0, points: 0, spent: { health: 5, stamina: 0, mana: 0 } };
    const cheap = addProgress(emptyProgress(), pointCost(0));
    const dear = addProgress(veteran, pointCost(0));

    expect(cheap.gained).toBe(1);
    expect(dear.gained).toBe(0);
  });

  it('вложить нечего — вложения нет', () => {
    expect(spendPoint(emptyProgress(), 'health')).toBeNull();

    const ready = addProgress(emptyProgress(), pointCost(0)).progress;
    const after = spendPoint(ready, 'health')!;
    expect(after.points).toBe(0);
    expect(after.spent.health).toBe(1);
  });
});
