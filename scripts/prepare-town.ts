/**
 * Подготовка зданий площади: ратуша и городской дом.
 *
 *   npx tsx scripts/prepare-town.ts            # все модели
 *   npx tsx scripts/prepare-town.ts rain_cloud # только те, чьё имя файла так начинается
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
/**
 * Заглушка DOM — ради выгрузок FBX.
 *
 * `FBXLoader` заводит <img> под каждую зашитую текстуру, а `GLTFExporter`
 * собирает GLB через Blob и FileReader — в node нет ни того, ни другого.
 * Та же заглушка, что в `prepare-weapon.ts`.
 */
(globalThis as unknown as { document: unknown }).document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};
(globalThis as unknown as { FileReader: unknown }).FileReader = class {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
};

import { BANK_STATUE, RAIN_CLOUD } from '@grimhold/shared';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import {
  dedup,
  draco,
  flatten,
  getBounds,
  join,
  metalRough,
  prune,
  simplify,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { readFileSync, statSync } from 'node:fs';
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
   * Выпрямить модель относительно земли.
   *
   * Выгрузки из редактора приходят с небольшим завалом: у деревенского пака
   * дома стоят криво на градус-три, и на ровной мостовой это видно глазом —
   * дом будто оседает набок. Доворачиваем **минимально**: собственную
   * вертикаль модели совмещаем с мировой, а разворот вокруг неё не трогаем.
   */
  upright?: boolean;
  /**
   * Взять из файла один узел по имени и выбросить остальное.
   *
   * Нужно для паков: деревенские дома приехали восемью строениями в одной
   * сцене, вместе с землёй, камерой и лампами автора. Резать их в редакторе
   * значило бы держать восемь исходников вместо одного и резать заново,
   * когда владелец пришлёт обновление.
   */
  pick?: string;
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

/**
 * Дома из деревенского пака.
 *
 * Высоты взяты по виду строения, а не по исходнику: в паке всё сложено
 * в одном масштабе, где дом в два человеческих роста соседствует с башней
 * в четыре. В городе они стоят рядом с таверной, и мерка у них общая.
 */
const VILLAGE_PACK = 'C:/Users/Wprot/OneDrive/Рабочий стол/Village/house_village.glb';
const VILLAGE: ModelSpec[] = (
  [
    ['maison7', 'village_house1.glb', 9],
    ['poutre_5_1', 'village_house2.glb', 9],
    ['ZBrushPolyMesh3D_1', 'village_house3.glb', 11],
    ['maison', 'village_house4.glb', 9],
    ['Cube_1', 'village_house5.glb', 9],
    ['Box024_2', 'village_house6.glb', 7],
    ['toit', 'village_house7.glb', 7],
    ['Box030_1', 'village_house8.glb', 8],
  ] as const
).map(([pick, output, height]) => ({
  source: VILLAGE_PACK,
  output,
  pick,
  normalize: { height },
}));

const MODELS: ModelSpec[] = [
  // Казна: каменный ларец. Середина в нуле, половина под землёй — поднимаем;
  // чуть больше исходника, чтобы читался на площади.
  { source: `${DESKTOP}/bank/bank.glb`, output: 'bank.glb', normalize: { scale: 1.1 } },
  /*
   * Памятник на казне — каменный ангел.
   *
   * В выгрузке он семнадцатиметровый и стоит в трёх метрах от своего
   * начала координат — на крышку ларца такой не поставишь. `normalize`
   * ставит его серединой пятна в ноль и приводит к росту из `BANK_STATUE`.
   */
  {
    source: `${DESKTOP}/Statue_Angel/Statue_Angel.glb`,
    output: 'statue_angel.glb',
    normalize: { height: BANK_STATUE.height },
  },
  /*
   * Два здания от владельца на смену двум домам пака — выгрузки FBX.
   *
   * Ратуша становится доминантой юго-восточного квартала, дом —
   * обычный жилой на западе. Рост задан здесь, пятно считается
   * по собранной модели и живёт в `HOUSE` (`shared/src/level.ts`).
   */
  {
    source: `${DESKTOP}/House_Village/TownHall.fbx`,
    output: 'town_hall.glb',
    normalize: { height: 11 },
    /**
     * Текстура крупнее обычной — исключение для ратуши.
     *
     * В выгрузке она 4096, и весь рисунок — резьба, доски, переплёты окон —
     * лежит в мелких деталях. На 512 она расползлась в кашу, и владелец забраковал.
     * Здание одно на город, и лишние полтораста килобайт его стоят.
     */
    texture: 2048,
  },
  { source: `${DESKTOP}/House_Village/House.fbx`, output: 'village_house9.glb', normalize: { height: 9 } },

  // Городские стены: вышка, пролёт, арка и две створки — части ставит houses.ts
  // по именам, поэтому не сливаются.
  { source: `${DESKTOP}/walls/walls.glb`, output: 'walls.glb', keepParts: true },

  /*
   * Таверна и лавка на колёсах — всё, что осталось от прежней застройки.
   * Остальные дома улиц (ратуша, часовня, три домика) владелец убрал: город
   * застроен заново деревенским паком, см. VILLAGE ниже и docs/buildings.md.
   */
  // Таверна пришла вдвое крупнее жизни — этаж в семь метров; ужата до трёх с половиной.
  { source: `${HOUSES}/house5_towern.glb`, output: 'tavern.glb', normalize: { scale: 0.5 } },
  // Повозка висела в четырёх метрах над землёй и в шести сбоку от начала.
  // Она сюжетная: стоит у люка в подземелье.
  { source: `${HOUSES}/shop_on_wheels.glb`, output: 'wagon.glb', normalize: {} },

  /**
   * Деревенские дома: один пак, восемь строений в одной сцене.
   *
   * Берём каждое по имени узла (`pick`) и приводим к своему росту: в паке
   * они в десятках единиц и стоят на общей земле. Имена узлов авторские,
   * французские и невнятные — наши имена файлов говорят, что это за дом.
   */
  ...VILLAGE,

  // Люк в подземелье за лавкой на колёсах: крышка открывается клипом.
  { source: `${DESKTOP}/Trapdoor/trapdoor.glb`, output: 'trapdoor.glb', normalize: {}, animated: true },
  // Туман из люка: пять полупрозрачных слоёв в 7 м шириной. Размер и высоту
  // над рамой задаёт houses.ts, слои кружит там же — клип в модели почти стоит.
  { source: `${DESKTOP}/fog/new-fog.glb`, output: 'trapdoor_fog.glb', keepParts: true },
  // Король крыс — облик хозяина глубины. 130 тысяч треугольников на одного
  // моба — в пять раз больше, чем нужно в полумраке зала. Размер задаёт игра
  // по росту босса (MOBS), здесь не трогаем.
  { source: `${DESKTOP}/Rat_Boss/rat.glb`, output: 'rat_king.glb', animated: true, simplifyTo: 0.2 },
  /*
   * Туча с дождём — проба над площадью (см. `RAIN_CLOUD` и docs/weather.md).
   *
   * Четыре облака, восемьдесят капель-треугольников и две молнии; всё это
   * двигает один клип «Take 001» на 2.7 с — капли падают, облака плывут,
   * молнии вспыхивают. Выгрузка в сотнях единиц: рост сводим к `RAIN_CLOUD`.
   */
  {
    source: `${DESKTOP}/clouds_rain/Clouds_rain.glb`,
    output: 'rain_cloud.glb',
    normalize: { height: RAIN_CLOUD.height },
    animated: true,
  },
];

/**
 * Имена в командной строке — собрать только эти модели (по началу имени
 * файла). Без них собирается всё: двадцать моделей и минуты ожидания ради
 * одной новой тучи.
 */
const ONLY = process.argv.slice(2);

/** Картинка, зашитая в FBX: PNG или JPEG, по их собственным подписям. */
function embeddedPicture(bytes: Buffer): Buffer {
  const png = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (png >= 0) return bytes.subarray(png);
  const jpeg = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpeg >= 0) return bytes.subarray(jpeg);
  throw new Error('в FBX нет зашитой картинки');
}

