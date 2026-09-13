import {
  CHEST_LOOT,
  CHEST_RANGE,
  CHEST_TIME,
  addItem,
  dungeonSeed,
  findChest,
  isDungeon,
  isItemId,
  type ItemId,
  type OpenChestMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player, type World } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Сундук в подземелье.
 *
 * Устроен как ресурсная нода: клиент шлёт только имя, сервер восстанавливает
 * сундук из зерна инстанса и хранит лишь то, что его вскрыли. Разница одна —
 * заряд у сундука один, и второй раз он не даст ничего.
 *
 * Вскрытие идёт долго и **в конце**: бросил на полпути — ничего не получил,
 * но ничего и не потерял. Эта пауза и есть цена добычи: пока идёт полоса,
 * игрок стоит на месте, и его видно.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

export const handleOpenChest: CommandHandler<OpenChestMessage> = (ctx, payload) => {
  const { world, actor } = ctx;
  if (!actor.combat.alive) return [];
  if (!isDungeon(actor.instanceId)) return refuse('Сундуки стоят внизу');

  // Клавишу держат, и повтор приходит десятками в секунду: начатую работу
  // это продолжать не мешает, а начинать заново сбросило бы полосу в ноль.
  if (actor.work?.id === payload.chestId) return [];

  const chest = findChest(dungeonSeed(actor.instanceId), payload.chestId);
  if (!chest) return refuse('Тут нечего вскрывать');

  if (Math.hypot(chest.x - actor.state.pos.x, chest.z - actor.state.pos.z) > CHEST_RANGE) {
    return refuse('Слишком далеко');
  }
  if (world.isChestOpen(actor.instanceId, chest.id)) return refuse('Он уже пуст');

  actor.work = {
    kind: 'chest',
    id: chest.id,
    name: 'Сундук',
    at: { x: chest.x, z: chest.z },
    range: CHEST_RANGE,
    duration: CHEST_TIME,
    remaining: CHEST_TIME,
  };
  return [{ type: 'gathering' }];
};

/**
 * Замок поддался.
 *
 * Вызывается игровым циклом. Проверка повторяется: за время работы сундук
 * мог вскрыть сосед — тот, кто пришёл на звук и не стал ждать своей очереди.
 */
export function finishChest(player: Player, world: World): GameEvent[] {
  const work = player.work;
  if (!work) return [];
  player.work = null;

  if (world.isChestOpen(player.instanceId, work.id)) {
    return [{ type: 'gathering', note: 'Его уже вскрыли' }];
  }

  // Сундук помечается вскрытым до раздачи добычи: вещь может не влезть
  // в рюкзак, но замок от этого обратно не запрётся.
  world.markChestOpen(player.instanceId, work.id);

  const taken: { itemId: string; name: string; count: number }[] = [];
  let lost = 0;

  for (const entry of CHEST_LOOT) {
    if (Math.random() > entry.chance) continue;
    // Опечатка в таблице не должна ронять забег — несуществующее пропускаем.
    if (!isItemId(entry.itemId)) continue;

    const count = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
    const result = addItem(player.inventory, entry.itemId as ItemId, count);
    player.inventory = result.grid;

    const got = count - result.leftover;
    if (got > 0) taken.push({ itemId: entry.itemId, name: entry.name, count: got });
    lost += result.leftover;
  }

  refreshLoadout(player);

  return [
    { type: 'gathering' },
    { type: 'inventory' },
    {
      type: 'loot',
      message: {
        t: 'loot',
        from: taken.length > 0 ? 'Сундук' : 'Сундук — пусто',
        items: taken,
        lost,
      },
    },
    // Добыча из сундука — ценность: падение сервера не должно её отменить.
    { type: 'criticalSave' },
  ];
}
