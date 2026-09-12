/**
 * Подготовка обстановки таверны.
 *
 *   npx tsx scripts/prepare-tavern.ts
 *
 * Исходник — готовая сцена таверны на 36 МБ: 210 мешей, из которых почти все
 * повторяются (двадцать бочек, сорок кружек). Нам нужна не сцена автора,
 * а **набор вещей**: по одному образцу каждого вида, который мы расставим
 * сами — см. client/src/props.ts.
 *
 * Каждый образец вынимается из своей иерархии, запекается в начало координат
 * основанием на ноль и получает понятное имя. Дальше клиенту достаточно
 * сказать «поставь сюда стол».
 */
import { NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, textureCompress, transformMesh } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const INPUT = 'C:/Users/Wprot/OneDrive/Рабочий стол/Taverna Low Poly/environment_taverna_low_poly_gameready_assets.glb';
const OUTPUT = resolve(ROOT, 'packages/client/public/models/tavern_props.glb');

/**
 * Что берём и как это будет называться у нас.
 *
 * Имена в исходнике — следы работы автора (`Cheer23_lowLow004`, `Box192_low`),
 * по ним ничего не понять. Ключ — начало имени узла, значение — наше имя.
 * Берётся первый попавшийся узел с таким началом: копии в паке одинаковые.
 */
const WANTED: Record<string, string> = {
  Cube070_low: 'table_long',
  Table3_1_low: 'table_round',
  Table3_16_low: 'bench',
  Cube050_low: 'counter',
  Cheer31_low: 'chair',
  Cheer23_low: 'stool',
  Barrel1_low: 'barrel',
  Barrel2_low: 'barrel_small',
  Barrel3_low: 'barrel_big',
  Box192_low: 'crate',
  locker004_low: 'cupboard',
  locker012_low: 'shelf',
  locker018_low: 'sideboard',
  WoodCup1_low: 'tankard',
  WoodCup4_low: 'cup',
  WoodCup5_low: 'bowl',
  WoodCup7_low: 'jug',
  WoodCup8_low: 'plate',
  Balks1_3_low: 'beam',
  Balks1_9_low: 'post',
  Tros1_low: 'rope',
  Book1_low: 'book',
  Door1_low: 'door',
};

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(INPUT);
const root = document.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0]!;

/** Мировая матрица узла: в паке вещи лежат внутри иерархии сцены автора. */
function worldMatrix(node: Node): number[] {
  const chain: Node[] = [];
  for (let current: Node | null = node; current; current = parentOf(current)) chain.unshift(current);

  let matrix = identity();
  for (const link of chain) matrix = multiply(matrix, link.getMatrix() as number[]);
  return matrix;
}

function parentOf(node: Node): Node | null {
  const parent = node.listParents().find((candidate) => candidate.propertyType === 'Node');
  return (parent as Node | undefined) ?? null;
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Умножение матриц 4×4 в порядке хранения glTF (по столбцам). */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function translation(x: number, y: number, z: number): number[] {
  const matrix = identity();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

/** Габариты меша после запекания: минимумы и максимумы по осям. */
function bounds(node: Node): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of node.getMesh()!.listPrimitives()) {
    const position = primitive.getAttribute('POSITION')!;
    const low = position.getMin([]) as number[];
    const high = position.getMax([]) as number[];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, low[axis]!);
      max[axis] = Math.max(max[axis]!, high[axis]!);
    }
  }
  return { min, max };
}

const picked = new Map<string, Node>();
for (const node of root.listNodes()) {
  if (!node.getMesh()) continue;
  for (const [prefix, name] of Object.entries(WANTED)) {
    if (picked.has(name)) continue;
    if (!node.getName().startsWith(prefix)) continue;
    picked.set(name, node);
  }
}

const missing = Object.values(WANTED).filter((name) => !picked.has(name));
if (missing.length > 0) console.warn('не нашлось в паке:', missing.join(', '));

// Сначала считаем матрицы, и только потом рвём иерархию: после переноса
// в корень родителей уже не спросишь.
const baked = [...picked].map(([name, node]) => ({ name, node, matrix: worldMatrix(node) }));

for (const { name, node, matrix } of baked) {
  transformMesh(node.getMesh()!, matrix as Parameters<typeof transformMesh>[1]);

  // Ставим основанием в ноль и центрируем по горизонтали: клиенту тогда
  // достаточно точки на полу, а высоту и середину он не ищет.
  const { min, max } = bounds(node);
  transformMesh(
    node.getMesh()!,
    translation(-(min[0]! + max[0]!) / 2, -min[1]!, -(min[2]! + max[2]!) / 2) as Parameters<
      typeof transformMesh
    >[1],
  );

  for (const parent of node.listParents()) {
    if (parent.propertyType === 'Node') (parent as Node).removeChild(node);
  }
  node.setMatrix(identity() as Parameters<typeof node.setMatrix>[0]);
  node.setName(name);
  scene.addChild(node);

  const size = bounds(node);
  console.log(
    `${name.padEnd(14)} ${(size.max[0]! - size.min[0]!).toFixed(2)} × ` +
      `${(size.max[1]! - size.min[1]!).toFixed(2)} × ${(size.max[2]! - size.min[2]!).toFixed(2)} м`,
  );
}

// Всё, что не отобрали, выбрасываем: это копии копий из сцены автора.
const keep = new Set(baked.map((entry) => entry.node));
for (const node of scene.listChildren()) {
  if (!keep.has(node)) node.dispose();
}

console.log(`\nисходник: ${megabytes(statSync(INPUT).size)}, текстур ${root.listTextures().length}`);

await document.transform(
  // Текстуры в паке по 1024² на каждый материал. Обстановку видно в полумраке
  // и вблизи, но не настолько вблизи, чтобы различать пиксели досок.
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }),
  dedup(),
  prune(),
  draco(),
);

await io.write(OUTPUT, document);
console.log(
  `результат: ${megabytes(statSync(OUTPUT).size)}, вещей ${picked.size}, ` +
    `текстур ${root.listTextures().length}`,
);
