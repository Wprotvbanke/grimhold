/**
 * Подготовка луны.
 *
 *   npx tsx scripts/prepare-moon.ts
 *
 * Модель от владельца — шар с картой поверхности. В небе она висит в сотне
 * метров и размером с ноготь, поэтому от исходника оставляем только то,
 * что на таком расстоянии видно: цветовую карту и саму сферу.
 *
 * Ставит её на небо `client/src/sky.ts`.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/moon/moon.glb';
const TARGET = resolve(ROOT, 'packages/client/public/models/moon.glb');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(SOURCE);
const root = document.getRoot();

/**
 * Рельеф и блики снимаем.
 *
 * Луна на небе — светящийся кружок: шейдерного рельефа на ней не разглядеть,
 * а свет на неё всё равно не падает (материал в игре заменяется на
 * несветочувствительный). Три карты по мегабайту ради этого не нужны.
 */
for (const material of root.listMaterials()) {
  material.setNormalTexture(null);
  material.setMetallicRoughnessTexture(null);
  material.setOcclusionTexture(null);
  material.setEmissiveTexture(null);
}

await document.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
  draco(),
);

await io.write(TARGET, document);
console.log(
  `готово: moon.glb, ${(statSync(TARGET).size / 1024).toFixed(0)} КБ ` +
    `(было ${(statSync(SOURCE).size / 1024).toFixed(0)} КБ)`,
);
