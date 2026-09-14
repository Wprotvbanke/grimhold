import { isItemId, addItem, isDungeon, type ClientMessage } from '@grimhold/shared';
import type { CommandContext, GameEvent } from './types.js';

/**
 * Служебные команды ведущего мира.
 *
 * Это отладочный инструмент, а не механика игры: выдать себе вещь, чтобы
 * проверить её в руках, и перевести часы, чтобы посмотреть город ночью,
 * не дожидаясь двадцати минут.
 *
 * Право проверяется **здесь**, а не в интерфейсе. Клиентское меню открывается
 * по признаку из `welcome`, но признак — удобство: команду можно прислать
 * и без окна, и ровно поэтому её принимает только тот, у кого есть право.
 */
export function handleAdmin(
  ctx: CommandContext,
  message: Extract<ClientMessage, { t: 'admin' }>,
): GameEvent[] {
  const { actor, world } = ctx;
  if (!actor.admin) return [{ type: 'itemError', reason: 'Нет прав' }];

  if (message.do === 'give') {
    const itemId = message.itemId ?? '';
    if (!isItemId(itemId)) return [{ type: 'itemError', reason: 'Нет такого предмета' }];

    const count = message.count ?? 1;
    const { grid, leftover } = addItem(actor.inventory, itemId, count);
    actor.inventory = grid;
    actor.dirty = true;

    const events: GameEvent[] = [{ type: 'inventory' }, { type: 'criticalSave' }];
    // Не влезло — говорим прямо. Молчаливая потеря выданного заставляет
    // гадать, сработала команда или нет.
    if (leftover > 0) {
      events.push({ type: 'itemError', reason: `Не поместилось: ${leftover}` });
    }
    return events;
  }

  /**
   * Отпереть порталы подземелья, не убивая хозяина глубины.
   *
   * Отладочный ключ, и нужен он ровно затем же, зачем выдача вещей: проверить
   * выход с добычей, перезаход и мешок павшего, не проводя перед этим боя
   * с боссом. Сквозные проверки ходят этим же путём — см. docs/checks.md.
   */
  if (message.do === 'portals') {
    if (!isDungeon(actor.instanceId)) return [{ type: 'itemError', reason: 'Ты не внизу' }];
    world.openPortals(actor.instanceId);
    const recipients = [...world.players.values()]
      .filter((player) => player.instanceId === actor.instanceId)
      .map((player) => player.id);
    return [
      {
        type: 'chat',
        broadcast: {
          t: 'chatMessage',
          channel: 'system',
          from: '',
          text: 'Порталы отперты словом ведущего',
        },
        recipients,
      },
    ];
  }

  /**
   * Перенос в точку своего мира — выбраться, если застрял в стене или в доме.
   *
   * Тем же путём, что спуск и выход: `moveToInstance` сбрасывает скорость
   * и накопленный ввод и шлёт клиенту `world`, чтобы предсказание село
   * в новую точку, а не тянуло обратно. Мир тот же — подземелье остаётся
   * подземельем, город городом.
   */
  if (message.do === 'teleport') {
    if (message.x === undefined || message.z === undefined) {
      return [{ type: 'itemError', reason: 'Нужны координаты x и z' }];
    }
    world.moveToInstance(actor, actor.instanceId, { x: message.x, y: message.y ?? 0.1, z: message.z });
    return [];
  }

  /**
   * Перевод стрелок. Сдвиг хранится у мира, а не у игрока: время суток общее
   * для всех, и ночь обязана наступить у всех разом.
   */
  const wanted = message.time ?? 0;
  world.setDaytime(wanted);
  return [{ type: 'daytime' }];
}
