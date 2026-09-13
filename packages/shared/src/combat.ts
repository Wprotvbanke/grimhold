import type { Attributes } from './stats.js';
import type { Vec3 } from './math.js';
import { SPRINT_SPEED_SCALE } from './movement.js';

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
  timing: { windup: 0.26, active: 0.1, recovery: 0.3 },
  staminaCost: 12,
  damageScale: 1,
  range: 2.4,
  arc: Math.PI / 4,
};

/** Тяжёлый удар: долгий замах, зато пробивает блок и бьёт по дуге шире. */
export const HEAVY_ATTACK: ActionProfile = {
  kind: 'heavy',
  name: 'Тяжёлый удар',
  timing: { windup: 0.62, active: 0.14, recovery: 0.45 },
  staminaCost: 25,
  damageScale: 2.1,
  range: 2.8,
  arc: Math.PI / 3,
};

/**
 * Рывок: короткая неуязвимость в фазе удара — это и есть уклонение.
 *
 * Бросок намеренно короткий: длинный превращался в способ передвижения —
 * им было выгоднее ходить, чем бегать. Зато после него остаётся накат
 * (`DODGE_GLIDE_SCALE`) — тело не встаёт как вкопанное.
 */
export const DODGE: ActionProfile = {
  kind: 'dodge',
  name: 'Рывок',
  timing: { windup: 0.05, active: 0.15, recovery: 0.2 },
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

/**
 * Накат после рывка: во время восстановления скорость гасится не мгновенно.
 *
 * Без него бросок обрывался в стену — разогнался втрое и в тот же кадр встал.
 * Держится ровно фазу восстановления рывка и считается из фазы действия,
 * которую обе стороны знают и так, — лишнего состояния в снапшоте не нужно.
 */
export const DODGE_GLIDE_SCALE = 1.7;

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

/** Пауза между рывками. Без неё рывок спамится, и уклонение перестаёт быть выбором. */
export const DODGE_COOLDOWN = 1.4;

/**
 * Пауза между ударами — время, за которое персонаж «собирается» после серии.
 *
 * Без неё удар начинался прямо в фазе восстановления предыдущего, и мышь
 * можно было щёлкать без остановки: урон шёл сплошным потоком, опережая
 * собственную анимацию. Пауза невелика — она задаёт ритм, а не отнимает
 * управление; с ней полный цикл лёгкого удара выходит около секунды.
 */
export const ATTACK_COOLDOWN = 0.3;

/** Стамина в секунду, пока бежишь. */
export const SPRINT_DRAIN = 16;

/**
 * Модификаторы скорости движения.
 *
 * Считаются одной формулой на клиенте и на сервере — иначе предсказание
 * разъезжается каждый раз, когда игрок поднимает щит или бежит, и сервер
 * начинает дёргать его назад. Клиент берёт значения из своего намерения,
 * сервер — из авторитетного состояния; расхождение гасит реконсилиация.
 */
export interface SpeedModifiers {
  blocking: boolean;
  /** Фаза рывка: короткий бросок с неуязвимостью. */
  dashing: boolean;
  /** Восстановление после рывка: инерция, с которой он затухает. */
  gliding: boolean;
  sprinting: boolean;
  /** Замах или восстановление обычного действия — они сковывают. */
  acting: boolean;
  /** Замедление от стужи: 1, если его нет. */
  slowFactor: number;
  /** Штраф за перегруз: 1, если вес в пределах. */
  weightFactor: number;
}

export function movementSpeedFactor(modifiers: SpeedModifiers): number {
  let scale = modifiers.slowFactor * modifiers.weightFactor;

  // Рывок перебивает всё: это короткий бросок, а не способ ходить.
  if (modifiers.dashing) return scale * DODGE_SPEED_SCALE;
  // Сразу за ним — накат: скорость спадает, а не обрывается.
  if (modifiers.gliding) return scale * DODGE_GLIDE_SCALE;

  if (modifiers.blocking) scale *= BLOCK_SPEED_SCALE;
  else if (modifiers.sprinting) scale *= SPRINT_SPEED_SCALE;

  if (modifiers.acting) scale *= 0.35;
  return scale;
}

/** Урон в спину. Бой от первого лица без этого не наказывает за потерю цели. */
/**
 * Цена частой смерти.
 *
 * Первый раз лежишь `RESPAWN_DELAY` секунд, каждая следующая быстрая смерть
 * удваивает срок — до `RESPAWN_STREAK_MAX` удвоений. Прожил `RESPAWN_FORGIVE`
 * без смертей — счётчик обнуляется.
 *
 * Три секунды делали смерть бесплатной: поднялся в городе, добежал, полез
 * снова, и так без конца. Наказывается упорство, а не невезение: одна смерть
 * стоит дёшево, десять подряд — дорого.
 *
 * Правило живёт в общем коде, хотя считает его только сервер: срок видит
 * игрок на экране смерти, и по нему же ждут сквозные проверки — иначе они
 * ждали бы вслепую, зашитым числом.
 */
export const RESPAWN_DELAY = 10;
export const RESPAWN_STREAK_MAX = 4;
export const RESPAWN_FORGIVE = 600;

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
