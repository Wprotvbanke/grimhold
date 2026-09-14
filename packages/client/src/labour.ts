import { NODES, findNode } from '@grimhold/shared';
import type { Place, SoundApi, SoundId } from './sound.js';

/**
 * Звук работы: рубка, кирка, сбор руками, вскрытие сундука, ремесло.
 *
 * Работа — это полоса, и звучит она **ударами, пока полоса идёт**: первый
 * сразу, дальше раз в `STRIKE`. Ровная петля читалась бы как станок, удары —
 * как человек с топором.
 *
 * Своя работа знает, чем работают: по инструменту ноды. Чужая — только что
 * работают и где (`work` в снапшоте), поэтому у ноды чужая работа звучит
 * одним звуком, а **сундук узнаваем всегда** — ради него поле и завели.
 */

type Sound = Pick<SoundApi, 'play'>;

/** Чем работают — от этого звук ударов. */
export type Labour = 'chop' | 'mine' | 'gather' | 'lockpick' | 'craft';

/** Раз в сколько секунд звучит удар работы. */
const STRIKE = 0.75;

const SOUND: Record<Labour, SoundId> = {
  chop: 'chop',
  mine: 'mine',
  gather: 'gather',
  lockpick: 'lockpick',
  craft: 'craft',
};

/**
 * Какой звук у работы по её цели.
 *
 * Имя сундука (`chest.этаж.номер`) нода не узнаёт — это и отличает одно
 * от другого. У ноды звук решает инструмент: топор рубит, кирка бьёт, всё
 * остальное берётся руками.
 */
export function labourForWork(targetId: string): Labour {
  if (targetId.startsWith('chest.')) return 'lockpick';
  const node = findNode(targetId);
  const tool = node ? NODES[node.nodeId].tool : null;
  if (tool === 'axe') return 'chop';
  if (tool === 'pick') return 'mine';
  return 'gather';
}

export interface Worker extends Place {
  id: string;
  work: 'node' | 'chest';
}

export interface LabourSounds {
  /** Своя работа началась. Та же уже идёт — ничего: сообщение могут повторить. */
  begin(kind: Labour): void;
  end(): void;
  /** Каждый кадр: удары своей работы и работы соседей. */
  tick(dt: number, workers: Iterable<Worker>): void;
}

export function createLabour(sound: Sound): LabourSounds {
  let own: Labour | null = null;
  let ownClock = 0;
  /** Сколько прошло с прошлого удара у каждого соседа. Ушедших забываем. */
  const clocks = new Map<string, number>();
  const seen = new Set<string>();

  return {
    begin(kind) {
      if (own === kind) return;
      own = kind;
      ownClock = 0;
      sound.play(SOUND[kind]);
    },

    end() {
      own = null;
    },

    tick(dt, workers) {
      if (own) {
        ownClock += dt;
        if (ownClock >= STRIKE) {
          ownClock %= STRIKE;
          sound.play(SOUND[own]);
        }
      }

      seen.clear();
      for (const worker of workers) {
        seen.add(worker.id);
        const kind: Labour = worker.work === 'chest' ? 'lockpick' : 'gather';
        const clock = clocks.get(worker.id);
        // Начал работать — первый удар сразу, как у своей работы.
        if (clock === undefined) {
          clocks.set(worker.id, 0);
          sound.play(SOUND[kind], worker);
          continue;
        }
        const next = clock + dt;
        if (next >= STRIKE) {
          clocks.set(worker.id, next % STRIKE);
          sound.play(SOUND[kind], worker);
        } else {
          clocks.set(worker.id, next);
        }
      }
      for (const id of clocks.keys()) {
        if (!seen.has(id)) clocks.delete(id);
      }
    },
  };
}
