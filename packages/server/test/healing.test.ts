import { describe, expect, it } from 'vitest';
import { addItem, itemDef } from '@grimhold/shared';
import { handleUseItem } from '../src/commands/items.js';
import { emptyOutbox, tickWorld } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Зелье лечит не разом, а тиками.
 *
 * Глоток перестаёт быть кнопкой «отменить пропущенный удар»: выпил в бою —
 * значит эти секунды ещё надо прожить. Сумма при этом та же, что обещана
 * в описании предмета.
 */
let counter = 0;

function drinker(world: World): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `heal-${counter}`,
    accountId: `acc-heal-${counter}`,
    name: 'Раненый',
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

/** Прогоняет мир быстрыми тиками — так же, как это делает сервер. */
function run(world: World, seconds: number): void {
  const step = 0.05;
  for (let i = 0; i < Math.round(seconds / step); i++) tickWorld(world, step, emptyOutbox());
}

function drink(world: World, player: Player): void {
  const potion = player.inventory.items[0]!;
  handleUseItem({ world, actor: player }, { t: 'useItem', x: potion.x, y: potion.y });
}

describe('зелье вливается тиками', () => {
  it('в первый миг здоровья не прибавляет', () => {
    const world = new World();
    const player = drinker(world);
    player.inventory = addItem(player.inventory, 'health_potion', 2).grid;
    player.combat.vitals.health = 10;

    drink(world, player);
    expect(player.combat.vitals.health).toBe(10);
    expect(player.healing?.left).toBe(itemDef('health_potion').restoreHealth);
  });

  it('за свой срок отдаёт ровно обещанное', () => {
    const world = new World();
    const player = drinker(world);
    player.inventory = addItem(player.inventory, 'health_potion', 2).grid;
    player.combat.vitals.health = 10;

    drink(world, player);
    run(world, itemDef('health_potion').restoreOver! / 2);
    const half = player.combat.vitals.health;
    expect(half).toBeGreaterThan(10);
    expect(half).toBeLessThan(10 + itemDef('health_potion').restoreHealth!);

    run(world, itemDef('health_potion').restoreOver! / 2 + 0.2);
    expect(player.combat.vitals.health).toBeCloseTo(10 + itemDef('health_potion').restoreHealth!, 1);
    expect(player.healing).toBeNull();
  });

  it('мёртвому не льётся', () => {
    const world = new World();
    const player = drinker(world);
    player.inventory = addItem(player.inventory, 'health_potion', 2).grid;
    player.combat.vitals.health = 10;

    drink(world, player);
    player.combat.alive = false;
    player.combat.vitals.health = 0;
    run(world, 2);

    expect(player.combat.vitals.health).toBe(0);
    expect(player.healing).toBeNull();
  });
});