/**
 * Выгрузка FBX → GLB в памяти.
 *
 * Владелец приносит здания и в FBX тоже, а весь остальной конвейер —
 * сжатие текстур, слияние сеток, нормализация — умеет только glTF.
 * Переводим на лету: промежуточный файл на диске однажды устареет
 * и соберётся не тот дом.
 *
 * **Текстура идёт отдельно от геометрии.** `GLTFExporter` просит
 * у текстуры настоящее <img> с пикселями, а в node его нет — экспорт
 * падает на «No valid image data». Поэтому материалы здесь пересобираются
 * без картинок, а саму картинку вынимаем из FBX и вкладываем уже в glTF
 * — тот же путь, что у оружия (`prepare-weapon.ts`).
 */
async function fbxToGlb(path: string): Promise<{ glb: Uint8Array; picture: Buffer }> {
  const THREE = await import('three');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

  const file = readFileSync(path);
  const group = new FBXLoader().parse(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    path.slice(0, path.lastIndexOf('/') + 1),
  );

  group.traverse((node) => {
    const mesh = node as unknown as { isMesh?: boolean; material?: unknown };
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const plain = list.map(
      (material) =>
        new THREE.MeshStandardMaterial({
          name: (material as { name?: string }).name ?? 'building',
          color: 0xffffff,
          roughness: 0.9,
          metalness: 0,
        }),
    );
    mesh.material = plain.length === 1 ? plain[0]! : plain;
  });

  const scene = new THREE.Scene();
  scene.add(group);

  const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  return { glb: new Uint8Array(glb), picture: embeddedPicture(file) };
}

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

