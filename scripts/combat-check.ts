/**
 * Проверка боя вехи 3 против живого сервера.
 *
 *   npx tsx scripts/combat-check.ts
 *
 * Проверяет:
 *   1. удар в пустоту даёт промах, а не урон;
 *   2. стамина тратится на удар и восстанавливается после паузы;
 *   3. мобы существуют в диких землях и замечают игрока;
 *   4. моба можно забить насмерть и получить лут;
 *   5. заклинание порождает летящий снаряд;
 *   6. смерть и воскрешение работают.
 */
import {
  INPUT_DT,
  RESPAWN_DELAY,
  RESPAWN_STREAK_MAX,
  TICK_RATE,
  type EntitySnapshot,
} from '@grimhold/shared';
import { TestClient, sleep, waitUntil } from './testClient.js';

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

/** Стоит на месте, но продолжает слать ввод: сервер должен видеть направление. */
async function face(client: TestClient, yaw: number, ticks = 4): Promise<void> {
  for (let i = 0; i < ticks * 3; i++) {
    client.send({
      t: 'input',
      seq: seq++,
      forward: 0,
      right: 0,
      yaw,
      pitch: 0,
      jump: false,
      sprint: false,
      dt: INPUT_DT,
    });
    if ((i + 1) % 8 === 0) await sleep(1000 / TICK_RATE);
  }
  await sleep(120);
}

