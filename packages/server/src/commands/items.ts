import {
  addItem,
  canPlace,
  itemAt,
  itemDef,
  place,
  removeItem,
  type DropItemMessage,
  type EquipMessage,
  type MoveItemMessage,
  type PlacedItem,
  type UnequipMessage,
  type UseItemMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player } from '../world.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Работа с вещами.
 *
 * Единственное место, где меняется содержимое рюкзака и экипировки. Клиент
 * присылает намерение и координаты клетки; влезает ли предмет, надевается ли
 * он в этот слот и что происходит при использовании — решает только сервер.
 *
 * Каждый обработчик возвращает событие `inventory`, по которому вызывающий код
 * отправляет игроку новое состояние. Молчаливый отказ недопустим: игрок должен
 * понимать, почему вещь не легла.
 */

/** Событие «состояние вещей изменилось» — на него отвечает рассылка. */
function changed(): GameEvent[] {
  return [{ type: 'inventory' }];
}

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

export const handleMoveItem: CommandHandler<MoveItemMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const item = itemAt(player.inventory, payload.fromX, payload.fromY);
  if (!item) return refuse('Здесь ничего нет');

  const rotated = payload.rotate ? !item.rotated : item.rotated;

  // Себя самого при проверке игнорируем: иначе предмет не смог бы сдвинуться
  // на соседнюю клетку, пересекающуюся с его нынешним местом.
  if (!canPlace(player.inventory, item.defId, payload.toX, payload.toY, rotated, item)) {
    // Попытка положить одну стопку на другую — складываем.
    const target = itemAt(player.inventory, payload.toX, payload.toY);
    if (target && target !== item && target.defId === item.defId) {
      return stackOnto(player, item, target);
    }
    return refuse('Сюда не влезает');
  }

  const without = removeItem(player.inventory, item);
  const moved = place(without, item.defId, item.count, payload.toX, payload.toY, rotated);
  if (!moved) return refuse('Сюда не влезает');

  player.inventory = moved;
  refreshLoadout(player);
  return changed();
};

/** Складывает одну стопку в другую, не превышая предела. */
function stackOnto(player: Player, source: PlacedItem, target: PlacedItem): GameEvent[] {
  const def = itemDef(source.defId);
  if (def.stack <= 1) return refuse('Этот предмет не складывается');

  const room = def.stack - target.count;
  if (room <= 0) return refuse('Стопка полна');

  const moved = Math.min(room, source.count);
  const items = player.inventory.items
    .map((entry) => {
      if (entry === target) return { ...entry, count: entry.count + moved };
      if (entry === source) return { ...entry, count: entry.count - moved };
      return entry;
    })
    .filter((entry) => entry.count > 0);

  player.inventory = { ...player.inventory, items };
  refreshLoadout(player);
  return changed();
}

export const handleEquip: CommandHandler<EquipMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const item = itemAt(player.inventory, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  const def = itemDef(item.defId);
  if (!def.slot) return refuse(`${def.name} не надевается`);

  const previous = player.equipment[def.slot];
  let inventory = removeItem(player.inventory, item);

  // Снимаемое возвращается в рюкзак. Если места нет — обмен не состоится,
  // иначе вещь просто исчезла бы.
  if (previous) {
    const returned = addItem(inventory, previous.defId, previous.count);
    if (returned.leftover > 0) return refuse('Некуда положить снятое');
    inventory = returned.grid;
  }

  player.inventory = inventory;
  player.equipment = {
    ...player.equipment,
    [def.slot]: { defId: item.defId, count: item.count, x: 0, y: 0, rotated: false },
  };

  refreshLoadout(player);
  return changed();
};

export const handleUnequip: CommandHandler<UnequipMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const item = player.equipment[payload.slot];
  if (!item) return refuse('Слот пуст');

  const returned = addItem(player.inventory, item.defId, item.count);
  if (returned.leftover > 0) return refuse('В рюкзаке нет места');

  player.inventory = returned.grid;
  const equipment = { ...player.equipment };
  delete equipment[payload.slot];
  player.equipment = equipment;

  refreshLoadout(player);
  return changed();
};

export const handleUseItem: CommandHandler<UseItemMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const combat = player.combat;
  if (!combat.alive) return refuse('Мёртвые не пьют зелья');

  const item = itemAt(player.inventory, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  const def = itemDef(item.defId);
  if (def.kind !== 'consumable') return refuse(`${def.name} так не используется`);
  if (!def.restoreHealth && !def.restoreStamina) {
    return refuse(`${def.name} сейчас бесполезен`);
  }

  if (def.restoreHealth) {
    combat.vitals.health = Math.min(player.maxima.health, combat.vitals.health + def.restoreHealth);
  }
  if (def.restoreStamina) {
    combat.vitals.stamina = Math.min(
      player.maxima.stamina,
      combat.vitals.stamina + def.restoreStamina,
    );
  }

  consumeOne(player, item);
  refreshLoadout(player);
  return changed();
};

/**
 * Выбросить вещь. Пока просто уничтожение: предметов на земле ещё нет,
 * и появятся они вместе с подземельями, где выброшенное станет добычей.
 */
export const handleDropItem: CommandHandler<DropItemMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const item = itemAt(player.inventory, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  player.inventory = removeItem(player.inventory, item);
  refreshLoadout(player);
  return changed();
};

function consumeOne(player: Player, item: PlacedItem): void {
  const items = player.inventory.items
    .map((entry) => (entry === item ? { ...entry, count: entry.count - 1 } : entry))
    .filter((entry) => entry.count > 0);

  player.inventory = { ...player.inventory, items };
}
