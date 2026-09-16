import { describe, expect, it } from 'vitest';
import {
  BACKPACK_HEIGHT,
  BACKPACK_WIDTH,
  ITEMS,
  addItem,
  attributesFor,
  arrangeInGrid,
  canPlace,
  carryCapacity,
  createGrid,
  countOf,
  createBackpack,
  equipmentArmor,
  findFreeSpot,
  itemAt,
  itemDef,
  place,
  removeItem,
  sanitizeGrid,
  sizeOf,
  takeItem,
  totalWeight,
  weaponDamageOf,
  weightSpeedFactor,
  type ItemId,
} from '../src/index.js';

/**
 * Инвентарь-сетка. Проверяется то, ради чего он вообще нужен: предмет не
 * налезает на чужое место, не вылезает за край, стопки не переполняются,
 * а вес считается честно. Ошибка здесь означает дюп или потерю вещей —
 * в игре с полной потерей лута это дороже любого другого бага.
 */

const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

describe('определения предметов', () => {
  it.each(ITEM_IDS)('%s имеет осмысленные размеры и вес', (id) => {
    const def = itemDef(id);
    expect(def.width).toBeGreaterThan(0);
    expect(def.height).toBeGreaterThan(0);
    expect(def.weight).toBeGreaterThanOrEqual(0);
    expect(def.stack).toBeGreaterThan(0);
  });

  it.each(ITEM_IDS)('%s влезает в пустой рюкзак', (id) => {
    // Предмет, который не помещается вообще никуда, — это потерянный лут.
    expect(findFreeSpot(createBackpack(), id), `${itemDef(id).name} не влезает`).not.toBeNull();
  });

  it('надеваемые предметы имеют слот, а ресурсы — нет', () => {
    for (const id of ITEM_IDS) {
      const def = itemDef(id);
      if (def.armor !== undefined) expect(def.slot, `${def.name}`).toBeDefined();
      if (def.kind === 'resource') expect(def.slot).toBeUndefined();
    }
  });
});

describe('размещение в сетке', () => {
  it('предмет не налезает на занятое место', () => {
    const grid = place(createBackpack(), 'wooden_club', 1, 0, 0, false)!;
    expect(grid).not.toBeNull();

    // Дубина 1x3 занимает (0,0)-(0,2).
    expect(canPlace(grid, 'bandage', 0, 1, false)).toBe(false);
    expect(canPlace(grid, 'bandage', 1, 1, false)).toBe(true);
  });

  it('предмет не вылезает за край', () => {
    const grid = createBackpack();
    expect(canPlace(grid, 'wooden_club', 0, BACKPACK_HEIGHT - 1, false)).toBe(false);
    expect(canPlace(grid, 'wooden_club', BACKPACK_WIDTH - 1, 0, false)).toBe(true);
    expect(canPlace(grid, 'bandage', -1, 0, false)).toBe(false);
  });

  it('поворот меняет занимаемую форму', () => {
    expect(sizeOf('wooden_club', false)).toEqual({ width: 1, height: 3 });
    expect(sizeOf('wooden_club', true)).toEqual({ width: 3, height: 1 });

    const grid = createBackpack();
    // Вдоль нижнего края влезет только повёрнутая дубина.
    const y = BACKPACK_HEIGHT - 1;
    expect(canPlace(grid, 'wooden_club', 0, y, false)).toBe(false);
    expect(canPlace(grid, 'wooden_club', 0, y, true)).toBe(true);
  });

  it('перенос на собственное место разрешён', () => {
    const grid = place(createBackpack(), 'pelt', 1, 2, 2, false)!;
    const item = grid.items[0]!;
    // Без исключения самого себя предмет не смог бы сдвинуться на клетку.
    expect(canPlace(grid, 'pelt', 3, 2, false)).toBe(false);
    expect(canPlace(grid, 'pelt', 3, 2, false, item)).toBe(true);
  });

  it('клетка находит лежащий в ней предмет', () => {
    const grid = place(createBackpack(), 'wooden_club', 1, 4, 1, false)!;
    expect(itemAt(grid, 4, 2)?.defId).toBe('wooden_club');
    expect(itemAt(grid, 5, 2)).toBeNull();
  });
});

