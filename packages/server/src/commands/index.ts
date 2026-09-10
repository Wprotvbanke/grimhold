import type { ClientMessage } from '@grimhold/shared';
import { handleAction, handleBlock, handleCast } from './action.js';
import { handleChat } from './chat.js';
import { handleInput } from './input.js';
import type { CommandContext, GameEvent } from './types.js';

export * from './types.js';

/**
 * Диспетчер команд. Сообщение уже провалидировано схемой протокола,
 * так что сюда попадает только структурно корректное намерение.
 *
 * Сюда доходят только команды играющего актора: вход, регистрация и выбор
 * персонажа обрабатываются на уровне соединения — до того, как актор появится.
 */
export function dispatch(ctx: CommandContext, message: ClientMessage): GameEvent[] {
  switch (message.t) {
    case 'input':
      return handleInput(ctx, message);
    case 'chat':
      return handleChat(ctx, message);
    case 'action':
      return handleAction(ctx, message);
    case 'block':
      return handleBlock(ctx, message);
    case 'cast':
      return handleCast(ctx, message);
    default:
      return [];
  }
}
