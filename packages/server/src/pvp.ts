import { isSafe } from '@grimhold/shared';
import type { Combatant } from './combatant.js';

/**
 * Кто кого может бить.
 *
 * **Единственное место, где это решается.** Его зовут и удары, и снаряды,
 * и всё, что появится дальше: ловушки, чужие заклинания, добивание. Разойдись
 * эти проверки по местам применения — и однажды окажется, что мечом в городе
 * ударить нельзя, а «Угольком» можно.
 *
 * Сюда же в вехе 5 придут флаги и карма: правило «белого бить нельзя, пока он
 * сам не полез» ляжет рядом с правилом про город, а не поверх него.
 */

export interface Verdict {
  ok: boolean;
  /** Почему нельзя. Пустая строка, если можно. */
  reason: string;
}

const ALLOWED: Verdict = { ok: true, reason: '' };

function no(reason: string): Verdict {
  return { ok: false, reason };
}

/**
 * Между игроком и зверем правил нет: за стены мобов не пускают, а в диких
 * землях они и есть содержание. Правила начинаются там, где с обеих сторон
 * человек.
 */
export function mayAttack(attacker: Combatant, target: Combatant): Verdict {
  if (attacker === target || !target.alive) return no('');
  if (attacker.instanceId !== target.instanceId) return no('');
  if (attacker.kind !== 'player' || target.kind !== 'player') return ALLOWED;

  // Проверяются оба: иначе из ворот можно было бы стрелять по тем, кто внутри,
  // или прятаться за черту, продолжая бить наружу.
  if (isSafe(attacker.pos.x, attacker.pos.z)) return no('В городе не дерутся');
  if (isSafe(target.pos.x, target.pos.z)) return no('Он под защитой города');

  return ALLOWED;
}

/** Стоит ли боец в безопасной зоне. Короткая обёртка для читаемости. */
export function inSafeZone(combatant: Combatant): boolean {
  return isSafe(combatant.pos.x, combatant.pos.z);
}
