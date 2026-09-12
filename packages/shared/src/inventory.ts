import { ITEMS, itemDef, type EquipSlot, type ItemId } from './items.js';

/**
 * Инвентарь-сетка.
 *
 * Всё здесь — чистые функции над данными, как step() в movement.ts. Это не
 * эстетика: раскладку хранит и проверяет сервер, а клиент рисует то же самое,
 * поэтому одна общая реализация означает, что картинка не может разойтись
 * с тем, что на самом деле лежит в рюкзаке.
 *
 * Функции не мутируют вход и возвращают новые объекты — так откат неудачной
 * операции сводится к тому, чтобы просто не взять результат.
 */

export const BACKPACK_WIDTH = 10;
export const BACKPACK_HEIGHT = 6;
export const BANK_WIDTH = 12;
export const BANK_HEIGHT = 10;

/** Предмет, лежащий в сетке. Адресуется координатами левого верхнего угла. */
export interface PlacedItem {
  defId: ItemId;
  count: number;
  x: number;
  y: number;
  /** Повёрнут на 90 градусов: меч 1x4 ложится как 4x1. */
  rotated: boolean;
}

export interface Grid {
  width: number;
  height: number;
  items: PlacedItem[];
}

export type Equipment = Partial<Record<EquipSlot, PlacedItem>>;

/** Сколько ячеек в панели горячих клавиш: клавиши 1…6. */
export const HOTBAR_SIZE = 6;

/**
 * Панель горячих клавиш.
 *
 * Хранит вид предмета, а не его место в сетке: вещи в рюкзаке двигаются,
 * и привязка к клетке рассыпалась бы при первом же переносе. По нажатию
 * сервер сам находит в рюкзаке первый подходящий предмет.
 */
export type Hotbar = (ItemId | null)[];

export function createHotbar(): Hotbar {
  return Array.from({ length: HOTBAR_SIZE }, () => null);
}

/** Проверяет панель из базы: вид предмета мог исчезнуть между версиями. */
export function sanitizeHotbar(raw: unknown): Hotbar {
  const result = createHotbar();
  if (!Array.isArray(raw)) return result;

  for (let i = 0; i < HOTBAR_SIZE; i++) {
    const entry = raw[i];
    if (typeof entry === 'string' && entry in ITEMS) result[i] = entry as ItemId;
  }
  return result;
}

/** Первый предмет такого вида в рюкзаке. */
export function findByDefId(grid: Grid, defId: ItemId): PlacedItem | null {
  return grid.items.find((item) => item.defId === defId) ?? null;
}

export function createGrid(width: number, height: number): Grid {
  return { width, height, items: [] };
}

export function createBackpack(): Grid {
  return createGrid(BACKPACK_WIDTH, BACKPACK_HEIGHT);
}

export function createBank(): Grid {
  return createGrid(BANK_WIDTH, BANK_HEIGHT);
}

/** Занимаемый размер с учётом поворота. */
export function sizeOf(defId: ItemId, rotated: boolean): { width: number; height: number } {
  const def = itemDef(defId);
  return rotated
    ? { width: def.height, height: def.width }
    : { width: def.width, height: def.height };
}

function overlaps(a: PlacedItem, x: number, y: number, width: number, height: number): boolean {
  const size = sizeOf(a.defId, a.rotated);
  return a.x < x + width && a.x + size.width > x && a.y < y + height && a.y + size.height > y;
}

/**
 * Влезет ли предмет в это место. Через `ignore` проверяется перенос предмета
 * на место, которое частично пересекается с ним же.
 */
export function canPlace(
  grid: Grid,
  defId: ItemId,
  x: number,
  y: number,
  rotated: boolean,
  ignore?: PlacedItem,
): boolean {
  const { width, height } = sizeOf(defId, rotated);

  if (x < 0 || y < 0) return false;
  if (x + width > grid.width || y + height > grid.height) return false;

  for (const item of grid.items) {
    if (item === ignore) continue;
    if (overlaps(item, x, y, width, height)) return false;
  }
  return true;
}

