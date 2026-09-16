import { describe, expect, it } from 'vitest';
import { addItem, itemDef } from '@grimhold/shared';
import { handleUseItem } from '../src/commands/items.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

let counter = 0;

function spawnTestPlayer(world: World): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `sip-${counter}`,
    accountId: `acc-sip-${counter}`,
    name: 'Пьющий',
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

/**
 * Зелья пьют не залпом.
 *
 * Без отката лечение — это удержание клавиши: здоровье льётся ровно с той
 * скоростью, с какой жмут, и бой перестаёт быть про здоровье.
 */
describe('откат расходников', () => {
  it('второе зелье подряд не выпить', () => {
    const world = new World();
    const player = spawnTestPlayer(world);
    player.inventory = addItem(player.inventory, 'health_potion', 2).grid;
    player.combat.vitals.health = 10;

    const potion = player.inventory.items[0]!;
    handleUseItem({ world, actor: player }, { t: 'useItem', x: potion.x, y: potion.y });
    expect(player.sipCooldown).toBeCloseTo(itemDef('health_potion').cooldown!);

    const health = player.combat.vitals.health;
    const second = player.inventory.items[0]!;
    const events = handleUseItem({ world, actor: player }, { t: 'useItem', x: second.x, y: second.y });

    expect(player.combat.vitals.health).toBe(health);
    expect(events.some((event) => event.type === 'itemError')).toBe(true);
  });

  it('а когда откат вышел — можно', () => {
    const world = new World();
    const player = spawnTestPlayer(world);
    player.inventory = addItem(player.inventory, 'health_potion', 2).grid;
    player.combat.vitals.health = 10;

    const potion = player.inventory.items[0]!;
    handleUseItem({ world, actor: player }, { t: 'useItem', x: potion.x, y: potion.y });
    player.sipCooldown = 0;

    const health = player.combat.vitals.health;
    const second = player.inventory.items[0]!;
    handleUseItem({ world, actor: player }, { t: 'useItem', x: second.x, y: second.y });
    expect(player.combat.vitals.health).toBeGreaterThan(health);
  });
});
