/**
 * Замер нагрузки против живого сервера.
 *
 *   npx tsx scripts/load-check.ts [сколько]
 *
 * Отвечает на один вопрос: **что упрётся первым** — расчёт или сеть.
 * Раньше это мерили руками и один раз; цифра устаревала на следующей вехе,
 * а сравнить было не с чем.
 *
 * Учётные записи с постоянными именами: повторный запуск входит теми же,
 * а не плодит новые.
 */
import { TICK_RATE } from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

const WANTED = Number(process.argv[2] ?? 20);
/** Сколько секунд считаем снапшоты. */
const WINDOW = 10;

async function main(): Promise<void> {
  console.log(`Поднимаю ${WANTED} клиентов…`);
  const clients: TestClient[] = [];

  for (let i = 0; i < WANTED; i++) {
    const client = new TestClient({ username: `Нагрузка${i}` });
    try {
      await client.ready;
    } catch (error) {
      console.log(`  клиент ${i} не вошёл: ${String(error).slice(0, 60)}`);
      continue;
    }
    clients.push(client);
    // Вход пачкой сервер переживает, но нам нужен ровный поток, а не пик.
    await sleep(120);
  }

  console.log(`Вошло: ${clients.length}`);
  await sleep(1500);

  // Считаем снапшоты и их размер. По сети идёт JSON, поэтому длина строки —
  // честная оценка байтов, а не приближение.
  let count = 0;
  let bytes = 0;
  let biggest = 0;

  for (const client of clients) {
    client.onSnapshot = (snapshot) => {
      const size = JSON.stringify(snapshot).length;
      count += 1;
      bytes += size;
      if (size > biggest) biggest = size;
    };
  }

  const started = Date.now();
  await sleep(WINDOW * 1000);
  const elapsed = (Date.now() - started) / 1000;

  const perClient = count / clients.length / elapsed;
  const average = bytes / Math.max(1, count);

  console.log('');
  console.log(`Снапшотов на игрока: ${perClient.toFixed(1)} в секунду (тик ${TICK_RATE} Гц)`);
  console.log(`Размер снапшота: в среднем ${Math.round(average)} Б, крупнейший ${biggest} Б`);
  console.log(
    `Трафик: ${((average * perClient) / 1024).toFixed(1)} КБ/с на игрока, ` +
      `${((bytes / elapsed) / 1048576).toFixed(2)} МБ/с на всех`,
  );

  /**
   * Просадка частоты снапшотов — первый признак того, что сервер не успевает:
   * тик у него фиксированный, и отставать он может только не выдавая кадры.
   */
  const health = perClient / TICK_RATE;
  console.log(
    health > 0.95
      ? 'Сервер держит темп: снапшоты идут в полный тик.'
      : `ВНИМАНИЕ: снапшотов лишь ${(health * 100).toFixed(0)}% от тика — сервер не успевает.`,
  );

  for (const client of clients) client.close();
  await sleep(300);
  process.exit(0);
}

main().catch((error) => {
  console.error('Ошибка замера:', error);
  process.exit(1);
});
