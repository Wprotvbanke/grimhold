/**
 * Проверка, что из города действительно можно выйти в дикие земли,
 * и что чанки за воротами существуют (игрок не проваливается в пустоту).
 */
import { CHUNK_SIZE, INPUT_DT, TICK_RATE, WORLD_CHUNK_RADIUS } from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

/** Сервер обрабатывает не больше MAX_INPUTS_PER_TICK за тик, поэтому не спамим. */
const INPUTS_PER_BATCH = 8;
const BATCH_PAUSE_MS = 1000 / TICK_RATE;

async function main(): Promise<void> {
  const client = new TestClient({ username: `Ходок${Date.now().toString(36)}` });
  await client.ready;
  await sleep(200);

  const start = client.latestSnapshot?.self;
  console.log(`старт: z=${start?.z.toFixed(2)}`);

  let seq = 0;
  const marks: number[] = [];

  // Идём строго на север (yaw = 0 → движение в -Z), прямо в створ ворот.
  for (let batch = 0; batch < 90; batch++) {
    for (let i = 0; i < INPUTS_PER_BATCH; i++) {
      client.send({
        t: 'input',
        seq: seq++,
        forward: 1,
        right: 0,
        yaw: 0,
        pitch: 0,
        jump: false,
        dt: INPUT_DT,
      });
    }
    await sleep(BATCH_PAUSE_MS);
    const self = client.latestSnapshot?.self;
    if (self) marks.push(self.z);
  }

  await sleep(300);
  const final = client.latestSnapshot?.self;
  const z = final?.z ?? 0;
  const y = final?.y ?? 0;
  const edge = (WORLD_CHUNK_RADIUS + 0.5) * CHUNK_SIZE;

  console.log(`финал: z=${z.toFixed(2)} y=${y.toFixed(2)}`);
  console.log(`граница мира: z=${(-edge).toFixed(0)}`);

  const leftTown = z < -31;
  const onGround = Math.abs(y) < 0.5;
  const insideWorld = z > -edge - 1;

  console.log(leftTown ? 'OK: вышел за городскую стену через ворота' : `FAIL: застрял в городе на z=${z.toFixed(2)}`);
  console.log(onGround ? 'OK: земля за воротами есть, не провалился' : `FAIL: провалился, y=${y.toFixed(2)}`);
  console.log(insideWorld ? 'OK: граница мира держит' : 'FAIL: улетел за край мира');

  client.close();
  process.exit(leftTown && onGround && insideWorld ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка:', error);
  process.exit(1);
});