/** Предмет, лежащий в указанной клетке. */
export function itemAt(grid: Grid, x: number, y: number): PlacedItem | null {
  for (const item of grid.items) {
    if (overlaps(item, x, y, 1, 1)) return item;
  }
  return null;
}

/** Первое место, куда влезет предмет. Проверяется и поворот. */
export function findFreeSpot(
  grid: Grid,
  defId: ItemId,
): { x: number; y: number; rotated: boolean } | null {
  const def = itemDef(defId);
  const orientations = def.width === def.height ? [false] : [false, true];

  for (const rotated of orientations) {
    const { width, height } = sizeOf(defId, rotated);
    for (let y = 0; y <= grid.height - height; y++) {
      for (let x = 0; x <= grid.width - width; x++) {
        if (canPlace(grid, defId, x, y, rotated)) return { x, y, rotated };
      }
    }
  }
  return null;
}

/** Кладёт предмет в указанное место. Возвращает null, если не влезает. */
export function place(
  grid: Grid,
  defId: ItemId,
  count: number,
  x: number,
  y: number,
  rotated: boolean,
): Grid | null {
  if (!canPlace(grid, defId, x, y, rotated)) return null;
  return { ...grid, items: [...grid.items, { defId, count, x, y, rotated }] };
}

export function removeItem(grid: Grid, item: PlacedItem): Grid {
  return { ...grid, items: grid.items.filter((entry) => entry !== item) };
}

/**
 * Добавляет предметы: сначала в существующие стопки, остаток — на свободное
 * место. Возвращает новую сетку и сколько добавить не удалось.
 */
export function addItem(
  grid: Grid,
  defId: ItemId,
  count: number,
): { grid: Grid; leftover: number } {
  const def = itemDef(defId);
  let remaining = count;
  let items = grid.items.map((item) => ({ ...item }));

  if (def.stack > 1) {
    for (const item of items) {
      if (remaining <= 0) break;
      if (item.defId !== defId) continue;

      const room = def.stack - item.count;
      if (room <= 0) continue;

      const moved = Math.min(room, remaining);
      item.count += moved;
      remaining -= moved;
    }
  }

  while (remaining > 0) {
    const spot = findFreeSpot({ ...grid, items }, defId);
    if (!spot) break;

    const portion = Math.min(def.stack, remaining);
    items = [...items, { defId, count: portion, x: spot.x, y: spot.y, rotated: spot.rotated }];
    remaining -= portion;
  }

  return { grid: { ...grid, items }, leftover: remaining };
}

/**
 * Перекладывание внутри одной сетки: с точностью до клетки, с поворотом
 * и со складыванием стопок.
 *
 * Живёт здесь, а не в обработчике рюкзака, потому что по этим же правилам
 * раскладывают вещи в казне. Два экземпляра одних правил разошлись бы, и
 * вещь, которая влезает в рюкзаке, однажды перестала бы влезать в сундуке.
 *
 * Возвращает новую сетку или строку с причиной отказа.
 */
export function arrangeInGrid(
  grid: Grid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  rotate: boolean,
): Grid | string {
  const item = itemAt(grid, fromX, fromY);
  if (!item) return 'Здесь ничего нет';

  const rotated = rotate ? !item.rotated : item.rotated;

  // Себя самого при проверке игнорируем: иначе предмет не смог бы сдвинуться
  // на соседнюю клетку, пересекающуюся с его нынешним местом.
  if (!canPlace(grid, item.defId, toX, toY, rotated, item)) {
    // Попытка положить одну стопку на другую — складываем.
    const target = itemAt(grid, toX, toY);
    if (target && target !== item && target.defId === item.defId) {
      return stackOnto(grid, item, target);
    }
    return 'Сюда не влезает';
  }

  const moved = place(removeItem(grid, item), item.defId, item.count, toX, toY, rotated);
  return moved ?? 'Сюда не влезает';
}

