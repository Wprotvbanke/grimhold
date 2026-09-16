import {
  RACES,
  arrangeInGrid,
  RECIPES,
  addItem,
  createBackpack,
  itemAt,
  itemDef,
  place,
  removeItem,
  type DropItemMessage,
  type EquipMessage,
  type MoveItemMessage,
  type Grid,
  type ItemDef,
  type PlacedItem,
  type UnequipMessage,
  type UseItemMessage,
} from '@grimhold/shared';
import { refreshLoadout, type Player } from '../world.js';
import { forgetMissing } from './hotbar.js';
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
  // Правила раскладки общие с казной и живут в shared/inventory.ts.
  const moved = arrangeInGrid(
    player.inventory,
    payload.fromX,
    payload.fromY,
    payload.toX,
    payload.toY,
    payload.rotate,
  );
  if (typeof moved === 'string') return refuse(moved);

  player.inventory = moved;
  refreshLoadout(player);
  return changed();
};

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

  // Притащили мышью в конкретную клетку — кладём туда. Не влезло, или пришёл
  // обычный щелчок по слоту — место ищет сервер.
  let inventory: Grid | null = null;
  if (payload.toX !== undefined && payload.toY !== undefined) {
    const rotated = payload.rotate ?? false;
    inventory = place(player.inventory, item.defId, item.count, payload.toX, payload.toY, rotated);
  }
  if (!inventory) {
    const returned = addItem(player.inventory, item.defId, item.count);
    if (returned.leftover > 0) return refuse('В рюкзаке нет места');
    inventory = returned.grid;
  }

  player.inventory = inventory;
  const equipment = { ...player.equipment };
  delete equipment[payload.slot];
  player.equipment = equipment;

  refreshLoadout(player);
  return changed();
};

/**
 * Чтение свитка рецептурного яруса.
 *
 * Свиток читается **только своей расой**. Найденный чужой прочесть нельзя —
 * и это не досада, а причина торговать: дворфу нужен эльф, эльфу человек.
 * Ради этого расы и разведены по ремёслам.
 */
function readScroll(player: Player, item: PlacedItem, def: ItemDef): GameEvent[] {
  if (!def.recipeId) return refuse(`${def.name} ничего не открывает`);

  const recipe = RECIPES[def.recipeId];
  if (recipe.race && recipe.race !== player.race) {
    return refuse(`${RACES[recipe.race].name} прочёл бы, а ты нет`);
  }
  if (player.knownRecipes.includes(def.recipeId)) {
    return refuse('Этот рецепт ты уже знаешь');
  }

  player.knownRecipes = [...player.knownRecipes, def.recipeId];
  consumeOne(player, item);
  refreshLoadout(player);
  return changed();
}

export const handleUseItem: CommandHandler<UseItemMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const combat = player.combat;
  if (!combat.alive) return refuse('Мёртвые не пьют зелья');

  const item = itemAt(player.inventory, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  const def = itemDef(item.defId);

  // Свиток не пьют, а читают: он открывает рецепт и на этом кончается.
  if (def.kind === 'scroll') return readScroll(player, item, def);

  if (def.kind !== 'consumable') return refuse(`${def.name} так не используется`);
  if (!def.restoreHealth && !def.restoreStamina) {
    return refuse(`${def.name} сейчас бесполезен`);
  }

  /**
   * Пить залпом нельзя.
   *
   * Без отката лечение — это удержание клавиши: здоровье льётся ровно с той
   * скоростью, с какой жмут, и бой перестаёт быть про здоровье вовсе. Откат
   * общий для всех расходников: раздельный обходили бы, чередуя зелье
   * с бинтом.
   */
  if (player.sipCooldown > 0) {
    return refuse(`Ещё рано: ${player.sipCooldown.toFixed(1)} с`);
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

  if (def.cooldown) player.sipCooldown = def.cooldown;

  consumeOne(player, item);
  refreshLoadout(player);
  return changed();
};

/**
 * Выбросить вещь. Пока просто уничтожение: предметов на земле ещё нет,
 * и появятся они вместе с подземельями, где выброшенное станет добычей.
 */
/** Докладывать выброшенное в свой мешок, если он лежит ближе этого, м. */
const DROP_MERGE_RANGE = 1.5;

/**
 * Выбросить вещь из рюкзака — **на землю мешком**, а не в никуда.
 *
 * Раньше выброшенное пропадало насовсем, и промах мышью стоил вещи. Теперь
 * оно лежит мешком у ног столько же, сколько добыча со зверя (`BAG_SECONDS`):
 * передумал — поднял, не нужно — его подберёт другой или оно истлеет.
 *
 * Выброшенное подряд на одном месте ложится **в один мешок**: иначе пять
 * выброшенных шкур — это пять мешков стопкой, и разбирать их по одному.
 * Сетка мешка — размером с рюкзак: всё, что в рюкзаке помещалось, влезет.
 */
export const handleDropItem: CommandHandler<DropItemMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const item = itemAt(player.inventory, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  const pos = player.state.pos;
  // `bagsFor` отдаёт мешки в виде для снапшота — сами мешки берём по имени.
  const nearby =
    ctx.world
      .bagsFor(player)
      .map((entry) => ctx.world.bagById(player.instanceId, entry.id))
      .find(
        (bag) =>
          bag !== null &&
          bag.owner === player.name &&
          Math.hypot(bag.pos.x - pos.x, bag.pos.z - pos.z) <= DROP_MERGE_RANGE,
      ) ?? null;
  const merged = nearby ? addItem(nearby.grid, item.defId, item.count) : null;
  if (nearby && merged && merged.leftover === 0) {
    nearby.grid = merged.grid;
  } else {
    const sack = addItem(createBackpack(), item.defId, item.count).grid;
    if (!ctx.world.dropBag(player.instanceId, pos, player.name, sack)) {
      return refuse('Вещь не легла на землю');
    }
  }

  player.inventory = removeItem(player.inventory, item);
  // Выброшенное возвращать неоткуда: ячейка панели, если она была, врала бы.
  forgetMissing(player, item.defId);
  refreshLoadout(player);
  return changed();
};

/**
 * Снимает одну штуку из стопки в рюкзаке. Открыто наружу ради стрел:
 * выстрел тратит стрелу так же, как глоток тратит зелье.
 */
export function consumeOne(player: Player, item: PlacedItem): void {
  const items = player.inventory.items
    .map((entry) => (entry === item ? { ...entry, count: entry.count - 1 } : entry))
    .filter((entry) => entry.count > 0);

  player.inventory = { ...player.inventory, items };
}
