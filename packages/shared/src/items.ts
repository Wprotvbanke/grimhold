/**
 * Предметы.
 *
 * Размер в клетках — не украшение, а основа всей ставки подземелья: рюкзак
 * ограничен, меч занимает четыре клетки, и выбор «что взять с собой и чем
 * рискнуть» рождается именно здесь. Поэтому размеры и вес заданы так, чтобы
 * набитый рюкзак был осознанным решением, а не автоматическим действием.
 */

import { SPELLS, type SpellId } from './spells.js';
import type { SkillId } from './skills.js';
// Только тип: ссылка нужна свиткам, а цикл при этом стирается при сборке.
import type { RecipeId } from './recipes.js';

export type ItemKind = 'resource' | 'consumable' | 'weapon' | 'armor' | 'tool' | 'scroll' | 'spell';

/** Куда надевается предмет. Отсутствие слота означает, что он только в рюкзаке. */
export type EquipSlot = 'head' | 'chest' | 'legs' | 'hands' | 'mainHand' | 'offHand';

export const EQUIP_SLOTS: EquipSlot[] = [
  'head',
  'chest',
  'legs',
  'hands',
  'mainHand',
  'offHand',
];

export const SLOT_NAMES: Record<EquipSlot, string> = {
  head: 'Голова',
  chest: 'Торс',
  legs: 'Ноги',
  hands: 'Руки',
  mainHand: 'Оружие',
  offHand: 'Щит',
};

/** Чем добывают ресурс. Без нужного инструмента нода не поддаётся. */
export type ToolKind = 'axe' | 'pick' | 'knife';

export interface ItemDef {
  id: ItemId;
  name: string;
  kind: ItemKind;
  /** Размер в клетках рюкзака. */
  width: number;
  height: number;
  /** Килограммы за штуку. */
  weight: number;
  /** Максимум в одной стопке. Единица означает, что предмет не складывается. */
  stack: number;
  /** Ярус: грубо задаёт ценность и требования. */
  tier: number;
  slot?: EquipSlot;
  /** Базовый урон оружия — уходит в resolveMelee вместо кулака. */
  damage?: number;
  /**
   * Во сколько раз удар этим оружием длиннее удара кулаком.
   *
   * Тяжёлое бьёт реже — это его цена за урон. Растягиваются **фазы**, а не
   * одна пауза: иначе удар засчитывался бы в тот миг, когда топор в кадре
   * ещё только заносится, и картинка расходилась бы с правдой.
   */
  swing?: number;
  /** Броня: складывается со всей надетой и режет урон в applyDamage. */
  armor?: number;
  toolKind?: ToolKind;
  /**
   * Какой навык растёт от ударов этой вещью.
   *
   * У оружия он свой и не зависит от класса: лук учит стрельбе, дубина —
   * дробящему, меч и топор — клинку. Пусто — значит вещь бьют не ради боя
   * (или это вовсе не оружие), и навык выбирается по классу, как при
   * пустых руках.
   */
  skill?: SkillId;
  /** Ярус инструмента: нода требует не ниже своего. */
  toolTier?: number;
  /** Что делает расходник при использовании. */
  restoreHealth?: number;
  restoreStamina?: number;
  /**
   * Какое заклинание читает предмет. Магия лежит в рюкзаке вещами и занимает
   * место наравне с зельями: маг тоже решает, что взять с собой.
   */
  spellId?: SpellId;
  /**
   * Какой рецепт открывает свиток.
   *
   * Свиток рецептурного яруса читается **только своей расой**: найденный
   * чужой прочесть нельзя, зато можно продать. Отсюда и растёт торговля,
   * ради которой расы разведены по ремёслам.
   */
  recipeId?: RecipeId;
  description?: string;
}

