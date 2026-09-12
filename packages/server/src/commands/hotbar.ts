import {
  SPELLS,
  beginAction,
  countOf,
  findByDefId,
  isItemId,
  itemDef,
  type ItemId,
  type SetHotbarMessage,
  type UseHotbarMessage,
} from '@grimhold/shared';
import { canAct, payForSpell } from '../combat.js';
import type { Player } from '../world.js';
import { handleEquip, handleUseItem } from './items.js';
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
  if (countOf(player.inventory, defId) > 0) return;
  if (Object.values(player.equipment).some((item) => item?.defId === defId)) return;

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

  const item = findByDefId(player.inventory, defId);
  if (!item) return refuse(`${itemDef(defId).name}: нет в рюкзаке`);

  const def = itemDef(defId);

  // Заклинание читается, а не тратится: свиток остаётся в рюкзаке.
  if (def.kind === 'spell' && def.spellId) {
    return castFromItem(ctx, payload, def.spellId);
  }

  if (def.kind === 'consumable' && (def.restoreHealth || def.restoreStamina)) {
    return handleUseItem(ctx, { t: 'useItem', x: item.x, y: item.y });
  }

  if (def.slot) {
    // Повторное нажатие по надетому ничего не ломает: сервер просто
    // наденет то же самое обратно.
    return handleEquip(ctx, { t: 'equip', x: item.x, y: item.y });
  }

  return refuse(`${def.name} так не используется`);
};

/** Чтение заклинания из панели. Проверки те же, что и при обычном касте. */
function castFromItem(
  ctx: Parameters<CommandHandler<UseHotbarMessage>>[0],
  payload: UseHotbarMessage,
  spellId: keyof typeof SPELLS,
): GameEvent[] {
  const { world, actor } = ctx;
  const combat = actor.combat;

  if (!combat.alive || !canAct(combat)) return [];

  const readyAt = actor.spellCooldowns[spellId] ?? 0;
  if (world.elapsed < readyAt) return refuse(`${SPELLS[spellId].name}: ещё не готово`);

  if (!payForSpell(combat, spellId)) return refuse('Не хватает маны');

  actor.pendingViewTick = payload.viewTick;

  const spell = SPELLS[spellId];
  combat.action = beginAction(
    {
      kind: 'cast',
      name: spell.name,
      timing: { windup: spell.castTime, active: 0.05, recovery: 0.3 },
      staminaCost: 0,
      damageScale: 1,
      range: spell.range,
      arc: spell.arc ?? 0,
    },
    spellId,
  );

  return [];
}
