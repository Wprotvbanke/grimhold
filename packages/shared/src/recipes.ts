import type { ItemId } from './items.js';
import type { Race } from './races.js';

/**
 * Ремесло.
 *
 * Два яруса, и это главное решение всей системы:
 *
 *  - **Базовый** доступен всем и без рецепта. Бинты, факелы, стрелы, доски,
 *    грубые инструменты. Одиночка не должен упереться в стену только потому,
 *    что нужной расы нет онлайн.
 *  - **Рецептурный** привязан к расе и требует изученного свитка. Дворф куёт
 *    металл, эльф варит зелья, человек работает с деревом и кожей. Отсюда
 *    растёт то, ради чего расы нужны друг другу, — торговля и договорённости.
 *
 * Станков нет: крафтить можно где угодно. Свитки падают в подземельях, поэтому
 * сила приходит из риска, а не из времени, проведённого у верстака.
 */

export type RecipeId =
  // ---- базовый ярус ----
  | 'plank_from_log'
  | 'cloth_from_fiber'
  | 'leather_from_pelt'
  | 'ingot_from_ore'
  | 'bandage'
  | 'torch'
  | 'arrows'
  | 'crude_axe'
  | 'crude_pick'
  | 'knife'
  | 'wooden_club'
  | 'wooden_shield'
  // ---- рецептурный: дворф ----
  | 'iron_sword'
  | 'iron_helm'
  | 'iron_cuirass'
  // ---- рецептурный: человек ----
  | 'hunting_bow'
  | 'leather_cap'
  | 'leather_jerkin'
  // ---- рецептурный: эльф ----
  | 'health_potion'
  | 'stamina_draught'
  | 'stone_elixir';

export interface Ingredient {
  itemId: ItemId;
  count: number;
}

export interface Recipe {
  id: RecipeId;
  name: string;
  /** Что получается и сколько. */
  output: Ingredient;
  inputs: Ingredient[];
  /**
   * Раса, которой доступен рецепт. Отсутствие означает базовый ярус:
   * доступен всем и без изучения.
   */
  race?: Race;
  /** Сколько секунд занимает изготовление. */
  duration: number;
}

