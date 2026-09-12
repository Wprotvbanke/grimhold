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
  type BankMessage,
  type CraftingMessage,
  type GatheringMessage,
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
  readonly errors: string[] = [];
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

    this.socket.on('message', (raw) => this.receive(JSON.parse(raw.toString()) as ServerMessage));
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
        this.latestSnapshot = message;
        this.onSnapshot?.(message);
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
      case 'itemError':
        this.errors.push(message.message);
        break;
      case 'error':
        console.error('[сервер]', message.message);
        break;
    }
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
