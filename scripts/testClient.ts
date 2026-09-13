/**
 * Тестовый клиент: проходит регистрацию, создание персонажа и вход в мир.
 * Используется проверочными скриптами, чтобы не дублировать поток входа.
 */
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type CharacterClass,
  type CharacterSummary,
  type ClientMessage,
  type CombatEvent,
  type EntitySnapshot,
  type BankMessage,
  type CraftingMessage,
  type GatheringMessage,
  type WorldMessage,
  type TradeMessage,
  type InventoryMessage,
  type LifeMessage,
  type LootMessage,
  type Race,
  type ServerMessage,
  type SkillUpMessage,
  type SnapshotMessage,
} from '@grimhold/shared';

export interface TestClientOptions {
  username: string;
  password?: string;
  characterName?: string;
  race?: Race;
  characterClass?: CharacterClass;
  url?: string;
  /** Односторонняя задержка в миллисекундах. */
  latency?: number;
}

export class TestClient {
  playerId: string | null = null;
  character: CharacterSummary | null = null;
  latestSnapshot: SnapshotMessage | null = null;

  readonly chat: string[] = [];
  readonly combat: CombatEvent[] = [];
  readonly skillUps: SkillUpMessage[] = [];
  readonly life: LifeMessage[] = [];
  readonly loot: LootMessage[] = [];
  /** Последнее состояние вещей: сервер шлёт его целиком при каждом изменении. */
  inventory: InventoryMessage | null = null;
  /** Последнее состояние казны: приходит только пока сундук открыт. */
  bank: BankMessage | null = null;
  /** Последнее состояние стола обмена. */
  trade: TradeMessage | null = null;
  /** Последнее состояние работы: начало и конец изготовления. */
  crafting: CraftingMessage | null = null;
  /** Последнее состояние добычи: начало и конец работы у ноды. */
  gathering: GatheringMessage | null = null;
  /** Где игрок находится: имя инстанса и точка появления. */
  world: WorldMessage | null = null;
  readonly errors: string[] = [];

  /**
   * Кого уже представили.
   *
   * Опознание (имя, вид, раса) едет один раз — при первом появлении сущности
   * в поле зрения. Проверки читают `kind` и `name`, и без этой памяти они
   * молча перестали бы находить кого бы то ни было: поле просто пустое.
   * Настоящий клиент устроен так же.
   */
  private readonly identities = new Map<string, Partial<EntitySnapshot>>();

  /** Длина последнего пришедшего сообщения на проводе, байт. */
  wireBytes = 0;

  /** Длина последнего снапшота на проводе — по ней считается трафик. */
  snapshotBytes = 0;
  onSnapshot?: (snapshot: SnapshotMessage) => void;

  private readonly socket: WebSocket;
  private readonly options: Required<Omit<TestClientOptions, 'url'>> & { url: string };
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready: Promise<void>;

  constructor(options: TestClientOptions) {
    this.options = {
      password: 'проверка123',
      characterName: options.username,
      race: 'human',
      characterClass: 'warrior',
      latency: 0,
      url: 'ws://localhost:8080',
      ...options,
    };

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.socket = new WebSocket(this.options.url);
    this.socket.on('open', () => {
      this.send({
        t: 'register',
        protocol: PROTOCOL_VERSION,
        username: this.options.username,
        password: this.options.password,
      });
    });

    this.socket.on('message', (raw) => {
      const text = raw.toString();
      // Длина **на проводе**, до разбора: клиент дополняет сущности опознанием
      // из памяти, и мерить размер после этого — значит мерить собственную
      // работу, а не трафик.
      this.wireBytes = text.length;
      this.receive(JSON.parse(text) as ServerMessage);
    });
    this.socket.on('error', (error) => this.rejectReady(error));
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case 'authenticated': {
        const existing = message.characters.find((c) => c.name === this.options.characterName);
        if (existing) {
          this.send({ t: 'enterWorld', characterId: existing.id });
        } else {
          this.send({
            t: 'createCharacter',
            name: this.options.characterName,
            race: this.options.race,
            characterClass: this.options.characterClass,
          });
        }
        break;
      }
      case 'authError':
        // Аккаунт уже есть — значит это повторный вход, пробуем логин.
        if (message.message.includes('занято')) {
          this.send({
            t: 'login',
            protocol: PROTOCOL_VERSION,
            username: this.options.username,
            password: this.options.password,
          });
        } else {
          this.rejectReady(new Error(message.message));
        }
        break;
      case 'welcome':
        this.playerId = message.playerId;
        this.character = message.character;
        this.resolveReady();
        break;
      case 'snapshot':
        this.snapshotBytes = this.wireBytes;
        this.latestSnapshot = { ...message, entities: message.entities.map((e) => this.identify(e)) };
        this.onSnapshot?.(this.latestSnapshot);
        break;
      case 'chatMessage':
        this.chat.push(`[${message.channel}] ${message.from}: ${message.text}`);
        break;
      case 'combat':
        this.combat.push(message);
        break;
      case 'skillUp':
        this.skillUps.push(message);
        break;
      case 'life':
        this.life.push(message);
        break;
      case 'loot':
        this.loot.push(message);
        break;
      case 'inventory':
        this.inventory = message;
        break;
      case 'bank':
        this.bank = message;
        break;
      case 'trade':
        this.trade = message;
        break;
      case 'crafting':
        this.crafting = message;
        break;
      case 'gathering':
        this.gathering = message;
        break;
      case 'world':
        this.world = message;
        break;
      case 'itemError':
        this.errors.push(message.message);
        break;
      case 'error':
        console.error('[сервер]', message.message);
        break;
    }
  }

  /**
   * Дополняет сущность опознанием из памяти.
   *
   * Сущность без имени — это не ошибка, а «ты его уже знаешь».
   */
  private identify(entity: EntitySnapshot): EntitySnapshot {
    if (entity.name !== undefined) {
      this.identities.set(entity.id, {
        name: entity.name,
        kind: entity.kind,
        race: entity.race,
        mobId: entity.mobId,
      });
      return entity;
    }
    return { ...entity, ...this.identities.get(entity.id) };
  }

  send(message: ClientMessage): void {
    const deliver = () => {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      }
    };
    if (this.options.latency > 0) setTimeout(deliver, this.options.latency);
    else deliver();
  }

  close(): void {
    this.socket.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ждёт **факта**, а не времени.
 *
 * Паузы в проверках — главный источник провалов, которые «не воспроизводятся»:
 * сервер стал отвечать на полсекунды дольше, и шаг, ждавший ровно столько,
 * сколько было вчера, не дождался. Такой провал невозможно объяснить по логу —
 * он просто говорит, что чего-то нет, и молчит о том, чего ждали.
 *
 * Поэтому здесь ждут условия и возвращают, сколько прождали. Не дождались —
 * это тоже ответ: `ok` ложно, и вызывающий скажет вслух, чего именно не было.
 */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  stepMs = 100,
): Promise<{ ok: boolean; waited: number }> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (condition()) return { ok: true, waited: Date.now() - started };
    await sleep(stepMs);
  }
  return { ok: condition(), waited: Date.now() - started };
}
