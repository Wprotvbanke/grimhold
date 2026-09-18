import {
  type ActionTiming,
  ATTACK_COOLDOWN,
  scaleTiming,
  ACTIONS,
  BACKSTAB_MULTIPLIER,
  BLOCK_REDUCTION,
  BLOCK_REDUCTION_VS_HEAVY,
  BLOCK_STAMINA_HIT,
  DODGE,
  DODGE_COOLDOWN,
  dodgeCooldown,
  dodgeCost,
  dodgeTiming,
  DODGE_SPEED_SCALE,
  EXPERIENCE_PER_DEFENCE,
  EXPERIENCE_PER_RIPOSTE,
  RIPOSTE_SECONDS,
  EXPERIENCE_PER_HIT,
  SPELLS,
  beginAction,
  inAttackCone,
  isBackstab,
  meleeDamage,
  spellDamage,
  type ActionProfile,
  type CombatEvent,
  type SkillId,
  type SpellId,
  type Vec3,
} from '@grimhold/shared';
import { applyDamage, spendMana, spendStamina, type Combatant } from './combatant.js';
import { markAggressor, mayAttack, punishKill } from './pvp.js';
import { PositionHistory } from './history.js';

/**
 * Разрешение боевых действий.
 *
 * Здесь и только здесь решается, кто в кого попал. Клиент присылает намерение
 * и номер снапшота, который он видел; всё остальное — сервер.
 */

/** Базовый урон безоружного удара, пока нет инвентаря и оружия. */
export const FIST_DAMAGE = 9;

export interface CombatOutcome {
  events: CombatEvent[];
  /** Кому и за что начислить опыт навыка. */
  experience: { combatantId: string; skill: SkillId; amount: number }[];
  /** Кто погиб в результате. */
  deaths: { victim: Combatant; killer: Combatant }[];
  /**
   * Почему удар не дошёл до того, кто стоял под ним.
   *
   * Молчаливый промах по человеку в городе выглядит как поломка: замах есть,
   * цель в двух шагах, урона нет. Сказать причину дешевле, чем объяснять её
   * потом.
   */
  refusals: { attackerId: string; reason: string }[];
}

function emptyOutcome(): CombatOutcome {
  return { events: [], experience: [], deaths: [], refusals: [] };
}

/** Может ли боец начать новое действие. */
export function canAct(combatant: Combatant): boolean {
  if (!combatant.alive) return false;
  // Действие доигрывается целиком, включая восстановление. Раньше новый удар
  // разрешался уже в фазе восстановления — тем самым она отменялась, и серия
  // шла без единой паузы.
  if (combatant.action) return false;
  return true;
}

export function startAttack(
  attacker: Combatant,
  kind: 'attack' | 'heavy' | 'dodge',
  swingScale = 1,
  staminaScale = 1,
  /** Свои фазы оружия (лук): перебивают множитель. */
  attackTiming: ActionTiming | null = null,
): boolean {
  if (!canAct(attacker)) return false;

  // Рывок на перезарядке: без паузы им спамят, и уклонение перестаёт быть выбором.
  if (kind === 'dodge' && attacker.dodgeCooldown > 0) return false;
  // Удар тоже не бесконечен: между сериями нужна пауза, иначе урон идёт
  // сплошным потоком и опережает анимацию.
  if (kind !== 'dodge' && attacker.swingCooldown > 0) return false;

  /**
   * Рывок зависит от навыка уклонения: он готов раньше, летит дальше
   * и стоит дешевле. Удары от навыка не зависят — там растёт урон, а не темп.
   */
  const base = ACTIONS[kind];
  const profile =
    kind === 'dodge'
      ? {
          ...base,
          timing: dodgeTiming(attacker.evasionSkill),
          staminaCost: dodgeCost(attacker.evasionSkill),
        }
      : {
          ...base,
          // Тяжёлое оружие бьёт реже: фазы растягиваются под него целиком.
          // У лука фазы свои — долгий замах и короткий хвост.
          timing: attackTiming ?? scaleTiming(base.timing, swingScale),
          // А голыми руками бьют дешевле: цена зависит от того, что в руке.
          staminaCost: base.staminaCost * staminaScale,
        };

  if (!spendStamina(attacker, profile.staminaCost)) return false;

  if (kind === 'dodge') attacker.dodgeCooldown = dodgeCooldown(attacker.evasionSkill);
  else attacker.swingCooldown = ATTACK_COOLDOWN + profile.timing.windup + profile.timing.active;

  attacker.action = beginAction(
    profile,
    undefined,
    kind === 'dodge' ? 1 : swingScale,
    kind === 'dodge' ? null : attackTiming,
  );
  // Блок и удар несовместимы: щит опускается.
  attacker.blocking = false;
  return true;
}

