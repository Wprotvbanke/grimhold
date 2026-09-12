import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBank } from '@grimhold/shared';
import { Persistence } from '../src/persistence.js';
import { World } from '../src/world.js';
import type { CharacterSave, Storage } from '../src/storage/types.js';

/**
 * Политика сохранения.
 *
 * Здесь закреплён баг учёта времени в игре: раньше при каждой записи считалось
 * «начальное значение + время с прошлого флаша», из-за чего значение в памяти
 * не росло и каждая запись перетирала предыдущую тем же числом, а игроку,
 * вошедшему в середине интервала, начислялся весь интервал целиком.
 */

/** Хранилище-заглушка: запоминает записи, ничего не пишет на диск. */
function fakeStorage(): Storage & { writes: CharacterSave[][] } {
  const writes: CharacterSave[][] = [];
  return {
    writes,
    saveCharacters: (saves) => {
      writes.push(saves.map((save) => ({ ...save })));
    },
    createAccount: () => {
      throw new Error('не используется');
    },
    findAccountByUsername: () => null,
    listCharacters: () => [],
    findCharacterByName: () => null,
    getCharacter: () => null,
    createCharacter: () => {
      throw new Error('не используется');
    },
    getBank: () => createBank(),
    saveBank: () => {},
    close: () => {},
  };
}

function spawn(world: World, playtimeSeconds = 0) {
  return world.spawnPlayer({
    id: 'char-1',
    accountId: 'acc-1',
    name: 'Испытуемый',
    race: 'human',
    characterClass: 'warrior',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    instanceId: 'overworld',
    playtimeSeconds,
  });
}

describe('учёт времени в игре', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('накапливается между записями, а не пересчитывается заново', () => {
    const storage = fakeStorage();
    const world = new World();
    const persistence = new Persistence(storage, world);

    const player = spawn(world, 100);

    vi.advanceTimersByTime(60_000);
    player.dirty = true;
    persistence.flush('первая');

    vi.advanceTimersByTime(60_000);
    player.dirty = true;
    persistence.flush('вторая');

    const [first] = storage.writes[0]!;
    const [second] = storage.writes[1]!;

    expect(first!.playtimeSeconds).toBe(160);
    // Ключевая проверка: вторая запись больше первой, а не равна ей.
    expect(second!.playtimeSeconds).toBe(220);
  });

  it('вошедшему в середине интервала не начисляют весь интервал', () => {
    const storage = fakeStorage();
    const world = new World();
    const persistence = new Persistence(storage, world);

    // Кто-то уже играет минуту.
    const veteran = spawn(world, 0);
    vi.advanceTimersByTime(60_000);

    // Новичок заходит прямо перед флашем.
    const rookie = world.spawnPlayer({
      id: 'char-2',
      accountId: 'acc-2',
      name: 'Новичок',
      race: 'elf',
      characterClass: 'mage',
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      instanceId: 'overworld',
      playtimeSeconds: 0,
    });

    vi.advanceTimersByTime(2_000);
    veteran.dirty = true;
    rookie.dirty = true;
    persistence.flush('общая');

    const saves = storage.writes[0]!;
    const veteranSave = saves.find((s) => s.id === 'char-1')!;
    const rookieSave = saves.find((s) => s.id === 'char-2')!;

    expect(veteranSave.playtimeSeconds).toBe(62);
    expect(rookieSave.playtimeSeconds).toBe(2);
  });

  it('пишет только изменившихся', () => {
    const storage = fakeStorage();
    const world = new World();
    const persistence = new Persistence(storage, world);

    const player = spawn(world);
    player.dirty = false;

    expect(persistence.flush('пустая')).toBe(0);
    expect(storage.writes).toHaveLength(0);
  });

  it('критичное событие пишется немедленно и снимает признак изменения', () => {
    const storage = fakeStorage();
    const world = new World();
    const persistence = new Persistence(storage, world);

    const player = spawn(world);
    player.state.pos = { x: 5, y: 0, z: -7 };
    player.dirty = true;

    persistence.flushPlayer(player, 'смерть');

    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]![0]!.x).toBe(5);
    expect(storage.writes[0]![0]!.z).toBe(-7);
    expect(player.dirty).toBe(false);
  });
});
