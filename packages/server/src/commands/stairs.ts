import {
  DUNGEON_EXIT_RANGE,
  floorArrival,
  floorOf,
  isDungeon,
  stairsDown,
  stairsUp,
  type StairsMessage,
} from '@grimhold/shared';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Лестницы между этажами подземелья.
 *
 * Этажи живут **в одном инстансе**, поэтому переход по лестнице — это не спуск
 * и не выход, а перенос внутри своего мира: отряд остаётся отрядом, хозяин
 * глубины открывает порталы сразу всем, а земля под ногами уже построена —
 * все три этажа выводятся из одного зерна.
 *
 * Вниз ведёт восточная ниша, наверх — западная. Ниши устроены как выход:
 * стена расступается, на её камне знак, и «E» срабатывает **у самого знака**.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

export const handleStairs: CommandHandler<StairsMessage> = (ctx, payload) => {
  const player = ctx.actor;
  if (!isDungeon(player.instanceId)) return [];
  if (!player.combat.alive) return refuse('Сначала подняться');

  const floor = floorOf(player.state.pos.x);
  const stairs = payload.down ? stairsDown(floor) : stairsUp(floor);
  if (!stairs) {
    return refuse(payload.down ? 'Глубже хода нет' : 'Отсюда наверх только порталом');
  }

  const distance = Math.hypot(player.state.pos.x - stairs.x, player.state.pos.z - stairs.z);
  if (distance > DUNGEON_EXIT_RANGE) return refuse('До лестницы надо дойти');

  const next = payload.down ? floor + 1 : floor - 1;

  /**
   * Перенос идёт через `moveToInstance`, хотя инстанс тот же.
   *
   * Не ради имени: это единственное место, которое помнит **всё**, что нужно
   * сделать при переезде — обнулить накопленный ввод, забыть историю позиций,
   * закрыть открытое хранилище, представить соседей заново и сказать клиенту,
   * что он в другом месте. Сделай перенос вручную — забудешь одно из пяти,
   * и вылезет это не здесь, а через два дня в виде удара, прошедшего сквозь
   * этаж.
   */
  ctx.world.moveToInstance(player, player.instanceId, floorArrival(next));

  console.log(`[подземелье] ${player.name}: этаж ${floor + 1} → ${next + 1}`);
  return [{ type: 'criticalSave' }];
};
