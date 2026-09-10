import {
  CORPSE_SECONDS,
  MOBS,
  attributesFor,
  createMoveState,
  fullVitals,
  type MobId,
  type MobProfile,
  type MoveInput,
  type MoveState,
  type Vec3,
} from '@grimhold/shared';
import type { Combatant } from './combatant.js';

/**
 * Мобы.
 *
 * Конечный автомат: дремлет → заметил → преследует → бьёт → возвращается.
 * Двигается через тот же step(), что и игроки, поэтому коллизии, скорость
 * и работа с чанками у него уже правильные.
 *
 * Навмеша нет: моб идёт к цели напрямую и честно упирается в камни.
 * Это осознанное упрощение — вокруг открытые дикие земли, а не лабиринт.
 */

export type MobPhase = 'idle' | 'chase' | 'attack' | 'return' | 'dead';

export interface Mob extends Combatant {
  mobId: MobId;
  profile: MobProfile;
  state: MoveState;
  phase: MobPhase;
  /** Точка спавна: дальше leash от неё моб не уходит. */
  home: Vec3;
  targetId: string | null;
  /** Секунд до следующего удара. */
  attackCooldown: number;
  /** Секунд до конца замаха, если он замахнулся. */
  windupRemaining: number;
  /** Секунд до воскрешения после смерти. */
  respawnIn: number;
}

const RESPAWN_SECONDS = 45;
/** Насколько дольше aggroRange моб держится за цель, прежде чем бросить. */
const CHASE_TOLERANCE = 1.6;

export function createMob(id: string, mobId: MobId, home: Vec3, instanceId: string): Mob {
  const profile = MOBS[mobId];
  // Атрибуты мобу нужны только ради общих формул регенерации.
  const attributes = attributesFor('human', 'warrior');
  const vitals = fullVitals(attributes);
  vitals.health = profile.health;

  return {
    id,
    name: profile.name,
    instanceId,
    mobId,
    profile,
    pos: { ...home },
    yaw: 0,
    radius: profile.radius,
    height: profile.height,
    vitals,
    attributes,
    armor: profile.armor,
    alive: true,
    action: null,
    blocking: false,
    invulnerable: 0,
    sinceStaminaUse: 0,
    wardArmor: 0,
    wardRemaining: 0,
    slowFactor: 1,
    slowRemaining: 0,
    lightRemaining: 0,
    state: createMoveState(home, {
      body: { radius: profile.radius, height: profile.height },
      speedScale: profile.speedScale,
    }),
    phase: 'idle',
    home: { ...home },
    targetId: null,
    attackCooldown: 0,
    windupRemaining: 0,
    respawnIn: 0,
  };
}

export interface MobTarget {
  id: string;
  pos: Vec3;
  alive: boolean;
}

export interface MobDecision {
  /** Намерение движения — уходит в общий step(). */
  input: MoveInput;
  /** Моб завершил замах и бьёт: сервер должен проверить попадание. */
  strike: boolean;
}

/**
 * Один шаг мышления моба. Чистая логика: ничего не мутирует, кроме самого моба,
 * и не знает ни о сети, ни о базе.
 */
