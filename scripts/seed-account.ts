/**
 * Создаёт тестовую учётную запись с готовыми персонажами.
 *
 *   npx tsx scripts/seed-account.ts
 *
 * Скрипт идемпотентен: если аккаунт или персонаж уже есть, он просто
 * сообщает об этом и идёт дальше.
 */
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type CharacterClass,
  type ClientMessage,
  type Race,
  type ServerMessage,
} from '@grimhold/shared';

const USERNAME = 'test';
const PASSWORD = 'test123';

const ROSTER: { name: string; race: Race; characterClass: CharacterClass }[] = [
  { name: 'Торин', race: 'dwarf', characterClass: 'warrior' },
  { name: 'Аэлин', race: 'elf', characterClass: 'mage' },
  { name: 'Ратмир', race: 'human', characterClass: 'ranger' },
];

const socket = new WebSocket('ws://localhost:8080');
const send = (message: ClientMessage) => socket.send(JSON.stringify(message));

let queue = [...ROSTER];
let registered = false;

socket.on('open', () => {
  send({ t: 'register', protocol: PROTOCOL_VERSION, username: USERNAME, password: PASSWORD });
});

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString()) as ServerMessage;

  if (message.t === 'authError') {
    if (!registered && message.message.includes('занято')) {
      console.log(`Учётная запись «${USERNAME}» уже существует — вхожу.`);
      registered = true;
      send({ t: 'login', protocol: PROTOCOL_VERSION, username: USERNAME, password: PASSWORD });
      return;
    }
    // Имя персонажа занято — не беда, берём следующего.
    console.log(`  пропуск: ${message.message}`);
    next();
    return;
  }

  if (message.t !== 'authenticated') return;

  if (!registered) {
    registered = true;
    console.log(`Учётная запись «${USERNAME}» создана.`);
  }

  const have = new Set(message.characters.map((c) => c.name));
  queue = queue.filter((entry) => !have.has(entry.name));

  if (message.characters.length > 0) {
    console.log('Персонажи на аккаунте:');
    for (const character of message.characters) {
      console.log(`  ${character.name} — ${character.race}/${character.characterClass}`);
    }
  }

  next();
});

function next(): void {
  const entry = queue.shift();
  if (!entry) {
    console.log(`\nГотово. Заходи как  ${USERNAME} / ${PASSWORD}\n`);
    socket.close();
    process.exit(0);
  }
  console.log(`Создаю ${entry.name} (${entry.race}/${entry.characterClass})…`);
  send({ t: 'createCharacter', ...entry });
}

socket.on('error', (error) => {
  console.error('Сервер не отвечает — запущен ли npm run dev?', error.message);
  process.exit(1);
});
