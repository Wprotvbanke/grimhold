/**
 * Проверка предсказания и реконсилиации против живого сервера.
 * Гоняет настоящий Predictor клиента, добавляя искусственную задержку и потери,
 * и меряет, насколько сервер поправляет предсказанную позицию.
 *
 *   npx tsx scripts/netcode-check.ts [задержка_мс] [секунд]
 */
import {
  ChunkedWorld,
  INPUT_DT,
  RACES,
  SPAWN_POINT,
  SPRINT_SPEED_SCALE,
  WALK_SPEED,
} from '@grimhold/shared';
import { Predictor } from '../packages/client/src/prediction.js';
import { TestClient, sleep } from './testClient.js';

const latency = Number(process.argv[2] ?? 150);
const seconds = Number(process.argv[3] ?? 10);
const loss = 0.02;

const profile = RACES.human;
const terrain = new ChunkedWorld();
const predictor = new Predictor(
  SPAWN_POINT,
  (x, z) => terrain.collidersAt(x, z),
  {
    body: { radius: profile.radius, height: profile.height },
    speedScale: profile.speedScale,
  },
);

const corrections: number[] = [];

async function main(): Promise<void> {
  const client = new TestClient({
    username: `Сетевик${Date.now().toString(36)}`,
    latency: latency / 2,
  });
  await client.ready;

  client.onSnapshot = (snapshot) => {
    // Те же модификаторы, что применяет сервер: иначе предсказание разойдётся.
    predictor.setModifiers({
      blocking: snapshot.self.blocking,
      dashing: snapshot.self.action === 'dodge' && snapshot.self.phase === 'active',
      gliding: snapshot.self.action === 'dodge' && snapshot.self.phase === 'recovery',
      acting: Boolean(snapshot.self.action) && snapshot.self.action !== 'dodge',
      slowFactor: 1,
      weightFactor: 1,
    });

    // Снапшот тоже идёт до нас половину RTT.
    setTimeout(() => {
      predictor.reconcile(snapshot.self, snapshot.ack);
      if (predictor.stats.pending > 0) corrections.push(predictor.stats.correction);
    }, latency / 2);
  };

  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;

    // Бег с поворотами: прямые участки, виражи и упор в препятствия.
    const t = now / 1000;
    const intent = {
      forward: 1,
      right: Math.sin(t * 0.7) > 0 ? 1 : -1,
      jump: Math.sin(t * 1.3) > 0.9,
      // Бег через раз: под ним предсказание проверяется вместе с тратой стамины.
      sprint: Math.sin(t * 0.5) > 0,
      yaw: Math.sin(t * 0.35) * Math.PI,
      pitch: 0,
    };

    for (const input of predictor.collectInputs(dt, intent)) {
      if (Math.random() < loss) continue; // потеря пакета
      client.send({ t: 'input', ...input });
    }
  }, 16);

  await sleep(seconds * 1000);
  clearInterval(timer);
  client.close();

  if (corrections.length === 0) {
    console.error('FAIL: сервер не прислал ни одной поправки');
    process.exit(1);
  }

  /**
   * Проверка, что проверка вообще что-то проверяла.
   *
   * Однажды скрипт перестал слать обязательное поле, сервер отверг каждый
   * пакет, игрок не сдвинулся — и тест отрапортовал идеальную сходимость.
   * Молчаливый успех хуже, чем его отсутствие, поэтому теперь мы требуем
   * доказательства движения.
   */
  const travelled = Math.hypot(
    predictor.state.pos.x - SPAWN_POINT.x,
    predictor.state.pos.z - SPAWN_POINT.z,
  );
  console.log(`пройдено: ${travelled.toFixed(1)} м`);

  if (travelled < 5) {
    console.error('FAIL: игрок не двигался — проверять было нечего');
    process.exit(1);
  }

  corrections.sort((a, b) => a - b);
  const avg = corrections.reduce((sum, v) => sum + v, 0) / corrections.length;
  const p95 = corrections[Math.floor(corrections.length * 0.95)]!;
  const max = corrections[corrections.length - 1]!;

  console.log(`задержка ${latency} мс, потери ${loss * 100}%, шаг ввода ${(INPUT_DT * 1000).toFixed(1)} мс`);
  console.log(`поправок: ${corrections.length}`);
  console.log(`средняя: ${(avg * 100).toFixed(2)} см`);
  console.log(`95-й процентиль: ${(p95 * 100).toFixed(2)} см`);
  console.log(`максимум: ${(max * 100).toFixed(2)} см`);
  console.log(`RTT по замеру клиента: ${predictor.stats.rtt.toFixed(0)} мс`);

  /**
   * Потерянный пакет стоит ровно одного шага ввода: сервер его не увидит,
   * а клиент уже применил. Поэтому поправка такого порядка — это нормальная
   * работа, а не расхождение. Расхождением считается устойчивая ошибка
   * в несколько таких шагов.
   *
   * Мерить надо **по бегу, а не по шагу**: эта проверка полсекунды из каждой
   * бежит, и потеря на бегу стоит в SPRINT_SPEED_SCALE раз дороже. Пока
   * порог считался по скорости ходьбы, каждый второй прогон падал ровно
   * на 13.7 см — это и есть 8.33 × 1.65, цена одной потери на бегу.
   * Проверка ловила собственную модель потерь, а не расхождение.
   */
  const lostInputCost = WALK_SPEED * SPRINT_SPEED_SCALE * INPUT_DT;
  console.log(`цена одного потерянного пакета на бегу: ${(lostInputCost * 100).toFixed(2)} см`);

  const ok = avg < lostInputCost && p95 < lostInputCost * 1.5;
  console.log(ok ? 'OK: предсказание сходится' : 'FAIL: предсказание расходится с сервером');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
