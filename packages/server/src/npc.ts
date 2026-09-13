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

/**
 * Доля от беговой скорости расы: житель не спешит.
 *
 * `WALK_SPEED` — это темп игрока в драке, пять метров в секунду; горожанин,
 * идущий так же, выглядит не жителем, а курьером. Сбоку это и видно: ноги
 * анимации не поспевают за перемещением, и шаги едут по мостовой.
 *
 * Число подобрано под шаг **и под анимацию**: три четверти метра в секунду —
 * это и неспешная походка, и почти ровно та скорость, на которую нарисован
 * клип жителя. Тогда клиенту остаётся подгонять темп на проценты, а не в разы.
 */
const STROLL = 0.19;

/**
 * Как быстро житель доворачивается, радиан в секунду.
 *
 * Раньше разворот был мгновенным: на точке маршрута он менял направление
 * в одном тике. Клиент сглаживает поворот между снапшотами, но пятидесяти
 * миллисекунд на полный разворот мало — со стороны это рывок, а не поворот.
 * Полсекунды на сто восемьдесят градусов читается как живое движение.
 */
const TURN_RATE = Math.PI * 2;

export function createNpc(id: string, name: string, race: Race, waypoints: Vec3[]): Npc {
  const profile = RACES[race];
  const first = waypoints[0] ?? { x: 0, y: 0, z: 0 };
  return {
    id,
    name,
    race,
    state: createMoveState(first, {
      body: { radius: profile.radius, height: profile.height },
      speedScale: profile.speedScale * STROLL,
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
  const wanted = Math.atan2(-dx, -dz);
  // Доворачивает постепенно и идёт дугой, а не разворачивается на месте:
  // площадь небольшая, радиус дуги выходит в четверть метра.
  return { ...idle, forward: 1, yaw: turnToward(npc.state.yaw, wanted, TURN_RATE * dt) };
}

/** Поворот на шаг к нужному направлению, кратчайшей стороной. */
function turnToward(from: number, to: number, limit: number): number {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  if (Math.abs(difference) <= limit) return to;
  return from + Math.sign(difference) * limit;
}