describe('стопки', () => {
  it('складываются до предела, а остаток ложится отдельно', () => {
    const stack = itemDef('bandage').stack;
    const { grid, leftover } = addItem(createBackpack(), 'bandage', stack + 3);

    expect(leftover).toBe(0);
    expect(countOf(grid, 'bandage')).toBe(stack + 3);
    expect(grid.items).toHaveLength(2);
    expect(grid.items[0]!.count).toBe(stack);
    expect(grid.items[1]!.count).toBe(3);
  });

  it('нескладываемое кладётся по одному', () => {
    const { grid } = addItem(createBackpack(), 'wooden_club', 3);
    expect(grid.items).toHaveLength(3);
    expect(grid.items.every((item) => item.count === 1)).toBe(true);
  });

  it('лишнее не пропадает молча, а возвращается остатком', () => {
    let grid = createBackpack();
    // Забиваем рюкзак крупными вещами.
    for (let i = 0; i < 40; i++) grid = addItem(grid, 'ogre_hide', 1).grid;

    const before = countOf(grid, 'ogre_hide');
    const { grid: after, leftover } = addItem(grid, 'ogre_hide', 5);

    expect(leftover).toBeGreaterThan(0);
    // Сколько не влезло — столько и осталось снаружи, ни больше ни меньше.
    expect(countOf(after, 'ogre_hide')).toBe(before + (5 - leftover));
  });

  it('изъятие берёт из нескольких стопок', () => {
    const stack = itemDef('bandage').stack;
    const { grid } = addItem(createBackpack(), 'bandage', stack + 4);

    const after = takeItem(grid, 'bandage', stack + 2)!;
    expect(after).not.toBeNull();
    expect(countOf(after, 'bandage')).toBe(2);
  });

  it('нельзя забрать больше, чем есть', () => {
    const { grid } = addItem(createBackpack(), 'bandage', 3);
    expect(takeItem(grid, 'bandage', 4)).toBeNull();
    // Неудачное изъятие ничего не меняет.
    expect(countOf(grid, 'bandage')).toBe(3);
  });
});

describe('вес и перегруз', () => {
  it('считается по содержимому', () => {
    const { grid } = addItem(createBackpack(), 'ore', 4);
    expect(totalWeight(grid)).toBeCloseTo(itemDef('ore').weight * 4, 5);
  });

  it('пустой рюкзак ничего не весит', () => {
    expect(totalWeight(createBackpack())).toBe(0);
  });

  it('до предела скорость не страдает', () => {
    const attributes = attributesFor('dwarf', 'warrior');
    expect(weightSpeedFactor(attributes, 0)).toBe(1);
    expect(weightSpeedFactor(attributes, carryCapacity(attributes))).toBe(1);
  });

  it('перегруз замедляет, но не обездвиживает', () => {
    const attributes = attributesFor('elf', 'mage');
    const capacity = carryCapacity(attributes);

    const slowed = weightSpeedFactor(attributes, capacity * 1.5);
    expect(slowed).toBeLessThan(1);
    expect(slowed).toBeGreaterThan(0.15);

    // Даже с непомерным грузом остаётся возможность доползти до банка.
    expect(weightSpeedFactor(attributes, capacity * 10)).toBeGreaterThanOrEqual(0.15);
  });

  it('дворф уносит больше эльфа', () => {
    expect(carryCapacity(attributesFor('dwarf', 'warrior'))).toBeGreaterThan(
      carryCapacity(attributesFor('elf', 'mage')),
    );
  });
});

describe('экипировка', () => {
  it('броня складывается со всех слотов', () => {
    const equipment = {
      head: { defId: 'cloth_hood' as ItemId, count: 1, x: 0, y: 0, rotated: false },
      chest: { defId: 'cloth_tunic' as ItemId, count: 1, x: 0, y: 0, rotated: false },
    };
    const expected = (itemDef('cloth_hood').armor ?? 0) + (itemDef('cloth_tunic').armor ?? 0);
    expect(equipmentArmor(equipment)).toBe(expected);
  });

  it('без оружия урон нулевой — значит бьём кулаком', () => {
    expect(weaponDamageOf({})).toBe(0);
  });

  it('оружие в основной руке даёт свой урон', () => {
    const equipment = {
      mainHand: { defId: 'wooden_club' as ItemId, count: 1, x: 0, y: 0, rotated: false },
    };
    expect(weaponDamageOf(equipment)).toBe(itemDef('wooden_club').damage);
  });
});