export type ItemId =
  // ---- добыча с мобов ----
  | 'rat_tail'
  | 'pelt'
  | 'fang'
  | 'coin'
  | 'bone'
  | 'rot_flesh'
  | 'bone_dust'
  | 'ogre_hide'
  | 'crude_ingot'
  | 'grave_silver'
  | 'recipe_scrap'
  // ---- свитки рецептурного яруса ----
  | 'scroll_iron_sword'
  | 'scroll_iron_helm'
  | 'scroll_iron_cuirass'
  | 'scroll_hunting_bow'
  | 'scroll_leather_cap'
  | 'scroll_leather_jerkin'
  | 'scroll_health_potion'
  | 'scroll_stamina_draught'
  | 'scroll_stone_elixir'
  // ---- ресурсы из мира ----
  | 'branch'
  | 'log'
  | 'ore'
  | 'herb'
  | 'stone'
  | 'clay'
  | 'plant_fiber'
  // ---- переработанное ----
  | 'plank'
  | 'ingot'
  | 'leather'
  | 'cloth'
  // ---- инструменты ----
  | 'crude_axe'
  | 'crude_pick'
  | 'knife'
  // ---- расходники ----
  | 'bandage'
  | 'torch'
  | 'arrow'
  | 'health_potion'
  // ---- снаряжение базового яруса ----
  | 'wooden_club'
  | 'wooden_shield'
  | 'cloth_hood'
  | 'cloth_tunic'
  | 'cloth_leggings'
  | 'leather_gloves'
  // ---- рецептурный ярус: дворф, металл ----
  | 'iron_sword'
  | 'iron_helm'
  | 'iron_cuirass'
  // ---- рецептурный ярус: человек, дерево и кожа ----
  | 'hunting_bow'
  | 'leather_cap'
  | 'leather_jerkin'
  // ---- рецептурный ярус: эльф, зелья ----
  | 'stamina_draught'
  | 'stone_elixir'
  // ---- магия: заклинания лежат в рюкзаке как вещи ----
  | 'spell_ember'
  | 'spell_frostbite'
  | 'spell_lightning'
  | 'spell_mend'
  | 'spell_wardskin'
  | 'spell_lantern';

