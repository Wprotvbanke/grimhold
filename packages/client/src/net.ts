import {
  PROTOCOL_VERSION,
  encode,
  type ChatBroadcast,
  type CharacterSummary,
  type CombatEvent,
  type LifeMessage,
  type InventoryMessage,
  type LootMessage,
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
  onItemError?(message: string): void;
  onDisconnected?(): void;
}

/** Перезапуск сервера при разработке — норма, поэтому клиент переподключается сам. */
const RECONNECT_DELAY_MS = 1000;

export class Connection {
  status: ConnectionStatus = 'connecting';
  playerId: string | null = null;
  latestSnapshot: SnapshotMessage | null = null;

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
      this.handlers.onDisconnected?.();
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.socket.addEventListener('error', () => this.socket.close());
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
