/**
 * Классы. Боевая роль персонажа; раса задаётся отдельно и отвечает за ремесло.
 * Навыки растут от использования, глобального уровня нет — поэтому класс
 * определяет стартовый уклон, а не жёсткую специализацию навсегда.
 */

export type CharacterClass = 'warrior' | 'ranger' | 'mage';

export interface ClassProfile {
  id: CharacterClass;
  name: string;
  description: string;
}

export const CLASSES: Record<CharacterClass, ClassProfile> = {
  warrior: {
    id: 'warrior',
    name: 'Воин',
    description: 'Ближний бой, тяжёлая броня, блок щитом',
  },
  ranger: {
    id: 'ranger',
    name: 'Следопыт',
    description: 'Луки и арбалеты, лёгкая броня, быстрые уклонения',
  },
  mage: {
    id: 'mage',
    name: 'Маг',
    description: 'Заклинания и мана, слабая защита, урон по площади',
  },
};

export const DEFAULT_CLASS: CharacterClass = 'warrior';
