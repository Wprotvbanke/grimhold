/**
 * Подготовка зданий площади: ратуша и городской дом.
 *
 *   npx tsx scripts/prepare-town.ts
 *
 * Обе модели от владельца (выгрузки Sketchfab), уже в метрах и основанием
 * на нуле, фасадом с дверью в +Z. Но в игру как есть не годятся:
 *
 * - **ратуша** нарисована материалом без освещения (`KHR_materials_unlit`):
 *   ни ночь, ни огонь фонаря на неё не действовали бы, она светилась бы
 *   ровно, как вывеска. Расширение снимается — материал становится обычным;
 * - **дом** — 418 отдельных сеток, то есть 418 вызовов отрисовки на одно
 *   здание. Сливаем по материалу: их три;
 * - текстуры: у дома девять по 1024 на 9.7 МБ, у ратуши одна 2048. Всё
 *   в webp не больше 1024.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { dedup, draco, flatten, join, prune, textureCompress, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Town';
const OUTPUT = resolve(ROOT, 'packages/client/public/models');

const MODELS: { source: string; output: string }[] = [
  { source: 'low_poly_town_hall (1).glb', output: 'town_hall.glb' },
  { source: 'townhouse_3_now_with_dust.glb', output: 'townhouse.glb' },
];

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

for (const { source, output } of MODELS) {
  const input = `${SOURCE}/${source}`;
  const target = resolve(OUTPUT, output);
  const document = await io.read(input);
  const root = document.getRoot();
  const before = root.listMeshes().length;

  // Материал без освещения — снимаем расширение, материал остаётся обычным.
  // Блеск металла у штукатурки и черепицы не нужен: матовые, как всё в городе.
  const unlit = root.listExtensionsUsed().find((extension) => extension.extensionName === KHRMaterialsUnlit.EXTENSION_NAME);
  if (unlit) {
    unlit.dispose();
    for (const material of root.listMaterials()) {
      material.setMetallicFactor(0);
      material.setRoughnessFactor(0.9);
    }
  }

  await document.transform(
    // Иерархия автора ни к чему: здание целиком стоит на месте.
    flatten(),
    weld(),
    // Сетки с одним материалом — в одну: вызов отрисовки на материал, а не на доску.
    join(),
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
    draco(),
  );
  await io.write(target, document);

  console.log(
    `${output}: ${megabytes(statSync(input).size)} → ${megabytes(statSync(target).size)}; ` +
      `сеток ${before} → ${root.listMeshes().length}, материалов ${root.listMaterials().length}` +
      (unlit ? '; снят материал без освещения' : ''),
  );
}
