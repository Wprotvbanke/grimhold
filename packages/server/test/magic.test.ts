import { describe, expect, it } from 'vitest';
import {
  addItem,
  attributesFor,
  createScrolls,
  dungeonInstance,
  fullVitals,
  movementSpeedFactor,
} from '@grimhold/shared';
import { resolveBlessing } from '../src/combat.js';
import { tickCombatant, type Combatant } from '../src/combatant.js';
import { beginCast } from '../src/commands/action.js';
import { handleUseItem } from '../src/commands/items.js';
import { handleScrollMove } from '../src/commands/scroll.js';
import { handleSetHotbar } from '../src/commands/hotbar.js';
import { emptyOutbox, handlePlayerDeath } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

let counter = 0;

function spawnMage(world: World): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `mag-${counter}`,
    accountId: `acc-mag-${counter}`,
    name: 'Читающий',
    race: 'elf',
    characterClass: 'mage',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    instanceId: OVERWORLD,
    playtimeSeconds: 0,
  });
}

/**
 * Клетки умений — это и есть класс персонажа.
 *
 * Проверяется базовое правило системы: заклинание доступно ровно тогда, когда
 * его свиток вставлен. Всё остальное — урон, радиусы, откаты — числа, которые
 * владелец будет крутить, и закреплять их тестами незачем.
 */
describe('клетки умений', () => {
  it('принимают свиток и не принимают зелье', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = createScrolls();
    player.inventory = addItem(player.inventory, 'spell_fireball', 1).grid;
    player.inventory = addItem(player.inventory, 'health_potion', 1).grid;

    const scroll = player.inventory.items.find((item) => item.defId === 'spell_fireball')!;
    handleScrollMove(
      { world, actor: player },
      { t: 'scrollMove', from: 'backpack', to: 'scrolls', x: scroll.x, y: scroll.y },
    );
    expect(player.scrolls.items.map((item) => item.defId)).toEqual(['spell_fireball']);

    const potion = player.inventory.items.find((item) => item.defId === 'health_potion')!;
    const events = handleScrollMove(
      { world, actor: player },
      { t: 'scrollMove', from: 'backpack', to: 'scrolls', x: potion.x, y: potion.y },
    );
    expect(events.some((event) => event.type === 'itemError')).toBe(true);
    expect(player.scrolls.items).toHaveLength(1);
  });

  it('свиток из рюкзака не читается, а вставленный — читается', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = createScrolls();
    player.inventory = addItem(player.inventory, 'spell_fireball', 1).grid;

    expect(beginCast(world, player, 'fireball', 0)).toMatch(/клетки умений/i);

    const scroll = player.inventory.items[0]!;
    handleScrollMove(
      { world, actor: player },
      { t: 'scrollMove', from: 'backpack', to: 'scrolls', x: scroll.x, y: scroll.y },
    );

    expect(beginCast(world, player, 'fireball', 0)).toBeNull();
    expect(player.combat.action?.kind).toBe('cast');
  });

  it('вынутый свиток пропадает с панели быстрого доступа', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = addItem(createScrolls(), 'spell_mend', 1).grid;

    handleSetHotbar({ world, actor: player }, { t: 'setHotbar', index: 3, itemId: 'spell_mend' });
    expect(player.hotbar[3]).toBe('spell_mend');

    const scroll = player.scrolls.items[0]!;
    handleScrollMove(
      { world, actor: player },
      { t: 'scrollMove', from: 'scrolls', to: 'backpack', x: scroll.x, y: scroll.y },
    );

    // Ячейка, обещающая заклинание, которого уже нет, — худший вид вранья:
    // на неё смотрят краем глаза в бою.
    expect(player.hotbar[3]).toBeNull();
  });
});

describe('свиток света', () => {
  it('гаснет повторным нажатием', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = addItem(createScrolls(), 'spell_light', 1).grid;

    expect(beginCast(world, player, 'light', 0)).toBeNull();
    // Каст дошёл до конца — свет зажёгся (это делает игровой цикл).
    player.combat.lightRemaining = 120;
    player.combat.action = null;

    // Видеть самому или не быть увиденным — выбор, и отменять его можно
    // сразу: ни откат, ни мана тут ни при чём.
    expect(beginCast(world, player, 'light', 0)).toMatch(/погас/i);
    expect(player.combat.lightRemaining).toBe(0);
  });
});

describe('мана не возвращается сама', () => {
  it('стоящий без дела её не накопит', () => {
    const world = new World();
    const player = spawnMage(world);
    player.combat.vitals.mana = 10;

    // Минута покоя: раньше этого хватало, чтобы набрать полный запас.
    tickCombatant(player.combat, 60, player.maxima);

    expect(player.combat.vitals.mana).toBe(10);
    // Стамина при этом отходит: она про дыхание, а мана — про запас.
    expect(player.combat.vitals.stamina).toBe(player.maxima.stamina);
  });
});

describe('настой разума', () => {
  it('возвращает ману — иначе её вернуть нечем', () => {
    const world = new World();
    const player = spawnMage(world);
    player.combat.vitals.mana = 10;
    player.inventory = addItem(player.inventory, 'mana_draught', 1).grid;

    const draught = player.inventory.items[0]!;
    handleUseItem({ world, actor: player }, { t: 'useItem', x: draught.x, y: draught.y });

    expect(player.combat.vitals.mana).toBeGreaterThan(10);
    expect(player.inventory.items).toHaveLength(0);
  });
});

