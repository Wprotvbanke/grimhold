import { spendPoint, type ClientMessage } from '@grimhold/shared';
import { vitalsFor } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Вложение очка роста.
 *
 * Клиент говорит только «во что»: есть ли очко, сколько оно даёт и каким стал
 * предел — считает сервер. Панель у игрока удобство, а не источник правды.
 */
export const handleSpendPoint: CommandHandler<Extract<ClientMessage, { t: 'spendPoint' }>> = (
  ctx,
  payload,
): GameEvent[] => {
  const player = ctx.actor;

  const next = spendPoint(player.progress, payload.into);
  if (!next) return [{ type: 'itemError', reason: 'Нечего вкладывать' }];

  player.progress = next;
  /**
   * Предел вырос — само здоровье нет.
   *
   * Вложенное очко делает тебя крепче в следующем бою, а не лечит в этом.
   * Иначе очки копили бы к драке и тратили вместо зелий.
   */
  player.maxima = vitalsFor(player.attributes, next);
  player.dirty = true;

  // Очки — ценность, заработанная часами: падение сервера не должно
  // отменить вложение.
  return [{ type: 'progress' }, { type: 'criticalSave' }];
};
