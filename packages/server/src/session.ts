import type { WebSocket } from 'ws';
import {
  MAX_CHARACTERS,
  PROTOCOL_VERSION,
  SPAWN_POINT,
  isDungeon,
  isInsideWorld,
  worldToChunk,
  TICK_RATE,
  encode,
  type CharacterSummary,
  type ClientMessage,
  type ServerMessage,
} from '@grimhold/shared';
import { hashPassword, verifyPassword } from './auth.js';
import type { Persistence } from './persistence.js';
import type { Storage, CharacterRecord } from './storage/types.js';
import { OVERWORLD, progressMessage, type Player, type World } from './world.js';

/**
 * Кто ведёт мир.
 *
 * Список задаётся при запуске сервера (`GRIMHOLD_ADMINS=имя,имя`), а не
 * хранится в базе: право выдаёт тот, кто поднял сервер, и его нельзя выписать
 * себе обычной регистрацией.
 *
 * По умолчанию в списке двое, и оба — от разработки: учебный аккаунт из
 * `npm run seed`, на котором играют, и `Копатель` — аккаунт сквозной проверки
 * подземелья. Ей право нужно затем, чтобы отпереть порталы, не проводя боя
 * с хозяином глубины. Настоящий сервер задаёт `GRIMHOLD_ADMINS` сам, и обоих
 * умолчаний там нет — ровно как нет и пароля `test123`.
 */
