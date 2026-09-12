/**
 * Проверка добычи ресурсов против живого сервера.
 *
 *   npx tsx scripts/harvest-check.ts
 *
 * Это приёмка вехи 4 по ресурсным нодам, дословно из DESIGN.md: «срубил
 * дерево — получил бревно». Проверяет то, ради чего ноды и заводились:
 *   1. ноды есть в диких землях и находятся тем же генератором, что у сервера;
 *   2. без инструмента в руке нода не поддаётся, и сервер объясняет почему;
 *   3. с топором в руке дерево даёт бревно в рюкзак;
 *   4. нода истощается и попадает в снапшот как выработанная;
 *   5. добыча переживает перезаход — она в базе, а не в памяти.
 */
import {
  HARVEST_COOLDOWN,
  INPUT_DT,
  NODES,
  TICK_RATE,
  generateNodes,
  type ResourceNode,
} from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

let seq = 0;

/**
 * Шагает к точке, пока не подойдёт ближе `stop` метров или не выйдет время.
 *
 * Навигации в игре нет, и ходок упирается в стволы и валуны честно, как игрок.
 * Поэтому здесь простейший обход: если расстояние перестало сокращаться —
 * несколько шагов боком и снова вперёд. Без этого проверка падала не на
 * добыче, а на первом же дереве по дороге.
 */
async function walkTo(client: TestClient, to: { x: number; z: number }, stop: number): Promise<number> {
  let closest = Infinity;
  let stuck = 0;
  let sidestep = 0;

  for (let step = 0; step < 600; step++) {
    const self = client.latestSnapshot?.self;
    if (!self) break;

    const distance = Math.hypot(to.x - self.x, to.z - self.z);
    if (distance <= stop) return distance;

    if (distance < closest - 0.05) {
      closest = distance;
      stuck = 0;
    } else if (++stuck > 6 && sidestep <= 0) {
      // Сторону чередуем: если обход вправо не помог, следующий раз влево.
      sidestep = 14;
      stuck = 0;
    }

    // При forward = 1 движение идёт в (−sin yaw, −cos yaw) — отсюда обратное.
    const yaw = Math.atan2(-(to.x - self.x), -(to.z - self.z));
    const right = sidestep > 0 ? (Math.floor(step / 40) % 2 === 0 ? 1 : -1) : 0;
    if (sidestep > 0) sidestep--;

    for (let i = 0; i < 4; i++) {
      client.send({
        t: 'input',
        seq: seq++,
        forward: right === 0 ? 1 : 0.4,
        right,
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
  return self ? Math.hypot(to.x - self.x, to.z - self.z) : Infinity;
}

function find(client: TestClient, defId: string): number {
  let total = 0;
  for (const item of client.inventory?.backpack.items ?? []) {
    if (item.defId === defId) total += item.count;
  }
  return total;
}

/** Ближайшее к городу дерево из диких земель — до него идти недалеко. */
function nearestTree(): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bestDistance = Infinity;

  for (const cx of [-1, 0, 1]) {
    for (const cz of [-1, 0, 1]) {
      for (const node of generateNodes(cx, cz)) {
        if (node.nodeId !== 'tree') continue;
        const distance = Math.hypot(node.x, node.z);
        if (distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
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
  const tree = nearestTree();
  check(tree !== null, 'в диких землях есть дерево');
  if (!tree) return;
  console.log(`  ближайшее дерево: ${tree.id} на (${tree.x.toFixed(1)}, ${tree.z.toFixed(1)})`);

  console.log('\n2. Голыми руками не выходит');
  client.errors.length = 0;
  const distance = await walkTo(client, tree, 2.4);
  check(distance <= 3.2, 'дошли до дерева', `${distance.toFixed(1)} м`);

  client.send({ t: 'harvest', nodeId: tree.id });
  await sleep(400);
  check(client.errors.length > 0, 'без топора сервер отказал и объяснил', client.errors[0] ?? 'молча');
  check(find(client, 'log') === 0, 'бревна при этом не появилось');

  console.log('\n3. С топором в руке');
  const axe = client.inventory?.backpack.items.find((item) => item.defId === 'crude_axe');
  check(axe !== undefined, 'топор есть в стартовом наборе');
  if (!axe) return;

  client.send({ t: 'equip', x: axe.x, y: axe.y });
  await sleep(400);
  check(client.inventory?.equipment.mainHand?.defId === 'crude_axe', 'топор в руке');

  client.errors.length = 0;
  client.send({ t: 'harvest', nodeId: tree.id });
  await sleep(400);

  const afterFirst = find(client, 'log');
  check(afterFirst > 0, 'срубил дерево — получил бревно', `${afterFirst} шт.`);
  check(client.errors.length === 0, 'отказов при этом не было', client.errors[0] ?? '');

  console.log('\n4. Истощение');
  // Бьём, пока нода не кончится: заряды и пауза — числа сервера, поэтому
  // просто стучим с запасом и ждём паузу между ударами.
  for (let i = 0; i < NODES.tree.charges + 2; i++) {
    client.send({ t: 'harvest', nodeId: tree.id });
    await sleep(HARVEST_COOLDOWN * 1000 + 120);
  }

  const mined = find(client, 'log');
  check(mined >= NODES.tree.charges, 'нода отдала все свои заряды', `${mined} бревна`);

  const depleted = client.latestSnapshot?.depletedNodes ?? [];
  check(depleted.includes(tree.id), 'выработанная нода пришла в снапшоте', depleted.join(', ') || 'пусто');

  client.errors.length = 0;
  client.send({ t: 'harvest', nodeId: tree.id });
  await sleep(400);
  check(find(client, 'log') === mined, 'из пустой ноды больше ничего не идёт');

  console.log('\n5. Добыча переживает перезаход');
  client.close();
  await sleep(600);

  // Тем же именем — клиент сам найдёт уже созданного персонажа и войдёт им.
  const again = new TestClient({ username: `Лесоруб${stamp}` });
  await again.ready;
  await sleep(600);

  check(find(again, 'log') === mined, 'брёвна на месте после перезахода', `${find(again, 'log')} шт.`);
  again.close();

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
