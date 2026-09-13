import { describe, expect, it } from 'vitest';
import { RESPAWN_DELAY } from '@grimhold/shared';
import { deathDelay, emptyOutbox, handlePlayerDeath, respawnPlayer } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Частая смерть дорожает.
 *
 * Проверяется само правило, а не его числа: первая смерть стоит базовый срок,
 * каждая следующая быстрая — вдвое дороже, а долгая жизнь всё прощает.
 */

let counter = 0;

function spawn(world: World): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: 'Упрямец',
    race: 'human',
    characterClass: 'warrior',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    instanceId: OVERWORLD,
    playtimeSeconds: 0,
  });
}

function dieAndRise(world: World, player: Player): void {
  handlePlayerDeath(world, player, 'Волк', emptyOutbox());
  respawnPlayer(world, player);
}

describe('срок лежания', () => {
  it('первая смерть стоит базовый срок', () => {
    const world = new World();
    const player = spawn(world);

    handlePlayerDeath(world, player, 'Волк', emptyOutbox());
    expect(deathDelay(world, player)).toBe(RESPAWN_DELAY);
  });

  it('каждая быстрая смерть удваивает его', () => {
    const world = new World();
    const player = spawn(world);

    dieAndRise(world, player);
    dieAndRise(world, player);
    dieAndRise(world, player);
    expect(deathDelay(world, player)).toBe(RESPAWN_DELAY * 4);
  });

  it('другим персонажем того же аккаунта не отмыться', () => {
    // Счётчик ведётся по аккаунту: иначе наказание обходится перезаходом.
    const world = new World();
    const first = spawn(world);
    const second = spawn(world);
    second.accountId = first.accountId;

    dieAndRise(world, first);
    handlePlayerDeath(world, second, 'Волк', emptyOutbox());
    expect(deathDelay(world, second)).toBe(RESPAWN_DELAY * 2);
  });

  it('прожитое время прощает счётчик', () => {
    const world = new World();
    const player = spawn(world);

    dieAndRise(world, player);
    dieAndRise(world, player);

    // Десять минут без смертей — и всё начинается заново. Время мира двигаем
    // руками: гонять тик десять минут ради этого незачем.
    world.elapsed += 600;
    handlePlayerDeath(world, player, 'Волк', emptyOutbox());
    expect(deathDelay(world, player)).toBe(RESPAWN_DELAY);
  });
});
