import {
  addItem,
  countOf,
  itemAt,
  itemDef,
  takeItem,
  type Grid,
  type ItemId,
  type TradeCancelMessage,
  type TradeEntry,
  type TradeInviteMessage,
  type TradeLockMessage,
  type TradeMessage,
  type TradeOfferMessage,
  type TradeRespondMessage,
  type TradeWithdrawMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player, type Trade } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Прямой обмен между игроками.
 *
 * Самое опасное место в игре после подземелий: здесь вещи переходят из рук
 * в руки, и ошибка стоит дюпа или кражи. Поэтому правил немного, но они
 * жёсткие:
 *
 * 1. **Предложение — обещание, а не залог.** Вещи остаются в рюкзаке, наличие
 *    проверяется в момент сделки. Отложенное на сторону пришлось бы возвращать
 *    при каждом разрыве связи, а место под возврат к тому моменту могло быть
 *    уже занято.
 * 2. **Любое изменение снимает оба подтверждения.** Иначе подтвердивший первым
 *    соглашался бы на то, чего не видел, — классическая подмена на столе.
 * 3. **Сделка либо проходит целиком, либо не начинается.** Сначала считаем обе
 *    стороны на копиях сеток, и только если сошлось — записываем.
 */

/** С какого расстояния можно предложить обмен и на каком он держится. */
const TRADE_RANGE = 5;

/** Сколько строк помещается на столе с одной стороны. */
const TABLE_SIZE = 12;

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/** Оба собеседника должны увидеть новое состояние стола. */
function show(trade: Trade, note?: string): GameEvent[] {
  return [{ type: 'trade', trade, note }];
}

function near(a: Player, b: Player): boolean {
  if (a.instanceId !== b.instanceId) return false;
  return Math.hypot(a.state.pos.x - b.state.pos.x, a.state.pos.z - b.state.pos.z) <= TRADE_RANGE;
}

/**
 * Стол глазами обеих сторон — по сообщению каждому.
 *
 * Строится по самому столу, а не по `player.trade`: после завершения ссылки
 * у игроков уже сняты, а сказать им, чем всё кончилось, надо.
 */
export function tradeMessages(
  trade: Trade,
  options: { closed?: boolean; done?: boolean; note?: string } = {},
): { playerId: string; message: TradeMessage }[] {
  const stage: TradeMessage['stage'] = options.done
    ? 'done'
    : options.closed
      ? 'closed'
      : trade.accepted
        ? 'open'
        : 'invited';

  const forSide = (self: Player, other: Player, mine: TradeEntry[], theirs: TradeEntry[], myLock: boolean, theirLock: boolean) => ({
    playerId: self.id,
    message: {
      t: 'trade' as const,
      stage,
      partner: other.name,
      mine,
      theirs,
      myLock,
      theirLock,
      note: options.note,
    },
  });

  const a = entriesOf(trade.offerA);
  const b = entriesOf(trade.offerB);
  return [
    forSide(trade.a, trade.b, a, b, trade.lockA, trade.lockB),
    forSide(trade.b, trade.a, b, a, trade.lockB, trade.lockA),
  ];
}

function entriesOf(offer: { itemId: ItemId; count: number }[]): TradeEntry[] {
  return offer.map((entry) => ({
    itemId: entry.itemId,
    name: itemDef(entry.itemId).name,
    count: entry.count,
  }));
}

/** Снимает оба подтверждения: стол изменился, и прежнее согласие устарело. */
function unlock(trade: Trade): void {
  trade.lockA = false;
  trade.lockB = false;
}

export function endTrade(trade: Trade): void {
  trade.a.trade = null;
  trade.b.trade = null;
}

export const handleTradeInvite: CommandHandler<TradeInviteMessage> = (ctx, payload) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвым не торгуют');
  if (player.trade) return refuse('Ты уже за столом');

  const target = ctx.world.players.get(payload.targetId);
  if (!target || target === player) return refuse('Такого рядом нет');
  if (!target.combat.alive) return refuse('Он мёртв');
  if (!near(player, target)) return refuse('Слишком далеко');
  if (target.trade) return refuse(`${target.name} уже торгует`);

  const trade: Trade = {
    a: player,
    b: target,
    offerA: [],
    offerB: [],
    lockA: false,
    lockB: false,
    accepted: false,
  };
  player.trade = trade;
  target.trade = trade;

  return show(trade);
};

export const handleTradeRespond: CommandHandler<TradeRespondMessage> = (ctx, payload) => {
  const trade = ctx.actor.trade;
  if (!trade) return refuse('Тебя никто не звал');
  // Отвечает только приглашённый: позвавший согласия у себя не спрашивает.
  if (trade.b !== ctx.actor || trade.accepted) return refuse('Это не твой ответ');

  if (!payload.accept) {
    endTrade(trade);
    return [{ type: 'trade', trade, closed: true, note: `${ctx.actor.name} отказался` }];
  }

  trade.accepted = true;
  return show(trade);
};