/** Складывает одну стопку в другую, не превышая предела. */
function stackOnto(grid: Grid, source: PlacedItem, target: PlacedItem): Grid | string {
  const def = itemDef(source.defId);
  if (def.stack <= 1) return 'Этот предмет не складывается';

  const room = def.stack - target.count;
  if (room <= 0) return 'Стопка полна';

  const moved = Math.min(room, source.count);
  const items = grid.items
    .map((entry) => {
      if (entry === target) return { ...entry, count: entry.count + moved };
      if (entry === source) return { ...entry, count: entry.count - moved };
      return entry;
    })
    .filter((entry) => entry.count > 0);

  return { ...grid, items };
}

/** Убирает указанное количество предметов. Возвращает null, если столько нет. */
export function takeItem(grid: Grid, defId: ItemId, count: number): Grid | null {
  if (countOf(grid, defId) < count) return null;

  let remaining = count;
  const items: PlacedItem[] = [];

  for (const item of grid.items) {
    if (remaining <= 0 || item.defId !== defId) {
      items.push(item);
      continue;
    }

    const taken = Math.min(item.count, remaining);
    remaining -= taken;
    if (item.count > taken) items.push({ ...item, count: item.count - taken });
  }

  return { ...grid, items };
}

export function countOf(grid: Grid, defId: ItemId): number {
  let total = 0;
  for (const item of grid.items) {
    if (item.defId === defId) total += item.count;
  }
  return total;
}

/** Вес содержимого сетки в килограммах. */
export function totalWeight(grid: Grid): number {
  let total = 0;
  for (const item of grid.items) {
    total += itemDef(item.defId).weight * item.count;
  }
  return Math.round(total * 100) / 100;
}

export function equipmentWeight(equipment: Equipment): number {
  let total = 0;
  for (const item of Object.values(equipment)) {
    if (item) total += itemDef(item.defId).weight * item.count;
  }
  return Math.round(total * 100) / 100;
}

/** Суммарная броня надетого — уходит в applyDamage. */
export function equipmentArmor(equipment: Equipment): number {
  let total = 0;
  for (const item of Object.values(equipment)) {
    if (item) total += itemDef(item.defId).armor ?? 0;
  }
  return total;
}

/** Урон оружия в основной руке. Ноль означает, что бьём кулаком. */
export function weaponDamageOf(equipment: Equipment): number {
  const weapon = equipment.mainHand;
  return weapon ? (itemDef(weapon.defId).damage ?? 0) : 0;
}

/** Инструмент в руке: по нему решается, поддастся ли нода. */
export function toolOf(equipment: Equipment): { kind: string; tier: number } | null {
  const weapon = equipment.mainHand;
  if (!weapon) return null;

  const def = itemDef(weapon.defId);
  if (!def.toolKind) return null;
  return { kind: def.toolKind, tier: def.toolTier ?? 0 };
}

/**
 * Проверяет данные из базы. Предмет мог исчезнуть из игры между версиями,
 * а раскладка — разъехаться; молча принимать такое нельзя.
 */
export function sanitizeGrid(raw: unknown, width: number, height: number): Grid {
  const empty = createGrid(width, height);
  if (!raw || typeof raw !== 'object') return empty;

  const source = raw as Partial<Grid>;
  if (!Array.isArray(source.items)) return empty;

  let result = empty;
  for (const entry of source.items) {
    if (!entry || typeof entry !== 'object') continue;

    const { defId, count, x, y, rotated } = entry as PlacedItem;
    if (typeof defId !== 'string' || !(defId in ITEMS)) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;

    const placed = place(result, defId, Math.floor(count), x, y, Boolean(rotated));
    // Если сохранённая раскладка не сошлась, кладём куда влезет: вещь терять нельзя.
    result = placed ?? addItem(result, defId, Math.floor(count)).grid;
  }

  return result;
}