/** Повернуть вектор кватернионом. */
function rotate(q: number[] | Float32Array, v: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const [vx, vy, vz] = v;
  // t = 2 * (q.xyz × v), результат = v + w*t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** Произведение кватернионов: сперва `b`, потом `a`. */
function multiply(
  a: [number, number, number, number],
  b: number[] | Float32Array,
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = [b[0]!, b[1]!, b[2]!, b[3]!];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

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
  pick,
  upright,
} of MODELS) {
  if (ONLY.length && !ONLY.some((name) => output.startsWith(name))) continue;
  const input = source;
  const target = resolve(OUTPUT, output);
  const fromFbx = input.toLowerCase().endsWith('.fbx') ? await fbxToGlb(input) : null;
  const document = fromFbx ? await io.readBinary(fromFbx.glb) : await io.read(input);
  if (fromFbx) {
    /**
     * У FBX начало развёртки внизу, у glTF — вверху: без переворота
     * рисунок на стенах уезжает. То же самое было у топора.
     */
    const flipped = await sharp(fromFbx.picture).flip().png().toBuffer();
    const skin = document
      .createTexture(output.replace('.glb', ''))
      .setImage(new Uint8Array(flipped))
      .setMimeType('image/png');
    for (const material of document.getRoot().listMaterials()) {
      material.setBaseColorTexture(skin);
      material.setBaseColorFactor([1, 1, 1, 1]);
    }
  }
  const root = document.getRoot();
  const before = root.listMeshes().length;

  /**
   * Выбор узла идёт **до** нормализации: она считает габариты по сцене,
   * и лишняя земля под домом сплющила бы его в лепёшку.
   */
  if (pick) {
    const scene = root.listScenes()[0]!;
    const found = root.listNodes().find((node) => node.getName() === pick);
    if (!found) throw new Error(`${output}: в файле нет узла «${pick}»`);
    // Узел мог лежать глубоко в чужой иерархии — поднимаем его в сцену,
    // сохранив собственный поворот и масштаб.
    const parent = found.getParentNode();
    if (parent) parent.removeChild(found);
    for (const child of [...scene.listChildren()]) {
      if (child !== found) child.dispose();
    }
    scene.addChild(found);
    await document.transform(prune());
  }

  /**
   * Выпрямление — до нормализации: она меряет габариты, а у заваленного
   * дома они шире и выше настоящих.
   */
  if (upright) {
    for (const node of root.listNodes()) {
      const q = node.getRotation();
      // Куда смотрит собственная вертикаль модели после её поворота.
      const up = rotate(q, [0, 1, 0]);
      /**
       * Цель — **ближайшая** мировая вертикаль, а не всегда «вверх».
       *
       * У половины пака геометрия построена вверх ногами в своих осях:
       * её ось Y смотрит вниз, а дом при этом стоит правильно. Тяни такую
       * к (0, 1, 0) — и дом встанет на крышу.
       */
      const facing = up[1] >= 0 ? 1 : -1;
      const dot = Math.min(1, Math.max(-1, up[1] * facing));
      if (dot > 0.99999) continue;

      const angle = Math.acos(dot);
      const length = Math.hypot(up[0], up[2]);
      if (length < 1e-9) continue;

      /**
       * Ось доворота берём **проверкой, а не выводом знака**.
       *
       * Направление зависит и от того, куда завалено, и от того, вверх или
       * вниз смотрит собственная вертикаль модели; ошибиться в знаке легко,
       * а ошибка бесшумная — дом остаётся кривым ровно настолько же.
       * Поэтому считаем оба поворота и берём тот, после которого вертикаль
       * ближе к мировой.
       */
      const half = Math.sin(angle / 2) / length;
      const best = [1, -1]
        .map((sign) => {
          const fix: [number, number, number, number] = [
            -up[2] * sign * half,
            0,
            up[0] * sign * half,
            Math.cos(angle / 2),
          ];
          const next = multiply(fix, q);
          return { next, straight: Math.abs(rotate(next, [0, 1, 0])[1]) };
        })
        .sort((a, b) => b.straight - a.straight)[0]!;

      node.setRotation(best.next);
    }
  }

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

  /**
   * Старые материалы «блеск и глянец» — в обычные PBR.
   *
   * `KHR_materials_pbrSpecularGlossiness` держит картинки **внутри себя**,
   * а не в базовом материале, и наш конвейер их попросту не видел: дома
   * из деревенского пака собирались белыми, как гипс. Расширение объявлено
   * устаревшим, three его тоже не читает — переводим на месте.
   */
  const glossy = root
    .listExtensionsUsed()
    .some((extension) => extension.extensionName === 'KHR_materials_pbrSpecularGlossiness');
  if (glossy) await document.transform(metalRough());

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
      (unlit ? '; снят материал без освещения' : '') +
      (glossy ? '; блеск переведён в PBR' : ''),
  );
}
