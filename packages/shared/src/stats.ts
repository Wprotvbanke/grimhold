import type { CharacterClass } from './classes.js';
import type { Race } from './races.js';

/**
 * Атрибуты и производные характеристики.
 *
 * Глобального уровня нет — сила персонажа растёт от навыков (skills.ts)
 * и снаряжения. Атрибуты задают стартовый уклон: раса даёт телесную основу,
 * класс — направление подготовки.
 */

export interface Attributes {
  /** Урон в ближнем бою и переносимый вес. */
  strength: number;
  /** Скорость атак, уклонения, урон дальнобойного оружия. */
  agility: number;
  /** Запас маны и сила заклинаний. */
  intellect: number;
  /** Здоровье и стамина. */
  endurance: number;
}

const BASE: Attributes = { strength: 10, agility: 10, intellect: 10, endurance: 10 };

/** Раса — это тело: дворф крепче, эльф ловчее и умнее, человек ровный. */
const RACE_BONUS: Record<Race, Partial<Attributes>> = {
  human: { strength: 1, agility: 1, intellect: 1, endurance: 1 },
  dwarf: { strength: 3, endurance: 3, agility: -2 },
  elf: { agility: 3, intellect: 3, strength: -2 },
};

/** Класс — это подготовка. */
const CLASS_BONUS: Record<CharacterClass, Partial<Attributes>> = {
  warrior: { strength: 3, endurance: 2 },
  ranger: { agility: 4, endurance: 1 },
  mage: { intellect: 5 },
};

export function attributesFor(race: Race, characterClass: CharacterClass): Attributes {
  const result = { ...BASE };
  for (const source of [RACE_BONUS[race], CLASS_BONUS[characterClass]]) {
    for (const [key, value] of Object.entries(source)) {
      result[key as keyof Attributes] += value as number;
    }
  }
  return result;
}

// ---------- производные характеристики ----------

export function maxHealth(attributes: Attributes): number {
  return Math.round(60 + attributes.endurance * 4);
}

export function maxMana(attributes: Attributes): number {
  return Math.round(20 + attributes.intellect * 5);
}

export function maxStamina(attributes: Attributes): number {
  return Math.round(70 + attributes.endurance * 3);
}

/** Стамина в секунду. Восстанавливается только после паузы (см. STAMINA_IDLE_DELAY). */
export function staminaRegen(attributes: Attributes): number {
  return 12 + attributes.endurance * 0.5;
}

export function manaRegen(attributes: Attributes): number {
  return 1.5 + attributes.intellect * 0.2;
}

/** Пауза без трат, после которой стамина начинает восстанавливаться. */
export const STAMINA_IDLE_DELAY = 1.0;
/** Здоровье само не восстанавливается — только зельями и бинтами. */
export const HEALTH_REGEN = 0;

export interface Vitals {
  health: number;
  mana: number;
  stamina: number;
}

export function fullVitals(attributes: Attributes): Vitals {
  return {
    health: maxHealth(attributes),
    mana: maxMana(attributes),
    stamina: maxStamina(attributes),
  };
}
