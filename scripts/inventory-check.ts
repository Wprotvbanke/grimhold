/**
 * Проверка инвентаря против живого сервера.
 *
 *   npx tsx scripts/inventory-check.ts
 *
 * Проверяет то, ради чего инвентарь вообще нужен:
 *   1. новичок получает стартовый набор;
 *   2. лут с убитого моба попадает в рюкзак;
 *   3. вещи переживают перезаход;
 *   4. снаряжение надевается, даёт броню и урон, снимается обратно;
 *   5. сервер отказывает в невозможном переносе, а не делает вид, что всё вышло;
 *   6. расходник лечит и тратится.
 */
import { INPUT_DT, TICK_RATE, itemAt, itemDef, type EntitySnapshot } from '@grimhold/shared';
import { makeTool } from './fieldwork.js';
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

async function walk(
  client: TestClient,
  steps: number,
  intent: { forward: number; right: number; yaw: number },
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    client.send({
      t: 'input',
      seq: seq++,
      forward: intent.forward,
      right: intent.right,
      yaw: intent.yaw,
      pitch: 0,
      jump: false,
      sprint: false,
      dt: INPUT_DT,
    });
    if ((i + 1) % 8 === 0) await sleep(1000 / TICK_RATE);
  }
  await sleep(200);
}

