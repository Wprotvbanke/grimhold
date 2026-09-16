import {
  addItem,
  arrangeInGrid,
  itemAt,
  itemDef,
  place,
  removeItem,
  type Grid,
  type ScrollMoveMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player } from '../world.js';
import { forgetMissing } from './hotbar.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Клетки умений: двенадцать клеток под рюкзаком.
 *
 * Правило тут ровно одно, зато твёрдое: **в клетки умений кладут только
 * свитки**. Это не склад на двенадцать мелочей, а то, что персонаж умеет:
 * вставил «Огненный шар» — стал бить огнём, вынул — перестал. Разреши сюда
 * зелья, и клетки мгновенно стали бы бессмертным рюкзаком, в котором прячут
 * добычу от смерти внизу.
 *
 * Обратно, из клеток в рюкзак, кладётся что угодно: вынутый свиток — обычная
 * вещь, её несут продать или бросают.
 */

function changed(): GameEvent[] {
  return [{ type: 'inventory' }];
}

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

export const handleScrollMove: CommandHandler<ScrollMoveMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const from = payload.from === 'scrolls' ? player.scrolls : player.inventory;

  const item = itemAt(from, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  // Перекладывание внутри одной сетки — общие правила раскладки, те же,
  // что у рюкзака и казны. Свитки не поворачивают: они в одну клетку.
  if (payload.from === payload.to) {
    const moved = arrangeInGrid(
      from,
      payload.x,
      payload.y,
      payload.toX ?? payload.x,
      payload.toY ?? payload.y,
      false,
    );
    if (typeof moved === 'string') return refuse(moved);

    if (payload.from === 'scrolls') player.scrolls = moved;
    else player.inventory = moved;
    refreshLoadout(player);
    return changed();
  }

  if (payload.to === 'scrolls' && itemDef(item.defId).kind !== 'spell') {
    return refuse('В клетки умений кладут только свитки');
  }

  const target = payload.to === 'scrolls' ? player.scrolls : player.inventory;

  // Притащили мышью в клетку — кладём туда. Не влезло или пришёл щелчок —
  // место ищет сервер: отказ из-за промаха мышью на клетку злит зря.
  let placed: Grid | null = null;
  if (payload.toX !== undefined && payload.toY !== undefined) {
    placed = place(target, item.defId, item.count, payload.toX, payload.toY, false);
  }
  if (!placed) {
    const added = addItem(target, item.defId, item.count);
    if (added.leftover > 0) {
      return refuse(payload.to === 'scrolls' ? 'Клетки умений полны' : 'В рюкзаке нет места');
    }
    placed = added.grid;
  }

  if (payload.to === 'scrolls') {
    player.scrolls = placed;
    player.inventory = removeItem(player.inventory, item);
  } else {
    player.inventory = placed;
    player.scrolls = removeItem(player.scrolls, item);
    /**
     * Вынутый свиток — уже не умение.
     *
     * Ячейка панели, показывающая свиток, которого нет в клетках, обещает
     * заклинание, которого не будет: нажатие получит отказ. Убираем её сразу,
     * как убираем ячейку выброшенной вещи.
     */
    forgetMissing(player, item.defId);
  }

  refreshLoadout(player);
  return changed();
};

/** Лежит ли такой свиток в клетках умений. Открыто ради панели и проверок. */
export function hasScroll(player: Player, defId: string): boolean {
  return player.scrolls.items.some((item) => item.defId === defId);
}
