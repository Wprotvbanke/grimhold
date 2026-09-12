import { type InputMessage } from '@grimhold/shared';
import type { CommandHandler } from './types.js';

/**
 * Сколько вводов держим в очереди. Это защита от флуда, а не темп симуляции:
 * за тик обрабатывается не больше `MAX_INPUTS_PER_TICK` (см. gameloop.ts),
 * остальное ждёт следующего.
 */
const INPUT_QUEUE_LIMIT = 64;

/**
 * Приём намерения движения. Здесь ввод только ставится в очередь —
 * симуляция происходит в тике, чтобы порядок и шаг были одинаковы для всех.
 */
export const handleInput: CommandHandler<InputMessage> = (ctx, payload) => {
  const { actor } = ctx;

  // Ввод старее уже обработанного игнорируем: это дубликат или пакет не по порядку.
  if (payload.seq <= actor.lastProcessedSeq) {
    return [];
  }

  // Предохранитель от флуда. Полноценное ограничение темпа — вместе с античитом.
  //
  // Копить можно куда больше, чем обрабатывается за один тик: при задержке
  // в сети вводы приходят пачками, и лишние просто подождут следующего тика.
  // Терять их нельзя ни с какого конца — выброшенный ввод оставляет дыру
  // в последовательности, клиент считает его подтверждённым и перестаёт
  // переигрывать, а позиции расходятся насовсем.
  if (actor.pendingInputs.length >= INPUT_QUEUE_LIMIT) {
    return [];
  }

  // Свежее намерение движения нужно рывку: он разрешён только в сторону.
  actor.lastIntent = { forward: payload.forward, right: payload.right, jump: payload.jump };

  actor.pendingInputs.push({
    seq: payload.seq,
    forward: payload.forward,
    right: payload.right,
    yaw: payload.yaw,
    pitch: payload.pitch,
    jump: payload.jump,
    sprint: payload.sprint,
    dt: payload.dt,
  });

  return [];
};
