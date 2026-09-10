import type { Player, World } from '../world.js';

/**
 * Слой команд — ЕДИНСТВЕННЫЙ путь изменения состояния мира.
 * Ничто не мутирует World в обход обработчика.
 *
 * Это и есть подготовка к античиту: когда придёт время, проверки
 * (дистанция удара, кулдаун, стамина, доступность рецепта, темп команд)
 * дописываются внутрь существующих обработчиков, а не размазываются по коду.
 */

export interface GameEvent {
  type: string;
  [key: string]: unknown;
}

export interface CommandContext {
  world: World;
  actor: Player;
}

export type CommandHandler<Payload> = (ctx: CommandContext, payload: Payload) => GameEvent[];
