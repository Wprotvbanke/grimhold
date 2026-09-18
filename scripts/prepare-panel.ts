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
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/bars/bar2.png';
const TARGET = resolve(import.meta.dirname, '../packages/client/public/ui/panel.webp');

const kb = (path: string): string => `${(statSync(path).size / 1024).toFixed(0)} КБ`;
await sharp(SOURCE).webp({ quality: 90, alphaQuality: 100 }).toFile(TARGET);
console.log(`panel.webp: ${kb(SOURCE)} → ${kb(TARGET)}`);

/**
 * Картинки лица в окне панели (`Human_Face_Radar`, 343×342, прозрачные):
 * шесть настроений, какое когда — `client/src/face.ts`. Ужимаются до 256:
 * окно в кадре меньше сотни пикселей.
 */
const FACES = 'C:/Users/Wprot/OneDrive/Рабочий стол/Human_Face_Radar';
const FACE_DIR = resolve(import.meta.dirname, '../packages/client/public/ui/face');
mkdirSync(FACE_DIR, { recursive: true });
const MOODS: Record<string, string> = {
  'Full HP.png': 'full.webp',
  'Start Fight.png': 'fight.webp',
  'Get DMG.png': 'hit.webp',
  'LOW HP.png': 'low.webp',
  'Start Trade.png': 'trade.webp',
  'End Trade.png': 'trade_end.webp',
};
for (const [source, output] of Object.entries(MOODS)) {
  const from = `${FACES}/${source}`;
  const to = resolve(FACE_DIR, output);
  await sharp(from).resize(256, 256, { fit: 'inside' }).webp({ quality: 88, alphaQuality: 100 }).toFile(to);
  console.log(`${output}: ${kb(from)} → ${kb(to)}`);
}
