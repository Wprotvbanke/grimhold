import { isItemId, addItem, type ClientMessage } from '@grimhold/shared';
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
   * Перевод стрелок. Сдвиг хранится у мира, а не у игрока: время суток общее
   * для всех, и ночь обязана наступить у всех разом.
   */
  const wanted = message.time ?? 0;
  world.setDaytime(wanted);
  return [{ type: 'daytime' }];
}
