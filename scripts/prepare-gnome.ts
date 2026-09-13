/**
 * Подготовка гнома — жителя городской площади.
 *
 *   npx tsx scripts/prepare-gnome.ts
 *
 * Файлы берутся **по содержимому, а не по именам**: в папке лежит выгрузка
 * из Mixamo, и имена там меняются от заказа к заказу — стоило один раз
 * положиться на имя, как анимацию подменили, и сборка встала.
 *
 * - файл со скином и анимацией — это модель: та же сетка, но с костями
 *   и клипом ходьбы;
 * - файл без костей нужен ради текстуры: анимировать его нечем.
 *
 * Текстура в обоих файлах лежит внутри — FBX умеет носить картинку в себе, —
 * и достать её приходится руками: загрузчик three написан для браузера
 * и раскодировать PNG в node не может.
 *
 * Клип ходьбы один, а житель на маршруте останавливается, поэтому здесь же
 * собирается поза покоя — см. `standing()`.
 */

/**
 * Заглушка DOM: FBXLoader заводит <img> под каждую текстуру, а GLTFExporter
 * собирает GLB через Blob и браузерный FileReader. В node нет ни того, ни другого.
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

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnimationClip, Group, KeyframeTrack, Mesh, MeshPhongMaterial, Quaternion } from 'three';

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Dwarf';
const OUTPUT = resolve(ROOT, 'packages/client/public/models/gnome.glb');

/** Модель смоделирована в сантиметрах: гном ростом в 97 единиц. */
const TO_METRES = 0.01;

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

/**
 * Достаёт картинку, зашитую в FBX.
 *
 * По-хорошему её надо читать из узла Video свойством Content, но формат
 * двоичный, и разбирать его целиком ради одной картинки незачем: PNG сам себя
 * обозначает — подписью в начале и меткой IEND в конце.
 */
function embeddedPng(bytes: Buffer): Buffer {
  const start = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (start < 0) throw new Error('в FBX нет зашитой картинки PNG');

  const end = bytes.indexOf(Buffer.from('IEND'), start);
  if (end < 0) throw new Error('картинка в FBX оборвана: нет метки IEND');

  // IEND плюс четыре байта контрольной суммы — на этом файл кончается.
  return bytes.subarray(start, end + 8);
}

/**
 * Поза покоя из клипа ходьбы.
 *
 * Другой анимации у модели нет, а житель стоит на каждой точке маршрута
 * по две с половиной секунды. Без позы покоя он продолжал бы шагать на месте:
 * микшер играет последний клип, пока не дали другой.
 *
 * Момент выбирается не на глаз, а счётом — тот, где бёдра развёрнуты
 * одинаково, то есть ноги сведены. В любой другой фазе гном замирал бы
 * с широко расставленными ногами, как будто его выключили на полушаге.
 *
 * Поверх неподвижной позы идёт дыхание: сантиметр вверх-вниз за три секунды.
 * Совсем неподвижная фигура читается как декорация, а не как житель.
 */
/**
 * Снимает значение дорожки в заданный момент.
 *
 * Через приведение: `createInterpolant` у three есть в коде, но не в его
 * описании типов — а без него позу из клипа не достать.
 */
function sampler(track: KeyframeTrack): { evaluate(time: number): ArrayLike<number> } {
  return (
    track as unknown as { createInterpolant(): { evaluate(time: number): ArrayLike<number> } }
  ).createInterpolant();
}

/**
 * Убирает движение корня.
 *
 * Клип из Mixamo заказан **не** «на месте»: за пятнадцать секунд таз уезжает
 * на несколько метров вперёд. В игре модель везёт сервер — она обязана шагать
 * там, где стоит сущность, иначе житель уплывает от собственного места,
 * от подписи над головой и от коробки столкновений.
 *
 * Вертикаль остаётся: покачивание на шаге — это и есть походка.
 *
 * Отсчёт идёт **от начала исходного клипа**, где персонаж стоит в нуле, а не
 * от начала вырезанного куска. Разница стоила заметной поломки: кусок вырезан
 * с середины прохода, и таз замирал там, где персонаж уже прошёл почти метр.
 * Модель вставала в метре впереди собственной позиции — а смещение это местное,
 * оно поворачивается вместе с ней, и на развороте жителя проносило через
 * два метра, будто его отбрасывало в сторону.
 */
