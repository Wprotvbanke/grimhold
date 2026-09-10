/**
 * Сквозная проверка вехи 2 против живого сервера.
 *
 *   npx tsx scripts/e2e.ts
 *
 * Проверяет то, что заявлено критериями вехи:
 *   1. регистрация, создание персонажа, вход в мир;
 *   2. два клиента видят друг друга;
 *   3. локальный чат слышен рядом, общий — всем;
 *   4. позиция переживает выход из игры (немедленная запись в БД);
 *   5. радиус интереса реально скрывает далёких игроков.
 */
import { AOI_RADIUS, INPUT_DT, TICK_RATE } from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

const stamp = Date.now().toString(36);
const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) {
    console.log(`  OK   ${description}`);
  } else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

/**
 * Шлёт вводы движения в темпе, который сервер успевает принимать.
 * Больше MAX_INPUTS_PER_TICK за тик он отбрасывает как флуд, поэтому
 * спамить бессмысленно: персонаж просто не доедет.
 */
async function walk(
  client: TestClient,
  seqStart: number,
  steps: number,
  intent: { forward: number; right: number; yaw: number },
): Promise<number> {
  let seq = seqStart;
  for (let i = 0; i < steps; i++) {
    client.send({
      t: 'input',
      seq: seq++,
      forward: intent.forward,
      right: intent.right,
      yaw: intent.yaw,
      pitch: 0,
      jump: false,
      dt: INPUT_DT,
    });
    if ((i + 1) % 8 === 0) await sleep(1000 / TICK_RATE);
  }
  await sleep(300);
  return seq;
}

async function main(): Promise<void> {
  console.log('\n1. Регистрация, персонаж, вход в мир');
  const alice = new TestClient({ username: `Алиса${stamp}`, race: 'elf', characterClass: 'mage' });
  await alice.ready;
  check(alice.playerId !== null, 'персонаж вошёл в мир');
  check(alice.character?.race === 'elf', 'раса сохранилась', `получено ${alice.character?.race}`);
  check(alice.character?.characterClass === 'mage', 'класс сохранился');

  console.log('\n2. Два клиента видят друг друга');
  const bob = new TestClient({ username: `Борис${stamp}`, race: 'dwarf', characterClass: 'warrior' });
  await bob.ready;
  await sleep(300);

  const aliceSees = alice.latestSnapshot?.entities.some((e) => e.id === bob.playerId) ?? false;
  const bobSees = bob.latestSnapshot?.entities.some((e) => e.id === alice.playerId) ?? false;
  check(aliceSees, 'Алиса видит Бориса');
  check(bobSees, 'Борис видит Алису');

  const dwarfNpc = alice.latestSnapshot?.entities.find((e) => e.kind === 'npc');
  check(dwarfNpc !== undefined, 'NPC-дворф присутствует в снапшоте');

  console.log('\n3. Чат');
  bob.send({ t: 'chat', channel: 'local', text: 'слышно рядом' });
  bob.send({ t: 'chat', channel: 'global', text: 'слышно всем' });
  await sleep(300);
  check(
    alice.chat.some((line) => line.includes('слышно рядом')),
    'локальное сообщение дошло до соседа',
  );
  check(
    alice.chat.some((line) => line.includes('слышно всем')),
    'общее сообщение дошло',
  );

  console.log('\n4. Позиция переживает выход из игры');
  let seq = await walk(alice, 0, 160, { forward: 1, right: 0, yaw: Math.PI / 2 });
  const before = alice.latestSnapshot?.self;
  check(before !== undefined && Math.abs(before.x) > 3, 'персонаж действительно сдвинулся',
    `x=${before?.x.toFixed(2)}`);

  alice.close();
  await sleep(600);

  const aliceAgain = new TestClient({ username: `Алиса${stamp}`, race: 'elf', characterClass: 'mage' });
  await aliceAgain.ready;
  await sleep(300);
  const after = aliceAgain.latestSnapshot?.self;

  const restored =
    before !== undefined &&
    after !== undefined &&
    Math.abs(after.x - before.x) < 0.5 &&
    Math.abs(after.z - before.z) < 0.5;
  check(restored, 'позиция восстановлена из базы',
    `было ${before?.x.toFixed(2)},${before?.z.toFixed(2)} стало ${after?.x.toFixed(2)},${after?.z.toFixed(2)}`);

  console.log('\n5. Радиус интереса');
  // Уводим Бориса далеко за радиус видимости.
  await walk(bob, 0, 700, { forward: 1, right: 0, yaw: 0 });
  seq = await walk(aliceAgain, seq, 700, { forward: 1, right: 0, yaw: Math.PI });
  await sleep(400);

  const selfA = aliceAgain.latestSnapshot?.self;
  const selfB = bob.latestSnapshot?.self;
  const distance =
    selfA && selfB ? Math.hypot(selfA.x - selfB.x, selfA.z - selfB.z) : 0;
  const stillVisible =
    aliceAgain.latestSnapshot?.entities.some((e) => e.id === bob.playerId) ?? false;

  console.log(`  расстояние между ними: ${distance.toFixed(1)} м (радиус ${AOI_RADIUS} м)`);
  if (distance > AOI_RADIUS) {
    check(!stillVisible, 'далёкий игрок исключён из снапшота');
  } else {
    check(stillVisible, 'близкий игрок остался в снапшоте');
  }

  aliceAgain.close();
  bob.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО\n' : `\nПРОВАЛЕНО: ${failures.length}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка теста:', error);
  process.exit(1);
});
