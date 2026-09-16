/**
 * Подготовка иконок свитков.
 *
 *   npx tsx scripts/prepare-scrolls.ts
 *
 * Свитков в игре шесть, а рисунка три — по одному на разряд: разрушение,
 * контроль, поддержка. Это не экономия на рисунках, а правило интерфейса:
 * в панели быстрого доступа человек не читает названия, он **узнаёт цвет**.
 * Красный — бьёт, голубой — держит, зелёный — помогает.
 *
 * Свиток занимает одну клетку, а клетка — 42 пикселя, панель — 58. Двойного
 * размера хватает с запасом на любой экран, и это десятки килобайт, а не
 * сотни: вес раздачи мы считаем (см. docs/performance.md).
 *
 * Прозрачность обязательна: белым фоном свиток стал бы наклейкой.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Scrolls';
const OUTPUT = resolve(ROOT, 'packages/client/public/icons');

/** Сторона иконки. Клетка 42, ячейка панели 58 — двойной размер с запасом. */
const SIDE = 128;

/** Файл владельца → имя в игре. Имена разрядов совпадают с `SpellCategory`. */
const SCROLLS: [string, string][] = [
  ['Scroll Damage.png', 'scroll_damage.webp'],
  ['Scroll Control.png', 'scroll_control.webp'],
  ['Scroll Support.png', 'scroll_support.webp'],
];

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

for (const [from, to] of SCROLLS) {
  const source = resolve(SOURCE, from);
  const target = resolve(OUTPUT, to);

  const meta = await sharp(source).metadata();
  if (!meta.hasAlpha) throw new Error(`${from}: нет прозрачности — фон станет наклейкой`);

  await sharp(source)
    .resize(SIDE, SIDE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, alphaQuality: 100 })
    .toFile(target);

  console.log(
    `${from} (${meta.width}×${meta.height}, ${kilobytes(statSync(source).size)})` +
      ` → ${to} — ${SIDE}×${SIDE}, ${kilobytes(statSync(target).size)}`,
  );
}
