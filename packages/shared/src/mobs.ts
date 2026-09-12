/**
 * Обитатели диких земель. Шесть типов, от безобидных до опасных, —
 * этого хватает, чтобы игрок учился читать противника: у одного долгий замах,
 * другой быстрый и слабый, третьего в одиночку лучше обойти.
 */

export type MobId = 'rat' | 'wolf' | 'bandit' | 'ghoul' | 'skeleton' | 'ogre' | 'wight';

export interface LootEntry {
  itemId: string;
  name: string;
  /** Вероятность выпадения, 0..1. */
  chance: number;
  min: number;
  max: number;
}

export interface MobProfile {
  id: MobId;
  name: string;
  health: number;
  damage: number;
  armor: number;
  /** Множитель скорости ходьбы. */
  speedScale: number;
  radius: number;
  height: number;
  /** Дистанция, с которой замечает игрока. */
  aggroRange: number;
  /** Дальность удара. */
  attackRange: number;
  /** Замах: чем длиннее, тем честнее уворот. */
  windup: number;
  /** Пауза между ударами. */
  attackCooldown: number;
  /**
   * Привязка к дому: с этого расстояния от точки спавна моб уже всерьёз
   * подумывает бросить погоню. Это не забор, а мера — см. docs/npc.md.
   */
  leash: number;
  /**
   * Упорство в погоне, 0..1.
   *
   * Чем выше, тем реже моб отстаёт с каждым пройденным метром. Крыса бросает
   * сразу за околицей, нежить идёт, пока не развалится.
   */
  aggression: number;
  color: number;
  loot: LootEntry[];
}

export const MOBS: Record<MobId, MobProfile> = {
  rat: {
    id: 'rat',
    name: 'Крыса',
    health: 18,
    damage: 4,
    armor: 0,
    speedScale: 0.9,
    radius: 0.3,
    height: 0.5,
    aggroRange: 8,
    attackRange: 1.3,
    windup: 0.35,
    attackCooldown: 1.1,
    leash: 18,
    aggression: 0.2,
    color: 0x6b5c4a,
    loot: [{ itemId: 'rat_tail', name: 'Крысиный хвост', chance: 0.7, min: 1, max: 2 }],
  },
  wolf: {
    id: 'wolf',
    name: 'Волк',
    health: 40,
    damage: 9,
    armor: 2,
    speedScale: 1.35,
    radius: 0.42,
    height: 0.9,
    aggroRange: 16,
    attackRange: 1.8,
    windup: 0.4,
    attackCooldown: 1.3,
    leash: 30,
    aggression: 0.6,
    color: 0x5a5f66,
    loot: [
      { itemId: 'pelt', name: 'Волчья шкура', chance: 0.6, min: 1, max: 1 },
      { itemId: 'fang', name: 'Клык', chance: 0.35, min: 1, max: 3 },
    ],
  },
  bandit: {
    id: 'bandit',
    name: 'Разбойник',
    health: 65,
    damage: 12,
    armor: 8,
    speedScale: 1,
    radius: 0.35,
    height: 1.8,
    aggroRange: 18,
    attackRange: 2.3,
    windup: 0.5,
    attackCooldown: 1.5,
    leash: 26,
    aggression: 0.45,
    color: 0x7a5f45,
    loot: [
      { itemId: 'coin', name: 'Монеты', chance: 0.85, min: 3, max: 14 },
      { itemId: 'rusty_blade', name: 'Ржавый клинок', chance: 0.2, min: 1, max: 1 },
    ],
  },
  ghoul: {
    id: 'ghoul',
    name: 'Упырь',
    health: 85,
    damage: 15,
    armor: 5,
    speedScale: 0.8,
    radius: 0.4,
    height: 1.7,
    aggroRange: 14,
    attackRange: 2.1,
    windup: 0.75,
    attackCooldown: 1.8,
    leash: 22,
    aggression: 0.75,
    color: 0x69735e,
    loot: [
      { itemId: 'rot_flesh', name: 'Гнилая плоть', chance: 0.75, min: 1, max: 3 },
      { itemId: 'bone_dust', name: 'Костная пыль', chance: 0.3, min: 1, max: 2 },
    ],
  },
  skeleton: {
    id: 'skeleton',
    name: 'Скелет',
    health: 70,
    damage: 16,
    armor: 12,
    speedScale: 0.95,
    radius: 0.36,
    height: 1.75,
    aggroRange: 17,
    attackRange: 2.4,
    // Длинный замах и заметная пауза: скелет опасен, но читается.
    windup: 0.7,
    attackCooldown: 1.7,
    leash: 28,
    aggression: 0.55,
    color: 0xbdb49a,
    loot: [
      { itemId: 'bone', name: 'Кость', chance: 0.8, min: 1, max: 3 },
      { itemId: 'rusty_blade', name: 'Ржавый клинок', chance: 0.25, min: 1, max: 1 },
      { itemId: 'grave_silver', name: 'Могильное серебро', chance: 0.15, min: 1, max: 2 },
    ],
  },
  ogre: {
    id: 'ogre',
    name: 'Огр',
    health: 190,
    damage: 34,
    armor: 14,
    speedScale: 0.75,
    radius: 0.8,
    height: 2.8,
    aggroRange: 15,
    attackRange: 3.4,
    windup: 1.1,
    attackCooldown: 2.6,
    leash: 24,
    aggression: 0.5,
    color: 0x6f7a52,
    loot: [
      { itemId: 'ogre_hide', name: 'Шкура огра', chance: 0.8, min: 1, max: 2 },
      { itemId: 'crude_ingot', name: 'Грубый слиток', chance: 0.45, min: 1, max: 3 },
      { itemId: 'coin', name: 'Монеты', chance: 0.6, min: 10, max: 40 },
    ],
  },
  wight: {
    id: 'wight',
    name: 'Умертвие',
    health: 140,
    damage: 24,
    armor: 20,
    speedScale: 1.05,
    radius: 0.38,
    height: 1.9,
    aggroRange: 20,
    attackRange: 2.4,
    windup: 0.6,
    attackCooldown: 1.4,
    leash: 34,
    aggression: 0.9,
    color: 0x4a5566,
    loot: [
      { itemId: 'grave_silver', name: 'Могильное серебро', chance: 0.5, min: 1, max: 4 },
      { itemId: 'recipe_scrap', name: 'Обрывок рецепта', chance: 0.12, min: 1, max: 1 },
    ],
  },
};

/**
 * Сколько секунд тело остаётся видимым после смерти.
 *
 * Мгновенное исчезновение читается как баг: игрок не понимает, добил он
 * противника или тот убежал. Тело падает и лежит, потом растворяется.
 */
export const CORPSE_SECONDS = 4;

/** Кто где водится: чем дальше от города, тем опаснее. */
export function mobsForChunk(cx: number, cz: number): MobId[] {
  const distance = Math.max(Math.abs(cx), Math.abs(cz));
  if (distance === 0) return [];
  if (distance === 1) return ['rat', 'rat', 'wolf'];
  if (distance === 2) return ['wolf', 'bandit', 'skeleton'];
  return ['ghoul', 'skeleton', 'wight', 'ogre'];
}
