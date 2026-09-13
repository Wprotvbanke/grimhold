import {
  CHEST_LOOT,
  createSack,
  CHEST_RANGE,
  CHEST_TIME,
  addItem,
  dungeonSeed,
  findChest,
  isDungeon,
  isItemId,
  itemDef,
  type ItemId,
  type OpenChestMessage,
} from '@grimhold/shared';
import type { Player, World } from '../world.js';
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
 *
 * Вскрытый сундук — **хранилище, а не выдача**. Добыча не сыплется в рюкзак,
 * а лежит в нём, и открывается он тем же окном, что казна: игрок сам решает,
 * что унести. Подойти к нему второй раз можно в любой момент — пока цел
 * инстанс, цело и содержимое.
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

  // Вскрытый открывается сразу: замок уже сломан, ждать нечего.
  if (world.isChestOpen(actor.instanceId, chest.id)) return openChest(actor, chest);

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

/** Ставит сундук перед игроком открытым окном — тем же, что у казны. */
function openChest(player: Player, chest: { id: string; x: number; z: number }): GameEvent[] {
  player.container = {
    kind: 'chest',
    instanceId: player.instanceId,
    chestId: chest.id,
    at: { x: chest.x, z: chest.z },
  };
  return [{ type: 'bank' }];
}

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

  const chest = findChest(dungeonSeed(player.instanceId), work.id);
  if (!chest) return [{ type: 'gathering' }];

  if (world.isChestOpen(player.instanceId, work.id)) {
    // Сосед пришёл на звук и вскрыл его, пока шла полоса. Не беда: смотреть
    // в чужой сундук не запрещено, там могло что-то остаться.
    return [{ type: 'gathering', note: 'Его уже вскрыли' }, ...openChest(player, chest)];
  }

  /**
   * Добыча складывается **в сам сундук**, а не в рюкзак.
   *
   * Что не поместилось в сетку — того в сундуке и не было: мешок мал
   * намеренно, и выбор «взять это или то» начинается уже здесь.
   */
  let loot = createSack();
  for (const entry of CHEST_LOOT) {
    if (Math.random() > entry.chance) continue;
    // Опечатка в таблице не должна ронять забег — несуществующее пропускаем.
    if (!isItemId(entry.itemId)) continue;

    const count = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
    loot = addItem(loot, entry.itemId as ItemId, count).grid;
  }

  world.markChestOpen(player.instanceId, work.id, loot);

  return [
    { type: 'gathering' },
    ...openChest(player, chest),
    {
      type: 'loot',
      message: {
        t: 'loot',
        from: loot.items.length > 0 ? 'Сундук' : 'Сундук — пусто',
        items: loot.items.map((item) => ({
          itemId: item.defId,
          name: itemDef(item.defId).name,
          count: item.count,
        })),
        lost: 0,
        onGround: true,
      },
    },
  ];
}
