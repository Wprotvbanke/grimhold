/**
 * Карты рельефа и шероховатости для поверхностей мира.
 *
 *   npx tsx scripts/prepare-surfaces.ts
 *
 * Цветовые карты камня, мостовой, земли, скалы и досок взяты с Poly Haven
 * давно, а рельефа у них не было: кладка выглядела нарисованной на плоскости.
 * Скрипт берёт у того же ассета ещё две карты:
 *
 * - **нормали** в соглашении OpenGL (`nor_gl`) — его ждёт three;
 * - **ARM** — в одной картинке три карты по каналам: затенение в щелях (R),
 *   шероховатость (G), металличность (B). three читает затенение и
 *   шероховатость ровно из этих каналов, поэтому одна картинка вместо двух.
 *
 * Разрешение 1K, как у цветовых карт: тайл в два с половиной метра, и больше
 * пикселей на нём не разглядеть. Пережимаются в webp — нормали в jpg весят
 * под мегабайт каждая.
 *
 * Прежде чем качать, скрипт сверяет цветовую карту ассета с нашей по md5:
 * рельеф от чужой картинки лёг бы камнями мимо камней.
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TEXTURES = resolve(ROOT, 'packages/client/public/textures');

/** Наш файл → ассет Poly Haven. См. public/textures/LICENSE.txt. */
const SURFACES: Record<string, string> = {
  pavement: 'cobblestone_floor_04',
  ground: 'forrest_ground_01',
  stone: 'medieval_blocks_02',
  rock: 'rock_face_03',
  // Id досок нигде не был записан — нашёлся сверкой md5 по всем деревянным
  // текстурам Poly Haven.
  planks: 'dark_planks',
};

interface PolyFile {
  url: string;
  md5: string;
  size: number;
}

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;
const md5 = (bytes: Buffer | Uint8Array): string => createHash('md5').update(bytes).digest('hex');

async function download(file: PolyFile): Promise<Buffer> {
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (md5(bytes) !== file.md5) throw new Error(`${file.url}: md5 не сошёлся`);
  return bytes;
}

for (const [name, asset] of Object.entries(SURFACES)) {
  const response = await fetch(`https://api.polyhaven.com/files/${asset}`);
  const files = (await response.json()) as Record<string, Record<string, { jpg: PolyFile }>>;
  const pick = (map: string): PolyFile => {
    const file = files[map]?.['1k']?.jpg;
    if (!file) throw new Error(`${asset}: нет карты ${map} в 1K`);
    return file;
  };

  const ours = md5(readFileSync(resolve(TEXTURES, `${name}.jpg`)));
  if (ours !== pick('Diffuse').md5) {
    throw new Error(`${name}.jpg не совпадает с цветовой картой ${asset} — рельеф ляжет мимо`);
  }

  const outputs: [string, Buffer, number][] = [
    [`${name}_normal.webp`, await download(pick('nor_gl')), 92],
    [`${name}_arm.webp`, await download(pick('arm')), 88],
  ];

  for (const [file, source, quality] of outputs) {
    const target = resolve(TEXTURES, file);
    writeFileSync(target, await sharp(source).webp({ quality }).toBuffer());
    console.log(`${file}: ${kilobytes(source.byteLength)} jpg → ${kilobytes(statSync(target).size)}`);
  }
}
