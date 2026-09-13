/**
 * Навыки растут от использования — как в Meridian 59, и это осознанное решение:
 * глобального уровня нет, поэтому разрыв между новичком и ветераном узкий,
 * и в подземелье с полной потерей вещей новичку есть что ловить.
 *
 * Рост замедляется с уровнем: первые уровни даются за минуты, последние — за
 * недели. Так ветеран заметно лучше, но не недосягаем.
 */

export type SkillId =
  | 'blade'
  | 'blunt'
  | 'archery'
  | 'evocation'
  | 'restoration'
  | 'block'
  | 'evasion';

export interface SkillProfile {
  id: SkillId;
  name: string;
  description: string;
}

export const SKILLS: Record<SkillId, SkillProfile> = {
  blade: { id: 'blade', name: 'Клинок', description: 'Мечи, топоры, кинжалы' },
  blunt: { id: 'blunt', name: 'Дробящее', description: 'Молоты и палицы' },
  archery: { id: 'archery', name: 'Стрельба', description: 'Луки и арбалеты' },
  evocation: { id: 'evocation', name: 'Разрушение', description: 'Боевая магия' },
  restoration: { id: 'restoration', name: 'Восстановление', description: 'Лечение и защита' },
  block: { id: 'block', name: 'Блок', description: 'Щиты и парирование' },
  evasion: { id: 'evasion', name: 'Уклонение', description: 'Рывки и уходы' },
};

export const MAX_SKILL_LEVEL = 100;

export type SkillBook = Partial<Record<SkillId, number>>;

/** Сколько опыта нужно, чтобы уйти с этого уровня на следующий. */
export function experienceForLevel(level: number): number {
  return Math.round(20 * Math.pow(1 + level / 12, 2.1));
}

export interface SkillProgress {
  level: number;
  experience: number;
}

/**
 * Начисляет опыт за использование. Возвращает новый прогресс и признак того,
 * что уровень поднялся — по нему клиент показывает сообщение.
 */
export function gainExperience(
  progress: SkillProgress,
  amount: number,
): { progress: SkillProgress; levelsGained: number } {
  if (progress.level >= MAX_SKILL_LEVEL) {
    return { progress, levelsGained: 0 };
  }

  let { level, experience } = progress;
  experience += amount;
  let levelsGained = 0;

  while (level < MAX_SKILL_LEVEL && experience >= experienceForLevel(level)) {
    experience -= experienceForLevel(level);
    level += 1;
    levelsGained += 1;
  }

  return { progress: { level, experience }, levelsGained };
}

/** Опыт за одно попадание. Промахи не учат — иначе выгодно бить воздух. */
export const EXPERIENCE_PER_HIT = 3;
/** Опыт за удачный блок или уклонение от удара. */
export const EXPERIENCE_PER_DEFENCE = 4;
/**
 * Добивание учит заметно лучше, и **цена зависит от убитого**:
 * `experienceFor` в `mobs.ts`. Плоского числа здесь нет намеренно — пока оно
 * было, выгоднее всего было бить крыс у ворот.
 *
 * Опыт за попадание при этом остался плоским, и это не забывчивость: удар
 * учит движению, а бой — противнику.
 */
