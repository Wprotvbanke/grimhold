import { DUNGEON_GATE, isSafe, type SelfState } from '@grimhold/shared';
import type { SoundApi, SoundId } from './sound.js';

/**
 * Из люка в городе слышно подземелье: гул и капель.
 *
 * Слышно в пяти метрах от люка: мимо проходят и слышат, но площадь
 * не звучит подземельем. Громкость растёт к люку плавно — граница радиуса
 * не должна щёлкать. Сначала у люка было вдвое тише, чем внизу, — владелец
 * едва слышал; стало на половину громче.
 */
const GATE_HEARING = 5;
const GATE_LOUDNESS = 0.75;

/** Доля громкости подземелья у люка на таком расстоянии. */
export function gateLoudness(x: number, z: number, underground: boolean): number {
  if (underground) return 0;
  const distance = Math.hypot(x - DUNGEON_GATE.x, z - DUNGEON_GATE.z);
  return GATE_LOUDNESS * Math.max(0, 1 - distance / GATE_HEARING);
}

/**
 * Звуки мира и вылазки: фон по месту, свой огонь, гонг хозяина глубины,
 * закрытие порталов, отдышка, переезд.
 *
 * Всё это — **переходы**, и хитрость у них одна: звучит смена, а не состояние.
 * Снапшот двадцать раз в секунду говорит «хозяин мёртв», а гонг бьёт один раз —
 * и только если на твоих глазах он **был жив**. Спустившийся в зал, где босса
 * уже убили, гонга не слышит: для него ничего не случилось.
 */

type Sound = Pick<SoundApi, 'play' | 'startLoop' | 'stopLoop' | 'setAmbience' | 'setNearby'>;

/** Где стоит слушатель — от этого фон. */
export type Scenery = 'town' | 'wild' | 'dungeon';

/** Место по координатам: подземелье, город внутри стен или дикие земли. */
export function sceneryAt(x: number, z: number, underground: boolean): Scenery {
  if (underground) return 'dungeon';
  return isSafe(x, z) ? 'town' : 'wild';
}

/**
 * Фон по месту.
 *
 * У города своего фона нет: подходящего под CC0 не нашлось, а ветер в городе
 * читается как пустырь. Лучше тишина площади, чем чужой звук.
 */
const AMBIENCE: Record<Scenery, SoundId | null> = {
  town: null,
  wild: 'ambWild',
  dungeon: 'ambDungeon',
};

export interface Atmosphere {
  /**
   * Каждый кадр: где слушатель. Фон меняется только на смене места.
   *
   * Принимает координаты, а не готовое место: решать, где кончается город,
   * — дело этого модуля, а не того, кто зовёт его сорок раз в секунду.
   */
  where(x: number, z: number, underground: boolean): void;
  /** Переехал в другой мир — звук перехода, а память о прошлом забыть. */
  moved(): void;
  /** Свежий снапшот: переходы, которые слышно. */
  self(state: SelfState, torchInHand: boolean): void;
  /** Умер — свой огонь гаснет вместе со звуком. */
  died(): void;
}

export function createAtmosphere(sound: Sound): Atmosphere {
  let scenery: Scenery | null = null;
  /** Прошлое, с которым сравнивается снапшот. `null` — ещё не с чем сравнить. */
  let bossAlive: boolean | null = null;
  let portalsOpen = false;
  let winded = false;
  let burning = false;

  function forget(): void {
    bossAlive = null;
    portalsOpen = false;
    winded = false;
  }

  return {
    where(x, z, underground) {
      sound.setNearby('ambDungeon', gateLoudness(x, z, underground));
      const next = sceneryAt(x, z, underground);
      if (next === scenery) return;
      scenery = next;
      sound.setAmbience(AMBIENCE[next]);
    },

    moved() {
      sound.play('transition');
      // Хозяин жив или мёртв в другом мире — к новому это отношения не имеет.
      forget();
    },

    self(state, torchInHand) {
      if (state.bossAlive !== undefined) {
        if (bossAlive === true && !state.bossAlive) sound.play('gong');
        bossAlive = state.bossAlive;
      } else {
        bossAlive = null;
      }

      const open = (state.portalsFor ?? 0) > 0;
      // Закрылись сами, по времени — а не потому, что игрок ушёл наверх.
      if (portalsOpen && !open && state.bossAlive === false) sound.play('portalClose');
      portalsOpen = open;

      const tired = state.exhausted > 0;
      if (tired && !winded) sound.play('breath');
      winded = tired;

      const lit = torchInHand && state.light > 0 && state.alive;
      if (lit && !burning) sound.startLoop('torch', 'torch');
      if (!lit && burning) sound.stopLoop('torch');
      burning = lit;
    },

    died() {
      if (burning) sound.stopLoop('torch');
      burning = false;
    },
  };
}
