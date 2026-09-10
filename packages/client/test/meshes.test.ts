import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOBS, RACES, type MobId, type Race } from '@grimhold/shared';
import { createAvatar, createMobMesh } from '../src/scene.js';

/**
 * Силуэт обязан совпадать с хитбоксом, по которому сервер считает попадание.
 *
 * Здесь ловится баг, из-за которого крыса уходила под землю: капсула в three.js
 * имеет высоту `длина + 2 × радиус`, и у приземистых существ она оказывалась
 * выше самого существа. Проверяем каждого моба и каждую расу.
 */

function boundsOf(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

const MOB_IDS = Object.keys(MOBS) as MobId[];
const RACE_IDS = Object.keys(RACES) as Race[];

describe('модели мобов', () => {
  it.each(MOB_IDS)('%s не проваливается под землю', (mobId) => {
    const bounds = boundsOf(createMobMesh(mobId));
    // Ноги стоят на нуле: небольшой допуск на морду и швы геометрии.
    expect(bounds.min.y, `${MOBS[mobId].name} уходит под землю`).toBeGreaterThan(-0.02);
  });

  it.each(MOB_IDS)('%s по высоте совпадает со своим хитбоксом', (mobId) => {
    const bounds = boundsOf(createMobMesh(mobId));
    const height = bounds.max.y - bounds.min.y;
    // Модель не должна быть заметно выше тела, по которому считаются удары.
    expect(height).toBeLessThanOrEqual(MOBS[mobId].height * 1.05);
    expect(height).toBeGreaterThan(MOBS[mobId].height * 0.7);
  });

  it.each(MOB_IDS)('%s не шире своего хитбокса', (mobId) => {
    const bounds = boundsOf(createMobMesh(mobId));
    const width = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
    // Силуэт не должен обещать досягаемость, которой нет у сервера.
    expect(width).toBeLessThanOrEqual(MOBS[mobId].radius * 2 * 1.02);
  });
});

describe('заглушки персонажей', () => {
  it.each(RACE_IDS)('%s стоит на земле и совпадает с ростом', (race) => {
    const bounds = boundsOf(createAvatar(race));
    expect(bounds.min.y).toBeGreaterThan(-0.02);
    expect(bounds.max.y - bounds.min.y).toBeLessThanOrEqual(RACES[race].height * 1.05);
  });
});
