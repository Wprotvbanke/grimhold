import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientMessageSchema,
  TICK_MS,
  TICK_RATE,
  encode,
  type ChatBroadcast,
  type LootMessage,
  type ServerMessage,
} from '@grimhold/shared';
import { dispatch } from './commands/index.js';
import { canRespawn, emptyOutbox, respawnPlayer, tickWorld } from './gameloop.js';
import { Persistence } from './persistence.js';
import { Session } from './session.js';
import { SqliteStorage } from './storage/sqlite.js';
import { World } from './world.js';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Путь к базе считается от самого файла, а не от рабочей папки.
 *
 * Иначе `npm run dev` (папка packages/server) и запуск из корня открывали бы
 * две разные базы, и персонажи молча «пропадали» бы в зависимости от того,
 * откуда запустили сервер.
 */
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? resolve(SERVER_ROOT, 'grimhold.db');

const storage = new SqliteStorage(DB_PATH);
const world = new World();
const persistence = new Persistence(storage, world);
persistence.start();

/** Сокеты играющих игроков — по ним идут снапшоты, чат и события боя. */
const sockets = new Map<string, WebSocket>();

// Навигации пока нет: NPC идёт к точке напрямую и честно упирается в геометрию,
// поэтому маршрут проложен по чистой площадке. Навмеш придёт вместе с боем ближнего круга.
world.spawnNpc('Громи Камнерук', 'dwarf', [
  { x: -8, y: 0, z: 8 },
  { x: 2, y: 0, z: 8 },
  { x: 2, y: 0, z: 0 },
  { x: -8, y: 0, z: 0 },
]);

const mobCount = world.populateMobs();

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.log(`[server] слушает ws://localhost:${PORT} — тик ${TICK_RATE} Гц`);
  console.log(`[server] база: ${resolve(DB_PATH)}`);
  console.log(`[server] в диких землях расселено мобов: ${mobCount}`);
});

wss.on('connection', (socket) => {
  const session = new Session(socket, storage, world, persistence, (_session, player) => {
    sockets.set(player.id, socket);
  });

  socket.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return session.send({ t: 'error', message: 'некорректный JSON' });
    }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      return session.send({ t: 'error', message: 'пакет не прошёл проверку схемы' });
    }

    // Вход, регистрация и выбор персонажа живут до появления актора.
    if (session.handle(result.data)) return;

    const player = session.player;
    if (!player) {
      return session.send({ t: 'error', message: 'сначала войдите в мир' });
    }

    // Воскрешение — не боевое действие, обрабатывается отдельно.
    if (result.data.t === 'respawn') {
      if (canRespawn(player)) {
        const message = respawnPlayer(player);
        persistence.flushPlayer(player, 'воскрешение');
        session.send(message);
      }
      return;
    }

    for (const event of dispatch({ world, actor: player }, result.data)) {
      if (event.type === 'chat') {
        deliverChat(event.broadcast as ChatBroadcast, event.recipients as string[]);
      }
      // Любое изменение вещей возвращает игроку новое состояние целиком:
      // рассинхрон раскладки дороже трафика.
      if (event.type === 'inventory') {
        session.send(world.inventoryMessage(player));
      }
      if (event.type === 'itemError') {
        session.send({ t: 'itemError', message: String(event.reason) });
      }
      // Добыча с ноды приходит тем же сообщением, что и лут с трупа: игроку
      // всё равно, откуда вещь, ему важно увидеть, что она у него.
      if (event.type === 'loot') {
        session.send(event.message as LootMessage);
      }
    }
  });

  socket.on('close', () => {
    const id = session.player?.id;
    session.disconnect();
    if (id) sockets.delete(id);
  });
});

/**
 * Игровой цикл с фиксированным шагом. Сервер авторитарен: всё, что происходит
 * в мире, считается здесь, а клиенту уходит только результат.
 */
const dt = TICK_MS / 1000;

setInterval(() => {
  const outbox = emptyOutbox();

  tickWorld(world, dt, outbox);

  // События боя видят те, кто рядом: чужая драка за холмом никого не касается.
  for (const entry of outbox.combat) {
    for (const player of world.playersNear(entry.near, entry.instanceId)) {
      sendTo(player.id, entry.event);
    }
  }
  for (const entry of outbox.skillUps) sendTo(entry.playerId, entry.message);
  for (const entry of outbox.life) sendTo(entry.playerId, entry.message);
  for (const entry of outbox.loot) sendTo(entry.playerId, entry.message);

  // Вещи изменились по ходу тика — шлём новое состояние рюкзака. Через Set,
  // потому что за один тик можно добить сразу двоих и попасть в список дважды.
  for (const player of new Set(outbox.inventory)) {
    sendTo(player.id, world.inventoryMessage(player));
  }

  // Смерть — критичное событие: пишем немедленно, а не ждём пакетного флаша.
  for (const player of outbox.criticalSaves) {
    persistence.flushPlayer(player, 'смерть');
  }

  for (const player of world.players.values()) {
    sendTo(player.id, {
      t: 'snapshot',
      tick: world.tick,
      ack: player.lastProcessedSeq,
      self: world.selfStateOf(player),
      entities: world.snapshotFor(player),
      projectiles: world.projectilesFor(player),
      depletedNodes: world.depletedNodesFor(player),
    });
  }
}, TICK_MS);

function deliverChat(broadcast: ChatBroadcast, recipients: string[]): void {
  for (const id of recipients) sendTo(id, broadcast);
}

function sendTo(playerId: string, message: ServerMessage): void {
  const socket = sockets.get(playerId);
  if (!socket || socket.readyState !== socket.OPEN) return;
  socket.send(encode(message));
}

/** Штатная остановка обязана дописать всё, что накопилось в памяти. */
function shutdown(): void {
  console.log('\n[server] остановка: сохраняю мир');
  persistence.flush('остановка сервера');
  persistence.stop();
  storage.close();
  wss.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