describe('чтение из базы', () => {
  it('мусор превращается в пустой рюкзак, а не роняет сервер', () => {
    expect(sanitizeGrid(null, 10, 6).items).toHaveLength(0);
    expect(sanitizeGrid('строка', 10, 6).items).toHaveLength(0);
    expect(sanitizeGrid({ items: 'не массив' }, 10, 6).items).toHaveLength(0);
  });

  it('исчезнувшие из игры предметы отбрасываются', () => {
    const raw = {
      items: [
        { defId: 'предмет_которого_нет', count: 1, x: 0, y: 0, rotated: false },
        { defId: 'bandage', count: 2, x: 0, y: 0, rotated: false },
      ],
    };
    const grid = sanitizeGrid(raw, 10, 6);
    expect(grid.items).toHaveLength(1);
    expect(countOf(grid, 'bandage')).toBe(2);
  });

  it('разъехавшаяся раскладка не теряет вещи', () => {
    // Два предмета сохранены на одном месте: так быть не должно, но вещь важнее.
    const raw = {
      items: [
        { defId: 'pelt', count: 1, x: 0, y: 0, rotated: false },
        { defId: 'pelt', count: 1, x: 0, y: 0, rotated: false },
      ],
    };
    expect(countOf(sanitizeGrid(raw, 10, 6), 'pelt')).toBe(2);
  });

  it('сохранённая раскладка восстанавливается как была', () => {
    const grid = place(createBackpack(), 'wooden_club', 1, 3, 2, true)!;
    const restored = sanitizeGrid(JSON.parse(JSON.stringify(grid)), 10, 6);

    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]).toMatchObject({ defId: 'wooden_club', x: 3, y: 2, rotated: true });
  });
});

describe('удаление', () => {
  it('освобождает место', () => {
    const grid = place(createBackpack(), 'ogre_hide', 1, 0, 0, false)!;
    expect(canPlace(grid, 'bandage', 0, 0, false)).toBe(false);

    const after = removeItem(grid, grid.items[0]!);
    expect(canPlace(after, 'bandage', 0, 0, false)).toBe(true);
  });
});

describe('стопку кладут на стопку', () => {
  /**
   * Складывать одинаковое перетаскиванием — то, чего ждут от сетки.
   * Правило живёт в arrangeInGrid и общее для рюкзака, казны и мешка.
   */
  it('одинаковые складываются, предел соблюдается', () => {
    let grid = createGrid(10, 6);
    grid = addItem(grid, 'health_potion', 1).grid;
    // Вторую стопку кладём руками: addItem сам сложил бы её в первую.
    grid = {
      ...grid,
      items: [...grid.items, { defId: 'health_potion', count: 3, x: 4, y: 0, rotated: false }],
    };

    const moved = arrangeInGrid(grid, 0, 0, 4, 0, false);
    expect(typeof moved).not.toBe('string');
    if (typeof moved === 'string') return;

    expect(moved.items).toHaveLength(1);
    expect(moved.items[0]).toMatchObject({ defId: 'health_potion', count: 4, x: 4, y: 0 });
  });

  it('лишнее остаётся на месте: предел стопки не обходится', () => {
    const stack = itemDef('health_potion').stack;
    let grid = createGrid(10, 6);
    grid = {
      ...grid,
      items: [
        { defId: 'health_potion', count: 3, x: 0, y: 0, rotated: false },
        { defId: 'health_potion', count: stack - 1, x: 4, y: 0, rotated: false },
      ],
    };

    const moved = arrangeInGrid(grid, 0, 0, 4, 0, false);
    if (typeof moved === 'string') throw new Error(moved);

    const target = moved.items.find((item) => item.x === 4);
    const rest = moved.items.find((item) => item.x === 0);
    expect(target?.count).toBe(stack);
    expect(rest?.count).toBe(3 - 1);
  });

  it('разное не складывается', () => {
    let grid = createGrid(10, 6);
    grid = {
      ...grid,
      items: [
        { defId: 'health_potion', count: 1, x: 0, y: 0, rotated: false },
        { defId: 'bandage', count: 1, x: 4, y: 0, rotated: false },
      ],
    };

    expect(typeof arrangeInGrid(grid, 0, 0, 4, 0, false)).toBe('string');
  });
});
