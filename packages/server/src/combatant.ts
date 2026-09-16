import {
  STAMINA_IDLE_DELAY,
  advanceAction,
  applyArmor,
  blockStaminaScale,
  blockedShare,
  staminaRegen,
  manaRegen,
  scaleTiming,
  timingOf,
  type ActionState,
  type Attributes,
  type Vec3,
  type Vitals,
} from '@grimhold/shared';

/**
 * Общая часть всего, что дерётся: игрок и моб.
 *
 * Единый интерфейс важен не ради красоты — он означает, что удар игрока по мобу
 * и удар моба по игроку проходят один и тот же код. Расхождение этих двух путей
 * это классический источник «по мне бьют сквозь блок, а я так не могу».
 */

export interface Combatant {
  id: string;
  name: string;
  /**
   * Игрок или зверь. От этого зависит, действуют ли правила PvP: между
   * игроками они есть, между игроком и мобом их нет и не будет.
   */
  kind: 'player' | 'mob';
  /**
   * Карма и остаток фиолетового. Живут на бойце, а не на игроке, потому что
   * читает их расчёт удара — а он видит только бойцов. У зверья всегда нули.
   */
  karma: number;
  purpleFor: number;
  instanceId: string;
  pos: Vec3;
  yaw: number;
  /** Радиус тела: по нему считается попадание. */
  radius: number;
  height: number;
  vitals: Vitals;
  attributes: Attributes;
  armor: number;
  alive: boolean;
  /** Текущее действие: замах, удар, восстановление. */
  action: ActionState | null;
  /** Держит ли блок. */
  blocking: boolean;
  /** Секунды оставшейся неуязвимости — даёт рывок. */
  invulnerable: number;
  /** Секунд с последней траты стамины: до паузы она не восстанавливается. */
  sinceStaminaUse: number;
  /**
   * Сколько ещё отходить после бега досуха.
   *
   * Живёт у бойца, а не у игрока: выдохнуться может любой, кто тратит стамину,
   * и правило одно на всех.
   */
  exhaustedFor: number;
  /**
   * Уровень навыка блока: им же считается, сколько урона погасит щит
   * и во сколько обойдётся стойка. У зверья ноль — щитов у них нет.
   */
  blockSkill: number;
  /**
   * Уровень уклонения: от него зависят откат рывка, его длина и цена.
   * У зверья ноль — рывков они не делают.
   */
  evasionSkill: number;
  /**
   * Сколько секунд ещё засчитывается ответ после ухода рывком.
   *
   * Уклонение учится не уходом, а **уходом с ответом**: ушёл от удара
   * и тут же достал врага. Рывок сам по себе делают и просто так.
   */
  riposteFor: number;
  /** Временная прибавка к броне от заклинания и сколько ей осталось. */
  wardArmor: number;
  wardRemaining: number;
  /** Замедление от стужи. */
  slowFactor: number;
  slowRemaining: number;
  /** Сколько ещё горит «Светоч». В подземелье это будет выбор: видеть или прятаться. */
  lightRemaining: number;
  /** Секунд до следующего возможного рывка. */
  dodgeCooldown: number;
  /**
   * Секунд до следующего возможного удара — пауза между сериями.
   *
   * Не путать с `attackCooldown` у моба: там темп, которым ИИ решает бить,
   * а здесь общая для всех бойцов пауза после взмаха.
   */
  swingCooldown: number;
}

export interface DamageResult {
  applied: number;
  blocked: boolean;
  dodged: boolean;
  killed: boolean;
}

/**
 * Единственное место, где убавляется здоровье.
 * Блок, неуязвимость и броня применяются здесь — чтобы ни один путь урона
 * не мог их случайно обойти.
 */
