import { INTERP_DELAY_MS, TICK_MS, type Vec3 } from '@grimhold/shared';

/**
 * История позиций для лагкомпенсации.
 *
 * Задача: игрок бьёт по тому, что видит на экране, а видит он прошлое —
 * пакет шёл до него полпинга, да ещё интерполяция чужих отстаёт на 110 мс.
 * Если сервер проверит попадание по текущим позициям, удары по движущейся
 * цели будут «проходить сквозь» — классическая жалоба на любой шутер.
 *
 * Поэтому клиент присылает номер снапшота, который он видел в момент удара,
 * а сервер отматывает цели ровно туда.
 *
 * Отматывать бесконечно нельзя: иначе с большой задержкой можно бить по тому,
 * где противник был секунду назад. Отсюда потолок REWIND_LIMIT_MS.
 */

/** Дальше этого сервер не отматывает: защита от «стрельбы по прошлому». */
export const REWIND_LIMIT_MS = 400;

interface Sample {
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const CAPACITY = Math.ceil((REWIND_LIMIT_MS * 2) / TICK_MS);

export class PositionHistory {
  private readonly tracks = new Map<string, Sample[]>();

  record(id: string, tick: number, pos: Vec3, yaw: number): void {
    let track = this.tracks.get(id);
    if (!track) {
      track = [];
      this.tracks.set(id, track);
    }
    track.push({ tick, x: pos.x, y: pos.y, z: pos.z, yaw });
    if (track.length > CAPACITY) track.shift();
  }

  forget(id: string): void {
    this.tracks.delete(id);
  }

  /**
   * Где сущность была на указанном тике. Если история не достаёт —
   * возвращает ближайшее известное, а не выдумывает.
   */
  at(id: string, tick: number, fallback: { pos: Vec3; yaw: number }): { pos: Vec3; yaw: number } {
    const track = this.tracks.get(id);
    if (!track || track.length === 0) return fallback;

    let best: Sample | undefined;
    for (let i = track.length - 1; i >= 0; i--) {
      const sample = track[i]!;
      if (sample.tick <= tick) {
        best = sample;
        break;
      }
    }

    const chosen = best ?? track[0]!;
    return { pos: { x: chosen.x, y: chosen.y, z: chosen.z }, yaw: chosen.yaw };
  }

  /**
   * Приводит присланный клиентом номер снапшота к тику, на который честно
   * отматывать: не в будущее и не дальше потолка.
   */
  static clampRewind(currentTick: number, claimedViewTick: number): number {
    const maxRewindTicks = Math.ceil(REWIND_LIMIT_MS / TICK_MS);
    const interpTicks = Math.ceil(INTERP_DELAY_MS / TICK_MS);

    // Клиент видит чужих с задержкой интерполяции — учитываем её тоже.
    const desired = Math.min(claimedViewTick, currentTick) - interpTicks;
    return Math.max(desired, currentTick - maxRewindTicks);
  }
}