function yawToward(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/**
 * Ближайший моб. Берём только тех, кто снаружи города: у тестового бота нет
 * навигации, а между ним и целью не должно оказаться городской стены —
 * ворота узкие, и обходить их бот не умеет.
 */
const TOWN_EDGE = 34;

function nearestMob(client: TestClient): EntitySnapshot | null {
  const self = client.latestSnapshot?.self;
  const entities = client.latestSnapshot?.entities ?? [];
  if (!self) return null;

  let best: EntitySnapshot | null = null;
  let bestDistance = Infinity;
  for (const entity of entities) {
    if (entity.kind !== 'mob' || !entity.alive) continue;
    // Цель и игрок должны быть по одну сторону городской стены.
    if (Math.abs(entity.x) < TOWN_EDGE && Math.abs(entity.z) < TOWN_EDGE) continue;
    const distance = Math.hypot(entity.x - self.x, entity.z - self.z);
    if (distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const client = new TestClient({
    username: `Боец${Date.now().toString(36)}`,
    race: 'dwarf',
    characterClass: 'warrior',
  });
  await client.ready;
  await sleep(300);

  console.log('\n1. Удар в пустоту');
  const staminaBefore = client.latestSnapshot?.self.stamina ?? 0;
  client.send({ t: 'action', kind: 'attack', seq: 0, viewTick: client.latestSnapshot?.tick ?? 0 });
  await sleep(700);

  check(
    client.combat.some((event) => event.kind === 'miss'),
    'удар по воздуху даёт промах',
  );
  const staminaAfter = client.latestSnapshot?.self.stamina ?? 0;
  check(staminaAfter < staminaBefore, 'стамина потрачена на удар',
    `было ${staminaBefore}, стало ${staminaAfter}`);

  console.log('\n2. Восстановление стамины');
  await sleep(2500);
  const staminaRegen = client.latestSnapshot?.self.stamina ?? 0;
  check(staminaRegen > staminaAfter, 'стамина восстанавливается после паузы',
    `${staminaAfter} → ${staminaRegen}`);

  console.log('\n3. Поиск мобов в диких землях');
  // Сначала выходим из города строго через северные ворота (створ у x = 0),
  // и только потом ищем цель — иначе между ботом и мобом окажется стена,
  // а обходить её бот не умеет.
  for (let attempt = 0; attempt < 12; attempt++) {
    const self = client.latestSnapshot?.self;
    if (self && self.z < -TOWN_EDGE - 6) break;
    const drift = self ? Math.max(-1, Math.min(1, -self.x / 2)) : 0;
    await walk(client, 60, { forward: 1, right: drift, yaw: 0 });
  }

  const exited = client.latestSnapshot?.self;
  console.log(`  вышел из города: ${exited?.x.toFixed(1)}, ${exited?.z.toFixed(1)}`);

  let found: EntitySnapshot | null = nearestMob(client);
  for (let attempt = 0; attempt < 14 && !found; attempt++) {
    await walk(client, 60, { forward: 1, right: 0, yaw: 0 });
    found = nearestMob(client);
  }
  check(found !== null, 'моб найден в снапшоте', found ? `${found.name}` : 'ни одного');

  if (!found) {
    client.close();
    console.log(`\nПРОВАЛЕНО: ${failures.length}\n`);
    process.exit(1);
  }
  console.log(`  ближайший: ${found.name}, hp ${Math.round(found.hp * 100)}%`);

  console.log('\n4. Убийство моба');
  client.combat.length = 0;
  let killed = false;
  let sawHit = false;

  // Двух мобов, а не одного: одна крыса даёт 18 опыта, а на первый уровень
  // навыка нужно 20 — проверять рост навыка на одном убийстве бессмысленно.
  const KILLS_WANTED = 2;

  for (let round = 0; round < 300 && client.loot.length < KILLS_WANTED; round++) {
    const self = client.latestSnapshot?.self;
    const mob = nearestMob(client);
    if (!self || !mob) break;

    const distance = Math.hypot(mob.x - self.x, mob.z - self.z);
    const yaw = yawToward(self, mob);

    if (distance > 1.9) {
      // Подходим вплотную, глядя на цель. Шаг соразмерен дистанции:
      // сервер принимает не больше MAX_INPUTS_PER_TICK за тик, поэтому
      // сближение занимает реальное время, а не один цикл.
      const steps = distance > 6 ? 48 : 12;
      await walk(client, steps, { forward: 1, right: 0, yaw });
      continue;
    }

    await face(client, yaw, 2);
    client.send({
      t: 'action',
      kind: 'attack',
      seq: round,
      viewTick: client.latestSnapshot?.tick ?? 0,
    });
    await sleep(600);

    sawHit ||= client.combat.some((event) => event.kind === 'hit' && event.targetId === mob.id);
    killed = client.loot.length > 0;
  }

  check(sawHit, 'удары по мобу засчитываются');
  check(killed, 'моб убит, добыча объявлена',
    client.loot[0] ? JSON.stringify(client.loot[0].items) : 'лута не было');

  if (client.loot[0]) {
    console.log(`  выпало с «${client.loot[0].from}»: ` +
      client.loot[0].items.map((i) => `${i.name} ×${i.count}`).join(', '));

    // Добыча теперь не сыплется в рюкзак, а лежит мешком: игрок сам решает,
    // что брать. Мешок обязан появиться в снапшоте — иначе брать нечего.
    check(client.loot[0].onGround === true, 'добыча лежит мешком, а не падает в рюкзак');
    await sleep(400);
    check(
      (client.latestSnapshot?.bags.length ?? 0) > 0,
      'мешок виден на земле',
      `мешков рядом: ${client.latestSnapshot?.bags.length ?? 0}`,
    );
  }
  check(client.skillUps.length > 0, 'навык вырос от использования',
    `поднятий: ${client.skillUps.length}`);

  console.log('\n5. Заклинание порождает снаряд');
  const mage = new TestClient({
    username: `Маг${Date.now().toString(36)}`,
    race: 'elf',
    characterClass: 'mage',
  });
  await mage.ready;
  await sleep(300);

  let sawProjectile = false;
  mage.onSnapshot = (snapshot) => {
    if (snapshot.projectiles.length > 0) sawProjectile = true;
  };
  mage.send({ t: 'cast', spellId: 'ember', viewTick: mage.latestSnapshot?.tick ?? 0 });
  await sleep(1200);
  check(sawProjectile, 'снаряд «Уголька» летит через мир');

  console.log('\n6. Смерть и воскрешение');
  // Подходим к живому мобу вплотную и перестаём защищаться.
  client.combat.length = 0;

  for (let round = 0; round < 60; round++) {
    const self = client.latestSnapshot?.self;
    const mob = nearestMob(client);
    if (!self || !mob) break;

    const distance = Math.hypot(mob.x - self.x, mob.z - self.z);
    if (distance <= 2) break;
    await walk(client, distance > 6 ? 48 : 12, {
      forward: 1,
      right: 0,
      yaw: yawToward(self, mob),
    });
  }

  const victim = nearestMob(client);
  console.log(`  стоим под ударами: ${victim?.name ?? 'никого рядом'}`);

  let died = false;
  for (let i = 0; i < 160 && !died; i++) {
    await sleep(500);
    died = client.latestSnapshot?.self.alive === false;
  }
  if (!died) console.log(`  здоровье осталось: ${client.latestSnapshot?.self.health}`);

  check(died, 'мобы способны убить игрока');
  if (died) {
    check(
      client.life.some((event) => event.event === 'died'),
      'сервер прислал сообщение о смерти',
    );

    /**
     * Жмём кнопку **сразу**, как это делает живой игрок.
     *
     * Сервер держит срок лежания, и раньше ранняя просьба пропадала молча:
     * клиент к тому моменту уже убирал экран смерти, и человек оставался
     * ходить мёртвым — невидимый для других, без возможности бить и с нулём
     * здоровья. Проверка ждала три секунды и поэтому ничего не ловила.
     */
    client.send({ t: 'respawn' });
    await sleep(700);
    check(
      client.latestSnapshot?.self.alive === false,
      'сразу после смерти подъём ещё не происходит',
    );

    /**
     * Ждём **подъёма**, а не срока.
     *
     * Срок лежания растёт с каждой быстрой смертью, и число, верное сегодня,
     * назавтра коротко. Ждём факта и печатаем, сколько ждали: если однажды
     * не дождёмся, в логе будет видно, сколько сервер держал павшего.
     */
    const risen = await waitUntil(
      () => client.latestSnapshot?.self.alive === true,
      RESPAWN_DELAY * 2 ** RESPAWN_STREAK_MAX * 1000 + 3000,
    );
    // Печатаем всегда, а не только при провале: срок лежания растёт от числа
    // смертей, и ползущее время видно заранее — до того, как оно упрётся
    // в предел и проверка начнёт падать «непонятно почему».
    console.log(`  ···  подъём занял ${(risen.waited / 1000).toFixed(1)} с`);

    const self = client.latestSnapshot?.self;
    check(self?.alive === true, 'ранняя просьба о воскрешении не потерялась');
    check(
      self !== undefined && Math.hypot(self.x, self.z - 10) < 3,
      'воскрешение переносит в город',
      `позиция ${self?.x.toFixed(1)}, ${self?.z.toFixed(1)}`,
    );
  }

  client.close();
  mage.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО\n' : `\nПРОВАЛЕНО: ${failures.length}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка теста:', error);
  process.exit(1);
});
