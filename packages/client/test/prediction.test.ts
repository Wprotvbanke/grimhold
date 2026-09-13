import { describe, expect, it } from 'vitest';
import { INPUT_DT } from '@grimhold/shared';
import { Predictor } from '../src/prediction.js';

/**
 * Ровность кадра.
 *
 * Шаги симуляции идут ровно шестьдесят раз в секунду, а кадры — как выйдет.
 * Если показывать в кадре последний целый шаг, при экране в 60 Гц и малейшем
 * расхождении часов один кадр не получит ни одного шага, а следующий получит
 * два: камера стоит и прыгает через раз. В движении это читается как мелкая
 * тряска всего мира — сильнее всего при движении боком, где картинка едет
 * по экрану быстрее всего.
 *
 * Поэтому проверяется не позиция, а **равномерность**: за одинаковые кадры
 * камера обязана проходить одинаковый путь.
 */

const FORWARD = { forward: 1, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };

/** Шаги камеры за кадр при заданной длительности кадра. */
function cameraSteps(frameSeconds: number, frames = 90): number[] {
  const predictor = new Predictor({ x: 0, y: 0.1, z: 0 }, () => []);
  const out = { x: 0, y: 0, z: 0 };
  const path: number[] = [];

  let previous: { x: number; z: number } | null = null;
  for (let i = 0; i < frames; i++) {
    predictor.collectInputs(frameSeconds, FORWARD);
    predictor.renderPosition(frameSeconds, out);

    if (previous) path.push(Math.hypot(out.x - previous.x, out.z - previous.z));
    previous = { x: out.x, z: out.z };
  }

  // Первые кадры — разгон: скорость там честно растёт, и мерить ровность
  // на них нечего.
  return path.slice(30);
}

describe('камера идёт ровно', () => {
  it('кадры не кратны шагу симуляции — ход всё равно ровный', () => {
    // 72 Гц: на такой частоте шаги в 60 Гц и кадры расходятся постоянно.
    const steps = cameraSteps(1 / 72);
    const longest = Math.max(...steps);
    const shortest = Math.min(...steps);

    expect(shortest).toBeGreaterThan(0);
    // Без сглаживания разброс был бы двукратным: кадр без шага и кадр с двумя.
    expect(longest / shortest).toBeLessThan(1.15);
  });

  it('и на частоте экрана, совпадающей с шагом', () => {
    const steps = cameraSteps(INPUT_DT);
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.15);
  });

  it('телепорт не размазывается по кадрам', () => {
    // Перенос в подземелье — разрыв, а не движение: тянуть камеру от старого
    // места к новому значит пролететь через полмира.
    const predictor = new Predictor({ x: 0, y: 0.1, z: 0 }, () => []);
    const out = { x: 0, y: 0, z: 0 };

    predictor.collectInputs(1 / 60, FORWARD);
    predictor.teleport({ x: 8192, y: 0.1, z: 8192 });
    predictor.renderPosition(1 / 60, out);

    expect(out.x).toBeCloseTo(8192);
    expect(out.z).toBeCloseTo(8192);
  });
});
