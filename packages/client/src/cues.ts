import type { ActionKind, CombatEvent, EntitySnapshot, ProjectileSnapshot } from '@grimhold/shared';
import type { SoundApi, SoundId } from './sound.js';

/**
 * Звуки боя: что прозвучит на какое событие.
 *
 * Отдельно от main.ts, потому что здесь живёт единственная хитрая часть —
 * **начало**. Снапшот двадцать раз в секунду говорит «замахивается»,
 * а звучать должно первое из этих сообщений, а не каждое: иначе один замах
 * звучит очередью. То же со стрелой — она видна во многих снапшотах подряд,
 * а тетива звенит один раз.
 */

type Sound = Pick<SoundApi, 'play'>;

/** Что звучит на исход удара. Промаха нет: взмах уже прозвучал в начале замаха. */
const OUTCOME: Partial<Record<CombatEvent['kind'], SoundId>> = {
  hit: 'hit',
  blocked: 'blocked',
  dodged: 'dodge',
  death: 'death',
  heal: 'heal',
};

export interface Cues {
  /**
   * Свой удар начался.
   *
   * Звучит сразу, как дёрнулись руки, а не по ответу сервера: иначе удар
   * звучит на полпинга позже, чем виден, и ощущается вязким.
   */
  ownAction(kind: ActionKind, bowInHand: boolean): void;
  combat(event: CombatEvent): void;
  /** Чужие замахи — по свежему снапшоту. */
  entities(list: readonly EntitySnapshot[], selfId: string | null): void;
  projectiles(list: readonly ProjectileSnapshot[]): void;
}

export function createCues(sound: Sound): Cues {
  /** Кто замахивался в прошлом снапшоте. */
  let winding = new Set<string>();
  /** Какие стрелы уже летели. */
  let flying = new Set<string>();

  return {
    ownAction(kind, bowInHand) {
      if (kind === 'dodge') sound.play('dodge');
      // С луком удар — это выстрел: звучит тетива, когда стрела появится.
      else if (!bowInHand) sound.play('swing');
    },

    combat(event) {
      const id = OUTCOME[event.kind];
      if (id) sound.play(id, event);
    },

    entities(list, selfId) {
      const now = new Set<string>();
      for (const entity of list) {
        // Свой замах уже прозвучал в ownAction — второй раз не нужен.
        if (entity.id === selfId || entity.phase !== 'windup') continue;
        now.add(entity.id);
        if (!winding.has(entity.id)) sound.play('swing', entity);
      }
      winding = now;
    },

    projectiles(list) {
      const now = new Set<string>();
      for (const projectile of list) {
        now.add(projectile.id);
        // Звук заклинания пока не найден под CC0 — сгусток летит молча.
        if (!flying.has(projectile.id) && !projectile.spellId) sound.play('bow', projectile);
      }
      flying = now;
    },
  };
}