function inPlace(clip: AnimationClip, home: { x: number; z: number }): void {
  for (const track of clip.tracks) {
    if (!track.name.endsWith('Hips.position')) continue;

    const values = track.values;
    for (let i = 0; i < values.length; i += 3) {
      values[i] = home.x;
      values[i + 2] = home.z;
    }
  }
}

/**
 * Вырезает из клипа зацикливаемый шаг.
 *
 * Заказанная анимация — подиумная: гном стоит, проходит вперёд два с половиной
 * метра, **разворачивается на 180°** и идёт обратно, и так пятнадцать секунд.
 * Жителю, которому её отдать как есть, полпути пришлось бы пятиться задом.
 *
 * Искать кусок сравнением с началом клипа бесполезно — это выяснилось прогоном:
 * в нуле персонаж ещё стоит, и на него не похож ни один момент ходьбы. Поэтому
 * ищется **повтор внутри самой походки**: пара «момент и он же через период»,
 * в которой позы совпадают лучше всего. Это и есть шаговый цикл.
 *
 * Разворот отсекается отдельно: повороты костей записаны относительно родителя,
 * поэтому весь разворот тела лежит в одной дорожке таза и тонет в сумме по трём
 * десяткам костей. Первый прогон именно так и выбрал момент посреди разворота.
 */
function trimToLoop(clip: AnimationClip): { walk: AnimationClip; metresPerSecond: number } {
  const turns = clip.tracks.filter((track: KeyframeTrack) => track.name.endsWith('.quaternion'));
  const poses = turns.map((track) => sampler(track));
  const pose = (time: number): Quaternion[] =>
    poses.map((source) => new THREE.Quaternion().fromArray(Array.from(source.evaluate(time))));

  /** Насколько тело может быть довёрнуто относительно начала, радианы. */
  const STRAIGHT = (20 * Math.PI) / 180;
  const hips = clip.tracks.find((track: KeyframeTrack) => track.name.endsWith('Hips.quaternion'));
  const euler = new THREE.Euler();
  const facing = (time: number): number => {
    if (!hips) return 0;
    euler.setFromQuaternion(
      new THREE.Quaternion().fromArray(Array.from(sampler(hips).evaluate(time))),
      'YXZ',
    );
    return euler.y;
  };

  // Прямой участок: от начала и до первого доворота. Всё, что за ним, —
  // разворот и обратный проход, они в цикл не годятся.
  const ahead = facing(0);
  const STEP = 1 / 30;
  let straight = STEP;
  while (straight + STEP < clip.duration) {
    const turned = facing(straight + STEP) - ahead;
    if (Math.abs(Math.atan2(Math.sin(turned), Math.cos(turned))) > STRAIGHT) break;
    straight += STEP;
  }

  /** Шаг взрослого человека — от полусекунды до двух с половиной. */
  const SHORTEST = 0.6;
  const LONGEST = 2.5;

  let bestFrom = 0;
  let bestPeriod = Math.min(clip.duration, LONGEST);
  let closest = Infinity;

  for (let period = SHORTEST; period <= LONGEST; period += STEP) {
    for (let from = 0; from + period <= straight; from += STEP * 3) {
      const before = pose(from);
      const after = pose(from + period);

      let difference = 0;
      for (const [index, quaternion] of before.entries()) {
        difference += quaternion.angleTo(after[index]!);
      }
      if (difference >= closest) continue;

      closest = difference;
      bestFrom = from;
      bestPeriod = period;
    }
  }

  const FPS = 30;
  const frames = Math.max(2, Math.round(bestPeriod * FPS));
  const times = Array.from({ length: frames + 1 }, (_, i) => (i / frames) * bestPeriod);
  const tracks: KeyframeTrack[] = [];

  for (const track of clip.tracks) {
    const source = sampler(track);
    const first = Array.from(source.evaluate(bestFrom)) as number[];
    const values: number[] = [];

    for (const [index, time] of times.entries()) {
      // Последний кадр — копия первого: петля обязана сойтись, иначе на стыке
      // виден рывок каждые пару секунд.
      const value =
        index === times.length - 1 ? first : Array.from(source.evaluate(bestFrom + time));
      values.push(...value);
    }

    tracks.push(
      first.length === 4
        ? new THREE.QuaternionKeyframeTrack(track.name, times, values)
        : new THREE.VectorKeyframeTrack(track.name, times, values),
    );
  }

  /**
   * Собственная скорость клипа — по тому самому движению корня, которое дальше
   * убирается.
   *
   * Без неё клиент не может свести шаг с движением: он знает, с какой скоростью
   * везёт сущность сервер, но не знает, на какую скорость нарисована анимация.
   * Разойдись эти два числа — и ноги едут по земле, как на льду.
   */
  const root = clip.tracks.find((track: KeyframeTrack) => track.name.endsWith('Hips.position'));
  let metresPerSecond = 0;
  if (root) {
    const from = Array.from(sampler(root).evaluate(bestFrom));
    const upto = Array.from(sampler(root).evaluate(bestFrom + bestPeriod));
    const travelled = Math.hypot((upto[0] ?? 0) - (from[0] ?? 0), (upto[2] ?? 0) - (from[2] ?? 0));
    metresPerSecond = (travelled * TO_METRES) / bestPeriod;
  }

  console.log(
    `прямой участок: ${straight.toFixed(2)} с из ${clip.duration.toFixed(2)}; ` +
      `шаг ${bestPeriod.toFixed(2)} с с ${bestFrom.toFixed(2)} ` +
      `(расхождение поз ${((closest * 180) / Math.PI).toFixed(0)}° на ${turns.length} костей)`,
  );
  return { walk: new THREE.AnimationClip('Walk', bestPeriod, tracks), metresPerSecond };
}