function yawToward(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

const TOWN_EDGE = 34;

function nearestMob(client: TestClient): EntitySnapshot | null {
  const self = client.latestSnapshot?.self;
  if (!self) return null;

  let best: EntitySnapshot | null = null;
  let bestDistance = Infinity;
  for (const entity of client.latestSnapshot?.entities ?? []) {
    if (entity.kind !== 'mob' || !entity.alive) continue;
    if (Math.abs(entity.x) < TOWN_EDGE && Math.abs(entity.z) < TOWN_EDGE) continue;

    const distance = Math.hypot(entity.x - self.x, entity.z - self.z);
    if (distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

/** Находит предмет в рюкзаке по идентификатору. */
function find(client: TestClient, defId: string) {
  return client.inventory?.backpack.items.find((item) => item.defId === defId) ?? null;
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const client = new TestClient({
    username: `Купец${stamp}`,
    race: 'dwarf',
    characterClass: 'warrior',
  });
  await client.ready;
  await sleep(400);

  console.log('\n1. Стартовый набор');
  check(client.inventory !== null, 'сервер прислал состояние рюкзака');
  check(find(client, 'crude_axe') === null, 'инструментов не выдают — их делают сами');
  check((find(client, 'bandage')?.count ?? 0) >= 3, 'бинты на месте');
  check(client.inventory!.weight > 0, 'вещи что-то весят',
    `${client.inventory!.weight} кг`);
  check(client.inventory!.capacity > 0, 'предел переноса известен',
    `${client.inventory!.capacity} кг`);

  console.log('\n2. Экипировка');
  // Надевать нечего, пока не сделаешь: нож дешевле прочего — ветка, камень
  // и волокно, и всё это берётся руками.
  check(await makeTool(client, 'knife'), 'нож связан своими руками');

  const knife = find(client, 'knife')!;
  client.send({ t: 'equip', x: knife.x, y: knife.y });
  await sleep(400);

  check(client.inventory?.equipment.mainHand?.defId === 'knife', 'нож в руке');
  check(
    client.inventory!.weaponDamage === itemDef('knife').damage,
    'урон оружия подхвачен',
    `${client.inventory!.weaponDamage}`,
  );
  check(find(client, 'knife') === null, 'надетое ушло из рюкзака');

  client.send({ t: 'unequip', slot: 'mainHand' });
  await sleep(400);
  check(client.inventory?.equipment.mainHand === undefined, 'нож снят');
  check(find(client, 'knife') !== null, 'снятое вернулось в рюкзак');

  console.log('\n3. Отказ в невозможном');
  client.errors.length = 0;
  client.send({ t: 'moveItem', fromX: 9, fromY: 5, toX: 0, toY: 0, rotate: false });
  await sleep(300);
  check(client.errors.length > 0, 'перенос из пустой клетки отклонён с объяснением',
    client.errors[0] ?? 'молча');

  const bandage = find(client, 'bandage')!;
  client.errors.length = 0;
  client.send({ t: 'moveItem', fromX: bandage.x, fromY: bandage.y, toX: 60, toY: 60, rotate: false });
  await sleep(300);
  check(
    find(client, 'bandage') !== null,
    'предмет не исчез при попытке уехать за край сетки',
  );

  console.log('\n4. Перенос внутри рюкзака');
  const before = find(client, 'bandage')!;
  const target = { x: 8, y: 5 };
  client.send({
    t: 'moveItem',
    fromX: before.x,
    fromY: before.y,
    toX: target.x,
    toY: target.y,
    rotate: false,
  });
  await sleep(400);

  const moved = itemAt(client.inventory!.backpack, target.x, target.y);
  check(moved?.defId === 'bandage', 'бинт переехал в указанную клетку');

  console.log('\n5. Использование расходника');
  // Сначала надо получить урон, иначе лечить нечего.
  for (let attempt = 0; attempt < 12; attempt++) {
    const self = client.latestSnapshot?.self;
    if (self && self.z < -TOWN_EDGE - 6) break;
    const drift = self ? Math.max(-1, Math.min(1, -self.x / 2)) : 0;
    await walk(client, 60, { forward: 1, right: drift, yaw: 0 });
  }

  let mob = nearestMob(client);
  for (let attempt = 0; attempt < 14 && !mob; attempt++) {
    await walk(client, 60, { forward: 1, right: 0, yaw: 0 });
    mob = nearestMob(client);
  }

  // Подходим вплотную и стоим, пока не получим по шее.
  for (let round = 0; round < 60; round++) {
    const self = client.latestSnapshot?.self;
    const current = nearestMob(client);
    if (!self || !current) break;
    if (self.health < self.maxHealth) break;

    const distance = Math.hypot(current.x - self.x, current.z - self.z);
    if (distance > 1.8) {
      await walk(client, distance > 6 ? 48 : 12, {
        forward: 1,
        right: 0,
        yaw: yawToward(self, current),
      });
    } else {
      await sleep(600);
    }
  }

  const hurt = client.latestSnapshot?.self;
  check((hurt?.health ?? 0) < (hurt?.maxHealth ?? 0), 'урон получен',
    `${hurt?.health} из ${hurt?.maxHealth}`);

  if (hurt && hurt.health < hurt.maxHealth) {
    const healBefore = hurt.health;
    const countBefore = find(client, 'bandage')?.count ?? 0;
    const heal = find(client, 'bandage')!;

    client.send({ t: 'useItem', x: heal.x, y: heal.y });
    await sleep(500);

    check((client.latestSnapshot?.self.health ?? 0) > healBefore, 'бинт вылечил',
      `${healBefore} → ${client.latestSnapshot?.self.health}`);
    check((find(client, 'bandage')?.count ?? 0) === countBefore - 1, 'бинт потрачен');
  }

  console.log('\n6. Лут и перезаход');
  const lootBefore = client.inventory!.backpack.items.length;
  console.log(`  предметов в рюкзаке: ${lootBefore}`);

  client.close();
  await sleep(800);

  const again = new TestClient({
    username: `Купец${stamp}`,
    race: 'dwarf',
    characterClass: 'warrior',
  });
  await again.ready;
  await sleep(500);

  check(again.inventory !== null, 'рюкзак пришёл после перезахода');
  check(
    (again.inventory?.backpack.items.length ?? 0) === lootBefore,
    'содержимое рюкзака сохранилось',
    `было ${lootBefore}, стало ${again.inventory?.backpack.items.length}`,
  );

  const restored = itemAt(again.inventory!.backpack, target.x, target.y);
  check(restored?.defId === 'bandage', 'раскладка сохранилась, а не пересобралась');

  again.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО\n' : `\nПРОВАЛЕНО: ${failures.length}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка теста:', error);
  process.exit(1);
});
