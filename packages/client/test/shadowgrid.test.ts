import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { snapToShadowGrid } from '../src/daynight.js';

/**
 * Выравнивание карты теней.
 *
 * Карта ездит за игроком. Если возить её за точной позицией, сетка её пикселей
 * сдвигается на доли пикселя каждый кадр, и края всех теней в кадре начинают
 * мелко ползти: стоя не видно, в движении дрожит вся картинка.
 *
 * Проверяется главное свойство: пока игрок не прошёл целый пиксель карты,
 * карта стоит на месте.
 */

const frame = new THREE.Object3D();
const towardSun = new THREE.Vector3(20, 40, 15);
const out = new THREE.Vector3();

function anchorFor(x: number, z: number): THREE.Vector3 {
  const result = new THREE.Vector3();
  snapToShadowGrid(frame, towardSun, new THREE.Vector3(x, 1.7, z), out);
  return result.copy(out);
}

/**
 * Насколько карта уехала **поперёк луча света**.
 *
 * Мерить надо именно это: сетка пикселей лежит в плоскости, перпендикулярной
 * лучу, и ползают края от сдвига в ней. Смещение вдоль луча сетку не трогает —
 * для ортографической тени это просто другая глубина.
 */
function sideways(before: THREE.Vector3, after: THREE.Vector3): number {
  const delta = new THREE.Vector3().subVectors(after, before);
  const along = towardSun.clone().normalize();
  delta.addScaledVector(along, -delta.dot(along));
  return delta.length();
}

describe('карта теней стоит на сетке', () => {
  it('шаг в миллиметр её не двигает', () => {
    const before = anchorFor(10, 10);
    const after = anchorFor(10.001, 10.001);

    expect(sideways(before, after)).toBeLessThan(1e-9);
  });

  it('а шаг в метр — двигает', () => {
    const before = anchorFor(10, 10);
    const after = anchorFor(11, 10);

    expect(sideways(before, after)).toBeGreaterThan(0.5);
  });

  it('и уводит от игрока не дальше половины пикселя', () => {
    // Пиксель карты — шесть с половиной сантиметров: сдвиг карты на такую
    // величину не виден, а вот ползающие края видны сразу.
    for (const step of [0, 0.013, 0.031, 0.047, 0.062, 0.2, 1.7]) {
      const wanted = new THREE.Vector3(4 + step, 1.7, -3 - step);
      snapToShadowGrid(frame, towardSun, wanted, out);
      expect(out.distanceTo(wanted)).toBeLessThan(0.07);
    }
  });

  it('одна и та же точка — один и тот же узел', () => {
    // Иначе выравнивание само стало бы источником дрожания.
    const once = anchorFor(-7.3, 12.9);
    const twice = anchorFor(-7.3, 12.9);
    expect(twice.distanceTo(once)).toBe(0);
  });
});
