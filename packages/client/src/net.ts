import {
  PROTOCOL_VERSION,
  encode,
  type BankMessage,
  type CraftingMessage,
  type GatheringMessage,
  type WorldMessage,
  type TradeMessage,
  type ChatBroadcast,
  type CharacterSummary,
  type CombatEvent,
  type LifeMessage,
  type InventoryMessage,
  type LootMessage,
  type ProgressMessage,
  type SkillUpMessage,
  type ClientMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@grimhold/shared';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface ConnectionHandlers {
  onAuthenticated?(username: string, characters: CharacterSummary[], max: number): void;
  onAuthError?(message: string): void;
  onWelcome?(message: WelcomeMessage): void;
  onChat?(message: ChatBroadcast): void;
  onCombat?(event: CombatEvent): void;
  onSkillUp?(message: SkillUpMessage): void;
  onLife?(message: LifeMessage): void;
  onLoot?(message: LootMessage): void;
  onInventory?(message: InventoryMessage): void;
  onBank?(message: BankMessage): void;
  onTrade?(message: TradeMessage): void;
  onCrafting?(message: CraftingMessage): void;
  onGathering?(message: GatheringMessage): void;
  onWorld?(message: WorldMessage): void;
  /** Прокачка: навыки и очки роста. Приходит при входе и при изменении. */
  onProgress?(message: ProgressMessage): void;
  /** Ведущий перевёл стрелки — час суток стал другим у всех сразу. */
  onDaytime?(shift: number): void;
  onItemError?(message: string): void;
  onDisconnected?(): void;
}

/** Перезапуск сервера при разработке — норма, поэтому клиент переподключается сам. */
const RECONNECT_DELAY_MS = 1000;

/** Сколько снапшотов ждут разбора. Три секунды при двадцати в секунду. */
const SNAPSHOT_BACKLOG = 60;

export class Connection {
  status: ConnectionStatus = 'connecting';
  playerId: string | null = null;
  latestSnapshot: SnapshotMessage | null = null;

  /**
   * Пришедшие снапшоты в порядке прихода.
   *
   * Одного «последнего» мало, и это стоило невидимых сущностей. Опознание —
   * имя, вид, порода — едет **ровно один раз**, в том снапшоте, где сущность
   * впервые попала в поле зрения. Кадр длиннее пятидесяти миллисекунд
   * пропускает снапшот целиком, и если пропущен был именно тот, клиент уже
   * никогда не узнает, кто это: сервер второй раз не представляет, пока
   * сущность не выйдет из радиуса и не вернётся. Моб при этом жив, бьёт
   * и ходит — просто его не рисуют.
   *
   * Поэтому снапшоты копятся, а кадр разбирает их все подряд. Время прихода
   * хранится рядом: интерполяции важно, **когда** пришла каждая выборка,
   * а не когда её разобрали.
   */
  private readonly snapshots: { message: SnapshotMessage; at: number }[] = [];

  private socket!: WebSocket;

  constructor(
    private readonly url: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.connect();
  }

  private connect(): void {
    this.status = 'connecting';
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('open', () => {
      this.status = 'online';
    });

    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      switch (message.t) {
        case 'authenticated':
          this.handlers.onAuthenticated?.(message.username, message.characters, message.maxCharacters);
          break;
        case 'authError':
          this.handlers.onAuthError?.(message.message);
          break;
        case 'welcome':
          this.playerId = message.playerId;
          this.handlers.onWelcome?.(message);
          break;
        case 'snapshot':
          this.latestSnapshot = message;
          this.snapshots.push({ message, at: performance.now() });
          // Предел на случай, когда вкладка ушла в фон и кадров нет вовсе:
          // разбирать минуту прошлого бессмысленно, а память копить незачем.
          if (this.snapshots.length > SNAPSHOT_BACKLOG) this.snapshots.shift();
          break;
        case 'chatMessage':
          this.handlers.onChat?.(message);
          break;
        case 'combat':
          this.handlers.onCombat?.(message);
          break;
        case 'skillUp':
          this.handlers.onSkillUp?.(message);
          break;
        case 'life':
          this.handlers.onLife?.(message);
          break;
        case 'loot':
          this.handlers.onLoot?.(message);
          break;
        case 'inventory':
          this.handlers.onInventory?.(message);
          break;
        case 'bank':
          this.handlers.onBank?.(message);
          break;
        case 'trade':
          this.handlers.onTrade?.(message);
          break;
        case 'crafting':
          this.handlers.onCrafting?.(message);
          break;
        case 'gathering':
          this.handlers.onGathering?.(message);
          break;
        case 'world':
          this.handlers.onWorld?.(message);
          break;
        case 'progress':
          this.handlers.onProgress?.(message);
          break;
        case 'daytime':
          this.handlers.onDaytime?.(message.shift);
          break;
        case 'itemError':
          this.handlers.onItemError?.(message.message);
          break;
        case 'error':
          console.error('[сервер]', message.message);
          break;
      }
    });

    this.socket.addEventListener('close', () => {
      this.status = 'offline';
      this.playerId = null;
      this.latestSnapshot = null;
      this.snapshots.length = 0;
      this.handlers.onDisconnected?.();
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.socket.addEventListener('error', () => this.socket.close());
  }

  /**
   * Забирает накопленные снапшоты и очищает очередь.
   *
   * Отдаёт их **все**, а не последний: в пропущенном мог ехать единственный
   * раз, когда сервер называл сущность по имени.
   */
  takeSnapshots(): { message: SnapshotMessage; at: number }[] {
    return this.snapshots.splice(0, this.snapshots.length);
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encode(message));
  }

  login(username: string, password: string): void {
    this.send({ t: 'login', protocol: PROTOCOL_VERSION, username, password });
  }

  register(username: string, password: string): void {
    this.send({ t: 'register', protocol: PROTOCOL_VERSION, username, password });
  }
}
