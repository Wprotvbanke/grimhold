import type { Storage, CharacterSave } from './storage/types.js';
import type { Player, World } from './world.js';

/**
 * Политика сохранения.
 *
 * Источник истины во время игры — память сервера. База это слой долговечности.
 * Отсюда два режима записи:
 *
 * 1. Пакетный флаш раз в минуту. Позиция, время в игре и прочее, что не жалко
 *    потерять при падении сервера. Десятки изменений между флашами схлопываются
 *    в одну запись на персонажа — база не видит шторма инсертов.
 *
 * 2. Немедленная запись критичных событий. Выход из игры, а позже — выход из
 *    подземелья, обмен, операции с банком, смерть с потерей лута. Если писать
 *    их пакетом, падение сервера откатит состояние и породит дюп предметов.
 *    Таких событий единицы в минуту на весь сервер, они ничего не стоят.
 */

const FLUSH_INTERVAL_MS = 60_000;

export class Persistence {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly world: World,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.flush('по таймеру'), FLUSH_INTERVAL_MS);
    // Не держим процесс живым только ради таймера сохранения.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Пакетная запись всех изменившихся персонажей. */
  flush(reason: string): number {
    const now = Date.now();
    const saves: CharacterSave[] = [];

    for (const player of this.world.players.values()) {
      if (!player.dirty) continue;
      saves.push(this.saveOf(player, now));
      player.dirty = false;
    }

    if (saves.length > 0) {
      this.storage.saveCharacters(saves);
      console.log(`[бд] сохранено персонажей: ${saves.length} (${reason})`);
    }

    return saves.length;
  }

  /** Критичное событие: пишем немедленно и синхронно, не дожидаясь флаша. */
  flushPlayer(player: Player, reason: string): void {
    this.storage.saveCharacters([this.saveOf(player, Date.now())]);
    player.dirty = false;
    console.log(`[бд] немедленно сохранён ${player.name} (${reason})`);
  }

  /**
   * Время в игре накапливается в памяти, а не пересчитывается при каждой записи.
   *
   * Раньше здесь было `playtimeSeconds + время с прошлого флаша`, и это врало
   * дважды: значение в памяти не росло, поэтому каждая запись перетирала
   * предыдущую тем же числом, а игроку, вошедшему в середине интервала,
   * начислялся весь интервал целиком.
   */
  private saveOf(player: Player, now: number): CharacterSave {
    const sinceSeen = Math.max(0, Math.round((now - player.lastAccountedAt) / 1000));
    player.playtimeSeconds += sinceSeen;
    player.lastAccountedAt = now;

    return {
      id: player.characterId,
      x: player.state.pos.x,
      y: player.state.pos.y,
      z: player.state.pos.z,
      yaw: player.state.yaw,
      lastSeenAt: now,
      playtimeSeconds: player.playtimeSeconds,
      inventory: player.inventory,
      equipment: player.equipment,
      knownRecipes: player.knownRecipes,
      skills: player.skills,
      instanceId: player.instanceId,
      karma: player.combat.karma,
      purpleFor: player.combat.purpleFor,
      hotbar: player.hotbar,
    };
  }
}
