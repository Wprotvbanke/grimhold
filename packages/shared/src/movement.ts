import { type Aabb, type Vec3, aabbOverlap, clamp, cloneVec3 } from './math.js';

/**
 * Единственная реализация шага симуляции движения.
 * Вызывается сервером (авторитет) и клиентом (предсказание) — намеренно одна и та же
 * функция, потому что две расходящиеся реализации ломают реконсилиацию.
 *
 * Функция чистая и детерминированная: одинаковый вход даёт одинаковый выход.
 */

export const WALK_SPEED = 5.0;
export const GRAVITY = -24.0;
export const JUMP_SPEED = 7.5;
export const MAX_FALL_SPEED = -50.0;

/** Габариты по умолчанию (человек). Позиция — точка на полу между ступнями. */
export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.65;

/** Габариты конкретного тела: у дворфа и эльфа они свои. */
export interface Body {
  radius: number;
  height: number;
}

export const DEFAULT_BODY: Body = { radius: PLAYER_RADIUS, height: PLAYER_HEIGHT };

/** Высота глаз пропорциональна росту тела. */
export function eyeHeight(body: Body): number {
  return body.height * (EYE_HEIGHT / PLAYER_HEIGHT);
}

/** Ограничение шага, чтобы фриз кадра или зависший таб не телепортировали игрока. */
export const MAX_STEP_DT = 0.1;

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  body: Body;
  /** Множитель скорости: раса, а позже вес и стамина. */
  speedScale: number;
}

/** Намерение игрока за кадр. Клиент никогда не присылает позицию — только это. */
export interface MoveInput {
  seq: number;
  /** -1..1, вперёд положительно */
  forward: number;
  /** -1..1, вправо положительно */
  right: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  dt: number;
}

export function createMoveState(
  pos: Vec3,
  options: { body?: Body; speedScale?: number } = {},
): MoveState {
  return {
    pos: cloneVec3(pos),
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: false,
    body: options.body ?? { ...DEFAULT_BODY },
    speedScale: options.speedScale ?? 1,
  };
}

export function playerAabb(pos: Vec3, body: Body = DEFAULT_BODY): Aabb {
  return {
    minX: pos.x - body.radius,
    minY: pos.y,
    minZ: pos.z - body.radius,
    maxX: pos.x + body.radius,
    maxY: pos.y + body.height,
    maxZ: pos.z + body.radius,
  };
}

/**
 * Продвигает состояние на один шаг. Не мутирует вход.
 * Коллизии разрешаются по осям раздельно — это даёт скольжение вдоль стен
 * и не даёт застревать в углах.
 */
export function step(state: MoveState, input: MoveInput, colliders: readonly Aabb[]): MoveState {
  const dt = clamp(input.dt, 0, MAX_STEP_DT);

  const yaw = input.yaw;
  const pitch = clamp(input.pitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);

  // Направление взгляда в плоскости XZ. Камера смотрит по -Z при yaw = 0.
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  let wishX = -sin * input.forward + cos * input.right;
  let wishZ = -cos * input.forward - sin * input.right;

  // Нормализация, чтобы движение по диагонали не было быстрее прямого.
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  const speed = WALK_SPEED * state.speedScale;
  const vel: Vec3 = {
    x: wishX * speed,
    y: state.vel.y,
    z: wishZ * speed,
  };

  if (input.jump && state.onGround) {
    vel.y = JUMP_SPEED;
  }

  vel.y = Math.max(vel.y + GRAVITY * dt, MAX_FALL_SPEED);

  const pos = cloneVec3(state.pos);

  const body = state.body;

  // X
  pos.x += vel.x * dt;
  if (resolveAxis(pos, colliders, 'x', vel.x, body)) {
    vel.x = 0;
  }

  // Z
  pos.z += vel.z * dt;
  if (resolveAxis(pos, colliders, 'z', vel.z, body)) {
    vel.z = 0;
  }

  // Y — здесь же определяется контакт с землёй.
  pos.y += vel.y * dt;
  let onGround = false;
  if (resolveAxis(pos, colliders, 'y', vel.y, body)) {
    onGround = vel.y < 0;
    vel.y = 0;
  }

  return { pos, vel, yaw, pitch, onGround, body, speedScale: state.speedScale };
}

/**
 * Выталкивает игрока из всех пересекаемых боксов по одной оси.
 * Возвращает true, если было хотя бы одно столкновение.
 */
function resolveAxis(
  pos: Vec3,
  colliders: readonly Aabb[],
  axis: 'x' | 'y' | 'z',
  velocity: number,
  body: Body,
): boolean {
  if (velocity === 0) return false;

  let hit = false;
  for (const box of colliders) {
    if (!aabbOverlap(playerAabb(pos, body), box)) continue;

    hit = true;
    if (axis === 'x') {
      pos.x = velocity > 0 ? box.minX - body.radius : box.maxX + body.radius;
    } else if (axis === 'z') {
      pos.z = velocity > 0 ? box.minZ - body.radius : box.maxZ + body.radius;
    } else {
      pos.y = velocity > 0 ? box.minY - body.height : box.maxY;
    }
  }
  return hit;
}
