import {
  RECIPES,
  addItem,
  canCraft,
  countOf,
  isRecipeId,
  itemDef,
  takeItem,
  type CraftMessage,
} from '@grimhold/shared';
import { refreshLoadout } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Ремесло.
 *
 * Клиент присылает только имя рецепта. Доступен ли он этой расе, изучен ли,
 * хватает ли сырья и влезает ли результат — считает сервер.
 *
 * Станков нет: изготавливать можно где угодно. Пауза между изделиями берётся
 * из самого рецепта (`duration`) — пока это именно пауза, а не полоса
 * прогресса: изделие появляется сразу, но взяться за следующее сразу нельзя.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

export const handleCraft: CommandHandler<CraftMessage> = (ctx, payload) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвые не мастерят');
  if (!isRecipeId(payload.recipeId)) return refuse('Такого рецепта нет');

  const recipe = RECIPES[payload.recipeId];

  // Расу и изученность проверяет общая функция — та же, по которой клиент
  // решает, что показать в списке. Расхождение тут означало бы кнопку,
  // которая гарантированно отказывает.
  const allowed = canCraft(recipe.id, player.race, player.knownRecipes);
  if (!allowed.ok) return refuse(allowed.reason);

  if (player.craftCooldown > 0) return [];

  for (const input of recipe.inputs) {
    if (countOf(player.inventory, input.itemId) < input.count) {
      return refuse(`Не хватает: ${itemDef(input.itemId).name}`);
    }
  }

  /**
   * Сырьё списывается только после того, как результат нашёл место.
   *
   * Иначе переполненный рюкзак съедал бы материалы и не отдавал изделие —
   * та же ошибка, что и с нодами, только дороже: там терялся один удар,
   * здесь — пять брёвен.
   */
  const after = addItem(player.inventory, recipe.output.itemId, recipe.output.count);
  if (after.leftover > 0) return refuse('В рюкзаке нет места');

  let grid = after.grid;
  for (const input of recipe.inputs) {
    const without = takeItem(grid, input.itemId, input.count);
    // Проверка выше уже прошла, но полагаться на неё нельзя: между ней
    // и списанием лежит добавление результата, а оно двигает раскладку.
    if (!without) return refuse(`Не хватает: ${itemDef(input.itemId).name}`);
    grid = without;
  }

  player.inventory = grid;
  player.craftCooldown = recipe.duration;
  refreshLoadout(player);

  const made = itemDef(recipe.output.itemId);
  return [
    { type: 'inventory' },
    {
      type: 'loot',
      message: {
        t: 'loot',
        from: recipe.name,
        items: [{ itemId: made.id, name: made.name, count: recipe.output.count }],
        lost: 0,
      },
    },
  ];
};
