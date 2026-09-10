import { INTERP_DELAY_MS, type EntitySnapshot } from '@grimhold/shared';

/**
 * Интерполяция чужих сущностей.
 *
 * Снапшоты приходят 20 раз в секунду, а кадров — 60+. Если рисовать последнюю
 * присланную позицию, движение будет ступенчатым, а любая потеря пакета — дыркой.
 * Поэтому чужих показываем с задержкой в INTERP_DELAY_MS и плавно ведём между
 * двумя известными точками. Своего игрока это не касается: он предсказывается.
 */

interface Sample {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const MAX_SAMPLES = 32;

export interface InterpolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Горизонтальная скорость — по ней выбирается анимация ходьбы или покоя. */
  speed: number;
}

export class EntityInterpolator {
  private readonly samples: Sample[] = [];

  push(entity: EntitySnapshot, time: number): void {
    this.samples.push({ time, x: entity.x, y: entity.y, z: entity.z, yaw: entity.yaw });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Поза на момент «сейчас минус задержка». */
  sample(now: number, out: InterpolatedPose): void {
    const target = now - INTERP_DELAY_MS;
    const samples = this.samples;

    const newest = samples[samples.length - 1];
    if (!newest) return;

    // Данных ещё не хватает или связь отстала — показываем последнее известное.
    const oldest = samples[0]!;
    if (samples.length === 1 || target <= oldest.time) {
      out.x = oldest.x;
      out.y = oldest.y;
      out.z = oldest.z;
      out.yaw = oldest.yaw;
      out.speed = 0;
      return;
    }
    if (target >= newest.time) {
      out.x = newest.x;
      out.y = newest.y;
      out.z = newest.z;
      out.yaw = newest.yaw;
      out.speed = 0;
      return;
    }

    for (let i = samples.length - 1; i > 0; i--) {
      const after = samples[i]!;
      const before = samples[i - 1]!;
      if (target < before.time || target > after.time) continue;

      const span = after.time - before.time;
      const alpha = span > 0 ? (target - before.time) / span : 1;

      out.x = before.x + (after.x - before.x) * alpha;
      out.y = before.y + (after.y - before.y) * alpha;
      out.z = before.z + (after.z - before.z) * alpha;
      out.yaw = before.yaw + shortestAngle(before.yaw, after.yaw) * alpha;

      const distance = Math.hypot(after.x - before.x, after.z - before.z);
      out.speed = span > 0 ? distance / (span / 1000) : 0;
      return;
    }
  }

  /** Отбрасывает то, что уже никогда не понадобится. */
  prune(now: number): void {
    const cutoff = now - INTERP_DELAY_MS * 4;
    while (this.samples.length > 2 && this.samples[0]!.time < cutoff) {
      this.samples.shift();
    }
  }
}

/** Кратчайший поворот между углами — чтобы разворот не шёл «через весь круг». */
function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
