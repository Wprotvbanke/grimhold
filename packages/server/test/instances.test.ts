import { describe, expect, it } from 'vitest';
import { SPAWN_POINT } from '@grimhold/shared';
import { OVERWORLD, World, type Player } from '../src/world.js';
import { respawnPlayer } from '../src/gameloop.js';
import { mayAttack } from '../src/pvp.js';

/**
 * Изоляция инстансов.
 *
 * На этом поле держится вся веха 6: подземелье — это не отдельный сервер и не
 * отдельный уровень, а тот же мир с другим `instanceId`. До сих пор второго
 * инстанса не существовало ни в игре, ни в проверках, то есть фундамент был
 * заявлен, но ни разу не нагружен.
 *
 * Проверяется главное: люди из разных инстансов друг друга **не видят и не
 * достают**. Ошибка здесь означала бы, что из подземелья можно убить того,
 * кто стоит в городе.
 */

const DUNGEON = 'dungeon-1';

let counter = 0;

function spawn(world: World, name: string, instanceId: string, x = 0, z = 0): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name,
    race: 'human',
    characterClass: 'warrior',
    x,
    y: 0,
    z,
    yaw: 0,
    instanceId,
    playtimeSeconds: 0,
  });
}

describe('инстансы', () => {
  it('чужой инстанс не попадает в снапшот', () => {
    const world = new World();
    const townsman = spawn(world, 'Горожанин', OVERWORLD);
    spawn(world, 'Копатель', DUNGEON);

    const seen = world.snapshotFor(townsman).map((entity) => entity.name);
    expect(seen).toContain('Горожанин');
    expect(seen).not.toContain('Копатель');
  });

  it('и не попадает под удар', () => {
    const world = new World();
    const townsman = spawn(world, 'Горожанин', OVERWORLD, 0, 100);
    const digger = spawn(world, 'Копатель', DUNGEON, 0, 100);

    // Стоят в одной точке мирового пространства — и всё равно недосягаемы.
    expect(mayAttack(townsman.combat, digger.combat).ok).toBe(false);
    expect(world.combatantsIn(OVERWORLD)).not.toContain(digger.combat);
  });

  it('перенос меняет инстанс и у игрока, и у бойца', () => {
    // Разойдись эти два поля — человек стал бы невидимым для одних и
    // уязвимым для других: снапшот собирается по одному, удар по другому.
    const world = new World();
    const player = spawn(world, 'Копатель', OVERWORLD, 5, 5);

    world.moveToInstance(player, DUNGEON, { x: 1, y: 0, z: 2 });

    expect(player.instanceId).toBe(DUNGEON);
    expect(player.combat.instanceId).toBe(DUNGEON);
    expect(player.state.pos).toEqual({ x: 1, y: 0, z: 2 });
    expect(world.combatantsIn(DUNGEON)).toContain(player.combat);
    expect(world.combatantsIn(OVERWORLD)).not.toContain(player.combat);
  });

  it('воскрешение возвращает в мир, а не только в город', () => {
    // Иначе умерший в подземелье воскресал бы внутри него на городских
    // координатах — то есть в пустоте: города там нет.
    const world = new World();
    const player = spawn(world, 'Неудачник', OVERWORLD);
    world.moveToInstance(player, DUNGEON, { x: 40, y: 0, z: 40 });
    player.combat.alive = false;

    respawnPlayer(world, player);

    expect(player.instanceId).toBe(OVERWORLD);
    expect(player.combat.instanceId).toBe(OVERWORLD);
    expect(player.state.pos.z).toBe(SPAWN_POINT.z);
  });

  it('у каждого инстанса своё зверьё', () => {
    const world = new World();
    const overworld = world.populateMobs(OVERWORLD);
    const dungeon = world.populateMobs(DUNGEON);

    expect(overworld).toBeGreaterThan(0);
    expect(dungeon).toBeGreaterThan(0);

    const ids = new Set((world.mobs.get(OVERWORLD) ?? []).map((mob) => mob.id));
    for (const mob of world.mobs.get(DUNGEON) ?? []) {
      expect(ids.has(mob.id)).toBe(false);
    }
  });
});
