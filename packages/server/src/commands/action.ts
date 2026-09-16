import {
  SPELLS,
  beginAction,
  canDashAtWeight,
  itemDef,
  staminaScaleOf,
  swingScaleOf,
  type ActionMessage,
  type BlockMessage,
  type CastMessage,
  type SpellId,
} from '@grimhold/shared';
import { canAct, payForSpell, startAttack } from '../combat.js';
import type { Player, World } from '../world.js';
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
  const refusal = beginCast(ctx.world, ctx.actor, payload.spellId, payload.viewTick);
  return refusal ? [{ type: 'itemError', reason: refusal }] : [];
};

/**
 * Начать чтение заклинания.
 *
 * Одна дверь на оба пути — прямое намерение и нажатие ячейки панели: проверки
 * тут одинаковые, а разведи их по двум местам, и однажды одна из дорог
 * пропустит то, что вторая запрещает.
 *
 * Возвращает причину отказа либо `null`, если чтение началось.
 */
export function beginCast(
  world: World,
  actor: Player,
  spellId: SpellId,
  viewTick: number,
): string | null {
  const combat = actor.combat;
  if (!combat.alive) return null;

  /**
   * Медитацию **выключают** тем же нажатием, и раньше всех прочих проверок.
   *
   * Ни откат, ни мана, ни чужой замах тут ни при чём: сидящий должен иметь
   * право встать в любой момент. Проверка «свиток вставлен» ниже — тоже:
   * вынутый из клеток свиток не обязан оставлять человека сидеть.
   */
  if (actor.meditating && SPELLS[spellId].shape === 'channel') {
    actor.meditating = false;
    return 'Медитация прервана';
  }

  /**
   * Свет гасят тем же свитком — и тоже раньше прочих проверок.
   *
   * Свиток длится две минуты, и в подземелье это не удобство, а выбор:
   * видеть самому или не быть увиденным. Выбор, который нельзя отменить,
   * выбором не является — зажёгшему свет оставалось только ждать.
   */
  if (SPELLS[spellId].shape === 'self' && combat.lightRemaining > 0) {
    combat.lightRemaining = 0;
    return 'Свет погас';
  }

  if (!canAct(combat)) return null;

  /**
   * Свиток должен лежать **в клетках умений**.
   *
   * Это и есть вся система магии: не класс решает, что персонаж умеет,
   * а то, что он в себя вставил. Свиток в рюкзаке — просто вещь, которую
   * несут продать. См. docs/magic.md.
   */
  const scroll = scrollFor(actor, spellId);
  if (!scroll) return `${SPELLS[spellId].name}: свиток не вставлен в клетки умений`;

  // Перезарядка — правило игры, а не античит-проверка: без неё тяжёлые
  // свитки читались бы так часто, как хватает маны, и баланс каста рушится.
  const readyAt = actor.spellCooldowns[spellId] ?? 0;
  if (world.elapsed < readyAt) {
    return `${SPELLS[spellId].name}: ещё не готово`;
  }

  const spell = SPELLS[spellId];
  if (!payForSpell(combat, spellId)) return 'Не хватает маны';

  actor.pendingViewTick = viewTick;

  // Каст занимает время и его видно — это цена силы заклинания.
  combat.action = beginAction(
    {
      kind: 'cast',
      name: spell.name,
      timing: { windup: spell.castTime, active: 0.05, recovery: 0.3 },
      staminaCost: 0,
      damageScale: 1,
      range: spell.range,
      // Кольцо бьёт вокруг, снаряд летит вперёд: целиться ни тому, ни другому
      // не нужно, и раствора у заклинаний больше нет.
      arc: 0,
    },
    spellId,
  );

  return null;
}

/** Вставлен ли такой свиток в клетки умений. */
function scrollFor(actor: Player, spellId: SpellId): boolean {
  return actor.scrolls.items.some((item) => itemDef(item.defId).spellId === spellId);
}