const ITEM_LIST: ItemDef[] = [
  // ---------- добыча с мобов ----------
  { id: 'rat_tail', name: 'Крысиный хвост', kind: 'resource', width: 1, height: 1, weight: 0.1, stack: 20, tier: 0 },
  { id: 'pelt', name: 'Волчья шкура', kind: 'resource', width: 2, height: 2, weight: 1.2, stack: 5, tier: 1 },
  { id: 'fang', name: 'Клык', kind: 'resource', width: 1, height: 1, weight: 0.1, stack: 20, tier: 1 },
  { id: 'coin', name: 'Монеты', kind: 'resource', width: 1, height: 1, weight: 0.01, stack: 999, tier: 0 },
  { id: 'bone', name: 'Кость', kind: 'resource', width: 1, height: 2, weight: 0.4, stack: 10, tier: 1 },
  { id: 'rot_flesh', name: 'Гнилая плоть', kind: 'resource', width: 1, height: 1, weight: 0.5, stack: 10, tier: 1 },
  { id: 'bone_dust', name: 'Костная пыль', kind: 'resource', width: 1, height: 1, weight: 0.2, stack: 20, tier: 2 },
  { id: 'ogre_hide', name: 'Шкура огра', kind: 'resource', width: 2, height: 3, weight: 4, stack: 3, tier: 3 },
  { id: 'crude_ingot', name: 'Грубый слиток', kind: 'resource', width: 1, height: 1, weight: 2, stack: 10, tier: 2 },
  { id: 'grave_silver', name: 'Могильное серебро', kind: 'resource', width: 1, height: 1, weight: 0.6, stack: 20, tier: 3 },
  {
    id: 'recipe_scrap',
    name: 'Обрывок рецепта',
    kind: 'scroll',
    width: 1,
    height: 1,
    weight: 0.05,
    stack: 5,
    tier: 2,
    description: 'Часть чертежа. Полные свитки ждут в подземельях.',
  },

  // ---------- свитки рецептурного яруса ----------
  //
  // Падают в подземельях (веха 6); пока их роняет умертвие — самый злой
  // обитатель диких земель. Читается свиток только своей расой, поэтому
  // чужой — это товар, а не мусор.
  ...(
    [
      ['scroll_iron_sword', 'Свиток: железный меч', 'iron_sword'],
      ['scroll_iron_helm', 'Свиток: железный шлем', 'iron_helm'],
      ['scroll_iron_cuirass', 'Свиток: железная кираса', 'iron_cuirass'],
      ['scroll_hunting_bow', 'Свиток: охотничий лук', 'hunting_bow'],
      ['scroll_leather_cap', 'Свиток: кожаная шапка', 'leather_cap'],
      ['scroll_leather_jerkin', 'Свиток: кожаная куртка', 'leather_jerkin'],
      ['scroll_health_potion', 'Свиток: зелье здоровья', 'health_potion'],
      ['scroll_stamina_draught', 'Свиток: настой сил', 'stamina_draught'],
      ['scroll_stone_elixir', 'Свиток: каменный эликсир', 'stone_elixir'],
    ] as [ItemId, string, RecipeId][]
  ).map(([id, name, recipeId]) => ({
    id,
    name,
    kind: 'scroll' as const,
    width: 1,
    height: 2,
    weight: 0.1,
    stack: 1,
    tier: 2,
    recipeId,
    description: 'Читается только своей расой. Чужой свиток — товар.',
  })),

  // ---------- ресурсы из мира ----------
  // Ветка — единственное дерево, которое берётся без топора, и на ней держится
  // весь выход из голых рук: из неё вяжутся первые инструменты.
  { id: 'branch', name: 'Ветка', kind: 'resource', width: 1, height: 2, weight: 1, stack: 10, tier: 0 },
  { id: 'log', name: 'Бревно', kind: 'resource', width: 2, height: 2, weight: 5, stack: 5, tier: 0 },
  { id: 'ore', name: 'Руда', kind: 'resource', width: 1, height: 1, weight: 3, stack: 10, tier: 1 },
  { id: 'herb', name: 'Травы', kind: 'resource', width: 1, height: 1, weight: 0.1, stack: 20, tier: 0 },
  { id: 'stone', name: 'Камень', kind: 'resource', width: 1, height: 1, weight: 2.5, stack: 10, tier: 0 },
  { id: 'clay', name: 'Глина', kind: 'resource', width: 1, height: 1, weight: 1.5, stack: 10, tier: 0 },
  { id: 'plant_fiber', name: 'Волокно', kind: 'resource', width: 1, height: 1, weight: 0.1, stack: 30, tier: 0 },

  // ---------- переработанное ----------
  { id: 'plank', name: 'Доска', kind: 'resource', width: 1, height: 2, weight: 1.5, stack: 10, tier: 1 },
  { id: 'ingot', name: 'Слиток', kind: 'resource', width: 1, height: 1, weight: 2, stack: 10, tier: 2 },
  { id: 'leather', name: 'Кожа', kind: 'resource', width: 2, height: 1, weight: 0.8, stack: 10, tier: 1 },
  { id: 'cloth', name: 'Ткань', kind: 'resource', width: 1, height: 1, weight: 0.2, stack: 20, tier: 1 },

  // ---------- инструменты ----------
  {
    id: 'crude_axe',
    name: 'Грубый топор',
    kind: 'tool',
    width: 1,
    height: 3,
    weight: 2.5,
    stack: 1,
    tier: 1,
    slot: 'mainHand',
    damage: 11,
    skill: 'blade',
    toolKind: 'axe',
    toolTier: 1,
    swing: 2,
    description: 'Рубит деревья. В бою лучше кулака, но ненамного.',
  },
  {
    id: 'crude_pick',
    name: 'Грубая кирка',
    kind: 'tool',
    width: 1,
    height: 3,
    weight: 3,
    stack: 1,
    tier: 1,
    slot: 'mainHand',
    damage: 10,
    skill: 'blunt',
    toolKind: 'pick',
    toolTier: 1,
    description: 'Бьёт руду и камень.',
  },
  {
    id: 'knife',
    name: 'Нож',
    kind: 'tool',
    width: 1,
    height: 2,
    weight: 0.6,
    stack: 1,
    tier: 1,
    slot: 'mainHand',
    damage: 8,
    skill: 'blade',
    toolKind: 'knife',
    toolTier: 1,
    description: 'Срезает травы и снимает шкуры.',
  },

  // ---------- расходники ----------
  {
    id: 'bandage',
    name: 'Бинт',
    kind: 'consumable',
    width: 1,
    height: 1,
    weight: 0.1,
    stack: 10,
    tier: 0,
    restoreHealth: 25,
    description: 'Лечит вне боя. Здоровье само не восстанавливается.',
  },
  {
    id: 'health_potion',
    name: 'Зелье лечения',
    kind: 'consumable',
    width: 1,
    height: 2,
    weight: 0.5,
    stack: 5,
    tier: 2,
    restoreHealth: 60,
    description: 'Работа эльфийского ремесла.',
  },
  {
    id: 'torch',
    name: 'Факел',
    kind: 'consumable',
    width: 1,
    height: 2,
    weight: 0.8,
    stack: 5,
    tier: 0,
    slot: 'offHand',
    description: 'Светит, пока в левой руке. Щит туда уже не возьмёшь, а тебя видно издалека.',
  },
  { id: 'arrow', name: 'Стрелы', kind: 'consumable', width: 1, height: 1, weight: 0.05, stack: 60, tier: 0 },

  // ---------- снаряжение базового яруса ----------
  {
    id: 'wooden_club',
    name: 'Деревянная дубина',
    kind: 'weapon',
    width: 1,
    height: 3,
    weight: 2,
    stack: 1,
    tier: 1,
    slot: 'mainHand',
    damage: 13,
    skill: 'blunt',
  },
  {
    id: 'wooden_shield',
    name: 'Деревянный щит',
    kind: 'armor',
    width: 2,
    height: 2,
    weight: 3.5,
    stack: 1,
    tier: 1,
    slot: 'offHand',
    armor: 6,
  },
  { id: 'cloth_hood', name: 'Тканевый капюшон', kind: 'armor', width: 2, height: 2, weight: 0.5, stack: 1, tier: 1, slot: 'head', armor: 2 },
  { id: 'cloth_tunic', name: 'Тканевая рубаха', kind: 'armor', width: 2, height: 3, weight: 1.2, stack: 1, tier: 1, slot: 'chest', armor: 4 },
  { id: 'cloth_leggings', name: 'Тканевые штаны', kind: 'armor', width: 2, height: 2, weight: 0.9, stack: 1, tier: 1, slot: 'legs', armor: 3 },
  { id: 'leather_gloves', name: 'Кожаные перчатки', kind: 'armor', width: 1, height: 1, weight: 0.3, stack: 1, tier: 1, slot: 'hands', armor: 2 },

  // ---------- рецептурный ярус: дворф ----------
  {
    id: 'iron_sword',
    name: 'Железный меч',
    kind: 'weapon',
    width: 1,
    height: 4,
    weight: 3.2,
    stack: 1,
    tier: 2,
    slot: 'mainHand',
    damage: 24,
    skill: 'blade',
    description: 'Работа дворфийской кузни. Занимает полрюкзака — и стоит того.',
  },
  { id: 'iron_helm', name: 'Железный шлем', kind: 'armor', width: 2, height: 2, weight: 2.4, stack: 1, tier: 2, slot: 'head', armor: 9 },
  { id: 'iron_cuirass', name: 'Железная кираса', kind: 'armor', width: 3, height: 3, weight: 8, stack: 1, tier: 2, slot: 'chest', armor: 18 },

  // ---------- рецептурный ярус: человек ----------
  {
    id: 'hunting_bow',
    name: 'Охотничий лук',
    kind: 'weapon',
    width: 2,
    height: 4,
    weight: 1.6,
    stack: 1,
    tier: 2,
    slot: 'mainHand',
    damage: 18,
    skill: 'archery',
    description: 'Бьёт издали. Требует стрел.',
  },
  { id: 'leather_cap', name: 'Кожаный шлем', kind: 'armor', width: 2, height: 2, weight: 0.8, stack: 1, tier: 2, slot: 'head', armor: 5 },
  { id: 'leather_jerkin', name: 'Кожаный доспех', kind: 'armor', width: 2, height: 3, weight: 3, stack: 1, tier: 2, slot: 'chest', armor: 11 },

  // ---------- рецептурный ярус: эльф ----------
  {
    id: 'stamina_draught',
    name: 'Настой выносливости',
    kind: 'consumable',
    width: 1,
    height: 2,
    weight: 0.4,
    stack: 5,
    tier: 2,
    restoreStamina: 70,
    description: 'Возвращает дыхание посреди боя.',
  },
  {
    id: 'stone_elixir',
    name: 'Эликсир камня',
    kind: 'consumable',
    width: 1,
    height: 2,
    weight: 0.5,
    stack: 3,
    tier: 3,
    description: 'Ненадолго обращает кожу в камень.',
  },

  // ---------- магия ----------
  // Заклинания занимают место в рюкзаке: это тоже груз, и маг выбирает,
  // что взять с собой, наравне с воином.
  spellItem('spell_ember', 'ember', 'Свиток уголька', 1, 1, 0.2),
  spellItem('spell_frostbite', 'frostbite', 'Свиток стужи', 1, 2, 0.3),
  spellItem('spell_lightning', 'lightning', 'Свиток разряда', 1, 2, 0.4),
  spellItem('spell_mend', 'mend', 'Свиток заживления', 1, 2, 0.3),
  spellItem('spell_wardskin', 'wardskin', 'Свиток каменной кожи', 1, 2, 0.35),
  spellItem('spell_lantern', 'lantern', 'Свиток светоча', 1, 1, 0.2),
];

