import {
  HARVEST_RANGE,
  NODES,
  addItem,
  findNode,
  itemDef,
  toolOf,
  type GatheringMessage,
  type HarvestMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player, type Work, type World } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Добыча с ресурсной ноды.
 *
 * Клиент присылает только имя ноды. Всё остальное — где она стоит, сколько
 * в ней осталось, годится ли то, что у игрока в руке, и влезает ли добыча
 * в рюкзак — считает сервер. Саму ноду он восстанавливает по имени тем же
 * генератором, что и клиент, поэтому хранить их не нужно.
 *
 * Добыча занимает время (`time` у профиля ноды) и показывается полосой —
 * устроено так же, как ремесло. Раньше ресурс падал в рюкзак мгновенно,
 * а пауза между ударами шла молча: со стороны игрока это выглядело как
 * кнопка, которая через раз не срабатывает.
 *
 * Добыча идёт **в конце**, а не в начале: бросил на полпути — ничего не
 * потратил и ничего не получил.
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

/**
 * Сообщение о ходе работы — уходит игроку в начале и в конце.
 *
 * Одно на добычу и на сундук: полоса у дерева и полоса у сундука обязаны
 * вести себя одинаково, а две шкалы рано или поздно разойдутся.
 */
export function workMessage(player: Player, note?: string): GatheringMessage {
  const work = player.work;
  if (!work) {
    return { t: 'gathering', nodeId: null, name: '', duration: 0, remaining: 0, note };
  }

  return {
    t: 'gathering',
    nodeId: work.id,
    name: work.name,
    duration: work.duration,
    remaining: Math.max(0, work.remaining),
    note,
  };
}

/** Далеко ли до цели. Проверяется и на старте, и каждый тик, и в конце. */
export function outOfReach(player: Player, work: Work): boolean {
  return Math.hypot(work.at.x - player.state.pos.x, work.at.z - player.state.pos.z) > work.range;
}

export const handleHarvest: CommandHandler<HarvestMessage> = (ctx, payload) => {
  const { world, actor } = ctx;
  if (!actor.combat.alive) return [];

  // Клавишу держат, и повтор приходит десятками в секунду. Начатую работу
  // это продолжать не мешает, а начинать заново — сбросило бы полосу в ноль
  // и добыть стало бы невозможно.
  if (actor.work?.id === payload.nodeId) return [];

  const node = findNode(payload.nodeId);
  if (!node) return refuse('Тут нечего добывать');
  const profile = NODES[node.nodeId];

  if (Math.hypot(node.x - actor.state.pos.x, node.z - actor.state.pos.z) > HARVEST_RANGE) {
    return refuse('Слишком далеко');
  }
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

  actor.work = {
    kind: 'node',
    id: node.id,
    name: profile.name,
    at: { x: node.x, z: node.z },
    range: HARVEST_RANGE,
    duration: profile.time,
    remaining: profile.time,
    node,
  };
  return [{ type: 'gathering' }];
};

/**
 * Работа доведена до конца.
 *
 * Вызывается игровым циклом. Проверки повторяются: за время работы нода могла
 * опустеть под чужой рукой, а рюкзак — наполниться добычей с мобов.
 */
export function finishHarvest(player: Player, world: World): GameEvent[] {
  const node = player.work?.node;
  if (!node) return [];

  const profile = NODES[node.nodeId];
  player.work = null;

  if (world.nodeCharges(player.instanceId, node) <= 0) {
    return [{ type: 'gathering', note: 'Здесь уже пусто' }];
  }

  const amount = profile.min + Math.floor(Math.random() * (profile.max - profile.min + 1));
  const { grid, leftover } = addItem(player.inventory, profile.itemId, amount);

  // Ни одной штуки не влезло — заряд не тратим. Иначе нода сгорала бы впустую
  // из-за переполненного рюкзака, и это выглядело бы как кража.
  if (leftover >= amount) return [{ type: 'gathering', note: 'В рюкзаке нет места' }];

  player.inventory = grid;
  refreshLoadout(player);

  const drained = world.spendNode(player.instanceId, node);
  const taken = amount - leftover;
  const def = itemDef(profile.itemId);

  return [
    { type: 'gathering' },
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
}
