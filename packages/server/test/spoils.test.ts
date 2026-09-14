import { describe, expect, it } from 'vitest';
import { BAG_SECONDS, addItem, dungeonInstance } from '@grimhold/shared';
import { handleDropItem } from '../src/commands/items.js';
import { emptyOutbox, handlePlayerDeath } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Цена смерти в подземелье.
 *
 * Вторая половина вылазки: без неё добыча внизу — бесплатные конфеты.
 * Проверяется здесь, а не живым миром, потому что правило должно выполняться
 * при **любой** смерти, а живой мир показывает только ту, что случилась.
 */

let counter = 0;

function spawn(world: World, instanceId: string): Player {
  counter += 1;
  const player = world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: 'Копатель',
    race: 'human',
    characterClass: 'warrior',
    x: 10,
    y: 0,
    z: -4,
    yaw: 0,
    instanceId,
    playtimeSeconds: 0,
  });

  player.equipment = {
    mainHand: { defId: 'crude_axe', count: 1, x: 0, y: 0, rotated: false },
    head: { defId: 'leather_cap', count: 1, x: 0, y: 0, rotated: false },
  };
  player.inventory = addItem(player.inventory, 'grave_silver', 4).grid;
  player.hotbar[0] = 'crude_axe';
  return player;
}

describe('смерть в подземелье', () => {
  it('надетое пропадает, рюкзак остаётся мешком на полу', () => {
    const world = new World();
    const instanceId = dungeonInstance(7);
    const player = spawn(world, instanceId);

    handlePlayerDeath(world, player, 'Умертвие', emptyOutbox());

    expect(player.equipment).toEqual({});
    expect(player.inventory.items).toHaveLength(0);

    const bags = world.bagsFor(player);
    expect(bags).toHaveLength(1);

    // Мешок лежит там, где упал хозяин: за добычей надо дойти.
    expect(bags[0]!.x).toBeCloseTo(10);
    expect(bags[0]!.z).toBeCloseTo(-4);

    const bag = world.bagById(instanceId, bags[0]!.id)!;
    expect(bag.owner).toBe('Копатель');
    expect(bag.grid.items).toHaveLength(1);
  });

  it('панель забывает то, чего больше нет', () => {
    const world = new World();
    const player = spawn(world, dungeonInstance(8));

    handlePlayerDeath(world, player, 'Упырь', emptyOutbox());

    // Серая ячейка с топором, которого нет ни в руках, ни в рюкзаке, читается
    // как «топор при мне» — и первый же удар оказывается кулаком.
    expect(player.hotbar[0]).toBeNull();
  });

  it('с пустым рюкзаком мешка не остаётся', () => {
    const world = new World();
    const player = spawn(world, dungeonInstance(9));
    player.inventory = { ...player.inventory, items: [] };

    handlePlayerDeath(world, player, 'Скелет', emptyOutbox());

    // Пустой мешок на полу — это мусор, который выглядит как добыча.
    expect(world.bagsFor(player)).toHaveLength(0);
  });

  it('наверху не теряется ничего', () => {
    // В открытом мире наказание — время и путь обратно, полная ставка только
    // в подземельях.
    const world = new World();
    const player = spawn(world, OVERWORLD);

    handlePlayerDeath(world, player, 'Волк', emptyOutbox());

    expect(Object.keys(player.equipment)).toHaveLength(2);
    expect(player.inventory.items).toHaveLength(1);
    expect(world.bagsFor(player)).toHaveLength(0);
  });
});

describe('мешок не лежит вечно', () => {
  it('истлевает по сроку', () => {
    const world = new World();
    const player = spawn(world, dungeonInstance(11));
    handlePlayerDeath(world, player, 'Умертвие', emptyOutbox());

    world.tickBags(BAG_SECONDS - 1);
    expect(world.bagsFor(player)).toHaveLength(1);

    const gone = world.tickBags(2);
    expect(gone).toHaveLength(1);
    expect(world.bagsFor(player)).toHaveLength(0);
  });

  it('и пропадает, как только его вынесли', () => {
    const world = new World();
    const player = spawn(world, dungeonInstance(12));
    handlePlayerDeath(world, player, 'Умертвие', emptyOutbox());

    const bag = world.bagById(player.instanceId, world.bagsFor(player)[0]!.id)!;
    bag.grid = { ...bag.grid, items: [] };

    world.tickBags(0.05);
    expect(world.bagsFor(player)).toHaveLength(0);
  });

  it('но не из-под руки того, кто в него смотрит', () => {
    /**
     * Разбор мешка двусторонний: достал посмотреть — можешь положить обратно.
     * Пока пустой мешок исчезал сразу, окно закрывалось на последней вещи,
     * и передумать было уже нельзя.
     */
    const world = new World();
    const player = spawn(world, dungeonInstance(13));
    const looter = spawn(world, dungeonInstance(13));
    handlePlayerDeath(world, player, 'Умертвие', emptyOutbox());

    const bag = world.bagById(player.instanceId, world.bagsFor(player)[0]!.id)!;
    bag.grid = { ...bag.grid, items: [] };
    looter.container = { kind: 'bag', bag };

    world.tickBags(0.05);
    expect(world.bagsFor(looter)).toHaveLength(1);

    // Закрыл панель — и мешка нет уже на следующем тике.
    looter.container = null;
    expect(world.tickBags(0.05)).toContain(bag);
  });

  it('истлевший уходит и из-под руки', () => {
    // Иначе мешок держат вечно, просто не закрывая окна.
    const world = new World();
    const player = spawn(world, dungeonInstance(14));
    handlePlayerDeath(world, player, 'Умертвие', emptyOutbox());

    const bag = world.bagById(player.instanceId, world.bagsFor(player)[0]!.id)!;
    player.container = { kind: 'bag', bag };

    expect(world.tickBags(BAG_SECONDS + 1)).toContain(bag);
  });
});

describe('выброшенное из рюкзака', () => {
  it('ложится мешком у ног, а выброшенное следом — в тот же мешок', () => {
    const world = new World();
    const player = spawn(world, OVERWORLD);
    player.inventory = addItem(player.inventory, 'leather_cap', 1).grid;
    const ctx = { world, actor: player };

    const silver = player.inventory.items.find((item) => item.defId === 'grave_silver')!;
    handleDropItem(ctx, { t: 'dropItem', x: silver.x, y: silver.y });
    const cap = player.inventory.items.find((item) => item.defId === 'leather_cap')!;
    handleDropItem(ctx, { t: 'dropItem', x: cap.x, y: cap.y });

    // Из рюкзака ушло, но не пропало: лежит на земле, одним мешком.
    expect(player.inventory.items).toHaveLength(0);
    const bags = world.bagsFor(player);
    expect(bags).toHaveLength(1);
    expect(world.bagById(OVERWORLD, bags[0]!.id)!.grid.items).toHaveLength(2);
  });
});