/**
 * Рывок: неуязвимость на всю фазу удара плюс ускорение.
 *
 * Длину фазы считаем по навыку, а не берём из профиля: с уклонением она
 * растёт, и неуязвимость обязана расти вместе с броском — иначе ловкач летел
 * бы дальше, оставаясь уязвимым на хвосте полёта.
 */
export function applyDodgeImpulse(dodger: Combatant): number {
  dodger.invulnerable = dodgeTiming(dodger.evasionSkill).active;
  return DODGE_SPEED_SCALE;
}

/**
 * Проверка попадания ближнего удара. Вызывается один раз — в тот тик,
 * когда действие перешло в фазу удара.
 *
 * Цели отматываются назад по истории: игрок бил по тому, что видел на экране.
 */
export function resolveMelee(
  attacker: Combatant,
  kind: 'attack' | 'heavy',
  targets: Combatant[],
  history: PositionHistory,
  currentTick: number,
  viewTick: number,
  skill: { id: SkillId; level: number },
  weaponDamage = FIST_DAMAGE,
): CombatOutcome {
  const outcome = emptyOutcome();
  const profile: ActionProfile = ACTIONS[kind];
  const rewindTick = PositionHistory.clampRewind(currentTick, viewTick);

  interface Candidate {
    target: Combatant;
    pos: Vec3;
    yaw: number;
    distance: number;
  }

  const candidates: Candidate[] = [];
  for (const target of targets) {
    // Кого бить можно — решает один предикат на всю игру, см. pvp.ts.
    const verdict = mayAttack(attacker, target);
    if (!verdict.ok) {
      // Причина есть только у запретов PvP: «сам себя» и «другой инстанс»
      // объяснять нечего.
      if (verdict.reason && inAttackCone(attacker.pos, attacker.yaw, target.pos, profile.range, profile.arc, target.radius)) {
        outcome.refusals.push({ attackerId: attacker.id, reason: verdict.reason });
      }
      continue;
    }

    const past = history.at(target.id, rewindTick, { pos: target.pos, yaw: target.yaw });
    if (!inAttackCone(attacker.pos, attacker.yaw, past.pos, profile.range, profile.arc, target.radius)) {
      continue;
    }

    candidates.push({
      target,
      pos: past.pos,
      yaw: past.yaw,
      distance: Math.hypot(past.pos.x - attacker.pos.x, past.pos.z - attacker.pos.z),
    });
  }

  if (candidates.length === 0) {
    outcome.events.push(missEvent(attacker));
    return outcome;
  }

  candidates.sort((a, b) => a.distance - b.distance);
  // Быстрый удар бьёт одного, тяжёлый рубит по дуге всех, до кого дотянулся.
  const hits = kind === 'heavy' ? candidates : candidates.slice(0, 1);

  for (const hit of hits) {
    const backstab = isBackstab(attacker.pos, hit.pos, hit.yaw);
    let raw = meleeDamage(attacker.attributes, weaponDamage, skill.level, profile.damageScale);
    if (backstab) raw *= BACKSTAB_MULTIPLIER;

    // Поднял руку на мирного — стал фиолетовым. Считается по флагу **до**
    // удара: иначе убитый успел бы стать не-мирным сам по себе.
    markAggressor(attacker, hit.target);

    const result = applyDamage(hit.target, raw, {
      blockReduction: kind === 'heavy' ? BLOCK_REDUCTION_VS_HEAVY : BLOCK_REDUCTION,
      staminaOnBlock: BLOCK_STAMINA_HIT,
    });

    outcome.events.push({
      t: 'combat',
      kind: result.dodged ? 'dodged' : result.blocked ? 'blocked' : 'hit',
      attackerId: attacker.id,
      attackerName: attacker.name,
      targetId: hit.target.id,
      targetName: hit.target.name,
      amount: result.applied,
      backstab,
      x: hit.target.pos.x,
      y: hit.target.pos.y + hit.target.height * 0.7,
      z: hit.target.pos.z,
    });

    // Учит только результат: удар в пустоту не тренирует.
    if (!result.dodged) {
      outcome.experience.push({ combatantId: attacker.id, skill: skill.id, amount: EXPERIENCE_PER_HIT });

      // Достал врага сразу после ухода — вот это и есть уклонение.
      if (attacker.riposteFor > 0) {
        attacker.riposteFor = 0;
        outcome.experience.push({
          combatantId: attacker.id,
          skill: 'evasion',
          amount: EXPERIENCE_PER_RIPOSTE,
        });
      }
    }
    if (result.blocked) {
      outcome.experience.push({ combatantId: hit.target.id, skill: 'block', amount: EXPERIENCE_PER_DEFENCE });
    }
    /**
     * Уход **не учит сам по себе** — он открывает окно для ответа.
     *
     * Пока навык рос от самого ухода, тренировкой было «прыгай в сторону
     * рядом с крысой»: рывок делают и просто так, а опыт капал. Теперь надо
     * уйти от настоящего удара и тут же достать врага — см. `riposteFor`.
     */
    if (result.dodged) hit.target.riposteFor = RIPOSTE_SECONDS;
    if (result.killed) {
      punishKill(attacker, hit.target);
      outcome.deaths.push({ victim: hit.target, killer: attacker });
    }
  }

  return outcome;
}