/** Свиток заклинания: не тратится при чтении, но занимает место и весит. */
function spellItem(
  id: ItemId,
  spellId: SpellId,
  name: string,
  width: number,
  height: number,
  weight: number,
): ItemDef {
  return {
    id,
    name,
    kind: 'spell',
    width,
    height,
    weight,
    stack: 1,
    tier: 2,
    spellId,
    description: SPELLS[spellId].description,
  };
}

export const ITEMS: Record<ItemId, ItemDef> = Object.fromEntries(
  ITEM_LIST.map((item) => [item.id, item]),
) as Record<ItemId, ItemDef>;

/**
 * Сколько горит один факел.
 *
 * Пять минут — столько, чтобы забег был возможен, но не бесплатен: с двумя
 * факелами в рюкзаке вниз не полезешь надолго, а значит темнота остаётся
 * вопросом, а не решённым делом. Прогоревший исчезает из руки.
 *
 * Число в общем коде, а не у сервера: игрок видит остаток в полосе факела,
 * и считать его обе стороны обязаны одинаково.
 */
export const TORCH_SECONDS = 300;

export function itemDef(id: ItemId): ItemDef {
  return ITEMS[id];
}

/** Существует ли такой предмет. Нужно при разборе данных из базы. */
export function isItemId(value: string): value is ItemId {
  return value in ITEMS;
}
