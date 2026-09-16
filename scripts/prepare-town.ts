/**
 * Подготовка зданий площади: ратуша и городской дом.
 *
 *   npx tsx scripts/prepare-town.ts
 *
 * Обе модели от владельца (выгрузки Sketchfab), уже в метрах и основанием
 * на нуле, фасадом с дверью в +Z. Но в игру как есть не годятся:
 *
 * - **ратуша** нарисована материалом без освещения (`KHR_materials_unlit`):
 *   ни ночь, ни огонь фонаря на неё не действовали бы, она светилась бы
 *   ровно, как вывеска. Расширение снимается — материал становится обычным;
 * - **дом** — 418 отдельных сеток, то есть 418 вызовов отрисовки на одно
 *   здание. Сливаем по материалу: их три;
 * - текстуры: у дома девять по 1024 на 9.7 МБ, у ратуши одна 2048. Всё
 *   в webp не больше 1024.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { dedup, draco, flatten, getBounds, join, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Town';
const OUTPUT = resolve(ROOT, 'packages/client/public/models');

const DESKTOP = 'C:/Users/Wprot/OneDrive/Рабочий стол';

/**
 * `normalize` — привести модель к нашим правилам прямо в файле: основанием
 * на ноль, серединой пятна в начало координат, в нужный размер. Выгрузки
 * приходят то висящими в воздухе, то наполовину под землёй, то в сотнях
 * единиц — и лучше один раз исправить файл, чем помнить поправку в коде.
 * `scale` — множитель, `height` — целевая высота в метрах (перебивает `scale`).
 */
interface ModelSpec {
  source: string;
  output: string;
  normalize?: { scale?: number; height?: number };
  /**
   * Не сливать сетки по материалу. Нужно, когда части берутся по имени:
   * в стенах обе створки ворот на одном материале, и слияние склеило бы их
   * в одну — распахнуть было бы нечего.
   */
  keepParts?: boolean;
  /**
   * Цвет материалам, у которых нет цветовой текстуры. У одного дома в
   * выгрузке пришли только рельеф и затенение — без этого он белый, как гипс.
   */
  tint?: [number, number, number];
  /**
   * С анимацией: иерархию не плющить и сетки не сливать. Кости и узлы,
   * которые двигает клип, живут в своей иерархии — сплющи её, и крыса
   * поедет без скелета, а крышка люка перестанет открываться.
   */
  animated?: boolean;
  /** Доля треугольников, которую оставить (meshoptimizer). */
  simplifyTo?: number;
  /**
   * Допустимая ошибка прореживания, доля размера модели.
   *
   * По умолчанию сотая: она держит силуэт, но у плотной геометрии
   * не даёт срезать почти ничего — часовня с ней теряла один процент
   * из тридцати пяти обещанных.
   */
  simplifyError?: number;
  /**
   * Сторона текстуры в пикселях. По умолчанию 512.
   *
   * Тысяча на двадцать домов — это мегабайты по сети и сотни мегабайт
   * в видеопамяти: картинки распаковываются там несжатыми. Дома видно
   * с трёх метров и в сумерках, и разницы между 1024 и 512 на них
   * не различить — проверено снимком.
   */
  texture?: number;
}

const HOUSES = `${DESKTOP}/houses`;

