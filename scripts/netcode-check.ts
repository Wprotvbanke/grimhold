/**
 * Проверка предсказания и реконсилиации против живого сервера.
 * Гоняет настоящий Predictor клиента, добавляя искусственную задержку и потери,
 * и меряет, насколько сервер поправляет предсказанную позицию.
 *
 *   npx tsx scripts/netcode-check.ts [задержка_мс] [секунд]
 */
import { ChunkedWorld, INPUT_DT, RACES, SPAWN_POINT, WALK_SPEED } from '@grimhold/shared';
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
   * а клиент уже применил. Поэтому поправка порядка WALK_SPEED * INPUT_DT
   * (около 8 см на ходу) — это нормальная работа, а не расхождение.
   * Расхождением считается устойчивая ошибка в несколько таких шагов.
   */
  const lostInputCost = WALK_SPEED * INPUT_DT;
  console.log(`цена одного потерянного пакета: ${(lostInputCost * 100).toFixed(2)} см`);

  const ok = avg < lostInputCost && p95 < lostInputCost * 1.5;
  console.log(ok ? 'OK: предсказание сходится' : 'FAIL: предсказание расходится с сервером');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});
