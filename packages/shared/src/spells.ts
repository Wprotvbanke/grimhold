import type { SkillId } from './skills.js';

/**
 * Заклинания.
 *
 * Магия у нас — это **свитки в отдельных клетках**, а не выученные умения:
 * игрок собирает себе набор из шести свитков, и этот набор и есть его класс.
 * Подробности замысла — docs/magic.md.
 *
 * Свитков шесть, и разнесены они по трём разрядам. Разряд — не украшение:
 * он задаёт цвет свитка, а по цвету человек узнаёт ячейку панели в бою,
 * не читая названия. Красный бьёт, голубой держит, зелёный помогает.
 *
 * Урон, лечение и радиусы считает сервер; клиент только просит применить.
 */

export type SpellId = 'fireball' | 'frost' | 'mend' | 'wardskin' | 'light' | 'meditation';

/** Разряд свитка. По нему берётся картинка и цвет ячейки. */
export type SpellCategory = 'damage' | 'control' | 'support';

export const CATEGORY_NAMES: Record<SpellCategory, string> = {
  damage: 'Разрушение',
  control: 'Контроль',
  support: 'Поддержка',
};

/**
 * Как заклинание достаёт цель.
 *
 * - `projectile` — летит телом, от него можно отойти;
 * - `burst` — вспышка кольцом вокруг чтеца, бьёт всех, кого дозволено бить;
 * - `blessing` — то же кольцо, но помогает: себе и тем, кого бить нельзя;
 * - `self` — только на себя;
 * - `channel` — держится, пока не отменят, и держит на месте самого чтеца.
 */
export type SpellShape = 'projectile' | 'burst' | 'blessing' | 'self' | 'channel';

export interface SpellProfile {
  id: SpellId;
  name: string;
  description: string;
  category: SpellCategory;
  skill: SkillId;
  shape: SpellShape;
  manaCost: number;
  /** Время произнесения в секундах. */
  castTime: number;
  cooldown: number;
  /** Базовый урон, лечение или прибавка к броне. */
  power: number;
  /** Дальность снаряда либо радиус кольца, метры. */
  range: number;
  /** Длительность эффекта в секундах. */
  duration?: number;
  /** Скорость снаряда, м/с. */
  projectileSpeed?: number;
  /** Сколько маны возвращает за секунду — только у медитации. */
  manaPerSecond?: number;
}

export const SPELLS: Record<SpellId, SpellProfile> = {
  fireball: {
    id: 'fireball',
    name: 'Огненный шар',
    description:
      'Сгусток пламени летит вперёд и бьёт первого, кого достанет. ' +
      'Бьёт дальше всего, но летит телом — от него уходят шагом в сторону.',
    category: 'damage',
    skill: 'evocation',
    shape: 'projectile',
    manaCost: 14,
    castTime: 0.6,
    cooldown: 1.2,
    power: 28,
    range: 40,
    projectileSpeed: 28,
  },
  frost: {
    id: 'frost',
    name: 'Заморозка',
    description:
      'Стужа расходится кольцом на десять метров: бьёт и замедляет на пять секунд ' +
      'всех вокруг, кого дозволено бить. Не про урон, а про то, чтобы не ушли.',
    category: 'control',
    skill: 'evocation',
    shape: 'burst',
    manaCost: 24,
    castTime: 0.9,
    cooldown: 8,
    power: 12,
    range: 10,
    duration: 5,
  },
  mend: {
    id: 'mend',
    name: 'Заживление ран',
    description:
      'Возвращает шестьдесят жизней разом — себе и всем своим в восьми метрах. ' +
      'Лечит именно своих: врага этим не поднять.',
    category: 'support',
    skill: 'restoration',
    shape: 'blessing',
    manaCost: 28,
    castTime: 1.2,
    cooldown: 10,
    power: 60,
    range: 8,
  },
  wardskin: {
    id: 'wardskin',
    name: 'Каменная кожа',
    description:
      'Броня себе и своим в восьми метрах на двадцать секунд. ' +
      'Читается до драки, а не посреди неё.',
    category: 'support',
    skill: 'restoration',
    shape: 'blessing',
    manaCost: 22,
    castTime: 1,
    cooldown: 16,
    power: 35,
    range: 8,
    duration: 20,
  },
  light: {
    id: 'light',
    name: 'Свиток света',
    description:
      'Белый свет вокруг, шире факела и без огня в руке. ' +
      'В подземелье это выбор: видеть самому или не быть увиденным.',
    category: 'support',
    skill: 'restoration',
    shape: 'self',
    manaCost: 12,
    castTime: 0.6,
    cooldown: 2,
    power: 0,
    range: 0,
    duration: 120,
  },
  meditation: {
    id: 'meditation',
    name: 'Медитация',
    description:
      'Возвращает свою ману, пока стоишь. С места не сойти — отпускает только ' +
      'повторное нажатие. Мана только себе: делиться ею нельзя.',
    category: 'support',
    skill: 'restoration',
    shape: 'channel',
    manaCost: 0,
    castTime: 0.5,
    cooldown: 3,
    power: 0,
    range: 0,
    manaPerSecond: 6,
  },
};

/** Все свитки разом — для перебора в интерфейсе и в проверках. */
export const SPELL_IDS = Object.keys(SPELLS) as SpellId[];
