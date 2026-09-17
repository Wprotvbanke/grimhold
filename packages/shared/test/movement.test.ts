import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  ChunkedWorld,
  PLAYER_HEIGHT,
  SPAWN_POINT,
  TOWN_SIZE,
  WORLD_CHUNK_RADIUS,
  aabbOverlap,
  createMoveState,
  type MoveInput,
  type MoveState,
  playerAabb,
  step,
} from '../src/index.js';

/** Мир чанковый, поэтому коллизии запрашиваются по текущей позиции. */
const terrain = new ChunkedWorld();
const collidersAt = (state: MoveState) => terrain.collidersAt(state.pos.x, state.pos.z);

const DT = 1 / 60;

function input(overrides: Partial<MoveInput> = {}): MoveInput {
  return {
    seq: 0,
    forward: 0,
    right: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    sprint: false,
    dt: DT,
    ...overrides,
  };
}

function simulate(state: MoveState, cmd: MoveInput, steps: number): MoveState {
  let current = state;
  for (let i = 0; i < steps; i++) {
    current = step(current, { ...cmd, seq: i }, collidersAt(current));
  }
  return current;
}

function insideGeometry(state: MoveState): boolean {
  const body = playerAabb(state.pos, state.body);
  return collidersAt(state).some((box) => aabbOverlap(body, box));
}

/** Крайняя координата, за которую не пускает стена на границе мира. */
const WORLD_EDGE = (WORLD_CHUNK_RADIUS + 0.5) * CHUNK_SIZE;

describe('шаг симуляции движения', () => {
  it('не проваливается сквозь пол — падение останавливается на уровне земли', () => {
    const dropped = createMoveState({ x: 0, y: 12, z: 10 });
    const result = simulate(dropped, input(), 240);

    expect(result.pos.y).toBeCloseTo(0, 5);
    expect(result.onGround).toBe(true);
    expect(insideGeometry(result)).toBe(false);
  });

  it('выходит из города через ворота, но не покидает мир', () => {
    const start = createMoveState(SPAWN_POINT);
    /**
     * Путь из двух колен: сначала вбок, потом прямо.
     *
     * Прямо от точки появления до ворот больше не пройти: посреди
     * площади стоит казна с памятником шириной в семь метров — её обходят.
     * Проверяем то же, что и раньше: ворота пропускают, край мира — нет.
     */
    const aside = simulate(start, input({ right: 1 }), 150);
    const past = simulate(aside, input({ forward: 1 }), 400);
    const back = simulate(past, input({ right: -1 }), 150);
    const result = simulate(back, input({ forward: 1 }), 4000);

    expect(insideGeometry(result)).toBe(false);
    // Ворота в городской стене есть, а край мира — глухой.
    expect(result.pos.z).toBeGreaterThan(-WORLD_EDGE);
    expect(result.pos.z).toBeLessThan(-TOWN_SIZE / 2);
  });

  it('не проходит сквозь стены ни под каким углом', () => {
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      const start = createMoveState(SPAWN_POINT);
      const result = simulate(start, input({ forward: 1, right: 1, yaw }), 1200);
      expect(insideGeometry(result), `застрял в геометрии при yaw=${yaw.toFixed(2)}`).toBe(false);
    }
  });

  it('детерминирован: одинаковый ввод даёт побитово одинаковый результат', () => {
    const start = createMoveState(SPAWN_POINT);
    const a = simulate(start, input({ forward: 1, right: 0.5, yaw: 0.7, jump: true }), 300);
    const b = simulate(start, input({ forward: 1, right: 0.5, yaw: 0.7, jump: true }), 300);

    expect(a).toEqual(b);
  });

  it('чистая функция: не мутирует переданное состояние', () => {
    const start = createMoveState(SPAWN_POINT);
    const before = JSON.parse(JSON.stringify(start));

    step(start, input({ forward: 1 }), collidersAt(start));

    expect(start).toEqual(before);
  });

  it('движение по диагонали не быстрее прямого', () => {
    const start = createMoveState(SPAWN_POINT);
    const straight = simulate(start, input({ forward: 1 }), 60);
    const diagonal = simulate(start, input({ forward: 1, right: 1 }), 60);

    const straightDist = Math.hypot(straight.pos.x - SPAWN_POINT.x, straight.pos.z - SPAWN_POINT.z);
    const diagonalDist = Math.hypot(diagonal.pos.x - SPAWN_POINT.x, diagonal.pos.z - SPAWN_POINT.z);

    expect(diagonalDist).toBeLessThanOrEqual(straightDist + 1e-9);
  });

  it('прыжок работает только с земли', () => {
    const grounded = simulate(createMoveState(SPAWN_POINT), input(), 30);
    expect(grounded.onGround).toBe(true);

    const jumped = step(grounded, input({ jump: true }), collidersAt(grounded));
    expect(jumped.vel.y).toBeGreaterThan(0);

    const midAir = step(jumped, input({ jump: true }), collidersAt(jumped));
    expect(midAir.vel.y).toBeLessThan(jumped.vel.y);
  });

  it('генерация чанков детерминирована', () => {
    const a = new ChunkedWorld();
    const b = new ChunkedWorld();
    for (const [cx, cz] of [[0, 0], [1, 0], [-2, 3], [3, -3]] as const) {
      expect(a.getChunk(cx, cz)).toEqual(b.getChunk(cx, cz));
    }
  });

  it('можно запрыгнуть на ступень и стоять на ней', () => {
    // Ступень своя, а не из города: помост с площади убрали, и проверка,
    // опиравшаяся на него, упала бы вместе с ним. Верх ступени — y = 0.5.
    const step1 = { minX: 12, maxX: 16, minY: 0, maxY: 0.5, minZ: -12, maxZ: -8 };
    const floor = { minX: -50, maxX: 50, minY: -1, maxY: 0, minZ: -50, maxZ: 50 };
    let onStep = createMoveState({ x: 14, y: 3, z: -10 });
    for (let i = 0; i < 180; i++) {
      onStep = step(onStep, { ...input(), seq: i }, [floor, step1]);
    }

    expect(onStep.pos.y).toBeCloseTo(0.5, 5);
    expect(onStep.onGround).toBe(true);
  });

  it('игрок занимает ожидаемый объём', () => {
    const body = playerAabb({ x: 0, y: 0, z: 0 });
    expect(body.maxY - body.minY).toBeCloseTo(PLAYER_HEIGHT, 10);
  });
});
