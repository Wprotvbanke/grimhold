import { AOI_RADIUS, type PartyMessage } from '@grimhold/shared';
import type { CommandHandler, GameEvent } from './types.js';
import type { Player } from '../world.js';

/**
 * Отряд.
 *
 * Внизу флаги не действуют и все всем враги — значит **своих надо как-то
 * отличать**, и это единственное, ради чего отряд существует. Он не даёт ни
 * общей добычи, ни общего опыта, ни защиты от своего же удара: всё это
 * потребовало бы делить правила, а делить пока нечего.
 *
 * Приглашение живёт одним полем у приглашённого. Очередь приглашений не нужна:
 * их и приходит-то одно за раз, а второе честно перебивает первое — человек
 * отвечает на то, что видел последним.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/**
 * Короткая весть игроку — системной строкой в чате.
 *
 * Не тем каналом, которым объясняются отказы: тот пишет в панель рюкзака,
 * а приглашение приходит, когда панель закрыта, и пропадало бы молча.
 */
function tell(player: Player, text: string): GameEvent {
  return {
    type: 'chat',
    broadcast: { t: 'chatMessage', channel: 'system', from: '', text },
    recipients: [player.id],
  };
}

export const handleParty: CommandHandler<PartyMessage> = (ctx, payload) => {
  const player = ctx.actor;

  if (payload.action === 'leave') {
    if (!player.partyId) return refuse('Ты и так сам по себе');
    const mates = ctx.world.partyMates(player);
    ctx.world.leaveParty(player);
    return [...mates.map((mate) => tell(mate, `${player.name} ушёл из отряда`))];
  }

  if (payload.action === 'decline') {
    player.partyInviteFrom = null;
    return [];
  }

  if (payload.action === 'accept') {
    const hostId = player.partyInviteFrom;
    player.partyInviteFrom = null;
    if (!hostId) return refuse('Тебя никто не звал');

    const host = ctx.world.playerByCombatantId(hostId);
    // Позвавший мог выйти, умереть и уехать наверх, пока приглашённый думал.
    if (!host || host.instanceId !== player.instanceId) return refuse('Звавшего уже нет рядом');

    ctx.world.joinParty(host, player);
    return [
      tell(host, `${player.name} в отряде`),
      tell(player, `Ты в отряде: ${host.name}`),
    ];
  }

  // invite
  if (!payload.targetId) return refuse('Некого звать');
  const target = ctx.world.playerByCombatantId(payload.targetId);
  if (!target || target.id === player.id) return refuse('Некого звать');
  if (target.instanceId !== player.instanceId) return refuse('Он не здесь');

  const distance = Math.hypot(
    target.state.pos.x - player.state.pos.x,
    target.state.pos.z - player.state.pos.z,
  );
  // Дальше радиуса интереса звать нельзя просто потому, что оттуда цель
  // и не видно: клиент не знает про тех, кого ему не прислали.
  if (distance > AOI_RADIUS) return refuse('Он слишком далеко');
  if (ctx.world.allies(player, target)) return refuse('Он и так свой');

  target.partyInviteFrom = player.id;
  return [
    tell(target, `${player.name} зовёт в отряд — G, чтобы принять`),
    tell(player, `Позвал: ${target.name}`),
  ];
};