/** Достаёт ли кольцо этого бойца: радиус меряется до его бока, а не до оси. */
function withinRing(caster: Combatant, target: Combatant, range: number): boolean {
  const dx = target.pos.x - caster.pos.x;
  const dz = target.pos.z - caster.pos.z;
  return Math.hypot(dx, dz) <= range + target.radius;
}

/**
 * Вспышка кольцом вокруг чтеца — «Заморозка».
 *
 * Кольцо, а не конус: свиток читают, когда обступили со всех сторон, и
 * заставлять при этом ещё и целиться значило бы отобрать у него весь смысл.
 * Отматывания времени не требует по той же причине — попасть тут нельзя мимо.
 */
export function resolveBurst(
  caster: Combatant,
  spellId: SpellId,
  targets: Combatant[],
  skillLevel: number,
  focus = 1,
): CombatOutcome {
  const outcome = emptyOutcome();
  const spell = SPELLS[spellId];

  for (const target of targets) {
    if (target.id === caster.id) continue;
    if (!withinRing(caster, target, spell.range)) continue;

    // Стужа подчиняется тем же правилам, что меч и снаряд: иначе в городе
    // нельзя было бы ударить, но можно было бы заморозить.
    const verdict = mayAttack(caster, target);
    if (!verdict.ok) {
      if (verdict.reason) outcome.refusals.push({ attackerId: caster.id, reason: verdict.reason });
      continue;
    }

    markAggressor(caster, target);

    const raw = spellDamage(caster.attributes, spell.power, skillLevel, focus);
    const result = applyDamage(target, raw, {
      blockReduction: BLOCK_REDUCTION * 0.5,
      staminaOnBlock: BLOCK_STAMINA_HIT * 0.5,
    });

    /**
     * Замедляет **даже когда урон не прошёл**.
     *
     * Свиток контроля тем и отличается от свитка разрушения: он про то,
     * чтобы не ушли. Щит от стужи спасает по здоровью, но не по ногам.
     */
    if (spell.duration && !result.dodged) {
      target.slowFactor = 0.55;
      target.slowRemaining = spell.duration;
    }

    outcome.events.push({
      t: 'combat',
      kind: result.dodged ? 'dodged' : result.blocked ? 'blocked' : 'hit',
      attackerId: caster.id,
      attackerName: caster.name,
      targetId: target.id,
      targetName: target.name,
      amount: result.applied,
      backstab: false,
      x: target.pos.x,
      y: target.pos.y + target.height * 0.7,
      z: target.pos.z,
    });

    if (!result.dodged) {
      outcome.experience.push({ combatantId: caster.id, skill: spell.skill, amount: EXPERIENCE_PER_HIT });
    }
    if (result.killed) {
      punishKill(caster, target);
      outcome.deaths.push({ victim: target, killer: caster });
    }
  }

  return outcome;
}

