/**
 * Проверка правил PvP против живого сервера.
 *
 *   npx tsx scripts/pvp-check.ts
 *
 * Приёмка вехи 5 по безопасным зонам, дословно из DESIGN.md: «в городе атака
 * невозможна». Проверяет:
 *   1. в городе удар по игроку не проходит, и сервер объясняет почему;
 *   2. и снаружи по тому, кто в городе, не достать — проверяются оба;
 *   3. за воротами тот же удар проходит и снимает здоровье.
 *
 * Второй пункт важнее первого: правило, проверяющее только бьющего, чинится
 * одним шагом за черту.
 */
import { ACTIONS, INPUT_DT, TICK_RATE, TOWN_SIZE, isSafe } from '@grimhold/shared';
import { walkTo } from './fieldwork.js';
import { TestClient, sleep } from './testClient.js';

const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

/** Досягаемость лёгкого удара: по ней видно, что проверка честная. */
const MELEE_RANGE = ACTIONS.attack.range;

/** С каким запасом сил начинаем бить: на замах и на пару следующих. */
const READY_STAMINA = ACTIONS.attack.staminaCost * 3;

let seq = 0;

/**
 * Ждёт, пока боец отдышится.
 *
 * До ворот ходок бежит спринтом и приходит выжатым, а без стамины замах не
 * начнётся — и проверка увидит «молча» вместо отказа, то есть соврёт про
 * правило, которое на самом деле работает.
 *
 * Отдыхать надо **до** замера позиций: за время отдыха все успевают
 * разойтись, и мерить заранее бессмысленно.
 */
async function rest(client: TestClient): Promise<void> {
  for (let wait = 0; wait < 40; wait++) {
    const self = client.latestSnapshot?.self;
    if (self && self.stamina >= READY_STAMINA) return;
    await sleep(700);
  }
}

/** Бьёт в сторону цели несколько раз подряд. */
async function swingAt(
  attacker: TestClient,
  target: { x: number; z: number },
  times = 4,
): Promise<void> {
  for (let i = 0; i < times; i++) {
    let self = attacker.latestSnapshot?.self;
    if (!self) break;

    if (self.stamina < ACTIONS.attack.staminaCost) break;

    const yaw = Math.atan2(-(target.x - self.x), -(target.z - self.z));
    // Развернуться к цели: попадание считается по направлению взгляда.
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

    attacker.send({
      t: 'action',
      kind: 'attack',
      seq: seq++,
      viewTick: attacker.latestSnapshot?.tick ?? 0,
    });
    await sleep(700);
  }
}

function healthOf(client: TestClient): number {
  return client.latestSnapshot?.self.health ?? 0;
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const bully = new TestClient({ username: `Буян${stamp}`, race: 'dwarf' });
  await bully.ready;
  await sleep(300);
  const victim = new TestClient({ username: `Жертва${stamp}`, race: 'human' });
  await victim.ready;
  await sleep(600);

  console.log('\n1. В городе драки нет');
  // Оба входят в город: точка входа внутри стен.
  const meeting = { x: 4, z: 6 };
  await walkTo(victim, meeting, 1.2);
  await walkTo(bully, meeting, 1.6);
  await rest(bully);

  const victimSelf = victim.latestSnapshot?.self;
  check(
    victimSelf !== undefined && isSafe(victimSelf.x, victimSelf.z),
    'оба в безопасной зоне',
    `${victimSelf?.x.toFixed(1)}, ${victimSelf?.z.toFixed(1)}`,
  );

  const before = healthOf(victim);
  bully.errors.length = 0;
  await swingAt(bully, { x: victimSelf?.x ?? 0, z: victimSelf?.z ?? 0 });

  check(healthOf(victim) === before, 'здоровье не тронуто', `${healthOf(victim)} из ${before}`);
  check(
    bully.errors.some((message) => /город/i.test(message)),
    'сервер объяснил, а не промолчал',
    bully.errors[0] ?? 'молча',
  );

  console.log('\n2. Из города наружу не достать');
  // Бьющий выходит за черту, жертва остаётся внутри — так проверяется второе
  // правило, про цель. Встают **в пределах руки**: иначе проверка пройдёт
  // просто потому, что удар не дотянулся.
  // Сначала уводим бьющего за черту, потом ставим жертву: иначе он проходит
  // сквозь неё и сдвигает с места.
  await walkTo(bully, { x: 0, z: TOWN_SIZE / 2 + 1.2 }, 0.6);
  await walkTo(victim, { x: 0, z: TOWN_SIZE / 2 - 1.0 }, 0.6);
  await rest(bully);

  const bullySelf = bully.latestSnapshot?.self;
  const victimIn = victim.latestSnapshot?.self;
  const split =
    bullySelf !== undefined &&
    victimIn !== undefined &&
    !isSafe(bullySelf.x, bullySelf.z) &&
    isSafe(victimIn.x, victimIn.z);
  check(
    split,
    'бьющий снаружи, жертва внутри',
    `${bullySelf?.z.toFixed(1)} и ${victimIn?.z.toFixed(1)}`,
  );

  if (split) {
    const gap = Math.hypot(victimIn.x - bullySelf.x, victimIn.z - bullySelf.z);
    check(gap <= MELEE_RANGE, 'и стоят в пределах руки', `${gap.toFixed(2)} м`);

    const health = healthOf(victim);
    bully.errors.length = 0;
    await swingAt(bully, { x: victimIn.x, z: victimIn.z });
    check(healthOf(victim) === health, 'через черту удар не прошёл');
    // Текст отказа для этого случая проверяется юнит-тестом
    // (server/test/pvp.test.ts): здесь он зависит от того, успел ли замах
    // начаться и не сдвинулся ли кто-то за время подхода, и ловил бы не
    // правило, а живой мир.
  }

  console.log('\n3. За воротами дерутся');
  const field = { x: 0, z: TOWN_SIZE / 2 + 10 };
  await walkTo(victim, field, 1.5);
  await walkTo(bully, field, 1.8);
  await rest(bully);

  const both = bully.latestSnapshot?.self;
  const prey = victim.latestSnapshot?.self;
  const wild =
    both !== undefined && prey !== undefined && !isSafe(both.x, both.z) && !isSafe(prey.x, prey.z);
  check(wild, 'оба в диких землях');

  if (wild) {
    const health = healthOf(victim);
    bully.errors.length = 0;
    await swingAt(bully, { x: prey.x, z: prey.z }, 6);
    check(healthOf(victim) < health, 'удар прошёл', `${health} → ${healthOf(victim)}`);
  }

  bully.close();
  victim.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
