import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TILE_METERS, scaleBoxUv } from '../src/scene.js';

/**
 * Развёртка коробок.
 *
 * У BoxGeometry каждая грань размечена от нуля до единицы, поэтому без
 * пересчёта текстура растягивается на всю грань: один камень мостовой
 * на шестьдесят метров пола. Здесь проверяется, что тайл всегда занимает
 * TILE_METERS метров мира, каким бы ни был размер коробки.
 */

/** Диапазон развёртки одной грани: сколько раз текстура повторится. */
function faceSpan(geometry: THREE.BoxGeometry, face: number): { u: number; v: number } {
  const uv = geometry.attributes.uv as THREE.BufferAttribute;

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (let i = 0; i < 4; i++) {
    const index = face * 4 + i;
    minU = Math.min(minU, uv.getX(index));
    maxU = Math.max(maxU, uv.getX(index));
    minV = Math.min(minV, uv.getY(index));
    maxV = Math.max(maxV, uv.getY(index));
  }

  return { u: maxU - minU, v: maxV - minV };
}

describe('развёртка коробок', () => {
  it('тайл занимает заданное число метров на боковой грани', () => {
    const width = 10;
    const height = 4;
    const depth = 6;

    const geometry = new THREE.BoxGeometry(width, height, depth);
    scaleBoxUv(geometry, width, height, depth);

    // Грань +X смотрит вдоль Z и Y.
    const side = faceSpan(geometry, 0);
    expect(side.u).toBeCloseTo(depth / TILE_METERS, 5);
    expect(side.v).toBeCloseTo(height / TILE_METERS, 5);
  });

  it('тайл занимает заданное число метров на верхней грани', () => {
    const width = 64;
    const height = 1;
    const depth = 64;

    const geometry = new THREE.BoxGeometry(width, height, depth);
    scaleBoxUv(geometry, width, height, depth);

    // Грань +Y — это пол чанка, самая заметная поверхность в игре.
    const top = faceSpan(geometry, 2);
    expect(top.u).toBeCloseTo(width / TILE_METERS, 5);
    expect(top.v).toBeCloseTo(depth / TILE_METERS, 5);
  });

  it('тайл занимает заданное число метров на передней грани', () => {
    const width = 12;
    const height = 3;
    const depth = 1;

    const geometry = new THREE.BoxGeometry(width, height, depth);
    scaleBoxUv(geometry, width, height, depth);

    const front = faceSpan(geometry, 4);
    expect(front.u).toBeCloseTo(width / TILE_METERS, 5);
    expect(front.v).toBeCloseTo(height / TILE_METERS, 5);
  });

  it('масштаб текстуры одинаков у пола чанка и у мелкого камня', () => {
    const floor = new THREE.BoxGeometry(64, 1, 64);
    scaleBoxUv(floor, 64, 1, 64);

    const rock = new THREE.BoxGeometry(2, 2, 2);
    scaleBoxUv(rock, 2, 2, 2);

    // Плотность тайлов на метр обязана совпадать, иначе камень рядом
    // с полом выглядел бы сделанным из другого материала.
    const floorDensity = faceSpan(floor, 2).u / 64;
    const rockDensity = faceSpan(rock, 2).u / 2;
    expect(floorDensity).toBeCloseTo(rockDensity, 6);
  });

  it('очень тонкая коробка не вырождает развёртку в ноль', () => {
    const geometry = new THREE.BoxGeometry(4, 0.001, 4);
    scaleBoxUv(geometry, 4, 0.001, 4);

    const side = faceSpan(geometry, 0);
    // Нулевой диапазон дал бы деление на ноль в шейдере и чёрную грань.
    expect(side.v).toBeGreaterThan(0);
  });

  it('развёртка не уходит в отрицательные значения', () => {
    const geometry = new THREE.BoxGeometry(8, 3, 5);
    scaleBoxUv(geometry, 8, 3, 5);

    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
    }
  });
});
