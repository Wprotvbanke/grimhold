import { describe, expect, it } from 'vitest';
import { AOI_RADIUS } from '@grimhold/shared';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Опознание едет один раз.
 *
 * Имя, вид и раса не меняются никогда, но занимали 45% каждой сущности
 * в каждом снапшоте — двадцать раз в секунду. Проверяется здесь, а не живым
 * миром, потому что ломается это молча: клиент, не получивший имени и не
 * помнящий его, рисует безымянного истукана, а проверка по `kind` перестаёт
 * находить кого бы то ни было.
 */

let counter = 0;

function spawn(world: World, x: number, z: number): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: `Ходок${counter}`,
    race: 'dwarf',
    characterClass: 'warrior',
    x,
    y: 0,
    z,
    yaw: 0,
    instanceId: OVERWORLD,
    playtimeSeconds: 0,
  });
}

describe('снапшот представляет один раз', () => {
  it('первый раз с именем, дальше без', () => {
    const world = new World();
    const viewer = spawn(world, 0, 0);
    const other = spawn(world, 3, 0);

    const first = world.snapshotFor(viewer).find((e) => e.id === other.id)!;
    expect(first.name).toBe(other.name);
    expect(first.kind).toBe('player');
    expect(first.race).toBe('dwarf');

    const second = world.snapshotFor(viewer).find((e) => e.id === other.id)!;
    expect(second.name).toBeUndefined();
    expect(second.kind).toBeUndefined();

    // Изменяемое едет всегда: по нему и рисуют.
    expect(second.x).toBeCloseTo(3);
    expect(second.alive).toBe(true);
  });

  it('ушёл за радиус и вернулся — представят заново', () => {
    // Клиент к этому времени мог убрать аватар: сущность без имени он рисовать
    // не умеет, и молчание здесь означало бы невидимку.
    const world = new World();
    const viewer = spawn(world, 0, 0);
    const other = spawn(world, 3, 0);

    world.snapshotFor(viewer);

    other.state.pos = { x: AOI_RADIUS + 20, y: 0, z: 0 };
    expect(world.snapshotFor(viewer).find((e) => e.id === other.id)).toBeUndefined();

    other.state.pos = { x: 3, y: 0, z: 0 };
    expect(world.snapshotFor(viewer).find((e) => e.id === other.id)?.name).toBe(other.name);
  });

  it('память о знакомых своя у каждого', () => {
    const world = new World();
    const viewer = spawn(world, 0, 0);
    const late = spawn(world, 3, 0);

    world.snapshotFor(viewer);

    // Второму зрителю всех представляют с нуля, даже если первый их уже знает.
    expect(world.snapshotFor(late).find((e) => e.id === viewer.id)?.name).toBe(viewer.name);
  });
});
