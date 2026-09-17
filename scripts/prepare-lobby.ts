/**
 * Подготовка задника лобби.
 *
 *   npx tsx scripts/prepare-lobby.ts
 *
 * Картинка владельца — подземный коридор с решёткой в конце; на её фоне
 * стоит выбранный персонаж (см. docs/lobby.md). Это первое, что человек
 * видит после входа, и единственное, что в лобби весит хоть сколько-то,
 * поэтому жмём её крепко: рассматривать камень никто не будет, а ждать
 * загрузки будут все.
 *
 * Полный кадр (1920) вместо 4K намеренно: задник размывается перспективой
 * и лежит за фигурой, деталей в нём не разглядеть даже на большом экране.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Lobby/lobby.png';
const OUTPUT = resolve(ROOT, 'packages/client/public/textures/lobby.webp');

/** Ширина задника. Высота берётся по пропорции исходника. */
const WIDTH = 1920;

const meta = await sharp(SOURCE).metadata();

await sharp(SOURCE)
  .resize(WIDTH, null, { fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 78 })
  .toFile(OUTPUT);

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;
console.log(`исходник: ${meta.width}×${meta.height}, ${kilobytes(statSync(SOURCE).size)}`);
console.log(`готово: ${OUTPUT} — ширина ${WIDTH}, ${kilobytes(statSync(OUTPUT).size)}`);