const ADMINS = new Set(
  (process.env.GRIMHOLD_ADMINS ?? 'test,копатель')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Жизненный цикл соединения: регистрация, вход, выбор персонажа, игра.
 *
 * Всё, что до входа в мир, живёт здесь, а не в слое команд: команды работают
 * с актором, а до выбора персонажа актора ещё нет.
 */

export class Session {
  accountId: string | null = null;
  username: string | null = null;
  player: Player | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly storage: Storage,
    private readonly world: World,
    private readonly persistence: Persistence,
    private readonly onEnterWorld: (session: Session, player: Player) => void,
  ) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(encode(message));
  }

  /** Возвращает true, если сообщение обработано здесь и в мир идти не нужно. */
  handle(message: ClientMessage): boolean {
    switch (message.t) {
      case 'register':
        this.register(message.username, message.password, message.protocol);
        return true;
      case 'login':
        this.login(message.username, message.password, message.protocol);
        return true;
      case 'createCharacter':
        this.createCharacter(message.name, message.race, message.characterClass);
        return true;
      case 'enterWorld':
        this.enterWorld(message.characterId);
        return true;
      default:
        return false;
    }
  }

  private register(username: string, password: string, protocol: number): void {
    if (!this.checkProtocol(protocol)) return;

    if (this.storage.findAccountByUsername(username)) {
      this.send({ t: 'authError', message: 'Такое имя уже занято' });
      return;
    }

    const { hash, salt } = hashPassword(password);
    const account = this.storage.createAccount(username, hash, salt);
    console.log(`[аккаунт] создан ${username}`);
    this.authenticate(account.id, account.username);
  }

  private login(username: string, password: string, protocol: number): void {
    if (!this.checkProtocol(protocol)) return;

    const account = this.storage.findAccountByUsername(username);
    // Отвечаем одинаково на неверный логин и неверный пароль:
    // иначе по разнице ответов перебирают существующие аккаунты.
    if (!account || !verifyPassword(password, account.passwordHash, account.salt)) {
      this.send({ t: 'authError', message: 'Неверное имя или пароль' });
      return;
    }

    this.authenticate(account.id, account.username);
  }

  private authenticate(accountId: string, username: string): void {
    this.accountId = accountId;
    this.username = username;
    this.sendCharacterList();
  }

  private createCharacter(
    name: string,
    race: CharacterRecord['race'],
    characterClass: CharacterRecord['characterClass'],
  ): void {
    if (!this.accountId) {
      this.send({ t: 'authError', message: 'Сначала войдите' });
      return;
    }

    const existing = this.storage.listCharacters(this.accountId);
    if (existing.length >= MAX_CHARACTERS) {
      this.send({ t: 'authError', message: `Больше ${MAX_CHARACTERS} персонажей нельзя` });
      return;
    }

    if (this.storage.findCharacterByName(name)) {
      this.send({ t: 'authError', message: 'Персонаж с таким именем уже существует' });
      return;
    }

    this.storage.createCharacter(this.accountId, name, race, characterClass, SPAWN_POINT);
    console.log(`[персонаж] создан ${name} (${race}/${characterClass})`);
    this.sendCharacterList();
  }

  private enterWorld(characterId: string): void {
    if (!this.accountId) {
      this.send({ t: 'authError', message: 'Сначала войдите' });
      return;
    }
    if (this.player) return;

    const character = this.storage.getCharacter(characterId);
    if (!character || character.accountId !== this.accountId) {
      this.send({ t: 'authError', message: 'Персонаж не найден' });
      return;
    }

    // Двойной вход тем же персонажем ломает и позицию, и будущий инвентарь.
    if (this.world.findByCharacterId(character.id)) {
      this.send({ t: 'authError', message: 'Этот персонаж уже в игре' });
      return;
    }

    /**
     * Вышел из игры внизу — вернулся в город.
     *
     * Подземелье живёт в памяти сервера и умирает вместе с сессией: вернуть
     * человека в зал, которого больше нет, значит поставить его в пустоту.
     * Так и случалось: координаты сохранялись подземельные, а инстанс — нет,
     * и персонаж появлялся под городом и падал.
     *
     * Забег при этом считается прерванным. Это честно: подземелье — вылазка,
     * а не место жительства.
     */
    const at = worldToChunk(character.x, character.z);
    const lost = !isDungeon(character.instanceId) && !isInsideWorld(at.cx, at.cz);

    const home =
      isDungeon(character.instanceId) || lost
        ? { ...character, instanceId: OVERWORLD, ...SPAWN_POINT }
        : character;

    if (lost) {
      // Самопочинка. Персонажа за краем мира быть не должно, и если он там
      // оказался — это след чужой ошибки, а не его выбор. Возвращаем в город
      // вместо того, чтобы уронить в пустоту.
      console.log(`[мир] ${character.name} был вне мира, возвращён в город`);
    }

    // Казна общая на аккаунт, поэтому берётся не из персонажа, а рядом с ним.
    const player = this.world.spawnPlayer({
      ...home,
      bank: this.storage.getBank(this.accountId),
    });
    player.admin = ADMINS.has((this.username ?? '').toLowerCase());
    this.player = player;
    this.onEnterWorld(this, player);

    this.send({
      t: 'welcome',
      playerId: player.id,
      tickRate: TICK_RATE,
      protocol: PROTOCOL_VERSION,
      character: toSummary(character),
      spawn: { x: character.x, y: character.y, z: character.z },
      admin: player.admin,
      // Стрелки могли перевести до его входа — иначе у вошедшего был бы
      // свой собственный час суток.
      daytimeShift: this.world.daytimeShift,
    });
    // Где он оказался. Персонаж мог выйти из игры внизу, и земля под ногами
    // должна собраться сразу правильная, а не «город, а потом разберёмся».
    this.send({
      t: 'world',
      instanceId: player.instanceId,
      spawn: { x: player.state.pos.x, y: player.state.pos.y, z: player.state.pos.z },
    });
    // Рюкзак нужен игроку сразу, а не после первого изменения.
    this.send(this.world.inventoryMessage(player));
    // Прокачка — тоже: панель обязана быть заполненной с первого открытия,
    // а не с первого убитого зверя.
    this.send(progressMessage(player));
    console.log(`[мир] вошёл ${character.name}`);
  }

  /** Разрыв соединения — критичное событие, пишем немедленно. */
  disconnect(): void {
    if (!this.player) return;
    this.persistence.flushPlayer(this.player, 'выход из игры');
    this.world.removePlayer(this.player.id);
    console.log(`[мир] вышел ${this.player.name}`);
    this.player = null;
  }

  private sendCharacterList(): void {
    if (!this.accountId || !this.username) return;
    this.send({
      t: 'authenticated',
      username: this.username,
      characters: this.storage.listCharacters(this.accountId).map(toSummary),
      maxCharacters: MAX_CHARACTERS,
    });
  }

  private checkProtocol(protocol: number): boolean {
    if (protocol === PROTOCOL_VERSION) return true;
    this.send({ t: 'authError', message: `Обновите клиент: нужна версия ${PROTOCOL_VERSION}` });
    return false;
  }
}

function toSummary(character: CharacterRecord): CharacterSummary {
  return {
    id: character.id,
    name: character.name,
    race: character.race,
    characterClass: character.characterClass,
    playtimeSeconds: character.playtimeSeconds,
    lastSeenAt: character.lastSeenAt,
  };
}
