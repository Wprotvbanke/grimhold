import {
  DUNGEON_ENTRY,
  DUNGEON_EXIT,
  DUNGEON_EXIT_RANGE,
  DUNGEON_GATE,
  SPAWN_POINT,
  dungeonInstance,
  isDungeon,
  type EnterDungeonMessage,
  type LeaveDungeonMessage,
} from '@grimhold/shared';
import { OVERWORLD } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Спуск в подземелье и выход из него.
 *
 * Подземелье — это отдельный `instanceId`, а не отдельный сервер и не
 * отдельный уровень. Вход заводит новый инстанс, выход возвращает в общий
 * мир; земля под ногами в обоих случаях выводится из имени инстанса, поэтому
 * по сети едет только имя.
 *
 * **Вещи едут с игроком в обе стороны** — на этом держится вся ставка
 * подземелья: зашёл со своим, вышел с добычей или не вышел вовсе. Никакого
 * отдельного переноса не нужно: рюкзак лежит на игроке, а не в мире.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/** Сколько подземелий уже заводили: зерно должно быть разным у каждого. */
let counter = 0;

export const handleEnterDungeon: CommandHandler<EnterDungeonMessage> = (ctx) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвым туда не надо');
  if (isDungeon(player.instanceId)) return refuse('Ты уже внизу');

  const distance = Math.hypot(
    player.state.pos.x - DUNGEON_GATE.x,
    player.state.pos.z - DUNGEON_GATE.z,
  );
  if (distance > DUNGEON_GATE.range) return refuse('До спуска надо дойти');

  /**
   * Сначала ищем, к кому подсесть.
   *
   * Из замысла: инстанс на двенадцать человек, соло и группы вместе, внутри
   * все всем враги. Зал на одного — это не подземелье, а полоса препятствий:
   * ни встречи, ни причины спешить, ни второго охотника за тем же сундуком.
   */
  const joined = ctx.world.joinableDungeon();
  if (joined) {
    ctx.world.moveToInstance(player, joined, DUNGEON_ENTRY);
    console.log(`[подземелье] ${player.name} подсел в ${joined}`);
    return [{ type: 'world' }, { type: 'criticalSave' }];
  }

  // Свободного нет — заводим свой. Зерно у каждого забега своё: два спуска
  // подряд не должны дать один и тот же зал.
  counter += 1;
  const seed = (Date.now() ^ (counter * 2654435761)) >>> 0;

  const instanceId = dungeonInstance(seed);
  ctx.world.moveToInstance(player, instanceId, DUNGEON_ENTRY);

  // Зал заселяется в момент заведения, а не при первом шаге: игрок должен
  // встретить обитателей там, где они стояли до него, а не там, куда он успел
  // дойти. Состав берётся из зерна — своя компания на каждый забег.
  const count = ctx.world.populateDungeon(instanceId);
  console.log(`[подземелье] ${player.name} спустился в ${instanceId}, обитателей: ${count}`);

  return [{ type: 'world' }, { type: 'criticalSave' }];
};

export const handleLeaveDungeon: CommandHandler<LeaveDungeonMessage> = (ctx) => {
  const player = ctx.actor;
  if (!isDungeon(player.instanceId)) return [];
  if (!player.combat.alive) return refuse('Сначала подняться');

  const distance = Math.hypot(
    player.state.pos.x - DUNGEON_EXIT.x,
    player.state.pos.z - DUNGEON_EXIT.z,
  );
  if (distance > DUNGEON_EXIT_RANGE) return refuse('До портала надо дойти');

  ctx.world.moveToInstance(player, OVERWORLD, SPAWN_POINT);

  // Выход с добычей — критичное событие: падение сервера сразу после него
  // не должно вернуть игрока вниз вместе с уже вынесенными вещами.
  return [{ type: 'world' }, { type: 'criticalSave' }];
};
