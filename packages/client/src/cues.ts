import {
  DUNGEON_BOSS,
  type ActionKind,
  type CombatEvent,
  type EntitySnapshot,
  type ProjectileSnapshot,
} from '@grimhold/shared';
import type { SoundApi, SoundId } from './sound.js';

/**
 * Не чаще раза в столько секунд ревёт хозяин глубины.
 *
 * Замах у него раз в три секунды, а рёв — три секунды: реви он на каждом,
 * бой звучал бы сплошным рёвом. Постоянное должно быть тише и реже события.
 */
const ROAR_EVERY = 12;

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
  /** Своё заклинание началось — руки дёрнулись с посохом. Шёпот сразу, как и взмах. */
  ownCast(): void;
  combat(event: CombatEvent): void;
  /**
   * Чужие замахи — по свежему снапшоту. Сущности уже опознанные: вид моба
   * приходит в снапшоте один раз, а по нему решается, чем звучит замах.
   * `now` — секунды, для редкого рёва.
   */
  entities(list: readonly EntitySnapshot[], selfId: string | null, now?: number): void;
  projectiles(list: readonly ProjectileSnapshot[]): void;
}

export function createCues(sound: Sound): Cues {
  /** Кто замахивался в прошлом снапшоте. */
  let winding = new Set<string>();
  /** Какие стрелы уже летели. */
  let flying = new Set<string>();
  /** Кто из видимых — хозяин глубины: события боя знают только имена-ключи. */
  const bosses = new Set<string>();
  let roaredAt = -Infinity;

  return {
    ownAction(kind, bowInHand) {
      if (kind === 'dodge') sound.play('dodge');
      // С луком удар — это выстрел: звучит тетива, когда стрела появится.
      else if (!bowInHand) sound.play('swing');
    },

    ownCast() {
      sound.play('castWhisper');
    },

    combat(event) {
      const id = OUTCOME[event.kind];
      if (id) sound.play(id, event);
      // Король крыс сверх общего звука пищит от боли и визжит, умирая.
      if (bosses.has(event.targetId)) {
        if (event.kind === 'hit') sound.play('bossPain', event);
        if (event.kind === 'death') sound.play('bossDeath', event);
      }
    },

    entities(list, selfId, now = performance.now() / 1000) {
      const windingNow = new Set<string>();
      for (const entity of list) {
        // Вид моба приходит только в первом снапшоте — дальше помним по id.
        if (entity.mobId === DUNGEON_BOSS) bosses.add(entity.id);
        const boss = bosses.has(entity.id);
        // Свой замах уже прозвучал в ownAction — второй раз не нужен.
        if (entity.id === selfId || entity.phase !== 'windup') continue;
        windingNow.add(entity.id);
        if (winding.has(entity.id)) continue;
        if (!boss) {
          sound.play('swing', entity);
          continue;
        }
        sound.play('bossAttack', entity);
        if (now - roaredAt >= ROAR_EVERY) {
          roaredAt = now;
          sound.play('bossRoar', entity);
        }
      }
      winding = windingNow;
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
