import type { Attributes } from './stats.js';
import type { Vec3 } from './math.js';

/**
 * Бой в реальном времени.
 *
 * Атака проходит три фазы: замах, удар, восстановление. Попадание проверяется
 * ровно один раз — в начале фазы удара, — и проверяет его сервер. Клиент может
 * прислать только намерение «бью», всё остальное считает сервер.
 *
 * Фазы важны геймплейно: замах видно, значит от удара можно отойти, поставить
 * блок или прервать его своим ударом. Без фаз бой превращается в обмен кликами.
 */

export type ActionKind = 'attack' | 'heavy' | 'block' | 'dodge' | 'cast';
export type ActionPhase = 'windup' | 'active' | 'recovery';

export interface ActionTiming {
  windup: number;
  active: number;
  recovery: number;
}

export interface ActionProfile {
  kind: ActionKind;
  name: string;
  timing: ActionTiming;
  staminaCost: number;
  /** Множитель урона от базового удара. */
  damageScale: number;
  /** Дальность в метрах. */
  range: number;
  /** Половина угла раствора конуса поражения, радианы. */
  arc: number;
}

/** Быстрый удар: короткий замах, малый урон — им перебивают чужой замах. */
export const LIGHT_ATTACK: ActionProfile = {
  kind: 'attack',
  name: 'Быстрый удар',
  timing: { windup: 0.18, active: 0.1, recovery: 0.25 },
  staminaCost: 12,
  damageScale: 1,
  range: 2.4,
  arc: Math.PI / 4,
};

/** Тяжёлый удар: долгий замах, зато пробивает блок и бьёт по дуге шире. */
export const HEAVY_ATTACK: ActionProfile = {
  kind: 'heavy',
  name: 'Тяжёлый удар',
  timing: { windup: 0.45, active: 0.14, recovery: 0.45 },
  staminaCost: 25,
  damageScale: 2.1,
  range: 2.8,
  arc: Math.PI / 3,
};

/** Рывок: короткая неуязвимость в фазе удара — это и есть уклонение. */
export const DODGE: ActionProfile = {
  kind: 'dodge',
  name: 'Рывок',
  timing: { windup: 0.05, active: 0.3, recovery: 0.2 },
  staminaCost: 22,
  damageScale: 0,
  range: 0,
  arc: 0,
};

export const ACTIONS: Record<Exclude<ActionKind, 'block' | 'cast'>, ActionProfile> = {
  attack: LIGHT_ATTACK,
  heavy: HEAVY_ATTACK,
  dodge: DODGE,
};

/** Скорость рывка. Умножается на скорость ходьбы. */
export const DODGE_SPEED_SCALE = 3.4;

/** Стамина в секунду, пока держат блок. */
export const BLOCK_DRAIN = 8;
/** Какую долю урона гасит блок. */
export const BLOCK_REDUCTION = 0.75;
/** Тяжёлый удар пробивает блок: гасится хуже и ломает стойку. */
export const BLOCK_REDUCTION_VS_HEAVY = 0.35;
/** Стамина, снимаемая с блокирующего при попадании. */
export const BLOCK_STAMINA_HIT = 18;
/** Скорость передвижения с поднятым щитом. */
export const BLOCK_SPEED_SCALE = 0.45;

/** Урон в спину. Бой от первого лица без этого не наказывает за потерю цели. */
export const BACKSTAB_MULTIPLIER = 1.6;
/** Угол сзади, считающийся спиной. */
export const BACKSTAB_ARC = Math.PI / 3;

export interface ActionState {
  kind: ActionKind;
  phase: ActionPhase;
  /** Секунд до конца текущей фазы. */
  remaining: number;
  /** Проверка попадания делается один раз за действие. */
  resolved: boolean;
  /** Для заклинаний. */
  spellId?: string;
}

export function beginAction(profile: ActionProfile, spellId?: string): ActionState {
  return {
    kind: profile.kind,
    phase: 'windup',
    remaining: profile.timing.windup,
    resolved: false,
    spellId,
  };
}

/**
 * Двигает действие по фазам. Возвращает null, когда действие закончилось.
 * Чистая функция: и сервер, и клиент считают одинаково.
 */
export function advanceAction(
  state: ActionState,
  timing: ActionTiming,
  dt: number,
): ActionState | null {
  let remaining = state.remaining - dt;
  let phase = state.phase;

  while (remaining <= 0) {
    if (phase === 'windup') {
      phase = 'active';
      remaining += timing.active;
    } else if (phase === 'active') {
      phase = 'recovery';
      remaining += timing.recovery;
    } else {
      return null;
    }
  }

  return { ...state, phase, remaining };
}

export function timingOf(kind: ActionKind): ActionTiming {
  if (kind === 'attack') return LIGHT_ATTACK.timing;
  if (kind === 'heavy') return HEAVY_ATTACK.timing;
  if (kind === 'dodge') return DODGE.timing;
  // Блок и каст держатся до отпускания либо задаются заклинанием.
  return { windup: 0.1, active: 0.1, recovery: 0.1 };
}

// ---------- формулы ----------

/**
 * Базовый урон удара. Навык влияет заметно, но не решает всё:
 * ветеран сильнее новичка примерно вдвое, а не вдесятеро — иначе
 * новичку нечего делать в подземелье, где ставка полная.
 */
export function meleeDamage(
  attributes: Attributes,
  weaponDamage: number,
  skillLevel: number,
  scale: number,
): number {
  const strength = 1 + attributes.strength * 0.03;
  const skill = 1 + skillLevel * 0.008;
  return weaponDamage * strength * skill * scale;
}

export function spellDamage(attributes: Attributes, base: number, skillLevel: number): number {
  const intellect = 1 + attributes.intellect * 0.04;
  const skill = 1 + skillLevel * 0.01;
  return base * intellect * skill;
}

/** Броня режет урон по убывающей: 50 брони — половина, 100 — две трети. */
export function applyArmor(damage: number, armor: number): number {
  return damage * (50 / (50 + Math.max(armor, 0)));
}

// ---------- геометрия попадания ----------

/** Цель внутри конуса перед атакующим? Конус, а не луч: бой не снайперский. */
export function inAttackCone(
  attacker: Vec3,
  attackerYaw: number,
  target: Vec3,
  range: number,
  arc: number,
  targetRadius: number,
): boolean {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const distance = Math.hypot(dx, dz);

  if (distance > range + targetRadius) return false;
  // Вплотную бьём без проверки угла — иначе нельзя попасть в упор.
  if (distance < 0.35) return true;

  // Направление взгляда при yaw: (-sin, -cos).
  const forwardX = -Math.sin(attackerYaw);
  const forwardZ = -Math.cos(attackerYaw);
  const cosAngle = (dx * forwardX + dz * forwardZ) / distance;

  // Крупная цель прощает промах по углу — иначе в упор мажешь по гиганту.
  const forgiveness = Math.atan2(targetRadius, Math.max(distance, 0.1));
  return cosAngle >= Math.cos(Math.min(arc + forgiveness, Math.PI));
}

/** Удар пришёлся в спину? */
export function isBackstab(attackerPos: Vec3, targetPos: Vec3, targetYaw: number): boolean {
  const dx = attackerPos.x - targetPos.x;
  const dz = attackerPos.z - targetPos.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.01) return false;

  // Спина цели — направление, противоположное её взгляду.
  const backX = Math.sin(targetYaw);
  const backZ = Math.cos(targetYaw);
  const cosAngle = (dx * backX + dz * backZ) / distance;
  return cosAngle >= Math.cos(BACKSTAB_ARC);
}
