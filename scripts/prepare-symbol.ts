/**
 * Подготовка знака выхода из подземелья.
 *
 *   npx tsx scripts/prepare-symbol.ts
 *
 * Исходник — рисунок с прозрачным фоном; в игре он лежит краской на полу
 * у ниши с порталом. Всё, что здесь делается, — ужать до разумного размера
 * и перевести в webp: знак рисуется одним прозрачным прямоугольником, и
 * мелкие детали на нём всё равно не разглядеть.
 *
 * Прозрачность обязательна: белым фоном знак превратился бы в табличку.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/symbol/Exit_symbol.png';
const OUTPUT = resolve(ROOT, 'packages/client/public/textures/exit_symbol.webp');

/** Размер стороны. Знак на полу — это пятно в несколько метров, не плакат. */
const SIDE = 512;

const source = await sharp(SOURCE).metadata();
if (!source.hasAlpha) throw new Error('у рисунка нет прозрачности — фон станет табличкой');

await sharp(SOURCE)
  .resize(SIDE, SIDE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .webp({ quality: 90, alphaQuality: 100 })
  .toFile(OUTPUT);

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;
console.log(`исходник: ${source.width}×${source.height}, ${kilobytes(statSync(SOURCE).size)}`);
console.log(`готово: ${OUTPUT} — ${SIDE}×${SIDE}, ${kilobytes(statSync(OUTPUT).size)}`);
