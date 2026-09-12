import { type Aabb, type Vec3, aabbOverlap, clamp, cloneVec3 } from './math.js';

/**
 * Единственная реализация шага симуляции движения.
 * Вызывается сервером (авторитет) и клиентом (предсказание) — намеренно одна и та же
 * функция, потому что две расходящиеся реализации ломают реконсилиацию.
 *
 * Функция чистая и детерминированная: одинаковый вход даёт одинаковый выход.
 */

export const WALK_SPEED = 5.0;
/** Во сколько раз бег быстрее шага. */
export const SPRINT_SPEED_SCALE = 1.65;
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
  /** Зажат ли бег. Хватит ли на него стамины — решает сервер. */
  sprint: boolean;
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
  const beforeY = pos.y;
  pos.y += vel.y * dt;
  let onGround = false;
  if (resolveVertical(pos, colliders, vel.y, body, beforeY)) {
    onGround = vel.y < 0;
    vel.y = 0;
  }

  // Последняя проверка: внутри геометрии оставаться нельзя. Обычно тут нечего
  // делать, но если игрока всё же вдавило — в угол, в шов между коробками или
  // в стену, построенную на его месте, — он выходит наружу, а не застревает.
  if (depenetrate(pos, colliders, body)) {
    onGround = true;
    if (vel.y < 0) vel.y = 0;
  }

  return { pos, vel, yaw, pitch, onGround, body, speedScale: state.speedScale };
}

/**
 * Зазор при выталкивании.
 *
 * Без него игрок встаёт ровно на грань коробки, и хватает ошибки в одну
 * миллиардную, чтобы он считался проникшим внутрь. Дальше срабатывала посадка
 * по вертикали и ставила его на верх стены — прижавшись к забору, игрок
 * оказывался на нём. Зазор оставляет между телом и стеной миллиметр, которого
 * float-погрешности не съедают.
 */
const SKIN = 0.001;

/**
 * Выталкивает игрока из всех пересекаемых боксов по одной оси.
 * Возвращает true, если было хотя бы одно столкновение.
 *
 * Пересечения проверяются по позиции на входе, а двигаем один раз в конце:
 * если менять позицию по ходу перебора, результат зависит от порядка коробок,
 * а выталкивание из одной может втолкнуть в другую.
 */
function resolveAxis(
  pos: Vec3,
  colliders: readonly Aabb[],
  axis: 'x' | 'y' | 'z',
  velocity: number,
  body: Body,
): boolean {
  if (velocity === 0) return false;

  const player = playerAabb(pos, body);
  let limit: number | null = null;

  for (const box of colliders) {
    if (!aabbOverlap(player, box)) continue;

    let candidate: number;
    if (axis === 'x') {
      candidate = velocity > 0 ? box.minX - body.radius - SKIN : box.maxX + body.radius + SKIN;
    } else if (axis === 'z') {
      candidate = velocity > 0 ? box.minZ - body.radius - SKIN : box.maxZ + body.radius + SKIN;
    } else {
      // По вертикали опорой считается только то, над чем игрок и был: иначе
      // стена, в которую его прижало сбоку, сработает как пол и поставит его
      // на верх забора. Поэтому вертикаль разрешается отдельной функцией.
      candidate = velocity > 0 ? box.minY - body.height - SKIN : box.maxY;
    }

    // Побеждает самое ограничивающее из препятствий, а не последнее в списке.
    if (limit === null) limit = candidate;
    else limit = velocity > 0 ? Math.min(limit, candidate) : Math.max(limit, candidate);
  }

  if (limit === null) return false;
  pos[axis] = limit;
  return true;
}

/**
 * Вертикальное столкновение: пол под ногами и потолок над головой.
 *
 * Отличается от горизонтального одним условием: коробка засчитывается, только
 * если игрок был выше её верха (при падении) или ниже её низа (при прыжке).
 * Без этого стена, к которой прижало сбоку, работает как пол — игрока ставило
 * на верх городской стены от погрешности в одну миллиардную метра.
 */
function resolveVertical(
  pos: Vec3,
  colliders: readonly Aabb[],
  velocity: number,
  body: Body,
  before: number,
): boolean {
  if (velocity === 0) return false;

  const player = playerAabb(pos, body);
  let limit: number | null = null;

  for (const box of colliders) {
    if (!aabbOverlap(player, box)) continue;

    if (velocity < 0) {
      // Падение: опора только та, что была не выше ног в начале шага.
      if (box.maxY > before + SKIN) continue;
      const candidate = box.maxY;
      limit = limit === null ? candidate : Math.max(limit, candidate);
    } else {
      // Подъём: потолок только тот, что был не ниже макушки.
      if (box.minY < before + body.height - SKIN) continue;
      const candidate = box.minY - body.height - SKIN;
      limit = limit === null ? candidate : Math.min(limit, candidate);
    }
  }

  if (limit === null) return false;
  pos.y = limit;
  return true;
}

/**
 * Выталкивает игрока наружу, если он всё-таки оказался внутри геометрии.
 *
 * Так бывает не только от погрешностей: постройку могли добавить там, где
 * игрок стоял, или его могло вдавить в угол между двумя коробками. Двигаем
 * в сторону ближайшей грани — тогда из стены выходят вбок, а не взлетают
 * на неё. Возвращает true, если пришлось поднимать вверх: это считается
 * опорой под ногами.
 */
function depenetrate(pos: Vec3, colliders: readonly Aabb[], body: Body): boolean {
  let lifted = false;

  // Двух проходов хватает: после первого остаются разве что углы.
  for (let pass = 0; pass < 2; pass++) {
    let touched = false;

    for (const box of colliders) {
      const player = playerAabb(pos, body);
      if (!aabbOverlap(player, box)) continue;
      touched = true;

      const toMinusX = player.maxX - box.minX;
      const toPlusX = box.maxX - player.minX;
      const toMinusZ = player.maxZ - box.minZ;
      const toPlusZ = box.maxZ - player.minZ;
      const toTop = box.maxY - player.minY;

      const shortest = Math.min(toMinusX, toPlusX, toMinusZ, toPlusZ, toTop);

      if (shortest === toMinusX) pos.x -= toMinusX + SKIN;
      else if (shortest === toPlusX) pos.x += toPlusX + SKIN;
      else if (shortest === toMinusZ) pos.z -= toMinusZ + SKIN;
      else if (shortest === toPlusZ) pos.z += toPlusZ + SKIN;
      else {
        pos.y += toTop;
        lifted = true;
      }
    }

    if (!touched) break;
  }

  return lifted;
}
