/**
 * Подготовка мешка с добычей.
 *
 *   npx tsx scripts/prepare-bag.ts
 *
 * Мешок лежит на земле после каждого убитого зверя, и в кадре их бывает
 * несколько сразу. Поэтому он ужимается как всё массовое: текстуры в webp,
 * геометрия — Draco.
 *
 * Исходник уже в GLB, разбирать FBX не нужно — только сжать и поставить
 * основанием в ноль: сервер присылает точку на полу, а не центр модели.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/bag/adventure_bag.glb';
const OUTPUT = resolve(ROOT, 'packages/client/public/models/loot_bag.glb');

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(SOURCE);
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

console.log(`исходник: ${countTriangles()} треугольников, ${kilobytes(statSync(SOURCE).size)}`);
console.log(
  `текстуры: ${root
    .listTextures()
    .map((texture) => `${texture.getMimeType()} ${kilobytes(texture.getImage()?.byteLength ?? 0)}`)
    .join(', ') || 'нет'}`,
);

// Анимаций у мешка нет и быть не должно: он лежит. Если приехали — выбрасываем,
// каждый клип весит как нужный.
for (const animation of root.listAnimations()) animation.dispose();

/**
 * Выбрасываем чужую сцену.
 *
 * Вместе с мешком приехали подстилка под ним и три светящихся квадрата —
 * то, чем автор подавал модель на витрине. В игре подстилка ложится поверх
 * мостовой чужой заплатой, а «светлячки» висят в воздухе и ничего не освещают:
 * это меши, а не свет.
 *
 * Правило то же, что у остальных паков: оставляем только саму вещь.
 */
const EXTRA = /ground|light/i;
let dropped = 0;

for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || !EXTRA.test(mesh.getName())) continue;
  node.setMesh(null);
  dropped++;
}
console.log(`выброшено лишних кусков сцены: ${dropped}`);

await document.transform(
  dedup(),
  prune(),
  // Половина размера в текстурах: мешок в кадре размером с ладонь, и 2048
  // на него — это вчетверо больше, чем видно.
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
  draco(),
);
await io.write(OUTPUT, document);

console.log(`готово: ${OUTPUT} — ${kilobytes(statSync(OUTPUT).size)}`);
