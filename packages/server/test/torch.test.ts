import { describe, expect, it } from 'vitest';
import { MOBS, TORCH_SECONDS, addItem, countOf } from '@grimhold/shared';
import { emptyOutbox, tickWorld } from '../src/gameloop.js';
import { handleUseHotbar } from '../src/commands/hotbar.js';
import { createMob, decideMob } from '../src/mob.js';
import { OVERWORLD, World, isLit, refreshLoadout, type Player } from '../src/world.js';

/**
 * Факел в руке: «вижу» против «меня видно».
 *
 * Проверяется сама сделка, а не её числа. Свет виден — значит виден всем;
 * факел горит — значит кончается; кончился — рука пуста.
 */

let counter = 0;

function spawn(world: World): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: 'Факелоносец',
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

function lightTorch(player: Player, count = 1): void {
  player.equipment = { offHand: { defId: 'torch', count, x: 0, y: 0, rotated: false } };
  refreshLoadout(player);
}

/** Прогоняет мир быстрыми тиками — так же, как это делает сервер. */
function run(world: World, seconds: number): void {
  const step = 0.05;
  for (let i = 0; i < Math.round(seconds / step); i++) tickWorld(world, step, emptyOutbox());
}

describe('факел', () => {
  it('зажигается надеванием и гаснет снятием', () => {
    const world = new World();
    const player = spawn(world);
    expect(isLit(player)).toBe(false);

    lightTorch(player);
    expect(isLit(player)).toBe(true);

    player.equipment = {};
    refreshLoadout(player);
    expect(isLit(player)).toBe(false);
  });

  it('огонь в руке видят чужие', () => {
    // Без этого факел — чистая выгода: видишь дальше и ничем не платишь.
    const world = new World();
    const carrier = spawn(world);
    const watcher = spawn(world);
    lightTorch(carrier);

    const seen = world.snapshotFor(watcher).find((entity) => entity.id === carrier.id);
    expect(seen?.lit).toBe(true);
  });

  it('прогорает и берёт следующий из связки', () => {
    const world = new World();
    const player = spawn(world);
    lightTorch(player, 2);

    run(world, TORCH_SECONDS + 1);
    expect(player.equipment.offHand?.count).toBe(1);
    expect(isLit(player)).toBe(true);

    run(world, TORCH_SECONDS + 1);
    expect(player.equipment.offHand).toBeUndefined();
    expect(isLit(player)).toBe(false);
  });

  it('гасится тем же нажатием панели, каким зажжён', () => {
    /**
     * Панель искала факел в рюкзаке, а он в руке — и отвечала «нет
     * в рюкзаке». Погасить его можно было только через окно вещей.
     */
    const world = new World();
    const player = spawn(world);
    player.inventory = addItem(player.inventory, 'torch', 1).grid;
    player.hotbar[0] = 'torch';

    handleUseHotbar({ world, actor: player }, { t: 'useHotbar', index: 0, viewTick: 0 });
    expect(isLit(player)).toBe(true);

    handleUseHotbar({ world, actor: player }, { t: 'useHotbar', index: 0, viewTick: 0 });
    expect(isLit(player)).toBe(false);
    expect(countOf(player.inventory, 'torch')).toBe(1);
  });

  it('а меч и щит вторым нажатием не снимаются', () => {
    // Иначе двойное нажатие в бою обезоружило бы владельца.
    const world = new World();
    const player = spawn(world);
    player.inventory = addItem(player.inventory, 'wooden_shield', 1).grid;
    player.hotbar[0] = 'wooden_shield';

    handleUseHotbar({ world, actor: player }, { t: 'useHotbar', index: 0, viewTick: 0 });
    handleUseHotbar({ world, actor: player }, { t: 'useHotbar', index: 0, viewTick: 0 });
    expect(player.equipment.offHand?.defId).toBe('wooden_shield');
  });

  it('несущего огонь зверьё замечает дальше', () => {
    const mob = createMob('m1', 'wolf', { x: 0, y: 0, z: 0 }, OVERWORLD);
    const range = MOBS.wolf.aggroRange;
    // Встал за пределом обычного зрения, но в пределах того, что выдаёт огонь.
    const pos = { x: 0, y: 0, z: range + 2 };

    const dark = decideMob(mob, [{ id: 'p1', pos, alive: true }], 0.05);
    expect(dark.input.forward).toBe(0);

    const lit = decideMob(mob, [{ id: 'p1', pos, alive: true, lit: true }], 0.05);
    expect(lit.input.forward).not.toBe(0);
  });
});
