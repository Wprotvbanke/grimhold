/**
 * Подготовка полос жизни, стамины и маны.
 *
 *   npx tsx scripts/prepare-bars.ts
 *
 * Владелец прислал три клинка: каждый заполнен наполовину — слева цвет,
 * справа пустой жёлоб. Для игры нужен **полный** клинок: пустоту рисует
 * сам интерфейс, затемняя правую часть по остатку (см. index.html).
 *
 * Поэтому цветное тело растягивается на всю длину: берём узкую полоску
 * из середины заливки и повторяем её до правого острия. Полоса однородная
 * вдоль — шва не видно, а рисунок клинка и оба острия остаются авторскими.
 *
 * Иначе пришлось бы просить у владельца по два кадра на полосу — полный
 * и пустой, — а это работа там, где хватает одного.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/bars';
const OUTPUT = resolve(ROOT, 'packages/client/public/textures');

const BARS: [string, string][] = [
  ['Hp_bar.png', 'bar_health.webp'],
  ['Stamina_Bar.png', 'bar_stamina.webp'],
  ['Mana_Bar.png', 'bar_mana.webp'],
];

/**
 * Где кончается заливка.
 *
 * Идём слева и ищем место, после которого цвет **перестаёт быть цветом**:
 * у заливки насыщенность под единицу, у пустого жёлоба — четверть.
 * Смотрим не отдельный столбец, а пробег подряд: у правого острия есть
 * красноватый блик, и по одному столбцу граница находилась там — заливка
 * «кончалась» у самого конца полосы, и растягивалась пустота.
 */
async function fillEnd(file: string, width: number, height: number): Promise<number> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const row = Math.floor(height / 2);

  /**
   * Насколько столбец «горит»: насыщенность на светлоту.
   *
   * Ни то ни другое по отдельности не годится. По насыщенности пустая часть
   * золотого клинка не отличается от залитой — жёлоб там тоже жёлтый;
   * по светлоте не отличается тёмно-красная заливка жизни. Вместе — отличают.
   */
  const glow = (x: number): number => {
    const at = (row * info.width + x) * info.channels;
    if (data[at + 3]! < 128) return 0;
    const max = Math.max(data[at]!, data[at + 1]!, data[at + 2]!);
    const min = Math.min(data[at]!, data[at + 1]!, data[at + 2]!);
    return max === 0 ? 0 : ((max - min) / max) * max;
  };

  /**
   * Граница — **место наибольшего спада**, а не порог.
   *
   * Порогом это не решается: клинки разной яркости, у жизни заливка
   * тёмно-красная и местами тусклее, чем золото пустого жёлоба стамины.
   * Любое число подошло бы одному клинку и соврало на другом, а ошибка
   * тихая — растянется пустая часть вместо цветной, и полоса выйдет серой.
   *
   * Зато спад виден у всех троих: слева от границы свечение в разы выше,
   * чем справа. Сравниваем средние по окну с обеих сторон и берём точку,
   * где разница наибольшая.
   */
  const window = Math.max(6, Math.round(width * 0.03));
  const mean = (from: number, to: number): number => {
    let sum = 0;
    let count = 0;
    for (let x = Math.max(0, from); x < Math.min(width, to); x++) {
      sum += glow(x);
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  };

  let fall = 0;
  let at = width;
  // Края не трогаем: там острия, и на них спад найдётся всегда.
  for (let x = window * 2; x < width - window * 2; x++) {
    const drop = mean(x - window, x) - mean(x, x + window);
    if (drop > fall) {
      fall = drop;
      at = x;
    }
  }
  return at;
}

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

for (const [from, to] of BARS) {
  const source = resolve(SOURCE, from);
  const target = resolve(OUTPUT, to);
  const meta = await sharp(source).metadata();
  const width = meta.width!;
  const height = meta.height!;

  const end = await fillEnd(source, width, height);
  if (end < width * 0.2) throw new Error(`${from}: не нашёл заливку`);

  /**
   * Полоска-образец берётся из середины заливки, подальше от острия:
   * у самого острия клинок сужается, и растянутое остриё дало бы клин
   * во всю длину.
   */
  const sampleWidth = Math.max(8, Math.round(width * 0.04));
  const sampleLeft = Math.round(end * 0.55);
  // Сколько заливки оставляем авторской слева: остриё и начало тела.
  const keep = Math.round(end * 0.5);
  /**
   * Правое остриё остаётся авторским.
   *
   * Первый раз растягивали до самого края — и клинок кончался обрубком:
   * остриё затиралось телом. Оно у всех трёх примерно в двадцатую часть
   * длины.
   */
  const tip = Math.max(10, Math.round(width * 0.05));
  const stretch = width - keep - tip;

  const body = await sharp(source)
    .extract({ left: sampleLeft, top: 0, width: sampleWidth, height })
    .resize(stretch, height, { fit: 'fill' })
    .toBuffer();

  await sharp(source)
    .composite([{ input: body, left: keep, top: 0 }])
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(target);

  console.log(
    `${from} (${width}×${height}, ${kilobytes(statSync(source).size)}) → ${to}:` +
      ` заливка до ${end}, растянута с ${keep}, ${kilobytes(statSync(target).size)}`,
  );
}
