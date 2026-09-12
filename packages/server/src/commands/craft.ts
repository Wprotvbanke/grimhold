import {
  RECIPES,
  addItem,
  canCraft,
  countOf,
  isRecipeId,
  itemDef,
  takeItem,
  type CraftMessage,
  type CraftingMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Ремесло.
 *
 * Клиент присылает только имя рецепта. Доступен ли он этой расе, изучен ли,
 * хватает ли сырья и влезает ли результат — считает сервер.
 *
 * Станков нет: изготавливать можно где угодно. `duration` рецепта — это
 * **настоящая работа**: изделие появляется в конце, а не в начале. Раньше вещь
 * выдавалась сразу, а пауза шла молча, и со стороны игрока это выглядело как
 * подвисшая кнопка — непонятно, началось ли что-нибудь и когда кончится.
 *
 * Сырьё при этом списывается в конце, а не при начале работы. Списание вперёд
 * выглядит честнее, но тогда разрыв связи посреди изготовления съедал бы
 * материалы без изделия. Плата за такой выбор — можно начать работу, которую
 * не удастся закончить: сервер объяснит это, когда дойдёт до конца.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/** Сообщение о ходе работы — уходит игроку в начале и в конце. */
export function craftingMessage(player: Player, note?: string): CraftingMessage {
  const work = player.crafting;
  if (!work) {
    return { t: 'crafting', recipeId: null, name: '', duration: 0, remaining: 0, note };
  }

  const recipe = RECIPES[work.recipeId];
  return {
    t: 'crafting',
    recipeId: recipe.id,
    name: recipe.name,
    duration: work.duration,
    remaining: Math.max(0, work.remaining),
    note,
  };
}

export const handleCraft: CommandHandler<CraftMessage> = (ctx, payload) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвые не мастерят');
  if (player.crafting) return refuse('Ты уже занят работой');
  if (!isRecipeId(payload.recipeId)) return refuse('Такого рецепта нет');

  const recipe = RECIPES[payload.recipeId];

  // Расу и изученность проверяет общая функция — та же, по которой клиент
  // решает, что показать в списке. Расхождение тут означало бы кнопку,
  // которая гарантированно отказывает.
  const allowed = canCraft(recipe.id, player.race, player.knownRecipes);
  if (!allowed.ok) return refuse(allowed.reason);

  // Сырьё проверяется дважды: здесь — чтобы не начинать заведомо пустую
  // работу, и в конце — потому что за это время вещи могли уйти.
  for (const input of recipe.inputs) {
    if (countOf(player.inventory, input.itemId) < input.count) {
      return refuse(`Не хватает: ${itemDef(input.itemId).name}`);
    }
  }

  player.crafting = {
    recipeId: recipe.id,
    duration: recipe.duration,
    remaining: recipe.duration,
  };
  return [{ type: 'crafting' }];
};

/**
 * Работа доведена до конца.
 *
 * Вызывается игровым циклом, а не игроком: к этому моменту решение принято
 * давно, остаётся только выдать сделанное — или объяснить, почему не вышло.
 */
export function finishCraft(player: Player): GameEvent[] {
  const work = player.crafting;
  if (!work) return [];

  const recipe = RECIPES[work.recipeId];
  player.crafting = null;

  /**
   * Сырьё списывается только после того, как результат нашёл место.
   *
   * Иначе переполненный рюкзак съедал бы материалы и не отдавал изделие —
   * та же ошибка, что и с нодами, только дороже: там терялся один удар,
   * здесь — пять брёвен.
   */
  const after = addItem(player.inventory, recipe.output.itemId, recipe.output.count);
  if (after.leftover > 0) return [{ type: 'crafting', note: 'В рюкзаке нет места' }];

  let grid = after.grid;
  for (const input of recipe.inputs) {
    const without = takeItem(grid, input.itemId, input.count);
    // Проверка в начале работы уже прошла, но полагаться на неё нельзя:
    // за время работы вещь могли обменять, а добавление результата к тому же
    // двигает раскладку.
    if (!without) {
      return [{ type: 'crafting', note: `Не хватило: ${itemDef(input.itemId).name}` }];
    }
    grid = without;
  }

  player.inventory = grid;
  refreshLoadout(player);
  player.dirty = true;

  const made = itemDef(recipe.output.itemId);
  return [
    { type: 'crafting', note: `Готово: ${recipe.name}` },
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
}