const MODELS: ModelSpec[] = [
  { source: `${SOURCE}/low_poly_town_hall (1).glb`, output: 'town_hall.glb' },
  { source: `${SOURCE}/townhouse_3_now_with_dust.glb`, output: 'townhouse.glb' },
  // Казна: каменный ларец. Середина в нуле, половина под землёй — поднимаем;
  // чуть больше исходника, чтобы читался на площади.
  { source: `${DESKTOP}/bank/bank.glb`, output: 'bank.glb', normalize: { scale: 1.1 } },
  // Городские стены: вышка, пролёт, арка и две створки — части ставит houses.ts
  // по именам, поэтому не сливаются.
  { source: `${DESKTOP}/walls/walls.glb`, output: 'walls.glb', keepParts: true },

  // Дома улиц. Все основанием на ноль и серединой в начало координат.
  // Таверна пришла вдвое крупнее жизни — этаж в семь метров; ужата до трёх с половиной.
  { source: `${HOUSES}/house5_towern.glb`, output: 'tavern.glb', normalize: { scale: 0.5 } },
  // Часовня пришла в сотнях единиц и на десять метров под землёй: 73 м высоты.
  // Часовня пришла с 83 тысячами треугольников — вчетверо больше соседних
  // домов при том же силуэте. Прореживаем: издали она читается кровлей
  // и башней, а не гранями.
  { source: `${HOUSES}/house3.glb`, output: 'chapel.glb', normalize: { height: 12 }, simplifyTo: 0.35, simplifyError: 0.05 },
  { source: `${HOUSES}/house4.glb`, output: 'house_narrow.glb', normalize: {} },
  { source: `${HOUSES}/house_Triangle.glb`, output: 'house_gable.glb', normalize: {} },
  { source: `${HOUSES}/house_tiny.glb`, output: 'house_tiny.glb', normalize: {} },
  // Повозка висела в четырёх метрах над землёй и в шести сбоку от начала.
  { source: `${HOUSES}/shop_on_wheels.glb`, output: 'wagon.glb', normalize: {} },

  // Люк в подземелье за лавкой на колёсах: крышка открывается клипом.
  { source: `${DESKTOP}/Trapdoor/trapdoor.glb`, output: 'trapdoor.glb', normalize: {}, animated: true },
  // Туман из люка: пять полупрозрачных слоёв в 7 м шириной. Размер и высоту
  // над рамой задаёт houses.ts, слои кружит там же — клип в модели почти стоит.
  { source: `${DESKTOP}/fog/new-fog.glb`, output: 'trapdoor_fog.glb', keepParts: true },
  // Король крыс — облик хозяина глубины. 130 тысяч треугольников на одного
  // моба — в пять раз больше, чем нужно в полумраке зала. Размер задаёт игра
  // по росту босса (MOBS), здесь не трогаем.
  { source: `${DESKTOP}/Rat_Boss/rat.glb`, output: 'rat_king.glb', animated: true, simplifyTo: 0.2 },
];

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

await MeshoptSimplifier.ready;

for (const {
  source,
  output,
  normalize,
  keepParts,
  tint,
  animated,
  simplifyTo,
  simplifyError,
  texture,
} of MODELS) {
  const input = source;
  const target = resolve(OUTPUT, output);
  const document = await io.read(input);
  const root = document.getRoot();
  const before = root.listMeshes().length;

  if (normalize) {
    // Всё содержимое сцены — под один узел со сдвигом и масштабом; дальше
    // `flatten` раскладывает его по сеткам, и файл уже стоит как надо.
    const scene = root.listScenes()[0]!;
    const bounds = getBounds(scene);
    const scale = normalize.height
      ? normalize.height / (bounds.max[1] - bounds.min[1])
      : (normalize.scale ?? 1);
    const pivot = document
      .createNode('pivot')
      .setScale([scale, scale, scale])
      .setTranslation([
        (-(bounds.min[0] + bounds.max[0]) / 2) * scale,
        -bounds.min[1] * scale,
        (-(bounds.min[2] + bounds.max[2]) / 2) * scale,
      ]);
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      pivot.addChild(child);
    }
    scene.addChild(pivot);
  }

  if (tint) {
    for (const material of root.listMaterials()) {
      if (!material.getBaseColorTexture()) material.setBaseColorFactor([...tint, 1]);
    }
  }

  // Материал без освещения — снимаем расширение, материал остаётся обычным.
  // Блеск металла у штукатурки и черепицы не нужен: матовые, как всё в городе.
  const unlit = root.listExtensionsUsed().find((extension) => extension.extensionName === KHRMaterialsUnlit.EXTENSION_NAME);
  if (unlit) {
    unlit.dispose();
    for (const material of root.listMaterials()) {
      material.setMetallicFactor(0);
      material.setRoughnessFactor(0.9);
    }
  }

  await document.transform(
    // Иерархия автора ни к чему: здание целиком стоит на месте. У анимированных
    // — нужна: по ней идут кости и клип.
    ...(animated ? [] : [flatten()]),
    weld(),
    ...(simplifyTo
      ? [simplify({ simplifier: MeshoptSimplifier, ratio: simplifyTo, error: simplifyError ?? 0.01 })]
      : []),
    // Сетки с одним материалом — в одну: вызов отрисовки на материал, а не на доску.
    ...(keepParts || animated ? [] : [join()]),
    dedup(),
    prune(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [texture ?? 512, texture ?? 512],
    }),
    draco(),
  );
  await io.write(target, document);

  console.log(
    `${output}: ${megabytes(statSync(input).size)} → ${megabytes(statSync(target).size)}; ` +
      `сеток ${before} → ${root.listMeshes().length}, материалов ${root.listMaterials().length}` +
      (unlit ? '; снят материал без освещения' : ''),
  );
}
