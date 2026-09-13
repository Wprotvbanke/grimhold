import { describe, expect, it } from 'vitest';
import { EXHAUSTION_SECONDS, INPUT_DT } from '@grimhold/shared';
import { emptyOutbox, tickWorld } from '../src/gameloop.js';
import { OVERWORLD, World, type Player } from '../src/world.js';

/**
 * Усталость после бега досуха.
 *
 * Проверяется само правило: стамина кончилась — ноги отходят, и бежать снова
 * нельзя, пока не отдышишься. Без этого пустая стамина просто отменяла бег,
 * и переход был обрывом: скорость менялась в один кадр, а клиент продолжал
 * предсказывать бег и дёргал картинку.
 */

let counter = 0;

function spawn(world: World): Player {
  counter += 1;
  return world.spawnPlayer({
    id: `char-${counter}`,
    accountId: `acc-${counter}`,
    name: 'Бегун',
    race: 'human',
    characterClass: 'warrior',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    instanceId: OVERWORLD,
    playtimeSeconds: 0,
  });
}

/** Бежит вперёд заданное число шагов — как клиент, шлющий ввод. */
function sprint(world: World, player: Player, seconds: number): void {
  const steps = Math.round(seconds / INPUT_DT);
  for (let i = 0; i < steps; i++) {
    player.pendingInputs.push({
      seq: i,
      forward: 1,
      right: 0,
      yaw: 0,
      pitch: 0,
      jump: false,
      sprint: true,
      dt: INPUT_DT,
    });
    tickWorld(world, INPUT_DT, emptyOutbox());
  }
}

describe('бег досуха', () => {
  it('оставляет выдохшимся', () => {
    const world = new World();
    const player = spawn(world);

    // Ровно столько, чтобы стамина кончилась, и не настолько долго, чтобы
    // усталость успела пройти и бег начался заново: цикл тут замкнутый.
    sprint(world, player, 7);

    // Про стамину здесь ничего не утверждаем: как только бег оборвался,
    // она начинает восстанавливаться, и к концу прогона её снова немного есть.
    // Проверяем то, ради чего правило и написано, — состояние ног.
    expect(player.combat.exhaustedFor).toBeGreaterThan(0);
  });

  it('и усталость проходит сама', () => {
    const world = new World();
    const player = spawn(world);

    sprint(world, player, 7);
    for (let i = 0; i < Math.round((EXHAUSTION_SECONDS + 0.5) / 0.05); i++) {
      tickWorld(world, 0.05, emptyOutbox());
    }
    expect(player.combat.exhaustedFor).toBe(0);
  });
});
