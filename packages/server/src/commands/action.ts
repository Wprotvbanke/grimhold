import {
  SPELLS,
  beginAction,
  type ActionMessage,
  type BlockMessage,
  type CastMessage,
} from '@grimhold/shared';
import { canAct, payForSpell, startAttack } from '../combat.js';
import type { CommandHandler } from './types.js';

/**
 * Боевые намерения игрока.
 *
 * Клиент говорит «бью», «держу щит», «читаю заклинание» — и всё.
 * Хватает ли стамины, попал ли, сколько урона — решает сервер.
 */

export const handleAction: CommandHandler<ActionMessage> = (ctx, payload) => {
  const { actor } = ctx;
  if (!actor.combat.alive) return [];

  // Запоминаем, какой снапшот игрок видел: по нему отматываются цели.
  actor.pendingViewTick = payload.viewTick;

  startAttack(actor.combat, payload.kind);
  return [];
};

export const handleBlock: CommandHandler<BlockMessage> = (ctx, payload) => {
  const { actor } = ctx;
  const combat = actor.combat;
  if (!combat.alive) return [];

  // Щит нельзя поднять посреди собственного замаха.
  if (payload.active && !canAct(combat)) return [];
  // Без стамины стойку не держат.
  if (payload.active && combat.vitals.stamina <= 0) return [];

  combat.blocking = payload.active;
  return [];
};

export const handleCast: CommandHandler<CastMessage> = (ctx, payload) => {
  const { world, actor } = ctx;
  const combat = actor.combat;
  if (!combat.alive || !canAct(combat)) return [];

  // Перезарядка — правило игры, а не античит-проверка: без неё «Разряд»
  // спамился бы так часто, как хватает маны, и весь баланс каста рушится.
  const readyAt = actor.spellCooldowns[payload.spellId] ?? 0;
  if (world.elapsed < readyAt) return [];

  const spell = SPELLS[payload.spellId];
  if (!payForSpell(combat, payload.spellId)) return [];

  actor.pendingViewTick = payload.viewTick;

  // Каст занимает время и его видно — это цена силы заклинания.
  combat.action = beginAction(
    {
      kind: 'cast',
      name: spell.name,
      timing: { windup: spell.castTime, active: 0.05, recovery: 0.3 },
      staminaCost: 0,
      damageScale: 1,
      range: spell.range,
      arc: spell.arc ?? 0,
    },
    payload.spellId,
  );

  return [];
};
