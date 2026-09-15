/**
 * Подготовка оружия, которое видно в руке.
 *
 *   npx tsx scripts/prepare-weapon.ts
 *
 * Меч от владельца приезжает сценой музейного качества: 45 тысяч
 * треугольников, тридцать одна сетка и шесть текстур по 1024 — пять мегабайт.
 * В кадре он занимает угол экрана и виден в движении, поэтому здесь его
 * ужимают так же, как короля крыс: сетки сливаются по материалу, геометрия
 * прореживается `simplify`, текстуры идут в webp, вершины — в draco.
 *
 * Ставит модель в руку `client/src/viewmodel.ts`.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  draco,
  flatten,
  join,
  prune,
  simplify,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = 'C:/Users/Wprot/OneDrive/Рабочий стол';

interface WeaponSpec {
  source: string;
  output: string;
  /** Доля треугольников, которую оставляем. */
  simplifyTo: number;
}

const WEAPONS: WeaponSpec[] = [
  {
    source: `${DESKTOP}/sword/moonbrand_early_14th_c_arming_sword.glb`,
    output: 'sword.glb',
    // Десятая часть: клинок — это прямая полоса и крестовина, форму такое
    // прореживание не портит, а в руке он ещё и в движении.
    simplifyTo: 0.1,
  },
];

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

await MeshoptSimplifier.ready;

for (const weapon of WEAPONS) {
  const target = resolve(ROOT, 'packages/client/public/models', weapon.output);
  const document = await io.read(weapon.source);
  const root = document.getRoot();
  const before = root.listMeshes().length;

  /**
   * Клипы выбрасываются: в файле лежит вращение витрины автора, и в руке
   * оно крутило бы меч само по себе.
   */
  for (const animation of root.listAnimations()) animation.dispose();

  /**
   * Музейные подписи — вон.
   *
   * Модель снята для витрины: рядом с клинком висят выноски с размерами
   * и линейка («Overall Length 96 cm»). В руке они уезжают вместе с мечом
   * и болтаются посреди экрана — так и вышло на первом снимке. Узнаются
   * по материалам: сам клинок один, всё остальное — подписи.
   */
  let labels = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial()?.getName() ?? '';
      if (!/annotation|scale_bar/i.test(material)) continue;
      primitive.dispose();
      labels++;
    }
  }
  console.log(`убрано музейных подписей: ${labels}`);

  await document.transform(
    flatten(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: weapon.simplifyTo, error: 0.005 }),
    join(),
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
    draco(),
  );
  await io.write(target, document);

  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      triangles += (primitive.getIndices()?.getCount() ?? 0) / 3;
    }
  }
  console.log(
    `${weapon.output}: ${megabytes(statSync(weapon.source).size)} → ${megabytes(statSync(target).size)}; ` +
      `сеток ${before} → ${root.listMeshes().length}, треугольников ${triangles}`,
  );
}
