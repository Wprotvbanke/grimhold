import {
  BAG_RANGE,
  BANK,
  CHEST_RANGE,
  addItem,
  arrangeInGrid,
  itemAt,
  itemDef,
  place,
  removeItem,
  type BankMoveMessage,
  type CloseBankMessage,
  type Grid,
  type OpenBagMessage,
  type OpenBankMessage,
  type PlacedItem,
} from '@grimhold/shared';
import { refreshLoadout, type OpenContainer, type Player, type World } from '../world.js';
import { forgetMissing } from './hotbar.js';
import type { CommandHandler, GameEvent } from './types.js';

/**
 * Открытое хранилище: городская казна или мешок павшего.
 *
 * Одним кодом, потому что для игрока это одно и то же окно с чужой сеткой,
 * и правила переноса в нём те же. Разница ровно в двух вещах: где стоять,
 * чтобы оно не закрылось, и куда писать результат. Всё остальное — раскладка,
 * поворот, складывание стопок — общее и лежит в `arrangeInGrid`.
 *
 * Казна — единственное безопасное хранилище: всё, что в рюкзаке, теряется
 * со смертью внизу, всё, что здесь — нет. Поэтому файл лежит в слое команд
 * наравне с боем: каждая операция двигает ценности.
 */

function refuse(reason: string): GameEvent[] {
  return [{ type: 'itemError', reason }];
}

/**
 * Куда писать результат.
 *
 * Казна идёт в базу целиком. Мешок и сундук живут в памяти инстанса и в базу
 * не попадают — зато **рюкзак игрока попадает**: вещь, вынутая из сундука,
 * уже ценность, и падение сервера не должно её отменить.
 */
function saveOf(container: OpenContainer): GameEvent {
  return container.kind === 'vault' ? { type: 'bankSave' } : { type: 'criticalSave' };
}

/** Вещи переложены — обновить обе панели и немедленно записать. */
function moved(container: OpenContainer): GameEvent[] {
  return [{ type: 'inventory' }, { type: 'bank' }, saveOf(container)];
}

/** Содержимое открытого хранилища. */
export function containerGrid(world: World, player: Player): Grid | null {
  const container = player.container;
  if (!container) return null;
  if (container.kind === 'vault') return player.bank;
  if (container.kind === 'bag') return container.bag.grid;
  return world.chestGrid(container.instanceId, container.chestId);
}

/** Подпись над сеткой: игрок должен видеть, куда кладёт. */
export function containerTitle(player: Player): string {
  const container = player.container;
  if (!container) return '';
  if (container.kind === 'vault') return 'Казна';
  if (container.kind === 'chest') return 'Сундук';
  return `Мешок: ${container.bag.owner}`;
}

function setContainerGrid(world: World, player: Player, grid: Grid): void {
  const container = player.container;
  if (!container) return;
  if (container.kind === 'vault') player.bank = grid;
  else if (container.kind === 'bag') container.bag.grid = grid;
  else world.setChestGrid(container.instanceId, container.chestId, grid);
}

/**
 * Далеко ли до хранилища.
 *
 * Проверяется при открытии и **при каждой операции**: открытую панель можно
 * унести с собой, и без этого казна работала бы из диких земель, а мешок —
 * из соседнего зала.
 */
function withinReach(player: Player): boolean {
  const container = player.container;
  if (!container) return false;

  const { x, z } = player.state.pos;
  if (container.kind === 'vault') return Math.hypot(x - BANK.x, z - BANK.z) <= BANK.range;
  if (container.kind === 'chest') {
    return Math.hypot(x - container.at.x, z - container.at.z) <= CHEST_RANGE;
  }
  return Math.hypot(x - container.bag.pos.x, z - container.bag.pos.z) <= BAG_RANGE;
}

export const handleOpenBank: CommandHandler<OpenBankMessage> = (ctx) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвым не до сбережений');

  player.container = { kind: 'vault' };
  if (!withinReach(player)) {
    player.container = null;
    return refuse('До казны надо дойти');
  }
  return [{ type: 'bank' }];
};