function standing(walk: AnimationClip): AnimationClip {
  const thighs = ['mixamorigLeftUpLeg.quaternion', 'mixamorigRightUpLeg.quaternion']
    .map((name) => walk.tracks.find((track: KeyframeTrack) => track.name === name))
    .filter((track): track is KeyframeTrack => track !== undefined);

  let best = 0;
  if (thighs.length === 2) {
    const left = sampler(thighs[0]!);
    const right = sampler(thighs[1]!);
    let closest = Infinity;

    for (let i = 0; i < 60; i++) {
      const time = (i / 60) * walk.duration;
      const a = new THREE.Quaternion().fromArray(Array.from(left.evaluate(time)));
      const b = new THREE.Quaternion().fromArray(Array.from(right.evaluate(time)));
      const spread = a.angleTo(b);
      if (spread >= closest) continue;
      closest = spread;
      best = time;
    }
  } else {
    console.warn('бёдра не нашлись по именам Mixamo — поза берётся с начала клипа');
  }

  const BREATH = 3;
  const tracks: KeyframeTrack[] = [];

  for (const track of walk.tracks) {
    const value = Array.from(sampler(track).evaluate(best)) as number[];

    if (track.name.endsWith('Hips.position')) {
      // Единицы сантиметровые: сантиметр — это единица.
      const breath = [...value];
      breath[1] = (breath[1] ?? 0) + 1;
      tracks.push(
        new THREE.VectorKeyframeTrack(
          track.name,
          [0, BREATH / 2, BREATH],
          [...value, ...breath, ...value],
        ),
      );
      continue;
    }

    const doubled = [...value, ...value];
    tracks.push(
      value.length === 4
        ? new THREE.QuaternionKeyframeTrack(track.name, [0, BREATH], doubled)
        : new THREE.VectorKeyframeTrack(track.name, [0, BREATH], doubled),
    );
  }

  console.log(`поза покоя снята с ходьбы на ${best.toFixed(2)} с — ноги сведены`);
  return new THREE.AnimationClip('Idle', BREATH, tracks);
}

// ---------- сборка ----------

/** Что лежит в исходной папке и что из этого нам пригодится. */
interface Candidate {
  name: string;
  bytes: Buffer;
  group: Group;
  bones: number;
  clips: number;
}

const loader = new FBXLoader();

function parse(name: string): Candidate {
  const bytes = readFileSync(`${SOURCE}/${name}`);
  const group = loader.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    '',
  );

  let bones = 0;
  group.traverse((node) => {
    if ((node as unknown as { isBone?: boolean }).isBone) bones++;
  });

  return { name, bytes, group, bones, clips: group.animations.length };
}

const found = readdirSync(SOURCE)
  .filter((name) => name.toLowerCase().endsWith('.fbx'))
  .map(parse);

