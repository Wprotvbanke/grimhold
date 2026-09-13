import { describe, expect, it } from 'vitest';
import { SPAWN_POINT, dungeonInstance } from '@grimhold/shared';
import { emptyOutbox, handlePlayerDeath, respawnPlayer } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Про переносы между мирами клиенту говорят всегда.
 *
 * Землю под ногами клиент строит сам, по имени инстанса. Не скажи ему
 * о переносе — он продолжит строить прежнюю: воскресший из подземелья
 * оказывался в городе без пола, потому что генератор подземелья за пределами
 * зала отдаёт пустоту.
 *
 * Ловится это только так. Сервер при этом стоит твёрдо, снапшоты идут, ни одна
 * проверка данных не падает — расходятся картинка и правда.
 */

let counter = 0;

function spawn(world: World, instanceId: string): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: 'Копатель',
    race: 'human',
    characterClass: 'warrior',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    instanceId,
    playtimeSeconds: 0,
  });
}

describe('перенос между мирами всегда объявляется', () => {
  it('воскрешение из подземелья', () => {
    const world = new World();
    const player = spawn(world, dungeonInstance(3));
    world.takeInstanceMoves();

    handlePlayerDeath(world, player, 'Умертвие', emptyOutbox());
    respawnPlayer(world, player);

    const moved = world.takeInstanceMoves();
    expect(moved).toContain(player);
    expect(player.instanceId).toBe(OVERWORLD);
    expect(player.state.pos.x).toBeCloseTo(SPAWN_POINT.x);
  });

  it('и любой другой перенос', () => {
    const world = new World();
    const player = spawn(world, OVERWORLD);
    world.takeInstanceMoves();

    world.moveToInstance(player, dungeonInstance(5), { x: 1, y: 0.1, z: 2 });
    expect(world.takeInstanceMoves()).toContain(player);
  });

  it('список забирается один раз', () => {
    // Иначе одно и то же сообщение уходило бы каждый тик до конца сессии.
    const world = new World();
    const player = spawn(world, OVERWORLD);

    world.moveToInstance(player, dungeonInstance(7), { x: 0, y: 0.1, z: 0 });
    expect(world.takeInstanceMoves()).toHaveLength(1);
    expect(world.takeInstanceMoves()).toHaveLength(0);
  });

  it('ушедшему из игры ничего не шлют', () => {
    const world = new World();
    const player = spawn(world, dungeonInstance(9));

    world.moveToInstance(player, OVERWORLD, SPAWN_POINT);
    world.removePlayer(player.id);

    expect(world.takeInstanceMoves()).toHaveLength(0);
  });
});
