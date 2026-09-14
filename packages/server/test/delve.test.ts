import { describe, expect, it } from 'vitest';
import {
  BOSS_FLOOR,
  DUNGEON_FLOORS,
  dungeonInstance,
  floorArrival,
  floorOf,
  stairsDown,
  stairsUp,
} from '@grimhold/shared';
import { OVERWORLD, World, type Player } from '../src/world.js';
import { handleStairs } from '../src/commands/stairs.js';
import { handleParty } from '../src/commands/party.js';
import { handleLeaveDungeon } from '../src/commands/dungeon.js';

/**
 * Вылазка целиком: этажи, хозяин глубины и отряд.
 *
 * Проверяются правила, а не числа: «глубже можно», «наверх нельзя, пока жив
 * хозяин», «свой отличается от чужого». Всё остальное — баланс, и меняться
 * ему предстоит часто.
 */

let counter = 0;

function spawn(world: World, instanceId: string, at: { x: number; y: number; z: number }): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: `Копатель ${counter}`,
    race: 'human',
    characterClass: 'warrior',
    x: at.x,
    y: at.y,
    z: at.z,
    yaw: 0,
    instanceId,
    playtimeSeconds: 0,
  });
}

/** Заведённое подземелье с обитателями и хозяином глубины. */
function delve(): { world: World; instanceId: string } {
  const world = new World();
  const instanceId = dungeonInstance(2024);
  world.populateDungeon(instanceId);
  return { world, instanceId };
}

/** Ставит игрока к лестнице и жмёт «E». */
function useStairs(world: World, player: Player, down: boolean) {
  const floor = floorOf(player.state.pos.x);
  const stairs = down ? stairsDown(floor) : stairsUp(floor);
  if (stairs) player.state.pos = { x: stairs.x, y: 0.1, z: stairs.z };
  return handleStairs({ world, actor: player }, { t: 'stairs', down });
}

describe('этажи', () => {
  it('лестница ведёт глубже и обратно, не меняя инстанса', () => {
    // Инстанс один на все этажи — иначе босс не открыл бы порталы всему
    // забегу, а отряд разваливался бы на каждом переходе.
    const { world, instanceId } = delve();
    const player = spawn(world, instanceId, floorArrival(0));

    useStairs(world, player, true);
    expect(player.instanceId).toBe(instanceId);
    expect(floorOf(player.state.pos.x)).toBe(1);

    useStairs(world, player, false);
    expect(floorOf(player.state.pos.x)).toBe(0);
  });

  it('до лестницы надо дойти', () => {
    const { world, instanceId } = delve();
    const player = spawn(world, instanceId, floorArrival(0));

    const events = handleStairs({ world, actor: player }, { t: 'stairs', down: true });
    expect(events[0]?.type).toBe('itemError');
    expect(floorOf(player.state.pos.x)).toBe(0);
  });

  it('со дна глубже хода нет', () => {
    const { world, instanceId } = delve();
    const player = spawn(world, instanceId, floorArrival(BOSS_FLOOR));

    const events = useStairs(world, player, true);
    expect(events[0]?.type).toBe('itemError');
    expect(floorOf(player.state.pos.x)).toBe(DUNGEON_FLOORS - 1);
  });

  it('на первом этаже лестницы наверх нет: оттуда уходят порталом', () => {
    expect(stairsUp(0)).toBeNull();
  });
});

describe('хозяин глубины', () => {
  it('пока он жив, портал заперт', () => {
    const { world, instanceId } = delve();
    const player = spawn(world, instanceId, floorArrival(0));
    player.state.pos = { x: 0, y: 0.1, z: 0 };

    expect(world.bossAlive(instanceId)).toBe(true);
    const events = handleLeaveDungeon({ world, actor: player }, { t: 'leaveDungeon' });
    expect(events[0]?.type).toBe('itemError');
    expect(player.instanceId).toBe(instanceId);
  });

  it('его смерть открывает порталы всему инстансу и ненадолго', () => {
    const { world, instanceId } = delve();
    const boss = (world.mobs.get(instanceId) ?? []).find((mob) =>
      world.isDungeonBoss(instanceId, mob.id),
    )!;

    expect(world.portalsFor(instanceId)).toBe(0);

    boss.alive = false;
    world.openPortals(instanceId);

    expect(world.bossAlive(instanceId)).toBe(false);
    expect(world.portalsFor(instanceId)).toBeGreaterThan(0);
  });
});

describe('отряд', () => {
  function pair() {
    const world = new World();
    const host = spawn(world, OVERWORLD, { x: 0, y: 0, z: 0 });
    const guest = spawn(world, OVERWORLD, { x: 2, y: 0, z: 0 });
    return { world, host, guest };
  }

  it('позвал, принял — свои', () => {
    const { world, host, guest } = pair();
    expect(world.allies(host, guest)).toBe(false);

    handleParty({ world, actor: host }, { t: 'party', action: 'invite', targetId: guest.id });
    handleParty({ world, actor: guest }, { t: 'party', action: 'accept' });

    expect(world.allies(host, guest)).toBe(true);
    expect(world.partySize(host)).toBe(2);
  });

  it('без приглашения в отряд не попасть', () => {
    // Иначе отряд собирался бы сам, и метка «свой» перестала бы что-то значить.
    const { world, host, guest } = pair();

    const events = handleParty({ world, actor: guest }, { t: 'party', action: 'accept' });
    expect(events[0]?.type).toBe('itemError');
    expect(world.allies(host, guest)).toBe(false);
  });

  it('ушедший из отряда перестаёт быть своим, и отряд из одного распускается', () => {
    const { world, host, guest } = pair();
    handleParty({ world, actor: host }, { t: 'party', action: 'invite', targetId: guest.id });
    handleParty({ world, actor: guest }, { t: 'party', action: 'accept' });

    handleParty({ world, actor: guest }, { t: 'party', action: 'leave' });

    expect(world.allies(host, guest)).toBe(false);
    expect(host.partyId).toBeNull();
  });

  it('разрыв связи выводит из отряда', () => {
    // Метка на том, кого больше нет, хуже отсутствия метки.
    const { world, host, guest } = pair();
    handleParty({ world, actor: host }, { t: 'party', action: 'invite', targetId: guest.id });
    handleParty({ world, actor: guest }, { t: 'party', action: 'accept' });

    world.removePlayer(guest.id);
    expect(host.partyId).toBeNull();
  });
});

describe('чужая работа слышна', () => {
  it('сосед видит, что рядом вскрывают сундук', () => {
    // Замысел: вскрывающий сундук «уязвим и слышен». Звук клиент выводит сам,
    // но о чужой полосе ему больше не сообщает ничто — только это поле.
    const { world, instanceId } = delve();
    const arrival = floorArrival(0);
    const digger = spawn(world, instanceId, arrival);
    const neighbour = spawn(world, instanceId, { ...arrival, x: arrival.x + 2 });

    digger.work = {
      kind: 'chest',
      id: 'chest.0.0',
      name: 'Сундук',
      at: { x: arrival.x, z: arrival.z },
      range: 3,
      duration: 5,
      remaining: 5,
    };

    const seen = world.snapshotFor(neighbour).find((entity) => entity.id === digger.id);
    expect(seen?.work).toBe('chest');

    digger.work = null;
    const after = world.snapshotFor(neighbour).find((entity) => entity.id === digger.id);
    expect(after?.work).toBeUndefined();
  });
});
