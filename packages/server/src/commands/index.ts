import type { ClientMessage } from '@grimhold/shared';
import { handleAction, handleBlock, handleCast } from './action.js';
import { handleAdmin } from './admin.js';
import { handleSpendPoint } from './progress.js';
import { handleBankMove, handleCloseBank, handleOpenBag, handleOpenBank } from './bank.js';
import { handleChat } from './chat.js';
import { handleOpenChest } from './chest.js';
import { handleEnterDungeon, handleLeaveDungeon } from './dungeon.js';
import { handleCraft } from './craft.js';
import { handleHarvest } from './harvest.js';
import { handleSetHotbar, handleUseHotbar } from './hotbar.js';
import {
  handleDropItem,
  handleEquip,
  handleMoveItem,
  handleUnequip,
  handleUseItem,
} from './items.js';
import { handleInput } from './input.js';
import {
  handleTradeCancel,
  handleTradeInvite,
  handleTradeLock,
  handleTradeOffer,
  handleTradeRespond,
  handleTradeWithdraw,
} from './trade.js';
import type { CommandContext, GameEvent } from './types.js';

export * from './types.js';

/**
 * Диспетчер команд. Сообщение уже провалидировано схемой протокола,
 * так что сюда попадает только структурно корректное намерение.
 *
 * Сюда доходят только команды играющего актора: вход, регистрация и выбор
 * персонажа обрабатываются на уровне соединения — до того, как актор появится.
 */
export function dispatch(ctx: CommandContext, message: ClientMessage): GameEvent[] {
  switch (message.t) {
    case 'input':
      return handleInput(ctx, message);
    case 'chat':
      return handleChat(ctx, message);
    case 'admin':
      return handleAdmin(ctx, message);
    case 'spendPoint':
      return handleSpendPoint(ctx, message);
    case 'action':
      return handleAction(ctx, message);
    case 'block':
      return handleBlock(ctx, message);
    case 'cast':
      return handleCast(ctx, message);
    case 'moveItem':
      return handleMoveItem(ctx, message);
    case 'equip':
      return handleEquip(ctx, message);
    case 'unequip':
      return handleUnequip(ctx, message);
    case 'useItem':
      return handleUseItem(ctx, message);
    case 'dropItem':
      return handleDropItem(ctx, message);
    case 'setHotbar':
      return handleSetHotbar(ctx, message);
    case 'useHotbar':
      return handleUseHotbar(ctx, message);
    case 'harvest':
      return handleHarvest(ctx, message);
    case 'openChest':
      return handleOpenChest(ctx, message);
    case 'craft':
      return handleCraft(ctx, message);
    case 'openBank':
      return handleOpenBank(ctx, message);
    case 'openBag':
      return handleOpenBag(ctx, message);
    case 'closeBank':
      return handleCloseBank(ctx, message);
    case 'bankMove':
      return handleBankMove(ctx, message);
    case 'enterDungeon':
      return handleEnterDungeon(ctx, message);
    case 'leaveDungeon':
      return handleLeaveDungeon(ctx, message);
    case 'tradeInvite':
      return handleTradeInvite(ctx, message);
    case 'tradeRespond':
      return handleTradeRespond(ctx, message);
    case 'tradeOffer':
      return handleTradeOffer(ctx, message);
    case 'tradeWithdraw':
      return handleTradeWithdraw(ctx, message);
    case 'tradeLock':
      return handleTradeLock(ctx, message);
    case 'tradeCancel':
      return handleTradeCancel(ctx, message);
    default:
      return [];
  }
}
