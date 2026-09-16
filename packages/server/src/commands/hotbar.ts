import {
  countOf,
  findByDefId,
  isItemId,
  itemDef,
  type ItemId,
  type SetHotbarMessage,
  type UseHotbarMessage,
} from '@grimhold/shared';
import type { Player } from '../world.js';
import { beginCast } from './action.js';
import { handleEquip, handleUnequip, handleUseItem } from './items.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Панель горячих клавиш.
 *
 * Панель хранит вид предмета, а не его место в сетке: вещи в рюкзаке двигаются,
 * и привязка к клетке рассыпалась бы при первом переносе. По нажатию сервер
 * сам находит подходящий предмет и решает, что с ним сделать, — клиент
 * присылает только номер ячейки.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/**
 * Убирает вид предмета с панели, если его больше нигде нет.
 *
 * Зовётся там, где вещь ушла **по воле игрока**: выбросил, положил в казну,
 * отдал в обмене. Ячейка, показывающая то, чего у тебя нет, просто врёт —
 * и хуже всего это в бою, где на неё смотрят краем глаза.
 *
 * А вот когда вещь кончилась от использования, привязка остаётся: наберёшь
 * новых бинтов — и ячейка снова заработает. Клиент такую приглушает.
 */
export function forgetMissing(player: Player, defId: ItemId): void {
  /**
   * У свитка «есть» значит «вставлен в клетки умений».
   *
   * Свиток в рюкзаке — не умение, а вещь на продажу: ячейка, показывающая
   * его, обещала бы заклинание, которого при нажатии не будет.
   */
  if (itemDef(defId).kind === 'spell') {
    if (countOf(player.scrolls, defId) === 0) clearHotbar(player, defId);
    return;
  }

  if (countOf(player.inventory, defId) > 0) return;
  if (Object.values(player.equipment).some((item) => item?.defId === defId)) return;
  clearHotbar(player, defId);
}

/** Снимает вид предмета со всех ячеек панели. */
function clearHotbar(player: Player, defId: ItemId): void {
  let cleared = false;
  for (let index = 0; index < player.hotbar.length; index++) {
    if (player.hotbar[index] !== defId) continue;
    player.hotbar[index] = null;
    cleared = true;
  }
  if (cleared) player.dirty = true;
}

export const handleSetHotbar: CommandHandler<SetHotbarMessage> = (ctx, payload) => {
  const player = ctx.actor;

  if (payload.itemId === '') {
    player.hotbar[payload.index] = null;
  } else {
    if (!isItemId(payload.itemId)) return refuse('Такого предмета нет');
    player.hotbar[payload.index] = payload.itemId;
  }

  player.dirty = true;
  return [{ type: 'inventory' }];
};

export const handleUseHotbar: CommandHandler<UseHotbarMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const defId = player.hotbar[payload.index];
  if (!defId) return [];

  const def = itemDef(defId);

  /**
   * Надетое тем же нажатием и снимается.
   *
   * Панель — это «сделать то, что на ней нарисовано», и таких действий
   * обычно два: взять и убрать. Факел так гасят, топор так убирают в рюкзак.
   * Пока снятие было только у расходников, вещь из панели можно было надеть,
   * а снять — лишь через рюкзак: нажатие уходило искать её в сетке, а она
   * уже в руке, и получало отказ «нет в рюкзаке».
   *
   * **Броня так не снимается.** Её носят ради защиты, а не ради действия,
   * и второе нажатие раздевало бы владельца посреди боя. Руки — другое дело:
   * там вещь меняют по ходу, и это решение владельца.
   */
  const inHands = def.slot === 'mainHand' || def.slot === 'offHand';
  if (
    def.slot &&
    (inHands || def.kind === 'consumable') &&
    player.equipment[def.slot]?.defId === defId
  ) {
    return handleUnequip(ctx, { t: 'unequip', slot: def.slot });
  }

  /**
   * Свиток читается там, где лежит, — в клетках умений.
   *
   * Искать его в рюкзаке нельзя: свиток умения в рюкзаке не лежит вовсе,
   * а лежащий там — просто вещь на продажу. Проверку «вставлен ли» держит
   * `beginCast`, одна на все пути.
   */
  if (def.kind === 'spell' && def.spellId) {
    const refusal = beginCast(ctx.world, player, def.spellId, payload.viewTick);
    return refusal ? refuse(refusal) : [];
  }

  const item = findByDefId(player.inventory, defId);
  if (!item) return refuse(`${def.name}: нет в рюкзаке`);

  if (def.kind === 'consumable' && (def.restoreHealth || def.restoreStamina)) {
    return handleUseItem(ctx, { t: 'useItem', x: item.x, y: item.y });
  }

  if (def.slot) {
    // Сюда доходит только то, что ещё не надето: надетое снято выше.
    return handleEquip(ctx, { t: 'equip', x: item.x, y: item.y });
  }

  return refuse(`${def.name} так не используется`);
};