export const handleOpenBag: CommandHandler<OpenBagMessage> = (ctx, payload) => {
  const player = ctx.actor;
  if (!player.combat.alive) return refuse('Мёртвым уже не пригодится');

  const bag = ctx.world.bagById(player.instanceId, payload.bagId);
  // Мешок мог истлеть или опустеть, пока игрок к нему бежал: это не ошибка,
  // это чужая расторопность.
  if (!bag) return refuse('Тут уже пусто');

  player.container = { kind: 'bag', bag };
  if (!withinReach(player)) {
    player.container = null;
    return refuse('До мешка надо дойти');
  }
  return [{ type: 'bank' }];
};

export const handleCloseBank: CommandHandler<CloseBankMessage> = (ctx) => {
  ctx.actor.container = null;
  return [{ type: 'bank' }];
};

export const handleBankMove: CommandHandler<BankMoveMessage> = (ctx, payload) => {
  const player = ctx.actor;
  const container = player.container;
  if (!container) return refuse('Хранилище закрыто');

  if (!withinReach(player)) {
    player.container = null;
    return [{ type: 'bank' }, ...refuse('Ты отошёл')];
  }

  // Мешок мог опустеть под чужой рукой, пока панель была открыта.
  if (container.kind === 'bag' && !ctx.world.bagById(player.instanceId, container.bag.id)) {
    player.container = null;
    return [{ type: 'bank' }, ...refuse('Мешка больше нет')];
  }

  const grid = containerGrid(ctx.world, player)!;

  // Раскладка внутри хранилища идёт по тем же правилам, что и в рюкзаке.
  if (payload.dir === 'arrange') {
    if (payload.toX === undefined || payload.toY === undefined) return [];

    const arranged = arrangeInGrid(
      grid,
      payload.x,
      payload.y,
      payload.toX,
      payload.toY,
      payload.rotate ?? false,
    );
    if (typeof arranged === 'string') return refuse(arranged);

    setContainerGrid(ctx.world, player, arranged);
    return [{ type: 'bank' }, saveOf(container)];
  }

  const from = payload.dir === 'deposit' ? player.inventory : grid;
  const to = payload.dir === 'deposit' ? grid : player.inventory;

  const item = itemAt(from, payload.x, payload.y);
  if (!item) return refuse('Здесь ничего нет');

  // Сначала находим место, и только потом убираем вещь с прежнего: иначе
  // полное хранилище съедало бы предмет молча.
  const placed = putInto(to, item, payload, container.kind);
  if (typeof placed === 'string') return refuse(placed);

  const rest = removeItem(from, item);
  if (payload.dir === 'deposit') {
    player.inventory = rest;
    setContainerGrid(ctx.world, player, placed);
  } else {
    setContainerGrid(ctx.world, player, rest);
    player.inventory = placed;
  }

  // Ушло из рюкзака — панель быстрого доступа об этом знать обязана.
  if (payload.dir === 'deposit') forgetMissing(player, item.defId);

  // Вес меняется в обе стороны: вынул — понёс.
  refreshLoadout(player);
  player.dirty = true;

  const def = itemDef(item.defId);
  console.log(
    `[${container.kind}] ${player.name}: ` +
      `${payload.dir === 'deposit' ? 'положил' : 'забрал'} ${def.name} ×${item.count}`,
  );
  return moved(container);
};

/**
 * Кладёт вещь в принимающую сетку.
 *
 * Клетка указана — значит игрок притащил вещь мышью именно туда, и класть
 * куда-то ещё было бы самоуправством. Не указана — щелчок, и место ищет
 * сервер: у щелчка нет точки назначения.
 */
function putInto(
  grid: Grid,
  item: PlacedItem,
  payload: BankMoveMessage,
  kind: OpenContainer['kind'],
): Grid | string {
  if (payload.toX !== undefined && payload.toY !== undefined) {
    const rotated = payload.rotate ?? false ? !item.rotated : item.rotated;
    const exact = place(grid, item.defId, item.count, payload.toX, payload.toY, rotated);
    if (exact) return exact;

    // Под курсором могла оказаться такая же стопка — складываем.
    const target = itemAt(grid, payload.toX, payload.toY);
    if (!target || target.defId !== item.defId) return 'Сюда не влезает';
  }

  const added = addItem(grid, item.defId, item.count);
  if (added.leftover > 0) {
    if (payload.dir !== 'deposit') return 'В рюкзаке нет места';
    if (kind === 'vault') return 'В казне нет места';
    return kind === 'chest' ? 'В сундуке нет места' : 'В мешке нет места';
  }
  return added.grid;
}
