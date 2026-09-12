import {
  RACES,
  type MoveInput,
  type MoveState,
  type Race,
  createMoveState,
  type Vec3,
} from '@grimhold/shared';

/**
 * Обитатель мира. Двигается через тот же step(), что и игроки — намеренно,
 * потому что на вехе 3 отсюда вырастут мобы, и общая симуляция означает,
 * что лагкомпенсация и коллизии для них уже работают.
 */
export interface Npc {
  id: string;
  name: string;
  race: Race;
  state: MoveState;
  /** Маршрут патруля. Достигнув точки, идёт к следующей. */
  waypoints: Vec3[];
  waypointIndex: number;
  /** Пауза на точке в секундах — чтобы не выглядел механическим. */
  restUntil: number;
}

const ARRIVE_DISTANCE = 0.6;
const REST_SECONDS = 2.5;

export function createNpc(id: string, name: string, race: Race, waypoints: Vec3[]): Npc {
  const profile = RACES[race];
  const first = waypoints[0] ?? { x: 0, y: 0, z: 0 };
  return {
    id,
    name,
    race,
    state: createMoveState(first, {
      body: { radius: profile.radius, height: profile.height },
      speedScale: profile.speedScale,
    }),
    waypoints,
    waypointIndex: 0,
    restUntil: 0,
  };
}

/**
 * Превращает маршрут в намерение движения — ровно такое же, какое присылает клиент.
 * NPC не двигают себя напрямую: они «нажимают на клавиши», а позицию считает симуляция.
 */
export function npcIntent(npc: Npc, elapsedSeconds: number, dt: number): MoveInput {
  const idle: MoveInput = {
    seq: 0,
    forward: 0,
    right: 0,
    yaw: npc.state.yaw,
    pitch: 0,
    jump: false,
    sprint: false,
    dt,
  };

  const target = npc.waypoints[npc.waypointIndex];
  if (!target) return idle;

  const dx = target.x - npc.state.pos.x;
  const dz = target.z - npc.state.pos.z;
  const distance = Math.hypot(dx, dz);

  if (distance < ARRIVE_DISTANCE) {
    if (npc.restUntil === 0) {
      npc.restUntil = elapsedSeconds + REST_SECONDS;
    } else if (elapsedSeconds >= npc.restUntil) {
      npc.restUntil = 0;
      npc.waypointIndex = (npc.waypointIndex + 1) % npc.waypoints.length;
    }
    return idle;
  }

  // Обратное преобразование к yaw: при forward=1 движение идёт в (-sin yaw, -cos yaw).
  const yaw = Math.atan2(-dx, -dz);
  return { ...idle, forward: 1, yaw };
}
