import type { ChatBroadcast, ChatMessage } from '@grimhold/shared';
import type { CommandHandler } from './types.js';

/**
 * Чат. Локальный канал слышен только в радиусе интереса — то есть тем,
 * кого игрок и так видит. Общий слышен всем в инстансе.
 *
 * Адресаты вычисляются на сервере: клиент не может ни подслушать далёкий
 * локальный чат, ни отправить сообщение от чужого имени.
 */
export const handleChat: CommandHandler<ChatMessage> = (ctx, payload) => {
  const { world, actor } = ctx;

  const broadcast: ChatBroadcast = {
    t: 'chatMessage',
    channel: payload.channel,
    from: actor.name,
    text: payload.text,
  };

  const recipients =
    payload.channel === 'local'
      ? world.playersNear(actor.state.pos, actor.instanceId)
      : [...world.players.values()].filter((p) => p.instanceId === actor.instanceId);

  return [{ type: 'chat', broadcast, recipients: recipients.map((p) => p.id) }];
};