for (const file of found) {
  console.log(`${file.name}: костей ${file.bones}, клипов ${file.clips}`);
}

const animated = found.find((file) => file.bones > 0 && file.clips > 0);
if (!animated) throw new Error('в папке нет файла со скелетом и анимацией');

// Текстуру предпочитаем брать из файла без костей: это исходник автора,
// а прогон через Mixamo картинку пережимает.
const skin = found.find((file) => file.bones === 0) ?? animated;
console.log(`модель: ${animated.name}, текстура: ${skin.name}`);

const model = animated.group;

model.scale.setScalar(TO_METRES);
model.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(model);
console.log(`рост модели: ${(bounds.max.y - bounds.min.y).toFixed(2)} м`);

/**
 * Материал пересобирается на свой.
 *
 * Исходный — Phong с битой ссылкой на текстуру: экспортёр её всё равно
 * не запишет, а картинку мы вложим потом, уже в GLB. Заодно уходит блик
 * Phong — в наших сумерках он выглядит пластиком.
 */
let uv = false;
model.traverse((node) => {
  const mesh = node as Mesh;
  if (!mesh.isMesh) return;
  uv = uv || mesh.geometry.attributes.uv !== undefined;

  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const rebuilt = list.map(
    (material) =>
      new THREE.MeshStandardMaterial({
        name: (material as MeshPhongMaterial).name || 'Gnome',
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0,
      }),
  );
  mesh.material = rebuilt.length === 1 ? rebuilt[0]! : rebuilt;
});

if (!uv) throw new Error('у модели нет развёртки — текстуру наложить некуда');

const raw = model.animations[0]!;
// Цикл вырезается до того, как убрано движение корня: по нему и считается,
// на какую скорость нарисована ходьба.
const { walk, metresPerSecond } = trimToLoop(raw);

// Дом — то место, где персонаж стоит в начале исходного клипа: относительно
// него и собрана модель.
const rootTrack = raw.tracks.find((track: KeyframeTrack) => track.name.endsWith('Hips.position'));
const rest = rootTrack ? Array.from(sampler(rootTrack).evaluate(0)) : [0, 0, 0];
inPlace(walk, { x: rest[0] ?? 0, z: rest[2] ?? 0 });

console.log(
  `собственная скорость ходьбы: ${metresPerSecond.toFixed(2)} м/с ` +
    `при росте модели ${(bounds.max.y - bounds.min.y).toFixed(2)} м ` +
    '— число идёт в WALK_PACE (client/src/models.ts)',
);

const clips = [walk, standing(walk)];
console.log(`клипы: ${clips.map((clip) => `${clip.name} ${clip.duration.toFixed(2)}с`).join(', ')}`);

const glb = (await new GLTFExporter().parseAsync(model, {
  binary: true,
  animations: clips,
})) as ArrayBuffer;
writeFileSync(OUTPUT, Buffer.from(glb));
console.log(`сборка: ${kilobytes(statSync(OUTPUT).size)}`);

// ---------- текстура и сжатие ----------

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(OUTPUT);
const root = document.getRoot();

const png = embeddedPng(skin.bytes);
const picture = await sharp(png).metadata();
console.log(`текстура из FBX: ${picture.width}×${picture.height}, ${kilobytes(png.byteLength)}`);

/**
 * Картинка переворачивается по вертикали.
 *
 * У FBX начало развёртки внизу, у glTF — вверху. Пока текстура идёт через
 * экспортёр, он это улаживает сам; мы вкладываем её в обход — и без переворота
 * модель получает свою же текстуру задом наперёд: лицо уезжает на живот,
 * а волосы на сапоги. Именно так и вышло с первого раза.
 */
const flipped = await sharp(png).flip().png().toBuffer();

const texture = document
  .createTexture('Gnome')
  .setImage(new Uint8Array(flipped))
  .setMimeType('image/png');

for (const material of root.listMaterials()) {
  material.setBaseColorTexture(texture);
  // Цвет идёт из картинки, а множитель оставляем белым: иначе он её тонирует.
  material.setBaseColorFactor([1, 1, 1, 1]);
}

await document.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
  draco(),
);
await io.write(OUTPUT, document);

console.log(`готово: ${OUTPUT}`);
console.log(`после сжатия: ${kilobytes(statSync(OUTPUT).size)}`);
