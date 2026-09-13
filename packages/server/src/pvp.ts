import {
  KARMA_PER_KILL,
  KARMA_PER_MOB,
  PURPLE_SECONDS,
  flagOf,
  isDungeon,
  isSafe,
  type PvpFlag,
} from '@grimhold/shared';
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

/** Какого цвета боец прямо сейчас. У зверья всегда белый — им флаги ни к чему. */
export function flagFor(combatant: Combatant): PvpFlag {
  return flagOf(combatant.karma, combatant.purpleFor);
}

/**
 * Игрок поднял руку на игрока.
 *
 * Фиолетовым становится **только нападающий на мирного**. Ответ мирного
 * фиолетовым его не делает: иначе защищаться было бы так же наказуемо, как
 * нападать, и первый удар решал бы всё.
 *
 * Нападение на фиолетового или красного не красит: они уже вне мира.
 */
export function markAggressor(attacker: Combatant, target: Combatant): void {
  if (attacker.kind !== 'player' || target.kind !== 'player') return;
  if (belowGround(attacker)) return;
  if (flagFor(target) !== 'white') return;

  attacker.purpleFor = PURPLE_SECONDS;
}

/**
 * Игрок убил игрока.
 *
 * Карма приходит только за мирного. Убил фиолетового или красного — ты его
 * не трогал первым, и отвечать не за что.
 */
export function punishKill(killer: Combatant, victim: Combatant): void {
  if (killer.kind !== 'player' || victim.kind !== 'player') return;
  if (belowGround(killer)) return;
  if (flagFor(victim) !== 'white') return;

  killer.karma += KARMA_PER_KILL;
}

/**
 * Внизу флаги не действуют — там все всем враги.
 *
 * Это замысел вылазки, а не послабление: подземелье и есть место, где встреча
 * с человеком опаснее нежити, и раздумывать «а не покраснею ли я» там некогда.
 * Наверху же всё остаётся как было — карма и фиолетовый живут своей жизнью
 * и вниз не смотрят.
 *
 * Проверяется по инстансу, а не по координатам: это правило **про место
 * действия**, а не про точку на карте. Цвет ника при этом не скрываем — он
 * говорит о человеке, а не о зале, в котором тот стоит.
 */
function belowGround(combatant: Combatant): boolean {
  return isDungeon(combatant.instanceId);
}

/**
 * Карма сходит со временем, а делом — быстрее.
 *
 * Мирная жизнь снимает её сама, убитый зверь ускоряет: замаливать делом
 * должно быть выгоднее, чем просто пересидеть.
 */
export function forgiveForMob(killer: Combatant): void {
  if (killer.kind !== 'player') return;
  killer.karma = Math.max(0, killer.karma - KARMA_PER_MOB);
}
