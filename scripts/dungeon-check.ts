/**
 * Проверка спуска в подземелье против живого сервера.
 *
 *   npx tsx scripts/dungeon-check.ts
 *
 * Первый ломоть вехи 6 — «вошёл и вышел». Проверяет то, на чём держится
 * вся ставка подземелья:
 *   1. издалека не спуститься;
 *   2. у люка спуск открывается, и игрок оказывается в своём инстансе;
 *   3. оставшийся наверху его не видит — и он не видит наверх;
 *   4. **вещи едут с игроком**: зашёл со своим, вышел со своим;
 *   5. в зале есть обитатели и сундуки, и сундук отдаёт добычу один раз;
 *   6. портал возвращает в город, и это переживает перезаход.
 */
import {
  ACTIONS,
  BAG_RANGE,
  INPUT_DT,
  TICK_RATE,
  CHEST_RANGE,
  CHEST_TIME,
  dungeonChests,
  dungeonSeed,
  DUNGEON_ENTRY,
  stairsDown,
  DUNGEON_EXIT,
  DUNGEON_GATE,
  SPAWN_POINT,
  isDungeon,
} from '@grimhold/shared';
import { carried, reviveIfDead, walkRoute, walkTo } from './fieldwork.js';
import { TestClient, sleep, waitUntil } from './testClient.js';

const failures: string[] = [];
let seq = 0;

/**
 * Бьёт в сторону цели, пока та жива или пока не кончится терпение.
 *
 * Мародёру нужно не победить, а убить: мешок появляется только после смерти,
 * и проверить его иначе нечем. Стамина кончается быстрее здоровья, поэтому
 * между сериями ударов боец отдыхает.
 */
