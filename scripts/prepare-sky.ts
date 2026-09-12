/**
 * Извлечение панорамы неба.
 *
 *   npx tsx scripts/prepare-sky.ts
 *
 * В исходнике небо приехало моделью — куполом с натянутой картинкой. Сам
 * купол нам не нужен: своих двух с половиной тысяч треугольников он не стоит,
 * а геометрию неба мы строим сами (client/src/sky.ts). Нужна только картинка,
 * и она равнопромежуточная — ложится на сферу без швов.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const INPUT = 'C:/Users/Wprot/OneDrive/Рабочий стол/sky/fantasy_sky_background.glb';
const OUTPUT = resolve(ROOT, 'packages/client/public/textures/sky.webp');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(INPUT);
const texture = document.getRoot().listTextures()[0];
if (!texture) throw new Error('в модели неба нет ни одной текстуры');

const [width, height] = texture.getSize() ?? [0, 0];
console.log(`исходная картинка: ${width}×${height}, ${texture.getMimeType()}`);
if (width !== height * 2) {
  console.warn('соотношение не 2:1 — на сфере будет шов или растяжение');
}

// Небо всегда вдали и всегда в дымке: качество можно не беречь, а вес — да.
const webp = await sharp(Buffer.from(texture.getImage()!)).webp({ quality: 82 }).toBuffer();
writeFileSync(OUTPUT, webp);

console.log(`результат: ${OUTPUT.split(/[\/]/).pop()}, ${(statSync(OUTPUT).size / 1024).toFixed(0)} КБ`);
