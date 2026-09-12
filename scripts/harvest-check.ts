/**
 * Проверка добычи ресурсов против живого сервера.
 *
 *   npx tsx scripts/harvest-check.ts
 *
 * Это приёмка вехи 4 по ресурсным нодам, дословно из DESIGN.md: «срубил
 * дерево — получил бревно». Проверяет то, ради чего ноды и заводились:
 *   1. ноды есть в диких землях и находятся тем же генератором, что у сервера;
 *   2. нулевой ярус берётся голыми руками — с этого начинается игра;
 *   3. дерево голыми руками не поддаётся, и сервер объясняет почему;
 *   4. связанный своими руками топор даёт бревно;
 *   5. нода истощается и попадает в снапшот как выработанная;
 *   6. добыча переживает перезаход — она в базе, а не в памяти.
 */
import { HARVEST_COOLDOWN, NODES } from '@grimhold/shared';
import { carried, equip, makeTool, nearestNode, walkTo } from './fieldwork.js';
import { TestClient, sleep } from './testClient.js';

const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const client = new TestClient({
    username: `Лесоруб${stamp}`,
    race: 'human',
    characterClass: 'warrior',
  });
  await client.ready;
  await sleep(400);

  console.log('\n1. Ноды в мире');
  const tree = nearestNode('tree');
  check(tree !== null, 'в диких землях есть дерево');
  const deadfall = nearestNode('deadfall');
  check(deadfall !== null, 'и сухостой, с которого всё начинается');
  if (!tree || !deadfall) return;
  console.log(`  ближайшее дерево: ${tree.id} на (${tree.x.toFixed(1)}, ${tree.z.toFixed(1)})`);

  console.log('\n2. Голыми руками берётся нулевой ярус');
  check(
    client.inventory?.backpack.items.every((item) => item.defId !== 'crude_axe') ?? false,
    'инструментов в стартовом наборе нет',
  );

  const walked = await walkTo(client, deadfall, 2.4);
  check(walked <= 3.2, 'дошли до сухостоя', `${walked.toFixed(1)} м`);

  client.errors.length = 0;
  client.send({ t: 'harvest', nodeId: deadfall.id });
  await sleep(400);
  check(carried(client, 'branch') > 0, 'ветка ломается без всякого инструмента');
  check(client.errors.length === 0, 'отказов при этом нет', client.errors[0] ?? '');

  console.log('\n3. Дерево голыми руками не выходит');
  client.errors.length = 0;
  const distance = await walkTo(client, tree, 2.4);
  check(distance <= 3.2, 'дошли до дерева', `${distance.toFixed(1)} м`);

  client.send({ t: 'harvest', nodeId: tree.id });
  await sleep(400);
  check(client.errors.length > 0, 'без топора сервер отказал и объяснил', client.errors[0] ?? 'молча');
  check(carried(client, 'log') === 0, 'бревна при этом не появилось');

  console.log('\n4. Топор своими руками');
  const made = await makeTool(client, 'crude_axe');
  check(made, 'топор связан из ветки, камня и волокна');
  check(await equip(client, 'crude_axe'), 'топор в руке');

  client.errors.length = 0;
  await walkTo(client, tree, 2.4);
  client.send({ t: 'harvest', nodeId: tree.id });
  await sleep(400);

  const afterFirst = carried(client, 'log');
  check(afterFirst > 0, 'срубил дерево — получил бревно', `${afterFirst} шт.`);
  check(client.errors.length === 0, 'отказов при этом не было', client.errors[0] ?? '');

  console.log('\n5. Истощение');
  // Бьём, пока нода не кончится: заряды и пауза — числа сервера, поэтому
  // просто стучим с запасом и ждём паузу между ударами.
  for (let i = 0; i < NODES.tree.charges + 2; i++) {
    client.send({ t: 'harvest', nodeId: tree.id });
    await sleep(HARVEST_COOLDOWN * 1000 + 120);
  }

  const mined = carried(client, 'log');
  check(mined >= NODES.tree.charges, 'нода отдала все свои заряды', `${mined} бревна`);

  const depleted = client.latestSnapshot?.depletedNodes ?? [];
  check(depleted.includes(tree.id), 'выработанная нода пришла в снапшоте', depleted.join(', ') || 'пусто');

  client.errors.length = 0;
  client.send({ t: 'harvest', nodeId: tree.id });
  await sleep(400);
  check(carried(client, 'log') === mined, 'из пустой ноды больше ничего не идёт');

  console.log('\n6. Добыча переживает перезаход');
  client.close();
  await sleep(600);

  // Тем же именем — клиент сам найдёт уже созданного персонажа и войдёт им.
  const again = new TestClient({ username: `Лесоруб${stamp}` });
  await again.ready;
  await sleep(600);

  check(
    carried(again, 'log') === mined,
    'брёвна на месте после перезахода',
    `${carried(again, 'log')} шт.`,
  );
  again.close();

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
