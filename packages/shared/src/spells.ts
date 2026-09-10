import type { SkillId } from './skills.js';

/**
 * Заклинания. Шесть штук — по замыслу магия редкая и опасная, поэтому
 * набор узкий, зато каждое заклинание делает что-то, чего иначе не сделать.
 *
 * Урон и лечение считает сервер; клиент только просит применить.
 */

export type SpellId =
  | 'ember'
  | 'frostbite'
  | 'lightning'
  | 'mend'
  | 'wardskin'
  | 'lantern';

export type SpellShape = 'projectile' | 'cone' | 'self';

export interface SpellProfile {
  id: SpellId;
  name: string;
  description: string;
  skill: SkillId;
  shape: SpellShape;
  manaCost: number;
  /** Время произнесения в секундах. */
  castTime: number;
  cooldown: number;
  /** Базовый урон либо лечение. */
  power: number;
  range: number;
  /** Раствор конуса для площадных, радианы. */
  arc?: number;
  /** Длительность эффекта в секундах. */
  duration?: number;
  /** Скорость снаряда, м/с. */
  projectileSpeed?: number;
}

export const SPELLS: Record<SpellId, SpellProfile> = {
  ember: {
    id: 'ember',
    name: 'Уголёк',
    description: 'Дешёвый огненный сгусток. Основной урон мага.',
    skill: 'evocation',
    shape: 'projectile',
    manaCost: 8,
    castTime: 0.5,
    cooldown: 0.6,
    power: 14,
    range: 28,
    projectileSpeed: 24,
  },
  frostbite: {
    id: 'frostbite',
    name: 'Стужа',
    description: 'Конус холода: слабый урон, но замедляет — удобно рвать дистанцию.',
    skill: 'evocation',
    shape: 'cone',
    manaCost: 16,
    castTime: 0.7,
    cooldown: 4,
    power: 9,
    range: 7,
    arc: Math.PI / 3,
    duration: 3,
  },
  lightning: {
    id: 'lightning',
    name: 'Разряд',
    description: 'Долгий каст, тяжёлый урон. Наказание за чужую ошибку.',
    skill: 'evocation',
    shape: 'projectile',
    manaCost: 30,
    castTime: 1.4,
    cooldown: 7,
    power: 46,
    range: 32,
    projectileSpeed: 42,
  },
  mend: {
    id: 'mend',
    name: 'Заживление',
    description: 'Лечит себя. В бою дорого: каст долгий и его видно.',
    skill: 'restoration',
    shape: 'self',
    manaCost: 22,
    castTime: 1.6,
    cooldown: 6,
    power: 38,
    range: 0,
  },
  wardskin: {
    id: 'wardskin',
    name: 'Каменная кожа',
    description: 'Временно добавляет броню.',
    skill: 'restoration',
    shape: 'self',
    manaCost: 18,
    castTime: 1,
    cooldown: 14,
    power: 35,
    range: 0,
    duration: 20,
  },
  lantern: {
    id: 'lantern',
    name: 'Светоч',
    description: 'Свет без факела. В подземелье это выбор: видеть или быть незаметным.',
    skill: 'restoration',
    shape: 'self',
    manaCost: 10,
    castTime: 0.6,
    cooldown: 2,
    power: 0,
    range: 0,
    duration: 120,
  },
};

/** Порядок в панели заклинаний — клавиши 1..6. */
export const SPELL_BAR: SpellId[] = ['ember', 'frostbite', 'lightning', 'mend', 'wardskin', 'lantern'];
