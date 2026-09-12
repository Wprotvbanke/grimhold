import {
  BANK,
  addItem,
  arrangeInGrid,
  itemAt,
  itemDef,
  place,
  removeItem,
  type BankMoveMessage,
  type CloseBankMessage,
  type Grid,
  type OpenBankMessage,
  type PlacedItem,
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

  // Раскладка внутри сундука идёт по тем же правилам, что и в рюкзаке.
  if (payload.dir === 'arrange') {
    if (payload.toX === undefined || payload.toY === undefined) return [];

    const arranged = arrangeInGrid(
      player.bank,
      payload.x,
      payload.y,
      payload.toX,
      payload.toY,
      payload.rotate ?? false,
    );
    if (typeof arranged === 'string') return refuse(arranged);

    player.bank = arranged;
    return [{ type: 'bank' }, { type: 'bankSave' }];
  }

  const from = payload.dir === 'deposit' ? player.inventory : player.bank;
  const to = payload.dir === 'deposit' ? player.bank : player.inventory;

  const item = itemAt(from, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  // Сначала находим место, и только потом убираем вещь с прежнего: иначе
  // полное хранилище съедало бы предмет молча.
  const placed = putInto(to, item, payload);
  if (typeof placed === 'string') return refuse(placed);

  const rest = removeItem(from, item);
  if (payload.dir === 'deposit') {
    player.inventory = rest;
    player.bank = placed;
  } else {
    player.bank = rest;
    player.inventory = placed;
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

/**
 * Кладёт вещь в принимающую сетку.
 *
 * Клетка указана — значит игрок притащил вещь мышью именно туда, и класть
 * куда-то ещё было бы самоуправством. Не указана — щелчок, и место ищет
 * сервер: у щелчка нет точки назначения.
 */
function putInto(
  grid: Grid,
  item: PlacedItem,
  payload: BankMoveMessage,
): Grid | string {
  if (payload.toX !== undefined && payload.toY !== undefined) {
    const rotated = payload.rotate ?? false ? !item.rotated : item.rotated;
    const exact = place(grid, item.defId, item.count, payload.toX, payload.toY, rotated);
    if (exact) return exact;

    // Под курсором могла оказаться такая же стопка — складываем.
    const target = itemAt(grid, payload.toX, payload.toY);
    if (!target || target.defId !== item.defId) return 'Сюда не влезает';
  }

  const added = addItem(grid, item.defId, item.count);
  if (added.leftover > 0) {
    return payload.dir === 'deposit' ? 'В казне нет места' : 'В рюкзаке нет места';
  }
  return added.grid;
}