async function beatDown(
  attacker: TestClient,
  target: TestClient,
  seconds = 70,
): Promise<boolean> {
  const until = Date.now() + seconds * 1000;

  while (Date.now() < until) {
    if (target.latestSnapshot?.self.alive === false) return true;

    const self = attacker.latestSnapshot?.self;
    const prey = target.latestSnapshot?.self;
    if (!self || !prey) break;

    if (self.stamina < ACTIONS.attack.staminaCost) {
      await sleep(1200);
      continue;
    }

    const yaw = Math.atan2(-(prey.x - self.x), -(prey.z - self.z));
    for (let k = 0; k < 4; k++) {
      attacker.send({
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
    }
    await sleep(1000 / TICK_RATE);

    attacker.send({ t: 'action', kind: 'attack', seq: seq++, viewTick: attacker.latestSnapshot?.tick ?? 0 });
    await sleep(600);
  }

  return target.latestSnapshot?.self.alive === false;
}

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

function where(client: TestClient): string {
  return client.world?.instanceId ?? 'неизвестно';
}

/**
 * Поднимает павшего и возвращает вниз. Возвращает true, если пришлось.
 *
 * Воскрешение всегда возвращает в город — значит, забег прерван, и спуск
 * начинается сначала, с новым залом и новым зерном.
 */
async function descendAgain(client: TestClient): Promise<boolean> {
  if (!(await reviveIfDead(client))) return false;

  /**
   * Воскрешение — это перенос, и клиенту о нём обязаны сказать.
   *
   * Без этого сообщения клиент продолжает строить землю подземелья, а она
   * за пределами зала пуста: игрок появлялся в городе без пола и проваливался.
   */
  check(where(client) === 'overworld', 'воскресшему сказали, что он в городе', where(client));

  await walkToGate(client);
  client.send({ t: 'enterDungeon' });
  // Ждём, пока сервер объявит переезд, а не «примерно столько, сколько надо»:
  // после воскрешения в очереди у сервера уже лежит целый забег событий.
  await waitUntil(() => isDungeon(where(client)), 5000);
  return true;
}

/**
 * Ведёт к люку в обход городской стены.
 *
 * Прямая от точки появления до люка упирается в стену города, и ходок
 * протискивался мимо неё через раз — проверка падала на втором шаге, так
 * и не дойдя до подземелья. Навигации в игре нет, поэтому дорога здесь
 * задана точками: южнее стены, потом на восток, потом к люку.
 */
async function walkToGate(client: TestClient): Promise<number> {
  await walkTo(client, { x: 3, z: -2 }, 1.5);
  await walkTo(client, { x: 8, z: -2 }, 1.5);
  return walkTo(client, DUNGEON_GATE, 1.2);
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  /**
   * Имя копателя **постоянное**, а не со штампом времени.
   *
   * Этим аккаунтом проверка отпирает порталы служебным словом ведущего: без
   * этого дойти до конца вылазки значило бы сперва убить хозяина глубины,
   * а бой с ним — это минуты и удача, и проверять он будет уже не связку
   * «вошёл и вышел». Право выдаётся по имени аккаунта при запуске сервера
   * (`GRIMHOLD_ADMINS`), а имя со штампом в такой список не впишешь.
   */
  const digger = new TestClient({ username: 'Копатель' });
  await digger.ready;
  await sleep(400);
  const stayer = new TestClient({ username: `Зевака${stamp}` });
  await stayer.ready;
  await sleep(600);

  console.log('\n1. Издалека не спуститься');
  check(where(digger) === 'overworld', 'начали наверху', where(digger));

  digger.errors.length = 0;
  digger.send({ t: 'enterDungeon' });
  await sleep(300);
  check(digger.errors.length > 0, 'дальний запрос отклонён с объяснением', digger.errors[0] ?? 'молча');
  check(where(digger) === 'overworld', 'и наверху остались');

  console.log('\n2. У люка спуск открывается');
  /**
   * Класть в рюкзак приходится самой проверке.
   *
   * Аккаунт копателя постоянный (право отпирать порталы выдаётся по имени),
   * а значит и персонаж живёт от запуска к запуску: стартовый набор он давно
   * израсходовал, и «что несли — вынесли» проверялось бы на пустом рюкзаке.
   */
  digger.send({ t: 'admin', do: 'give', itemId: 'bandage', count: 3 });
  await sleep(400);
  const bandages = carried(digger, 'bandage');
  check(bandages > 0, 'взяли что-то с собой', `бинтов ${bandages}`);

  const distance = await walkToGate(digger);
  check(distance <= DUNGEON_GATE.range, 'дошли до спуска', `${distance.toFixed(2)} м`);

  digger.errors.length = 0;
  digger.send({ t: 'enterDungeon' });
  await sleep(700);

  check(isDungeon(where(digger)), 'оказались в подземелье', where(digger));
  const below = digger.latestSnapshot?.self;
  check(
    below !== undefined && Math.hypot(below.x - DUNGEON_ENTRY.x, below.z - DUNGEON_ENTRY.z) < 3,
    'и встали у входа',
    `${below?.x.toFixed(1)}, ${below?.z.toFixed(1)}`,
  );

  console.log('\n3. Миры не видят друг друга');
  const seenFromAbove = stayer.latestSnapshot?.entities.some((e) => e.id === digger.playerId);
  const seenFromBelow = digger.latestSnapshot?.entities.some((e) => e.id === stayer.playerId);
  check(seenFromAbove !== true, 'сверху копателя не видно');
  check(seenFromBelow !== true, 'снизу зеваку не видно');

  console.log('\n4. Вещи поехали с игроком');
  check(carried(digger, 'bandage') === bandages, 'рюкзак при нём', `бинтов ${carried(digger, 'bandage')}`);

  console.log('\n5. В зале есть чем поживиться и от кого получить');
  const dwellers = digger.latestSnapshot?.entities.filter((e) => e.kind === 'mob') ?? [];
  check(dwellers.length > 0, 'зал заселён', `видно обитателей: ${dwellers.length}`);

  const chests = dungeonChests(dungeonSeed(where(digger)));
  check(chests.length > 0, 'сундуки разложены', `их ${chests.length}`);

  // Ближайший к игроку: идти до дальнего дольше, а проверяем мы не выносливость.
  const here = digger.latestSnapshot!.self;
  const chest = [...chests].sort(
    (a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z),
  )[0]!;

  const seed = dungeonSeed(where(digger));
  const toChest = await walkRoute(digger, seed, chest, 1.4);
  check(toChest <= CHEST_RANGE, 'дошли до сундука', `${toChest.toFixed(2)} м`);

  digger.loot.length = 0;
  digger.errors.length = 0;
  digger.send({ t: 'openChest', chestId: chest.id });
  await sleep(400);
  check(
    digger.gathering?.nodeId === chest.id,
    'пошла полоса вскрытия',
    String(digger.gathering?.nodeId),
  );

  // Ждём дольше самой работы: замок должен поддаться сам, без второго нажатия.
  await sleep(CHEST_TIME * 1000 + 900);
  check(digger.loot.length > 0, 'сундук вскрыт', digger.loot[0]?.from ?? 'молчит');

  // Сундук — хранилище, а не выдача: добыча лежит в нём, и открывается он тем
  // же окном, что казна.
  const inside = digger.bank;
  check(inside?.open === true, 'сундук открылся окном', inside?.title ?? 'молчит');
  check((inside?.grid.items.length ?? 0) > 0, 'и в нём лежит добыча');

  if (digger.latestSnapshot?.self.alive) {
    digger.send({ t: 'closeBank' });
    await sleep(200);
    digger.send({ t: 'openChest', chestId: chest.id });
    await sleep(400);
    // Замок уже сломан: второй раз он открывается сразу, без полосы.
    check(digger.bank?.open === true, 'вскрытый открывается снова, без полосы');
  } else {
    console.log('  ···  второй заход не проверен: копателя убили у сундука');
  }

  console.log('\n6. Лестница ведёт глубже');
  /**
   * Этажи живут в одном инстансе: переход по лестнице не меняет имени мира,
   * меняет только место. Проверяется именно это — иначе отряд разваливался бы
   * на каждом спуске, а хозяин глубины отпирал бы порталы не тем.
   */
  {
    const above = where(digger);
    const down = stairsDown(0)!;
    const toStairs = await walkRoute(digger, dungeonSeed(above), down, 0.9);
    check(toStairs <= 1.6, 'дошли до лестницы вниз', `${toStairs.toFixed(2)} м`);

    digger.send({ t: 'stairs', down: true });
    await sleep(700);
    check(where(digger) === above, 'инстанс тот же — этажи в одном забеге', where(digger));
    check(
      digger.latestSnapshot?.self.floor === 1,
      'оказались на втором этаже',
      `этаж ${(digger.latestSnapshot?.self.floor ?? 0) + 1}`,
    );

    digger.send({ t: 'stairs', down: false });
    await sleep(700);
    check(
      digger.latestSnapshot?.self.floor === 0,
      'и вернулись на первый',
      `этаж ${(digger.latestSnapshot?.self.floor ?? 0) + 1}`,
    );
  }

  console.log('\n7. Зал общий, и павший оставляет мешок');
  // Подземелье на одного — это полоса препятствий: ни встречи, ни второго
  // охотника за тем же сундуком. Из замысла зал принимает двенадцать.
  const marauder = new TestClient({ username: `Мародёр${stamp}` });
  await marauder.ready;
  await sleep(600);
  await walkToGate(marauder);
  marauder.send({ t: 'enterDungeon' });
  await sleep(800);

  check(where(marauder) === where(digger), 'спустились в один зал', where(marauder));

  const met = marauder.latestSnapshot?.entities.some((e) => e.id === digger.playerId);
  check(met === true, 'и видят друг друга');

  // Сходимся вплотную: удар считается по дистанции, а не по намерению.
  const prey = digger.latestSnapshot!.self;
  await walkRoute(marauder, dungeonSeed(where(marauder)), { x: prey.x, z: prey.z }, 1.0);

  const killed = await beatDown(marauder, digger);
  if (killed) {
    await sleep(500);
    const spoils = marauder.latestSnapshot?.bags ?? [];
    check(spoils.length > 0, 'от павшего остался мешок', `мешков рядом: ${spoils.length}`);

    if (spoils.length > 0) {
      const sack = spoils[0]!;
      const toBag = await walkRoute(marauder, dungeonSeed(where(marauder)), sack, 1.0);
      check(toBag <= BAG_RANGE, 'дошли до мешка', `${toBag.toFixed(2)} м`);

      marauder.send({ t: 'openBag', bagId: sack.id });
      await sleep(400);

      const opened = marauder.bank;
      check(opened?.open === true, 'мешок открывается', opened?.title ?? 'молчит');
      check(
        (opened?.grid.items.length ?? 0) > 0,
        'и в нём лежит добыча павшего',
        `предметов: ${opened?.grid.items.length ?? 0}`,
      );
    }

    // Убитому вещи не вернулись: надетое пропало, рюкзак остался внизу.
    check(carried(digger, 'bandage') === 0, 'у павшего рюкзак пуст', `бинтов ${carried(digger, 'bandage')}`);
  } else {
    console.log('  ···  добить не вышло за отведённое время — мешок не проверен');
  }

  marauder.close();
  await sleep(300);

  console.log('\n8. Портал возвращает наверх');
  // Зал обитаем, и до портала можно не дойти — это и есть подземелье.
  // Проверяем правило выхода, а не выносливость: павшего поднимаем и спускаем
  // заново, иначе проверка будет падать через раз по совершенно честной причине.
  if (await descendAgain(digger)) {
    console.log('  ···  копателя убили в зале — спустился заново');
  }

  // Что несём вниз на момент подъёма: сравнивать с самым началом больше нельзя —
  // по дороге могли убить, и тогда рюкзак пуст совершенно законно.
  const carriedDown = digger.inventory?.backpack.items.length ?? 0;

  digger.errors.length = 0;
  digger.send({ t: 'leaveDungeon' });
  await sleep(300);
  check(digger.errors.length > 0, 'от входа выйти нельзя — до портала надо дойти', digger.errors[0] ?? 'молча');

  // Портал теперь у самого знака, и отклик у него узкий: подойти надо
  // вплотную, а не «примерно туда».
  const toPortal = await walkRoute(digger, dungeonSeed(where(digger)), DUNGEON_EXIT, 0.9);
  check(toPortal <= 1.6, 'дошли до портала', `${toPortal.toFixed(2)} м`);

  /**
   * Порталы заперты, пока жив хозяин глубины, — и это правило, а не помеха
   * проверке: дойти до портала мало.
   *
   * Босса проверка не убивает: бой с ним — это минуты и удача, а здесь
   * проверяется связка «вошёл и вышел». Порталы отпираются служебным словом
   * ведущего, тем же, каким выдают вещи.
   */
  digger.errors.length = 0;
  digger.send({ t: 'leaveDungeon' });
  await sleep(300);
  check(
    digger.errors.length > 0,
    'портал заперт, пока жив хозяин глубины',
    digger.errors[0] ?? 'молча',
  );
  check(
    digger.latestSnapshot?.self.bossAlive === true,
    'и клиенту об этом сказано',
    `этаж ${(digger.latestSnapshot?.self.floor ?? 0) + 1}`,
  );

  digger.send({ t: 'admin', do: 'portals' });
  await sleep(400);
  check(
    (digger.latestSnapshot?.self.portalsFor ?? 0) > 0,
    'порталы отперты и идёт отсчёт',
    `${Math.round(digger.latestSnapshot?.self.portalsFor ?? 0)} с`,
  );

  digger.send({ t: 'leaveDungeon' });
  await sleep(700);
  check(where(digger) === 'overworld', 'вернулись в мир', where(digger));

  const back = digger.latestSnapshot?.self;
  check(
    back !== undefined && Math.hypot(back.x - SPAWN_POINT.x, back.z - SPAWN_POINT.z) < 3,
    'и встали в городе',
    `${back?.x.toFixed(1)}, ${back?.z.toFixed(1)}`,
  );
  check(
    (digger.inventory?.backpack.items.length ?? 0) === carriedDown,
    'что несли — вынесли',
    `предметов ${digger.inventory?.backpack.items.length ?? 0} из ${carriedDown}`,
  );

  console.log('\n9. Перезаход помнит, где ты');
  digger.close();
  await sleep(700);

  const again = new TestClient({ username: 'Копатель' });
  await again.ready;
  await sleep(700);
  check(where(again) === 'overworld', 'зашли обратно в мир, а не в пустоту', where(again));

  again.close();
  stayer.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
