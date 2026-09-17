/**
 * Подготовка виньетки медитации.
 *
 *   npx tsx scripts/prepare-vignette.ts
 *
 * Исходник владельца — готовая виньетка: чёрный цвет и **прозрачность**,
 * густая по краям кадра и сходящая на нет в середине. Всё, что делается
 * здесь, — ужать до разумного размера и перевести в webp.
 *
 * Прозрачность обязательна: без неё это чёрный прямоугольник во весь экран.
 * Просмотрщик рисует такую картинку на белом фоне, и она выглядит как маска
 * «белый центр, чёрные края» — на это легко попасться и начать инвертировать
 * яркость, получив закрашенный экран.
 *
 * Считать то же самое градиентом в CSS было бы дешевле по весу, но форму
 * пятна задаёт рисунок владельца — вытянутый эллипс с мягким краем, — и она
 * не сводится к `radial-gradient` без подгона на глаз.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Vignette_Meditation/Vignette.png';
const OUTPUT = resolve(ROOT, 'packages/client/public/textures/meditation_vignette.webp');

/**
 * Размер картинки. Исходник — 4K, но это мягкий градиент без единой детали:
 * растянутый вчетверо, он неотличим от исходного, а весит копейки.
 */
const WIDTH = 960;
const HEIGHT = 540;

const meta = await sharp(SOURCE).metadata();
if (!meta.hasAlpha) throw new Error('у виньетки нет прозрачности — она закрасит экран');

await sharp(SOURCE)
  .resize(WIDTH, HEIGHT, { fit: 'fill' })
  .webp({ quality: 88, alphaQuality: 100 })
  .toFile(OUTPUT);

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;
console.log(`исходник: ${meta.width}×${meta.height}, ${kilobytes(statSync(SOURCE).size)}`);
console.log(`готово: ${OUTPUT} — ${WIDTH}×${HEIGHT}, ${kilobytes(statSync(OUTPUT).size)}`);