describe('свитки переживают смерть', () => {
  it('внизу рюкзак остаётся мешком, а клетки умений — при хозяине', () => {
    const world = new World();
    const player = spawnMage(world);
    player.instanceId = dungeonInstance(1);
    player.combat.instanceId = player.instanceId;
    player.inventory = addItem(player.inventory, 'health_potion', 1).grid;
    player.scrolls = addItem(createScrolls(), 'spell_fireball', 1).grid;

    handlePlayerDeath(world, player, 'Хозяин глубины', emptyOutbox());

    // Ради этого клетки и заведены: собранный набор умений не собирают
    // заново после каждой вылазки.
    expect(player.scrolls.items.map((item) => item.defId)).toEqual(['spell_fireball']);
    expect(player.inventory.items).toHaveLength(0);
  });
});

describe('медитация', () => {
  it('держит на месте', () => {
    const still = movementSpeedFactor({
      blocking: false,
      dashing: false,
      gliding: false,
      sprinting: true,
      acting: false,
      exhausted: false,
      slowFactor: 1,
      weightFactor: 1,
      rooted: true,
    });
    expect(still).toBe(0);
  });

  it('на полном запасе не начинается вовсе', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = addItem(createScrolls(), 'spell_meditation', 1).grid;

    /**
     * Медитация кончается сама, когда мана полна, — значит нажатие на полном
     * запасе включало её и гасило в тот же тик. Со стороны это выглядело
     * как «ничего не произошло»: ни маны, ни виньетки. Отказ вслух честнее.
     */
    expect(beginCast(world, player, 'meditation', 0)).toMatch(/полна/i);
    expect(player.combat.action).toBeNull();
  });

  it('включается и выключается тем же свитком', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = addItem(createScrolls(), 'spell_meditation', 1).grid;
    player.combat.vitals.mana = 10;

    expect(beginCast(world, player, 'meditation', 0)).toBeNull();
    // Каст дошёл до конца — медитация началась (это делает игровой цикл).
    player.meditating = true;

    // Второе нажатие отпускает сразу, не дожидаясь ни каста, ни отката:
    // иначе севший медитировать оставался бы стоять против своей воли.
    expect(beginCast(world, player, 'meditation', 0)).toMatch(/прервана/i);
    expect(player.meditating).toBe(false);
  });

  it('встал — семь секунд обратно не сесть', () => {
    const world = new World();
    const player = spawnMage(world);
    player.scrolls = addItem(createScrolls(), 'spell_meditation', 1).grid;
    player.combat.vitals.mana = 10;
    player.meditating = true;

    beginCast(world, player, 'meditation', 0);
    player.combat.action = null;

    /**
     * Откат идёт **от конца**, а не от начала: иначе, посидев полминуты,
     * можно было бы вскакивать и садиться обратно без потерь, и выбирать
     * место для медитации было бы незачем.
     */
    expect(beginCast(world, player, 'meditation', 0)).toMatch(/не готово/i);
    expect(player.meditating).toBe(false);
  });
});

/** Боец на ровном месте: всё остальное правилам кольца безразлично. */
function makeCombatant(overrides: Partial<Combatant> = {}): Combatant {
  const attributes = attributesFor('human', 'warrior');
  return {
    id: 'c1',
    kind: 'player',
    karma: 0,
    purpleFor: 0,
    name: 'Кто-то',
    instanceId: 'overworld',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    radius: 0.35,
    height: 1.8,
    vitals: fullVitals(attributes),
    attributes,
    armor: 0,
    alive: true,
    action: null,
    blocking: false,
    invulnerable: 0,
    sinceStaminaUse: 99,
    exhaustedFor: 0,
    blockSkill: 0,
    evasionSkill: 0,
    riposteFor: 0,
    wardArmor: 0,
    wardRemaining: 0,
    slowFactor: 1,
    slowRemaining: 0,
    lightRemaining: 0,
    dodgeCooldown: 0,
    swingCooldown: 0,
    ...overrides,
  };
}

/**
 * Кольцо помощи достаёт своих и не достаёт чужих.
 *
 * «Свой» определяется теми же правилами PvP, что и «враг»: в городе бить
 * нельзя никого, значит лечатся все, кто рядом. Вторая таблица «кто чей»
 * разошлась бы с первой в тот же день.
 */
describe('кольцо помощи', () => {
  it('лечит соседа и не лечит зверя', () => {
    const caster = makeCombatant({ id: 'a' });
    const friend = makeCombatant({ id: 'b', pos: { x: 3, y: 0, z: 0 } });
    const wolf = makeCombatant({ id: 'w', kind: 'mob', pos: { x: 3, y: 0, z: 1 } });
    const far = makeCombatant({ id: 'f', pos: { x: 40, y: 0, z: 0 } });

    for (const one of [caster, friend, wolf, far]) one.vitals.health = 20;

    resolveBlessing(caster, 'mend', [caster, friend, wolf, far], 0, () => 120);

    expect(caster.vitals.health).toBeGreaterThan(20);
    expect(friend.vitals.health).toBeGreaterThan(20);
    // Зверь — не свой, и восьми метров ему не хватит.
    expect(wolf.vitals.health).toBe(20);
    // Стоящий в сорока метрах — тоже: кольцо у свитка восьмиметровое.
    expect(far.vitals.health).toBe(20);
  });

  it('каменная кожа кладёт броню на тех же', () => {
    const caster = makeCombatant({ id: 'a' });
    const friend = makeCombatant({ id: 'b', pos: { x: 3, y: 0, z: 0 } });

    resolveBlessing(caster, 'wardskin', [caster, friend], 0, () => 120);

    expect(caster.wardArmor).toBeGreaterThan(0);
    expect(friend.wardRemaining).toBeGreaterThan(0);
  });
});
