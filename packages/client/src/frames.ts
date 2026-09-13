/**
 * Замер кадра.
 *
 * Средний FPS почти ничего не говорит о плавности: сто девяносто девять кадров
 * в секунду с одним застрявшим кадром на десяток выглядят хуже ровных шестидесяти.
 * Дрожание картинки — это **разброс** длительности кадров, а не их число.
 *
 * Поэтому меряются три вещи: обычный кадр (медиана), тяжёлый (95-й процентиль)
 * и доля рывков — кадров заметно длиннее обычного. Ровная картинка — это когда
 * рывков почти нет, каким бы ни было число кадров.
 */

/** По скольким кадрам судим. На двух сотнях кадров это около секунды. */
const WINDOW = 240;

/**
 * Во сколько раз кадр должен быть длиннее обычного, чтобы считаться рывком.
 *
 * Полтора — это уже пропущенная развёртка: кадр, не успевший к своему моменту,
 * показывается на следующем, и глаз ловит это как дёрганье.
 */
const STUTTER = 1.5;

export interface FrameStats {
  /** Зовётся раз в кадр с его длительностью в миллисекундах. */
  push(ms: number): void;
  /** Готовая строка для меню настроек. */
  readout(): string;
  /** Медиана, 95-й процентиль и доля рывков — для отладочной строки и тестов. */
  measure(): { median: number; p95: number; worst: number; stutter: number; fps: number };
}

export function createFrameStats(): FrameStats {
  const times: number[] = [];

  function measure(): { median: number; p95: number; worst: number; stutter: number; fps: number } {
    if (times.length === 0) return { median: 0, p95: 0, worst: 0, stutter: 0, fps: 0 };

    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    const worst = sorted[sorted.length - 1]!;
    const rough = times.filter((ms) => ms > median * STUTTER).length / times.length;

    return { median, p95, worst, stutter: rough, fps: median > 0 ? 1000 / median : 0 };
  }

  return {
    push(ms) {
      // Отрицательных и невероятных кадров не бывает: это перевод часов,
      // возврат из свёрнутого окна или подобная небывальщина.
      if (!(ms > 0) || ms > 1000) return;
      times.push(ms);
      if (times.length > WINDOW) times.shift();
    },

    measure,

    readout() {
      const { median, p95, worst, stutter, fps } = measure();
      if (median === 0) return 'замер идёт…';

      return (
        `кадр ${median.toFixed(1)} мс (${Math.round(fps)} в секунду) · ` +
        `тяжёлый ${p95.toFixed(1)} · худший ${worst.toFixed(1)} · ` +
        `рывков ${(stutter * 100).toFixed(1)}%`
      );
    },
  };
}
