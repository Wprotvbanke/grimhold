/**
 * Панель внизу экрана — картинка владельца (`bars/bar2.png`).
 *
 *   npx tsx scripts/prepare-panel.ts
 *
 * PNG в 300 КБ переводится в webp без потери вырезов: окно портрета и три
 * щели полосок в картинке **прозрачные**, и по ним раскладка в index.html
 * и меряется — см. docs/panel.md. Размер не трогаем: раскладка задана
 * в долях картинки, а не в пикселях, но резкость камня при ужатии уходит.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/bars/bar2.png';
const TARGET = resolve(import.meta.dirname, '../packages/client/public/ui/panel.webp');

await sharp(SOURCE).webp({ quality: 90, alphaQuality: 100 }).toFile(TARGET);
const kb = (path: string): string => `${(statSync(path).size / 1024).toFixed(0)} КБ`;
console.log(`panel.webp: ${kb(SOURCE)} → ${kb(TARGET)}`);
