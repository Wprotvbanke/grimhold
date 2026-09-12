/**
 * Проверка городской казны против живого сервера.
 *
 *   npx tsx scripts/bank-check.ts
 *
 * Приёмка вехи 4 по банку: обмен переживает перезапуск. Проверяет:
 *   1. издалека сундук не открывается;
 *   2. у казны открывается, и приходит её содержимое;
 *   3. вещь уходит из рюкзака в казну и весит там ноль;
 *   4. положенное на месте после перезахода — и после смены персонажа тоже,
 *      хранилище общее на аккаунт;
 *   5. забранное возвращается в рюкзак.
 */
import { BANK, INPUT_DT, TICK_RATE, countOf, type Grid } from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

function inBank(grid: Grid | undefined, defId: string): number {
  return grid ? countOf(grid, defId as never) : 0;
}

/** Доходит до казны: навигации нет, идём напрямую и упираемся честно. */
async function walkToVault(client: TestClient): Promise<number> {
  let seq = 0;
  for (let step = 0; step < 400; step++) {
    const self = client.latestSnapshot?.self;
    if (!self) break;
    const distance = Math.hypot(BANK.x - self.x, BANK.z - self.z);
    if (distance <= BANK.range - 0.6) return distance;

    const yaw = Math.atan2(-(BANK.x - self.x), -(BANK.z - self.z));
    for (let i = 0; i < 4; i++) {
      client.send({
        t: 'input',
        seq: seq++,
        forward: 1,
        right: 0,
        yaw,
        pitch: 0,
        jump: false,
        sprint: true,
        dt: INPUT_DT,
      });
    }
    await sleep(1000 / TICK_RATE);
  }
  const self = client.latestSnapshot?.self;
  return self ? Math.hypot(BANK.x - self.x, BANK.z - self.z) : Infinity;
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const account = `Вкладчик${stamp}`;
  const client = new TestClient({ username: account, characterName: `Первый${stamp}` });
  await client.ready;
  await sleep(500);

  console.log('\n1. Издалека казна не открывается');
  client.errors.length = 0;
  client.send({ t: 'openBank' });
  await sleep(300);
  check(client.errors.length > 0, 'дальний запрос отклонён с объяснением', client.errors[0] ?? 'молча');
  check(client.bank === null, 'содержимое казны издалека не пришло');

  console.log('\n2. У сундука открывается');
  const distance = await walkToVault(client);
  check(distance <= BANK.range, 'дошли до казны', `${distance.toFixed(2)} м`);

  client.errors.length = 0;
  client.send({ t: 'openBank' });
  await sleep(300);
  check(client.bank?.open === true, 'сундук открыт', client.errors[0] ?? '');

  console.log('\n3. Вещь уходит в казну');
  // Кладём то, что есть у новичка в рюкзаке с самого начала.
  const item = client.inventory?.backpack.items[0];
  if (!item) {
    console.log('  FAIL рюкзак пуст, класть нечего');
    process.exit(1);
  }
  const defId = item.defId;
  const before = countOf(client.inventory!.backpack, defId);
  const weightBefore = client.inventory!.weight;

  client.send({ t: 'bankMove', dir: 'deposit', x: item.x, y: item.y });
  await sleep(400);

  check(inBank(client.bank?.grid, defId) === item.count, 'вещь лежит в казне', `${inBank(client.bank?.grid, defId)} шт.`);
  check(
    countOf(client.inventory!.backpack, defId) === before - item.count,
    'из рюкзака вещь ушла',
  );
  check(client.inventory!.weight < weightBefore, 'сложенное в казну не весит');

  console.log('\n4. Казна общая на аккаунт и переживает перезаход');
  const stored = inBank(client.bank?.grid, defId);
  client.close();
  await sleep(700);

  // Другой персонаж того же аккаунта: банк не привязан к телу.
  const other = new TestClient({ username: account, characterName: `Второй${stamp}`, race: 'dwarf' });
  await other.ready;
  await sleep(500);
  await walkToVault(other);
  other.send({ t: 'openBank' });
  await sleep(400);
  check(inBank(other.bank?.grid, defId) === stored, 'вещь на месте у второго персонажа', `${inBank(other.bank?.grid, defId)} шт.`);

  console.log('\n5. Забранное возвращается в рюкзак');
  const cell = other.bank?.grid.items.find((entry) => entry.defId === defId);
  const had = countOf(other.inventory!.backpack, defId);
  if (cell) {
    other.send({ t: 'bankMove', dir: 'withdraw', x: cell.x, y: cell.y });
    await sleep(400);
  }
  check(countOf(other.inventory!.backpack, defId) === had + stored, 'вещь вернулась в рюкзак');
  check(inBank(other.bank?.grid, defId) === 0, 'в казне её больше нет');

  other.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
