import {
  HARVEST_COOLDOWN,
  HARVEST_RANGE,
  NODES,
  addItem,
  findNode,
  itemDef,
  toolOf,
  type HarvestMessage,
} from '@grimhold/shared';
import { refreshLoadout } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Удар по ресурсной ноде.
 *
 * Клиент присылает только имя ноды. Всё остальное — где она стоит, сколько
 * в ней осталось, годится ли то, что у игрока в руке, и влезает ли добыча
 * в рюкзак — считает сервер. Саму ноду он восстанавливает по имени тем же
 * генератором, что и клиент, поэтому хранить их не нужно.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/** Как назвать нужный инструмент в отказе. */
const TOOL_NAMES: Record<string, string> = {
  axe: 'топор',
  pick: 'кирка',
  knife: 'нож',
};

export const handleHarvest: CommandHandler<HarvestMessage> = (ctx, payload) => {
  const { world, actor } = ctx;
  if (!actor.combat.alive) return [];

  const node = findNode(payload.nodeId);
  if (!node) return refuse('Тут нечего добывать');
  const profile = NODES[node.nodeId];

  // Пауза между ударами. Молча: игрок жмёт кнопку чаще, чем нужно, и сыпать
  // ему отказами за это — значит ругать за темп, а не за ошибку.
  if (actor.harvestCooldown > 0) return [];

  // Расстояние проверяет сервер — это и есть античит-проверка на своём месте.
  const distance = Math.hypot(node.x - actor.state.pos.x, node.z - actor.state.pos.z);
  if (distance > HARVEST_RANGE) return refuse('Слишком далеко');

  if (world.nodeCharges(actor.instanceId, node) <= 0) return refuse('Здесь уже пусто');

  /**
   * Инструмент нужен **в руке**, а не в рюкзаке.
   *
   * В этом вся цена: рука занята киркой, а не мечом, и встреча с волком по
   * дороге к жиле становится решением. Ради этого сетка предметов и заводилась.
   */
  if (profile.tool) {
    const held = toolOf(actor.equipment);
    const fits = held?.kind === profile.tool && held.tier >= profile.toolTier;
    if (!fits) return refuse(`Нужен в руке: ${TOOL_NAMES[profile.tool] ?? profile.tool}`);
  }

  const amount = profile.min + Math.floor(Math.random() * (profile.max - profile.min + 1));
  const { grid, leftover } = addItem(actor.inventory, profile.itemId, amount);

  // Ни одной штуки не влезло — удар не тратим. Иначе нода сгорала бы впустую
  // из-за переполненного рюкзака, и это выглядело бы как кража.
  if (leftover >= amount) return refuse('В рюкзаке нет места');

  actor.inventory = grid;
  refreshLoadout(actor);

  const drained = world.spendNode(actor.instanceId, node);
  actor.harvestCooldown = HARVEST_COOLDOWN;

  const taken = amount - leftover;
  const def = itemDef(profile.itemId);

  return [
    { type: 'inventory' },
    {
      type: 'loot',
      message: {
        t: 'loot',
        from: drained ? `${profile.name} — пусто` : profile.name,
        items: [{ itemId: def.id, name: def.name, count: taken }],
        lost: leftover,
      },
    },
  ];
};
