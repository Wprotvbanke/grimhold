/**
 * Рост самого персонажа.
 *
 * Вторая дорожка рядом с навыками, и устроена она **нарочно иначе**:
 *
 * - **навыки учатся сами** от того, чем ты пользуешься: бьёшь мечом — растёт
 *   клинок, и выбирать тут нечего;
 * - **персонаж растёт победами**: за убитых копится опыт, из него выходят
 *   очки, и очко игрок вкладывает **сам** — в жизнь, стамину или ману.
 *
 * Разделение не косметическое. Навык — это умение, оно приходит от повторения;
 * очки — это выбор, каким ты хочешь быть, и выбор должен быть редким, чтобы
 * что-то значить. Отсюда и цена: первое очко даётся за несколько боёв,
 * двадцатое — за сотни, полсотни — дело месяцев.
 */

export type Vital = 'health' | 'stamina' | 'mana';

/** Сколько прибавляет одно вложенное очко. */
export const HEALTH_PER_POINT = 3;
export const STAMINA_PER_POINT = 3;
export const MANA_PER_POINT = 3;

/**
 * Сколько опыта стоит следующее очко, когда `earned` уже заработано.
 *
 * Считается от **числа уже полученных очков**, а не от суммы опыта: так цена
 * читается в игре («следующее стоит вдвое дороже прошлого»), а не выводится
 * из накопленного числа.
 *
 * Первое очко — 120 опыта, это четыре умертвия или дюжина волков: новичок
 * должен попробовать вложение в первый же вечер. Десятое стоит уже 791,
 * а всего к нему приходит 4230 — сто тридцать семь умертвий.
 */
export function pointCost(earned: number): number {
  return Math.round(120 * Math.pow(1 + Math.max(0, earned) / 4, 1.6));
}

/** Куда вложены очки. Сколько во что — столько и прибавки. */
export interface SpentPoints {
  health: number;
  stamina: number;
  mana: number;
}

export function noPoints(): SpentPoints {
  return { health: 0, stamina: 0, mana: 0 };
}

/** Состояние роста персонажа: что накоплено, что не роздано, что вложено. */
export interface Progress {
  /** Опыт персонажа, накопленный к следующему очку. */
  pool: number;
  /** Нераспределённые очки. */
  points: number;
  /** Сколько очков уже вложено — из них и растут пределы. */
  spent: SpentPoints;
}

export function emptyProgress(): Progress {
  return { pool: 0, points: 0, spent: noPoints() };
}

/** Всего очков у персонажа: и вложенные, и лежащие без дела. */
export function totalPoints(progress: Progress): number {
  const { health, stamina, mana } = progress.spent;
  return progress.points + health + stamina + mana;
}

/**
 * Добавляет опыт персонажа и выдаёт очки, если набралось.
 *
 * Возвращает новое состояние и сколько очков прибавилось — по этому клиент
 * говорит игроку, что есть что вложить. Цикл, а не одно деление: крупная
 * награда может дать сразу несколько очков.
 */
export function addProgress(progress: Progress, amount: number): {
  progress: Progress;
  gained: number;
} {
  let pool = progress.pool + Math.max(0, amount);
  let points = progress.points;
  let gained = 0;

  let earned = totalPoints(progress);
  while (pool >= pointCost(earned)) {
    pool -= pointCost(earned);
    points += 1;
    earned += 1;
    gained += 1;
  }

  return { progress: { ...progress, pool, points }, gained };
}

/** Вкладывает очко. Возвращает null, если вкладывать нечего. */
export function spendPoint(progress: Progress, into: Vital): Progress | null {
  if (progress.points <= 0) return null;

  return {
    ...progress,
    points: progress.points - 1,
    spent: { ...progress.spent, [into]: progress.spent[into] + 1 },
  };
}