const RECIPE_LIST: Recipe[] = [
  // ---------- базовый ярус: доступен всем, изучать не нужно ----------
  {
    id: 'plank_from_log',
    name: 'Доски из бревна',
    output: { itemId: 'plank', count: 2 },
    inputs: [{ itemId: 'log', count: 1 }],
    duration: 1.5,
  },
  {
    id: 'cloth_from_fiber',
    name: 'Ткань из волокна',
    output: { itemId: 'cloth', count: 1 },
    inputs: [{ itemId: 'plant_fiber', count: 3 }],
    duration: 1.5,
  },
  {
    id: 'leather_from_pelt',
    name: 'Кожа из шкуры',
    output: { itemId: 'leather', count: 2 },
    inputs: [{ itemId: 'pelt', count: 1 }],
    duration: 2,
  },
  {
    id: 'ingot_from_ore',
    name: 'Слиток из руды',
    output: { itemId: 'ingot', count: 1 },
    inputs: [{ itemId: 'ore', count: 2 }],
    duration: 3,
  },
  {
    id: 'bandage',
    name: 'Бинт',
    output: { itemId: 'bandage', count: 2 },
    inputs: [{ itemId: 'cloth', count: 1 }],
    duration: 1,
  },
  {
    id: 'torch',
    name: 'Факел',
    output: { itemId: 'torch', count: 2 },
    inputs: [
      { itemId: 'plank', count: 1 },
      { itemId: 'cloth', count: 1 },
    ],
    duration: 1,
  },
  {
    id: 'arrows',
    name: 'Стрелы',
    output: { itemId: 'arrow', count: 10 },
    inputs: [
      { itemId: 'plank', count: 1 },
      { itemId: 'fang', count: 1 },
    ],
    duration: 2,
  },
  {
    id: 'crude_axe',
    name: 'Грубый топор',
    output: { itemId: 'crude_axe', count: 1 },
    inputs: [
      { itemId: 'plank', count: 2 },
      { itemId: 'stone', count: 2 },
    ],
    duration: 3,
  },
  {
    id: 'crude_pick',
    name: 'Грубая кирка',
    output: { itemId: 'crude_pick', count: 1 },
    inputs: [
      { itemId: 'plank', count: 2 },
      { itemId: 'stone', count: 3 },
    ],
    duration: 3,
  },
  {
    id: 'knife',
    name: 'Нож',
    output: { itemId: 'knife', count: 1 },
    inputs: [
      { itemId: 'plank', count: 1 },
      { itemId: 'stone', count: 1 },
    ],
    duration: 2,
  },
  {
    id: 'wooden_club',
    name: 'Деревянная дубина',
    output: { itemId: 'wooden_club', count: 1 },
    inputs: [{ itemId: 'plank', count: 3 }],
    duration: 3,
  },
  {
    id: 'wooden_shield',
    name: 'Деревянный щит',
    output: { itemId: 'wooden_shield', count: 1 },
    inputs: [
      { itemId: 'plank', count: 4 },
      { itemId: 'leather', count: 1 },
    ],
    duration: 4,
  },

  // ---------- рецептурный ярус: дворф, металл ----------
  {
    id: 'iron_sword',
    name: 'Железный меч',
    race: 'dwarf',
    output: { itemId: 'iron_sword', count: 1 },
    inputs: [
      { itemId: 'ingot', count: 4 },
      { itemId: 'leather', count: 1 },
    ],
    duration: 6,
  },
  {
    id: 'iron_helm',
    name: 'Железный шлем',
    race: 'dwarf',
    output: { itemId: 'iron_helm', count: 1 },
    inputs: [
      { itemId: 'ingot', count: 3 },
      { itemId: 'cloth', count: 1 },
    ],
    duration: 5,
  },
  {
    id: 'iron_cuirass',
    name: 'Железная кираса',
    race: 'dwarf',
    output: { itemId: 'iron_cuirass', count: 1 },
    inputs: [
      { itemId: 'ingot', count: 6 },
      { itemId: 'leather', count: 2 },
    ],
    duration: 8,
  },

  // ---------- рецептурный ярус: человек, дерево и кожа ----------
  {
    id: 'hunting_bow',
    name: 'Охотничий лук',
    race: 'human',
    output: { itemId: 'hunting_bow', count: 1 },
    inputs: [
      { itemId: 'plank', count: 3 },
      { itemId: 'plant_fiber', count: 6 },
    ],
    duration: 6,
  },
  {
    id: 'leather_cap',
    name: 'Кожаный шлем',
    race: 'human',
    output: { itemId: 'leather_cap', count: 1 },
    inputs: [{ itemId: 'leather', count: 3 }],
    duration: 4,
  },
  {
    id: 'leather_jerkin',
    name: 'Кожаный доспех',
    race: 'human',
    output: { itemId: 'leather_jerkin', count: 1 },
    inputs: [
      { itemId: 'leather', count: 5 },
      { itemId: 'cloth', count: 2 },
    ],
    duration: 7,
  },

  // ---------- рецептурный ярус: эльф, зелья ----------
  {
    id: 'health_potion',
    name: 'Зелье лечения',
    race: 'elf',
    output: { itemId: 'health_potion', count: 2 },
    inputs: [
      { itemId: 'herb', count: 4 },
      { itemId: 'clay', count: 1 },
    ],
    duration: 4,
  },
  {
    id: 'stamina_draught',
    name: 'Настой выносливости',
    race: 'elf',
    output: { itemId: 'stamina_draught', count: 2 },
    inputs: [
      { itemId: 'herb', count: 3 },
      { itemId: 'plant_fiber', count: 2 },
    ],
    duration: 4,
  },
  {
    id: 'stone_elixir',
    name: 'Эликсир камня',
    race: 'elf',
    output: { itemId: 'stone_elixir', count: 1 },
    inputs: [
      { itemId: 'herb', count: 5 },
      { itemId: 'bone_dust', count: 2 },
      { itemId: 'clay', count: 2 },
    ],
    duration: 6,
  },
];

export const RECIPES: Record<RecipeId, Recipe> = Object.fromEntries(
  RECIPE_LIST.map((recipe) => [recipe.id, recipe]),
) as Record<RecipeId, Recipe>;

/** Рецепты базового яруса: их знают все с самого начала. */
export const BASIC_RECIPES: RecipeId[] = RECIPE_LIST.filter((r) => !r.race).map((r) => r.id);

export function isRecipeId(value: string): value is RecipeId {
  return value in RECIPES;
}

/**
 * Может ли персонаж изготовить это прямо сейчас.
 * Базовый ярус не требует ничего, рецептурный — своей расы и изученного свитка.
 */
export function canCraft(
  recipeId: RecipeId,
  race: Race,
  known: readonly RecipeId[],
): { ok: true } | { ok: false; reason: string } {
  const recipe = RECIPES[recipeId];
  if (!recipe) return { ok: false, reason: 'Такого рецепта нет' };

  if (!recipe.race) return { ok: true };

  if (recipe.race !== race) {
    return { ok: false, reason: 'Это ремесло не твоей расы' };
  }
  if (!known.includes(recipeId)) {
    return { ok: false, reason: 'Рецепт не изучен' };
  }
  return { ok: true };
}

/** Какие рецепты вообще имеет смысл показывать этой расе. */
export function recipesForRace(race: Race, known: readonly RecipeId[]): Recipe[] {
  return RECIPE_LIST.filter(
    (recipe) => !recipe.race || (recipe.race === race && known.includes(recipe.id)),
  );
}