export function applyDamage(
  target: Combatant,
  rawDamage: number,
  options: { blockReduction: number; staminaOnBlock: number },
): DamageResult {
  if (!target.alive) {
    return { applied: 0, blocked: false, dodged: false, killed: false };
  }

  // Рывок: в фазе удара персонаж неуязвим — это и есть уклонение.
  if (target.invulnerable > 0) {
    return { applied: 0, blocked: false, dodged: true, killed: false };
  }

  let damage = applyArmor(rawDamage, target.armor + effectiveWard(target));
  let blocked = false;

  if (target.blocking && target.vitals.stamina > 0) {
    blocked = true;
    /**
     * Насколько хорошо принят удар, решает **навык того, кто принимает**.
     *
     * Уровень едет вместе с бойцом (`blockSkill`), а не ищется по книге
     * навыков: бить могут и по мобу, и по игроку, а applyDamage должен
     * оставаться одним на всех.
     */
    damage *= 1 - blockedShare(options.blockReduction, target.blockSkill);
    const cost = options.staminaOnBlock * blockStaminaScale(target.blockSkill);
    target.vitals.stamina = Math.max(0, target.vitals.stamina - cost);
    target.sinceStaminaUse = 0;
    // Стамина кончилась — стойка сломана, блок падает.
    if (target.vitals.stamina <= 0) target.blocking = false;
  }

  const applied = Math.max(1, Math.round(damage));
  target.vitals.health -= applied;

  const killed = target.vitals.health <= 0;
  if (killed) {
    target.vitals.health = 0;
    target.alive = false;
    target.action = null;
    target.blocking = false;
  }

  return { applied, blocked, dodged: false, killed };
}

export function effectiveWard(combatant: Combatant): number {
  return combatant.wardRemaining > 0 ? combatant.wardArmor : 0;
}

/** Множитель скорости от эффектов. */
export function speedMultiplier(combatant: Combatant): number {
  return combatant.slowRemaining > 0 ? combatant.slowFactor : 1;
}

/**
 * Тик состояния бойца: фазы действия, регенерация, затухание эффектов.
 * Возвращает фазу, в которую действие только что перешло, — по ней сервер
 * понимает, что пора проверять попадание.
 */
export function tickCombatant(
  combatant: Combatant,
  dt: number,
  maxima: { health: number; mana: number; stamina: number },
): { enteredActive: boolean; finished: boolean } {
  combatant.invulnerable = Math.max(0, combatant.invulnerable - dt);
  combatant.wardRemaining = Math.max(0, combatant.wardRemaining - dt);
  combatant.slowRemaining = Math.max(0, combatant.slowRemaining - dt);
  combatant.lightRemaining = Math.max(0, combatant.lightRemaining - dt);
  combatant.dodgeCooldown = Math.max(0, combatant.dodgeCooldown - dt);
  combatant.swingCooldown = Math.max(0, combatant.swingCooldown - dt);
  combatant.sinceStaminaUse += dt;
  combatant.exhaustedFor = Math.max(0, combatant.exhaustedFor - dt);
  combatant.riposteFor = Math.max(0, combatant.riposteFor - dt);

  let enteredActive = false;
  let finished = false;

  if (combatant.action) {
    const before = combatant.action.phase;
    // Темп оружия едет в самом действии: у топора фазы вдвое длиннее.
    const next = advanceAction(
      combatant.action,
      scaleTiming(timingOf(combatant.action.kind), combatant.action.scale ?? 1),
      dt,
    );
    if (!next) {
      combatant.action = null;
      finished = true;
    } else {
      combatant.action = next;
      enteredActive = before !== 'active' && next.phase === 'active';
    }
  }

  if (!combatant.alive) return { enteredActive, finished };

  // Стамина восстанавливается только после паузы: иначе блок держат вечно.
  if (combatant.sinceStaminaUse >= STAMINA_IDLE_DELAY && !combatant.blocking) {
    combatant.vitals.stamina = Math.min(
      maxima.stamina,
      combatant.vitals.stamina + staminaRegen(combatant.attributes) * dt,
    );
  }

  combatant.vitals.mana = Math.min(
    maxima.mana,
    combatant.vitals.mana + manaRegen(combatant.attributes) * dt,
  );

  return { enteredActive, finished };
}

/** Списывает стамину, если её хватает. Возвращает false, если нет. */
export function spendStamina(combatant: Combatant, cost: number): boolean {
  if (combatant.vitals.stamina < cost) return false;
  combatant.vitals.stamina -= cost;
  combatant.sinceStaminaUse = 0;
  return true;
}

export function spendMana(combatant: Combatant, cost: number): boolean {
  if (combatant.vitals.mana < cost) return false;
  combatant.vitals.mana -= cost;
  return true;
}
