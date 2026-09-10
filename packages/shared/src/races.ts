/**
 * Расы. Раса определяет габариты, модификатор скорости и ремесленную специализацию —
 * класс (Воин / Следопыт / Маг) задаётся отдельно и на габариты не влияет.
 *
 * Ремесло: базовый ярус доступен всем без рецептов; рецептурный ярус —
 * только своей расе и только по изученному свитку из подземелья.
 */

export type Race = 'human' | 'dwarf' | 'elf';

export interface RaceProfile {
  id: Race;
  name: string;
  /** Полная высота тела в метрах. */
  height: number;
  /** Половина ширины по XZ. */
  radius: number;
  /** Множитель скорости ходьбы. */
  speedScale: number;
  /** Цвет заглушки на время блокаута. */
  color: number;
  /** Что раса умеет крафтить по рецептам. */
  craft: string;
}

export const RACES: Record<Race, RaceProfile> = {
  human: {
    id: 'human',
    name: 'Человек',
    height: 1.8,
    radius: 0.35,
    speedScale: 1,
    color: 0x8c7f63,
    craft: 'деревянное оружие, луки, тканевая и кожаная экипировка',
  },
  dwarf: {
    id: 'dwarf',
    name: 'Дворф',
    height: 1.3,
    radius: 0.42,
    speedScale: 0.78,
    color: 0x9c6b3f,
    craft: 'металлическое оружие и броня',
  },
  elf: {
    id: 'elf',
    name: 'Эльф',
    height: 1.85,
    radius: 0.32,
    speedScale: 1.1,
    color: 0x6f8c72,
    craft: 'зелья и бафы',
  },
};

export const DEFAULT_RACE: Race = 'human';