export const handleTradeOffer: CommandHandler<TradeOfferMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const trade = player.trade;
  if (!trade || !trade.accepted) return refuse('Стол ещё не накрыт');

  const item = itemAt(player.inventory, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  const offer = trade.a === player ? trade.offerA : trade.offerB;
  if (offer.length >= TABLE_SIZE) return refuse('На столе больше не помещается');

  // Одну и ту же стопку нельзя пообещать дважды: считаем уже обещанное.
  const promised = offer
    .filter((entry) => entry.itemId === item.defId)
    .reduce((sum, entry) => sum + entry.count, 0);
  if (promised + item.count > countOf(player.inventory, item.defId)) {
    return refuse('Столько у тебя нет');
  }

  offer.push({ itemId: item.defId, count: item.count });
  unlock(trade);
  return show(trade);
};

export const handleTradeWithdraw: CommandHandler<TradeWithdrawMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const trade = player.trade;
  if (!trade || !trade.accepted) return refuse('Стол ещё не накрыт');

  const offer = trade.a === player ? trade.offerA : trade.offerB;
  if (payload.index >= offer.length) return refuse('Этого на столе нет');

  offer.splice(payload.index, 1);
  unlock(trade);
  return show(trade);
};

export const handleTradeLock: CommandHandler<TradeLockMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const trade = player.trade;
  if (!trade || !trade.accepted) return refuse('Стол ещё не накрыт');

  if (trade.a === player) trade.lockA = payload.locked;
  else trade.lockB = payload.locked;

  if (!trade.lockA || !trade.lockB) return show(trade);
  return settle(trade);
};

export const handleTradeCancel: CommandHandler<TradeCancelMessage> = (ctx) => {
  const trade = ctx.actor.trade;
  if (!trade) return [];

  endTrade(trade);
  return [{ type: 'trade', trade, closed: true, note: `${ctx.actor.name} ушёл от стола` }];
};

/**
 * Сделка.
 *
 * Считается сначала целиком на копиях: если хоть одна вещь пропала или не
 * влезает, не меняется ничего. Половина обмена хуже, чем несостоявшийся обмен.
 */
function settle(trade: Trade): GameEvent[] {
  if (!near(trade.a, trade.b)) {
    unlock(trade);
    return show(trade, 'Вы разошлись слишком далеко');
  }
  if (!trade.a.combat.alive || !trade.b.combat.alive) {
    unlock(trade);
    return show(trade, 'Один из вас мёртв');
  }

  const first = exchange(trade.a.inventory, trade.offerA, trade.offerB);
  if (typeof first === 'string') {
    unlock(trade);
    return show(trade, `${trade.a.name}: ${first}`);
  }
  const second = exchange(trade.b.inventory, trade.offerB, trade.offerA);
  if (typeof second === 'string') {
    unlock(trade);
    return show(trade, `${trade.b.name}: ${second}`);
  }

  trade.a.inventory = first;
  trade.b.inventory = second;
  refreshLoadout(trade.a);
  refreshLoadout(trade.b);
  trade.a.dirty = true;
  trade.b.dirty = true;

  console.log(
    `[обмен] ${trade.a.name} ↔ ${trade.b.name}: ${describe(trade.offerA)} за ${describe(trade.offerB)}`,
  );

  endTrade(trade);
  return [{ type: 'trade', trade, closed: true, done: true, note: 'Обмен состоялся' }];
}

/**
 * Отдать своё и принять чужое на копии сетки.
 *
 * Отдаём раньше, чем принимаем: освободившееся место засчитывается в пользу
 * игрока, иначе равный обмен упирался бы в полный рюкзак.
 */
function exchange(
  grid: Grid,
  give: { itemId: ItemId; count: number }[],
  take: { itemId: ItemId; count: number }[],
): Grid | string {
  let result = grid;
  for (const entry of give) {
    const without = takeItem(result, entry.itemId, entry.count);
    if (!without) return `не хватает «${itemDef(entry.itemId).name}»`;
    result = without;
  }
  for (const entry of take) {
    const added = addItem(result, entry.itemId, entry.count);
    if (added.leftover > 0) return 'в рюкзаке нет места';
    result = added.grid;
  }
  return result;
}

function describe(offer: { itemId: ItemId; count: number }[]): string {
  if (offer.length === 0) return 'ничего';
  return offer.map((entry) => `${itemDef(entry.itemId).name} ×${entry.count}`).join(', ');
}
