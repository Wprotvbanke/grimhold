/**
 * Подготовка источников света: фонарь и костёр.
 *
 *   npx tsx scripts/prepare-lights.ts
 *
 * Два файла из разных мест сводятся в один: и фонарь, и костёр нужны сразу
 * по всему городу, а один запрос с общим сжатием дешевле двух.
 *
 * Сами лампы (`PointLight`) здесь не появляются — они заводятся в коде,
 * см. client/src/lights.ts и docs/light.md. Модель даёт только вид.
 */
import { Document, NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  draco,
  mergeDocuments,
  prune,
  textureCompress,
  transformMesh,
  unpartition,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = 'C:/Users/Wprot/OneDrive/Рабочий стол/lights';
const OUTPUT = resolve(ROOT, 'packages/client/public/models/lights.glb');

/**
 * Что берём из каждого файла.
 *
 * У фонаря в сцене автора лежит ещё и кусок мостовой — в игре он висел бы
 * серым пятном поверх нашей. Берём только сам столб.
 */
const SOURCES = [
  { file: 'stylized_streetlight__free_download.glb', pick: /^Streetlight$/i, name: 'streetlight' },
  { file: 'fogata__bonfire.glb', pick: /^(Tronco|Fuego)/i, name: 'bonfire' },
];

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

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

function parentOf(node: Node): Node | null {
  const parent = node.listParents().find((candidate) => candidate.propertyType === 'Node');
  return (parent as Node | undefined) ?? null;
}

function worldMatrix(node: Node): number[] {
  const chain: Node[] = [];
  for (let current: Node | null = node; current; current = parentOf(current)) chain.unshift(current);
  let matrix = identity();
  for (const link of chain) matrix = multiply(matrix, link.getMatrix() as number[]);
  return matrix;
}

function boundsOf(nodes: Node[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION')!;
      const low = position.getMin([]) as number[];
      const high = position.getMax([]) as number[];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, low[axis]!);
        max[axis] = Math.max(max[axis]!, high[axis]!);
      }
    }
  }
  return { min, max };
}

const target = new Document();
const targetScene = target.createScene('lights');
target.getRoot().setDefaultScene(targetScene);

for (const { file, pick, name } of SOURCES) {
  const source = await io.read(resolve(DESKTOP, file));
  // Что было в документе до слияния — чужое: mergeDocuments возвращает
  // соответствие по узлам исходника, а нам удобнее разница по результату.
  const before = new Set(target.getRoot().listNodes());
  mergeDocuments(target, source);
  const holder = target.createNode(name);

  // Узел с мешем может лежать глубоко в иерархии автора, поэтому сначала
  // запекаем мировую матрицу, а уже потом вынимаем его наружу.
  const taken: Node[] = [];
  for (const node of target.getRoot().listNodes()) {
    if (!node.getMesh() || before.has(node)) continue;
    // Имя смотрим у самого узла и у его прямого родителя: меш лежит в узле
    // вида «Tronco 1_2_0», а осмысленное имя — на уровень выше. Глубже
    // подниматься нельзя: в сцене автора столб и куски мостовой лежат под
    // одним общим родителем, и по цепочке мостовая проходила как фонарь.
    const owner = parentOf(node)?.getName() ?? '';
    if (!pick.test(node.getName()) && !pick.test(owner)) continue;

    const matrix = worldMatrix(node);
    transformMesh(node.getMesh()!, matrix as Parameters<typeof transformMesh>[1]);
    taken.push(node);
  }

  for (const node of taken) {
    for (const parent of node.listParents()) {
      if (parent.propertyType === 'Node') (parent as Node).removeChild(node);
    }
    node.setMatrix(identity() as Parameters<typeof node.setMatrix>[0]);
    holder.addChild(node);
  }

  // Ставим основанием в ноль: клиенту достаточно точки на земле.
  const { min, max } = boundsOf(taken);
  holder.setTranslation([-(min[0]! + max[0]!) / 2, -min[1]!, -(min[2]! + max[2]!) / 2]);
  targetScene.addChild(holder);

  console.log(
    `${name.padEnd(12)} мешей ${taken.length}, ` +
      `${(max[0]! - min[0]!).toFixed(2)} × ${(max[1]! - min[1]!).toFixed(2)} × ` +
      `${(max[2]! - min[2]!).toFixed(2)} м`,
  );

  /**
   * Сцену автора выбрасываем целиком — в ней остались только обрезки
   * подложки. Условие тут однажды стояло наоборот, и скрипт выкидывал **нашу**
   * сцену: файл собирался, весил сколько надо, а узлов `streetlight`
   * и `bonfire` в нём не было вовсе. В игре это выглядело просто как
   * «фонарей нет», без единой ошибки в консоли.
   */
  for (const scene of target.getRoot().listScenes()) {
    if (scene !== targetScene) scene.dispose();
  }
}

await target.transform(
  // Каждый исходник приносит свой буфер, а GLB терпит только один.
  unpartition(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }),
  dedup(),
  prune(),
  draco(),
);

await io.write(OUTPUT, target);
const before = SOURCES.reduce((sum, s) => sum + statSync(resolve(DESKTOP, s.file)).size, 0);
console.log(`\n${megabytes(before)} → ${megabytes(statSync(OUTPUT).size)}`);
