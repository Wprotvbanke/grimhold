import { describe, expect, it } from 'vitest';
import { BASIC_RECIPES, RECIPES, canCraft, recipesForRace } from '../src/index.js';

/**
 * Ремесло держится на одном правиле: базовый ярус открыт всем, рецептурный —
 * только своей расе и только по изученному свитку. На этом стоит взаимная
 * нужность рас, то есть вся торговля между игроками. Правило и проверяем.
 */

describe('ремесло', () => {
  it('базовый ярус доступен любой расе без изучения', () => {
    for (const id of BASIC_RECIPES) {
      expect(canCraft(id, 'dwarf', []).ok, id).toBe(true);
      expect(canCraft(id, 'elf', []).ok, id).toBe(true);
      expect(canCraft(id, 'human', []).ok, id).toBe(true);
    }
  });

  it('чужое ремесло не поддаётся даже с изученным рецептом', () => {
    // Зелья — эльфийское дело. Дворф не сварит их ни при каких условиях.
    const potion = RECIPES.health_potion;
    expect(potion.race).toBe('elf');

    expect(canCraft('health_potion', 'dwarf', ['health_potion']).ok).toBe(false);
    expect(canCraft('health_potion', 'elf', ['health_potion']).ok).toBe(true);
  });

  it('своё ремесло требует изученного свитка', () => {
    expect(canCraft('iron_sword', 'dwarf', []).ok, 'без свитка не должно выйти').toBe(false);
    expect(canCraft('iron_sword', 'dwarf', ['iron_sword']).ok).toBe(true);
  });

  it('в списке расы нет чужого и неизученного', () => {
    const visible = recipesForRace('elf', ['health_potion', 'iron_sword']);
    const ids = visible.map((recipe) => recipe.id);

    expect(ids, 'своё изученное показываем').toContain('health_potion');
    expect(ids, 'чужое не показываем даже изученным').not.toContain('iron_sword');
    expect(ids, 'базовое показываем всегда').toContain('plank_from_log');
  });
});