export function decideMob(mob: Mob, candidates: MobTarget[], dt: number): MobDecision {
  const idle: MoveInput = {
    seq: 0,
    forward: 0,
    right: 0,
    yaw: mob.yaw,
    pitch: 0,
    jump: false,
    dt,
  };

  mob.attackCooldown = Math.max(0, mob.attackCooldown - dt);

  if (!mob.alive) {
    mob.phase = 'dead';
    return { input: idle, strike: false };
  }

  // Замах уже идёт — доводим его до удара, что бы ни случилось.
  if (mob.windupRemaining > 0) {
    mob.windupRemaining -= dt;
    if (mob.windupRemaining <= 0) {
      mob.windupRemaining = 0;
      mob.attackCooldown = mob.profile.attackCooldown;
      return { input: { ...idle, yaw: mob.yaw }, strike: true };
    }
    return { input: { ...idle, yaw: mob.yaw }, strike: false };
  }

  const target = mob.targetId
    ? candidates.find((c) => c.id === mob.targetId && c.alive)
    : undefined;

  const distanceHome = horizontalDistance(mob.pos, mob.home);

  // Ушёл слишком далеко от дома — бросает цель и возвращается.
  if (distanceHome > mob.profile.leash) {
    mob.targetId = null;
    mob.phase = 'return';
    return { input: moveToward(mob, mob.home, dt), strike: false };
  }

  if (target) {
    const distance = horizontalDistance(mob.pos, target.pos);

    // Цель убежала слишком далеко — теряем интерес.
    if (distance > mob.profile.aggroRange * CHASE_TOLERANCE) {
      mob.targetId = null;
      mob.phase = 'return';
      return { input: moveToward(mob, mob.home, dt), strike: false };
    }

    mob.yaw = yawToward(mob.pos, target.pos);

    if (distance <= mob.profile.attackRange) {
      mob.phase = 'attack';
      // Замах виден игроку — за это время можно отойти или поставить блок.
      if (mob.attackCooldown <= 0) mob.windupRemaining = mob.profile.windup;
      return { input: { ...idle, yaw: mob.yaw }, strike: false };
    }

    mob.phase = 'chase';
    return { input: moveToward(mob, target.pos, dt), strike: false };
  }

  // Цели нет — ищем ближайшую в радиусе обнаружения.
  let nearest: MobTarget | null = null;
  let nearestDistance = mob.profile.aggroRange;
  for (const candidate of candidates) {
    if (!candidate.alive) continue;
    const distance = horizontalDistance(mob.pos, candidate.pos);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  if (nearest) {
    mob.targetId = nearest.id;
    mob.phase = 'chase';
    return { input: moveToward(mob, nearest.pos, dt), strike: false };
  }

  // Никого рядом: возвращаемся домой или дремлем.
  if (distanceHome > 1.5) {
    mob.phase = 'return';
    return { input: moveToward(mob, mob.home, dt), strike: false };
  }

  mob.phase = 'idle';
  return { input: idle, strike: false };
}

/** Отсчёт до воскрешения. Возвращает true, если моба пора поднимать. */
export function tickRespawn(mob: Mob, dt: number): boolean {
  if (mob.alive) return false;
  mob.respawnIn -= dt;
  if (mob.respawnIn > 0) return false;

  mob.alive = true;
  mob.vitals.health = mob.profile.health;
  mob.pos = { ...mob.home };
  mob.state = createMoveState(mob.home, {
    body: { radius: mob.profile.radius, height: mob.profile.height },
    speedScale: mob.profile.speedScale,
  });
  mob.phase = 'idle';
  mob.targetId = null;
  mob.windupRemaining = 0;
  return true;
}

/**
 * Видно ли ещё тело. Первые CORPSE_SECONDS после смерти моб остаётся
 * в снапшотах с признаком alive: false, чтобы клиент успел уронить его,
 * а не убрать из сцены мгновенно.
 */
export function isCorpseVisible(mob: Mob): boolean {
  return !mob.alive && mob.respawnIn > RESPAWN_SECONDS - CORPSE_SECONDS;
}

export function killMob(mob: Mob): void {
  mob.alive = false;
  mob.phase = 'dead';
  mob.targetId = null;
  mob.windupRemaining = 0;
  mob.respawnIn = RESPAWN_SECONDS;
}

function moveToward(mob: Mob, destination: Vec3, dt: number): MoveInput {
  const yaw = yawToward(mob.pos, destination);
  mob.yaw = yaw;
  return { seq: 0, forward: 1, right: 0, yaw, pitch: 0, jump: false, dt };
}

/** При forward = 1 движение идёт в (-sin yaw, -cos yaw) — отсюда обратное преобразование. */
function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