/**
 * Кольцо помощи — «Заживление ран» и «Каменная кожа».
 *
 * Помогает себе и **тем, кого бить нельзя**: союзнику, отряду, соседу
 * в мирной зоне. Свой определяется теми же правилами PvP, что и враг, и это
 * не хитрость, а единственный способ не завести вторую таблицу «кто чей»:
 * разойдись они, и лечение доставалось бы тому, кого ты только что ударил.
 *
 * Мобы под кольцо не попадают никогда: лечить волка незачем, а правила
 * дозволяют бить его всегда — значит «своим» он не станет.
 */
export function resolveBlessing(
  caster: Combatant,
  spellId: SpellId,
  targets: Combatant[],
  skillLevel: number,
  maxHealthOf: (combatant: Combatant) => number,
  focus = 1,
): CombatOutcome {
  const outcome = emptyOutcome();
  const spell = SPELLS[spellId];
  const power = spellDamage(caster.attributes, spell.power, skillLevel, focus);

  const blessed: Combatant[] = [caster];
  for (const target of targets) {
    if (target.id === caster.id || !target.alive) continue;
    if (target.kind !== 'player') continue;
    if (!withinRing(caster, target, spell.range)) continue;
    // Кого дозволено бить — тот не свой, и помощь ему не полагается.
    if (mayAttack(caster, target).ok) continue;
    blessed.push(target);
  }

  for (const target of blessed) {
    if (spellId === 'mend') {
      const before = target.vitals.health;
      target.vitals.health = Math.min(maxHealthOf(target), target.vitals.health + Math.round(power));
      const healed = target.vitals.health - before;
      if (healed <= 0) continue;

      outcome.events.push({
        t: 'combat',
        kind: 'heal',
        attackerId: caster.id,
        attackerName: caster.name,
        targetId: target.id,
        targetName: target.name,
        amount: healed,
        backstab: false,
        x: target.pos.x,
        y: target.pos.y + target.height * 0.7,
        z: target.pos.z,
      });
    }

    if (spellId === 'wardskin') {
      target.wardArmor = spell.power;
      target.wardRemaining = spell.duration ?? 20;
    }
  }

  outcome.experience.push({ combatantId: caster.id, skill: spell.skill, amount: EXPERIENCE_PER_HIT });
  return outcome;
}

/** Заклинания, которые действуют только на самого чтеца: свет и медитация. */
export function resolveSelfSpell(caster: Combatant, spellId: SpellId): CombatOutcome {
  const outcome = emptyOutcome();
  const spell = SPELLS[spellId];

  if (spellId === 'light') caster.lightRemaining = spell.duration ?? 120;

  outcome.experience.push({ combatantId: caster.id, skill: spell.skill, amount: EXPERIENCE_PER_HIT });
  return outcome;
}

/** Списывает ману под заклинание. */
export function payForSpell(caster: Combatant, spellId: SpellId): boolean {
  return spendMana(caster, SPELLS[spellId].manaCost);
}

function missEvent(attacker: Combatant): CombatEvent {
  return {
    t: 'combat',
    kind: 'miss',
    attackerId: attacker.id,
    attackerName: attacker.name,
    targetId: '',
    targetName: '',
    amount: 0,
    backstab: false,
    x: attacker.pos.x,
    y: attacker.pos.y,
    z: attacker.pos.z,
  };
}
