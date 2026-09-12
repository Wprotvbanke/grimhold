import {
  BANK,
  addItem,
  itemAt,
  itemDef,
  removeItem,
  type BankMoveMessage,
  type CloseBankMessage,
  type OpenBankMessage,
} from '@grimhold/shared';
import { refreshLoadout } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Городская казна.
 *
 * Единственное безопасное хранилище: всё, что в рюкзаке, теряется со смертью,
 * всё, что здесь — нет. Поэтому банк лежит в слое команд наравне с боем, а не
 * в «интерфейсной» части: каждая операция двигает ценности.
 *
 * Хранилище общее на аккаунт — см. `BANK` в level.ts.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/** Вещи переложены — обновить обе панели и немедленно записать в базу. */
function moved(): GameEvent[] {
  return [{ type: 'inventory' }, { type: 'bank' }, { type: 'bankSave' }];
}

/** Далеко ли до сундука. Проверяется и при открытии, и при каждой операции. */
function atVault(x: number, z: number): boolean {
  return Math.hypot(x - BANK.x, z - BANK.z) <= BANK.range;
}

export const handleOpenBank: CommandHandler<OpenBankMessage> = (ctx) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвым не до сбережений');
  if (!atVault(player.state.pos.x, player.state.pos.z)) return refuse('До казны надо дойти');

  player.bankOpen = true;
  return [{ type: 'bank' }];
};

export const handleCloseBank: CommandHandler<CloseBankMessage> = (ctx) => {
  ctx.actor.bankOpen = false;
  return [{ type: 'bank' }];
};

export const handleBankMove: CommandHandler<BankMoveMessage> = (ctx, payload) => {
  const player = ctx.actor;
  if (!player.bankOpen) return refuse('Казна закрыта');

  // Открытую панель можно унести с собой: проверяем расстояние каждый раз,
  // иначе сундук работал бы из диких земель.
  if (!atVault(player.state.pos.x, player.state.pos.z)) {
    player.bankOpen = false;
    return [{ type: 'bank' }, ...refuse('Ты отошёл от казны')];
  }

  const from = payload.dir === 'deposit' ? player.inventory : player.bank;
  const to = payload.dir === 'deposit' ? player.bank : player.inventory;

  const item = itemAt(from, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  // Сначала находим место, и только потом убираем вещь с прежнего: иначе
  // полное хранилище съедало бы предмет молча.
  const added = addItem(to, item.defId, item.count);
  if (added.leftover > 0) {
    return refuse(
      payload.dir === 'deposit' ? 'В казне нет места' : 'В рюкзаке нет места',
    );
  }

  const rest = removeItem(from, item);
  if (payload.dir === 'deposit') {
    player.inventory = rest;
    player.bank = added.grid;
  } else {
    player.bank = rest;
    player.inventory = added.grid;
  }

  // Вес меняется в обе стороны: вынул из казны — понёс.
  refreshLoadout(player);
  player.dirty = true;

  const def = itemDef(item.defId);
  console.log(
    `[банк] ${player.name}: ${payload.dir === 'deposit' ? 'положил' : 'забрал'} ${def.name} ×${item.count}`,
  );
  return moved();
};
