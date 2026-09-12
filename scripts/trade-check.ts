/**
 * Проверка прямого обмена против живого сервера.
 *
 *   npx tsx scripts/trade-check.ts
 *
 * Приёмка вехи 4 по обмену: «обмен переживает перезапуск». Проверяет:
 *   1. издалека обмен не предложить;
 *   2. рядом — стол накрывается и виден обоим;
 *   3. любое изменение снимает оба подтверждения;
 *   4. по двум подтверждениям вещи меняются местами;
 *   5. поменянное переживает перезаход.
 */
import { INPUT_DT, TICK_RATE, countOf, type InventoryMessage } from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

function have(client: TestClient, defId: string): number {
  const inventory: InventoryMessage | null = client.inventory;
  return inventory ? countOf(inventory.backpack, defId as never) : 0;
}

/** Подводит первого ко второму: навигации нет, идём напрямую. */
async function approach(client: TestClient, target: TestClient): Promise<number> {
  let seq = 0;
  for (let step = 0; step < 500; step++) {
    const self = client.latestSnapshot?.self;
    const other = target.latestSnapshot?.self;
    if (!self || !other) break;

    const distance = Math.hypot(other.x - self.x, other.z - self.z);
    if (distance <= 2.5) return distance;

    const yaw = Math.atan2(-(other.x - self.x), -(other.z - self.z));
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
  const other = target.latestSnapshot?.self;
  return self && other ? Math.hypot(other.x - self.x, other.z - self.z) : Infinity;
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const first = new TestClient({ username: `Купец${stamp}`, race: 'dwarf' });
  await first.ready;
  await sleep(300);
  const second = new TestClient({ username: `Гость${stamp}`, race: 'elf' });
  await second.ready;
  await sleep(600);

  console.log('\n1. Издалека обмен не предложить');
  // Оба только что вошли и стоят на точке входа, поэтому сначала разводим их.
  let seq = 0;
  for (let step = 0; step < 90; step++) {
    for (let i = 0; i < 4; i++) {
      second.send({
        t: 'input',
        seq: seq++,
        forward: 1,
        right: 0,
        yaw: 0,
        pitch: 0,
        jump: false,
        sprint: true,
        dt: INPUT_DT,
      });
    }
    await sleep(1000 / TICK_RATE);
  }

  first.errors.length = 0;
  first.send({ t: 'tradeInvite', targetId: second.playerId! });
  await sleep(300);
  check(first.errors.length > 0, 'дальнее предложение отклонено', first.errors[0] ?? 'молча');
  check(first.trade === null, 'стол не накрылся');

  console.log('\n2. Рядом стол накрывается и виден обоим');
  const distance = await approach(first, second);
  check(distance <= 5, 'сошлись', `${distance.toFixed(2)} м`);

  first.errors.length = 0;
  first.send({ t: 'tradeInvite', targetId: second.playerId! });
  await sleep(300);
  check(first.trade?.stage === 'invited', 'позвавший видит приглашение', first.errors[0] ?? '');
  check(second.trade?.stage === 'invited', 'позванный тоже');

  second.send({ t: 'tradeRespond', accept: true });
  await sleep(300);
  check(first.trade?.stage === 'open' && second.trade?.stage === 'open', 'стол открыт у обоих');

  console.log('\n3. Изменение снимает подтверждения');
  const give = first.inventory?.backpack.items[0];
  if (!give) {
    console.log('  FAIL рюкзак пуст, менять нечего');
    process.exit(1);
  }
  const givenId = give.defId;
  const givenCount = give.count;

  first.send({ t: 'tradeOffer', x: give.x, y: give.y });
  await sleep(300);
  check(first.trade?.mine.length === 1, 'вещь на столе');
  check(second.trade?.theirs.length === 1, 'собеседник её видит');

  first.send({ t: 'tradeLock', locked: true });
  await sleep(250);
  check(first.trade?.myLock === true, 'подтверждение принято');

  // Вторая вещь на стол — и согласие должно слететь.
  const second1 = first.inventory?.backpack.items[1];
  if (second1) {
    first.send({ t: 'tradeOffer', x: second1.x, y: second1.y });
    await sleep(300);
    check(first.trade?.myLock === false, 'изменение сняло подтверждение');
    first.send({ t: 'tradeWithdraw', index: 1 });
    await sleep(250);
  }

  console.log('\n4. Два подтверждения — сделка');
  const hadBefore = have(second, givenId);
  first.send({ t: 'tradeLock', locked: true });
  await sleep(250);
  second.send({ t: 'tradeLock', locked: true });
  await sleep(500);

  check(first.trade?.stage === 'done', 'обе стороны узнали об итоге', first.trade?.stage ?? 'молча');
  check(have(second, givenId) === hadBefore + givenCount, 'вещь у получателя', `${have(second, givenId)} шт.`);
  check(have(first, givenId) === 0, 'у отдавшего её больше нет', `${have(first, givenId)} шт.`);

  console.log('\n5. Обмен переживает перезаход');
  const after = have(second, givenId);
  second.close();
  await sleep(700);

  const again = new TestClient({ username: `Гость${stamp}` });
  await again.ready;
  await sleep(600);
  check(have(again, givenId) === after, 'вещь на месте после перезахода', `${have(again, givenId)} шт.`);

  again.close();
  first.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
