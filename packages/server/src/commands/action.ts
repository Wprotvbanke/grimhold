import {
  SPELLS,
  beginAction,
  canDashAtWeight,
  staminaScaleOf,
  swingScaleOf,
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

  // Рывок — это бросок в сторону, а не кнопка «потратить стамину». Стоя на
  // месте рывать некуда: раньше C на месте съедал стамину и давал только
  // неуязвимость, и выгоднее всего было жать его, никуда не двигаясь.
  if (payload.kind === 'dodge' && !dashDirection(actor.lastIntent)) return [];

  // С полным рюкзаком не рвутся. Рывок теряется раньше скорости — это и есть
  // цена жадности, и платится она в бою, а не в дороге.
  if (payload.kind === 'dodge' && !canDashAtWeight(actor.attributes, actor.carriedWeight)) {
    return [{ type: 'itemError', reason: 'Слишком тяжело для рывка' }];
  }

  // Запоминаем, какой снапшот игрок видел: по нему отматываются цели.
  actor.pendingViewTick = payload.viewTick;

  // И темп удара, и его цена берутся у того, что в руке: топор тяжелее
  // кулака и бьёт реже, зато кулаком махать дешевле.
  startAttack(
    actor.combat,
    payload.kind,
    swingScaleOf(actor.equipment),
    staminaScaleOf(actor.equipment),
  );
  return [];
};

/** Есть ли куда рвать: любое направление движения или прыжок. */
function dashDirection(intent: { forward: number; right: number; jump: boolean }): boolean {
  return intent.forward !== 0 || intent.right !== 0 || intent.jump;
}

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
