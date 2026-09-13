import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_LEVEL,
  MOBS,
  PROGRESS_CAP,
  attributesFor,
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

describe('тело крепнет от прокачки', () => {
  const attributes = attributesFor('human', 'warrior');

  it('новичок слабее ветерана, но не вдвое', () => {
    const green = maxHealth(attributes);
    const veteran = maxHealth(attributes, PROGRESS_CAP);

    expect(veteran).toBeGreaterThan(green);
    expect(veteran).toBeLessThan(green * 2);
  });

  it('растут все три предела', () => {
    expect(maxStamina(attributes, PROGRESS_CAP)).toBeGreaterThan(maxStamina(attributes));
    expect(maxMana(attributes, PROGRESS_CAP)).toBeGreaterThan(maxMana(attributes));
  });

  it('выше потолка не растёт', () => {
    expect(maxHealth(attributes, PROGRESS_CAP * 3)).toBe(maxHealth(attributes, PROGRESS_CAP));
  });

  it('пустая книга навыков ничего не прибавляет', () => {
    // И не отнимает: отрицательная сумма — это испорченные данные, а не штраф.
    expect(maxHealth(attributes, 0)).toBe(maxHealth(attributes));
    expect(maxHealth(attributes, -50)).toBe(maxHealth(attributes));
  });
});
