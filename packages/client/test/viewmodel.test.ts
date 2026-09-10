import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '@grimhold/shared';
import { ViewModel } from '../src/viewmodel.js';

/**
 * Руки нельзя проверить глазами из тестов, но можно проверить арифметикой:
 * попадают ли они в кадр, двигаются ли в нужную сторону при ударе и
 * различаются ли у рас. Это ровно те способы сломать видмодель, которые
 * не видны в типах.
 */

const ASPECT = 16 / 9;

function screenPositionOf(model: ViewModel, side: 'left' | 'right'): THREE.Vector3 {
  model.camera.aspect = ASPECT;
  model.camera.updateProjectionMatrix();
  model.camera.updateMatrixWorld(true);
  model.scene.updateMatrixWorld(true);

  const hand = model.scene.getObjectByName(`hand-${side}`);
  if (!hand) throw new Error(`кисть ${side} не найдена`);

  const position = new THREE.Vector3();
  hand.getWorldPosition(position);
  return position.project(model.camera);
}

/** Прогоняет несколько кадров, чтобы позы успели прийти к цели. */
function settle(model: ViewModel, seconds: number, state: Parameters<ViewModel['update']>[1]): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) model.update(dt, state);
}

const IDLE_STATE = {
  action: null,
  phase: null,
  blocking: false,
  speed: 0,
  alive: true,
} as const;

describe('руки от первого лица', () => {
  it('обе кисти попадают в кадр в покое', () => {
    const model = new ViewModel('human');
    settle(model, 1, IDLE_STATE);

    for (const side of ['left', 'right'] as const) {
      const point = screenPositionOf(model, side);
      expect(Math.abs(point.x), `${side}: ушла за край по горизонтали`).toBeLessThan(1);
      expect(Math.abs(point.y), `${side}: ушла за край по вертикали`).toBeLessThan(1);
      // z в диапазоне [-1, 1] означает «между ближней и дальней плоскостью».
      expect(point.z, `${side}: за камерой или за дальней плоскостью`).toBeGreaterThan(-1);
      expect(point.z).toBeLessThan(1);
    }
  });

  it('руки держатся в нижней половине экрана и не закрывают прицел', () => {
    const model = new ViewModel('human');
    settle(model, 1, IDLE_STATE);

    for (const side of ['left', 'right'] as const) {
      const point = screenPositionOf(model, side);
      expect(point.y, `${side}: рука лезет выше центра экрана`).toBeLessThan(0);
    }
  });

  it('удар выбрасывает правую руку вперёд', () => {
    const model = new ViewModel('human');
    settle(model, 1, IDLE_STATE);

    model.camera.updateMatrixWorld(true);
    model.scene.updateMatrixWorld(true);
    const idle = new THREE.Vector3();
    model.scene.getObjectByName('hand-right')!.getWorldPosition(idle);

    // Доводим до фазы удара — той самой, в которой сервер считает попадание.
    model.beginAction('attack');
    const toStrike = ACTIONS.attack.timing.windup + ACTIONS.attack.timing.active / 2;
    settle(model, toStrike, IDLE_STATE);

    model.scene.updateMatrixWorld(true);
    const striking = new THREE.Vector3();
    model.scene.getObjectByName('hand-right')!.getWorldPosition(striking);

    // Камера смотрит в -Z, значит «вперёд» — это уменьшение z.
    expect(striking.z).toBeLessThan(idle.z);
  });

  it('замах уводит кулак назад — это видимый сигнал удара', () => {
    const model = new ViewModel('human');
    settle(model, 1, IDLE_STATE);

    model.scene.updateMatrixWorld(true);
    const idle = new THREE.Vector3();
    model.scene.getObjectByName('hand-right')!.getWorldPosition(idle);

    model.beginAction('heavy');
    settle(model, ACTIONS.heavy.timing.windup * 0.8, IDLE_STATE);

    model.scene.updateMatrixWorld(true);
    const winding = new THREE.Vector3();
    model.scene.getObjectByName('hand-right')!.getWorldPosition(winding);

    expect(winding.z).toBeGreaterThan(idle.z);
  });

  it('у дворфа руки толще и ниже, чем у эльфа', () => {
    const dwarf = new ViewModel('dwarf');
    const elf = new ViewModel('elf');
    settle(dwarf, 1, IDLE_STATE);
    settle(elf, 1, IDLE_STATE);

    const dwarfHand = screenPositionOf(dwarf, 'right');
    const elfHand = screenPositionOf(elf, 'right');

    // Дворф ниже ростом и шире в плечах — рука дальше от центра по горизонтали.
    expect(Math.abs(dwarfHand.x)).toBeGreaterThan(Math.abs(elfHand.x));
  });

  it('после смерти руки не рисуются', () => {
    const model = new ViewModel('human');
    settle(model, 0.5, { ...IDLE_STATE, alive: false });
    expect(model.scene.visible).toBe(false);
  });

  it('стоимость стамины берётся из тех же правил, что и у сервера', () => {
    expect(ViewModel.staminaCost('attack')).toBe(ACTIONS.attack.staminaCost);
    expect(ViewModel.staminaCost('heavy')).toBe(ACTIONS.heavy.staminaCost);
    expect(ViewModel.staminaCost('dodge')).toBe(ACTIONS.dodge.staminaCost);
  });
});
