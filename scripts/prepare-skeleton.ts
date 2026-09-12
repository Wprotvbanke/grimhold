/**
 * Подготовка модели скелета к вебу.
 *
 *   npx tsx scripts/prepare-skeleton.ts
 *
 * Исходник — сцена из Sketchfab, в которой лежат сразу две модели: тяжёлая
 * статичная россыпь костей на 401 тысячу треугольников и настоящий скелет
 * со скином, костями и анимацией — всего на 6.8 тысячи. В игру идёт только
 * второй: он в шестьдесят раз легче и умеет двигаться.
 *
 * Поэтому скрипт сначала выбрасывает всё, что не привязано к скелету,
 * а потом жмёт остаток Draco. Упрощать здесь уже нечего — модель и так
 * игровой плотности.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const INPUT = resolve(ROOT, 'assets/source/skeleton2_raw.glb');
const OUTPUT = resolve(ROOT, 'packages/client/public/models/skeleton_human.glb');

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(INPUT);
const root = document.getRoot();

function countTriangles(): number {
  let total = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      total += indices ? indices.getCount() / 3 : 0;
    }
  }
  return Math.round(total);
}

console.log(`исходник: ${countTriangles()} треугольников, ${megabytes(statSync(INPUT).size)}`);

// Своя анимация модели в игру не идёт: скелет в ней вскидывается из глубокого
// наклона, и ни на ходьбу, ни на удар это не похоже. Ходьба переносится с рига
// Mixamo, удар собирается на месте — см. client/src/retarget.ts.
for (const animation of root.listAnimations()) animation.dispose();

// Всё, что не привязано к скелету, — это вторая, статичная модель из той же
// сцены. Она не анимируется и весит почти весь файл.
let dropped = 0;
for (const node of root.listNodes()) {
  if (node.getMesh() === null || node.getSkin() !== null) continue;
  dropped++;
  node.setMesh(null);
}
console.log(`выброшено мешей без скелета: ${dropped}`);

await document.transform(dedup(), prune(), draco());
await io.write(OUTPUT, document);

const skin = root.listSkins()[0];
console.log(
  `результат: ${countTriangles()} треугольников, ${megabytes(statSync(OUTPUT).size)}, ` +
    `костей ${skin ? skin.listJoints().length : 0}, ` +
    `анимаций ${root.listAnimations().length} (они не нужны)`,
);
