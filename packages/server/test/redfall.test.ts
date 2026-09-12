import { afterEach, describe, expect, it, vi } from 'vitest';
import { KARMA_PER_KILL, RED_SKILL_PENALTY, addItem } from '@grimhold/shared';
import { emptyOutbox, punishRedDeath, tickWorld } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Чем платит красный.
 *
 * Единственная механика в игре, уничтожающая вещь насовсем, и притом
 * случайная — такую нельзя оставлять непроверенной: ошибка здесь не роняет
 * сервер и не видна в логах, она просто молча съедает чужой шлем.
 */

let counter = 0;

function spawn(world: World, karma: number): Player {
  counter += 1;
  const player = world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: 'Душегуб',
    race: 'human',
    characterClass: 'warrior',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    instanceId: OVERWORLD,
    playtimeSeconds: 0,
    karma,
  });

  player.equipment = {
    mainHand: { defId: 'crude_axe', count: 1, x: 0, y: 0, rotated: false },
    head: { defId: 'leather_cap', count: 1, x: 0, y: 0, rotated: false },
  };
  player.inventory = addItem(player.inventory, 'bandage', 3).grid;
  player.skills.blade.experience = 200;
  return player;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('смерть красного', () => {
  it('роняет надетое, когда не повезло', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const world = new World();
    const player = spawn(world, KARMA_PER_KILL);

    punishRedDeath(player, emptyOutbox());

    const worn = Object.keys(player.equipment).length;
    expect(worn).toBe(1);
  });

  it('оставляет надетое, когда повезло', () => {
    // Наказание должно пугать, а не превращать первую ошибку в конец
    // персонажа: это шанс, а не приговор.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const world = new World();
    const player = spawn(world, KARMA_PER_KILL);

    punishRedDeath(player, emptyOutbox());

    expect(Object.keys(player.equipment)).toHaveLength(2);
  });

  it('рюкзак не трогает', () => {
    // Роняется вещь из надетого: прощаться со шлемом обиднее, чем с чем-то
    // из рюкзака, и цена должна быть ощутима.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const world = new World();
    const player = spawn(world, KARMA_PER_KILL);
    const before = player.inventory.items.length;

    punishRedDeath(player, emptyOutbox());

    expect(player.inventory.items).toHaveLength(before);
  });

  it('срезает часть опыта навыков', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const world = new World();
    const player = spawn(world, KARMA_PER_KILL);

    punishRedDeath(player, emptyOutbox());

    expect(player.skills.blade.experience).toBe(Math.round(200 * (1 - RED_SKILL_PENALTY)));
  });

  it('с белого не берётся ничего', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const world = new World();
    const player = spawn(world, 0);

    punishRedDeath(player, emptyOutbox());

    expect(Object.keys(player.equipment)).toHaveLength(2);
    expect(player.skills.blade.experience).toBe(200);
  });
});

describe('карма сходит со временем', () => {
  it('за тик становится меньше, но не уходит в минус', () => {
    const world = new World();
    const player = spawn(world, 1);

    tickWorld(world, 1, emptyOutbox());
    expect(player.combat.karma).toBeLessThan(1);

    for (let i = 0; i < 10; i++) tickWorld(world, 1, emptyOutbox());
    expect(player.combat.karma).toBe(0);
  });
});
