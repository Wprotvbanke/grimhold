import { describe, expect, it } from 'vitest';
import { createFace } from '../src/face.js';

/** Картинка без DOM: лицо пишет только `src`. */
function picture(): { image: HTMLImageElement; shown: () => string } {
  const image = { src: '' } as HTMLImageElement;
  return { image, shown: () => image.src.split('/').pop() ?? '' };
}

describe('лицо в панели', () => {
  it('урон мелькает и возвращается к основе — «мало здоровья», если его мало', () => {
    const { image, shown } = picture();
    const face = createFace(image);
    face.reset();
    face.vitals(100, 100);
    face.update(0);
    expect(shown()).toBe('full.webp');

    face.vitals(20, 100);
    face.update(100);
    expect(shown()).toBe('hit.webp');

    face.update(5000);
    expect(shown()).toBe('low.webp');
  });

  it('бой мелькает поверх спокойного и гаснет', () => {
    const { image, shown } = picture();
    const face = createFace(image);
    face.reset();
    face.vitals(100, 100);
    face.update(0);
    face.fight();
    face.update(1000);
    expect(shown()).toBe('fight.webp');
    face.update(4000);
    expect(shown()).toBe('full.webp');
  });

  it('торг держится, пока открыт; сделка мелькает', () => {
    const { image, shown } = picture();
    const face = createFace(image);
    face.reset();
    face.vitals(100, 100);
    face.trade('open');
    face.update(0);
    expect(shown()).toBe('trade.webp');
    face.trade('done');
    face.update(100);
    expect(shown()).toBe('trade_end.webp');
    face.update(5000);
    expect(shown()).toBe('full.webp');
  });
});
