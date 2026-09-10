import { MAX_INPUTS_PER_TICK, type InputMessage } from '@grimhold/shared';
import type { CommandHandler } from './types.js';

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
  if (actor.pendingInputs.length >= MAX_INPUTS_PER_TICK) {
    actor.pendingInputs.shift();
  }

  actor.pendingInputs.push({
    seq: payload.seq,
    forward: payload.forward,
    right: payload.right,
    yaw: payload.yaw,
    pitch: payload.pitch,
    jump: payload.jump,
    dt: payload.dt,
  });

  return [];
};
