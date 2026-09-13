import {
  ATTACK_COOLDOWN,
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

export function startAttack(attacker: Combatant, kind: 'attack' | 'heavy' | 'dodge'): boolean {
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
      : base;

  if (!spendStamina(attacker, profile.staminaCost)) return false;

  if (kind === 'dodge') attacker.dodgeCooldown = dodgeCooldown(attacker.evasionSkill);
  else attacker.swingCooldown = ATTACK_COOLDOWN + profile.timing.windup + profile.timing.active;

  attacker.action = beginAction(profile);
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
    }
    if (result.blocked) {
      outcome.experience.push({ combatantId: hit.target.id, skill: 'block', amount: EXPERIENCE_PER_DEFENCE });
    }
    if (result.dodged) {
      outcome.experience.push({ combatantId: hit.target.id, skill: 'evasion', amount: EXPERIENCE_PER_DEFENCE });
    }
    if (result.killed) {
      punishKill(attacker, hit.target);
      outcome.deaths.push({ victim: hit.target, killer: attacker });
    }
  }

  return outcome;
}

/** Урон в конусе — стужа и подобное. Отматывания не требует: конус широкий. */
export function resolveCone(
  caster: Combatant,
  spellId: SpellId,
  targets: Combatant[],
  skillLevel: number,
): CombatOutcome {
  const outcome = emptyOutcome();
  const spell = SPELLS[spellId];
  const arc = spell.arc ?? Math.PI / 4;

  for (const target of targets) {
    // Стужа подчиняется тем же правилам, что меч и снаряд: иначе в городе
    // нельзя было бы ударить, но можно было бы заморозить.
    const verdict = mayAttack(caster, target);
    if (!verdict.ok) {
      if (verdict.reason && inAttackCone(caster.pos, caster.yaw, target.pos, spell.range, arc, target.radius)) {
        outcome.refusals.push({ attackerId: caster.id, reason: verdict.reason });
      }
      continue;
    }
    if (!inAttackCone(caster.pos, caster.yaw, target.pos, spell.range, arc, target.radius)) continue;

    markAggressor(caster, target);

    const raw = spellDamage(caster.attributes, spell.power, skillLevel);
    const result = applyDamage(target, raw, {
      blockReduction: BLOCK_REDUCTION * 0.5,
      staminaOnBlock: BLOCK_STAMINA_HIT * 0.5,
    });

    // Стужа замедляет — это её смысл, а не урон.
    if (spell.duration && result.applied > 0) {
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

/** Заклинания на себя: лечение, броня, свет. */
export function resolveSelfSpell(
  caster: Combatant,
  spellId: SpellId,
  skillLevel: number,
  maxHealth: number,
): CombatOutcome {
  const outcome = emptyOutcome();
  const spell = SPELLS[spellId];

  if (spellId === 'mend') {
    const healed = Math.round(spellDamage(caster.attributes, spell.power, skillLevel));
    const before = caster.vitals.health;
    caster.vitals.health = Math.min(maxHealth, caster.vitals.health + healed);

    outcome.events.push({
      t: 'combat',
      kind: 'heal',
      attackerId: caster.id,
      attackerName: caster.name,
      targetId: caster.id,
      targetName: caster.name,
      amount: caster.vitals.health - before,
      backstab: false,
      x: caster.pos.x,
      y: caster.pos.y + caster.height * 0.7,
      z: caster.pos.z,
    });
  }

  if (spellId === 'wardskin') {
    caster.wardArmor = spell.power;
    caster.wardRemaining = spell.duration ?? 20;
  }

  if (spellId === 'lantern') {
    caster.lightRemaining = spell.duration ?? 120;
  }

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
