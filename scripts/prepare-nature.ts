/**
 * Подготовка пака растительности к вебу.
 *
 *   npx tsx scripts/prepare-nature.ts
 *
 * Исходник — 68 файлов FBX на 86 МБ, без единой текстуры: цвет у этих моделей
 * лежит в вершинах. Возить их в игру как есть нельзя ни по весу, ни по числу
 * запросов, поэтому всё собирается в **один** GLB: растительность нужна вся
 * сразу и повсюду, а один файл с общим сжатием весит меньше суммы частей.
 *
 * Каждая модель приводится к метрам и ставится основанием в ноль — дальше
 * клиент только клонирует её и разбрасывает по миру (client/src/nature.ts).
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
// Типы берём статически, а сам модуль — динамически: THREE можно грузить
// только после заглушки DOM, иначе загрузчик падает на первой же текстуре.
import type { Material, Mesh, MeshPhongMaterial } from 'three';
import { resolve } from 'node:path';

/**
 * Заглушка DOM.
 *
 * FBXLoader написан для браузера и заводит <img> под каждую текстуру. Текстур
 * в паке нет — ссылки в материалах битые, — но без заглушки загрузчик падает
 * на первой же из них.
 */
(globalThis as unknown as { document: unknown }).document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};

/**
 * Заглушка FileReader: GLTFExporter собирает двоичный GLB через Blob и читает
 * его браузерным ридером. В node Blob есть, а ридера нет.
 */
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

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Nature';
const OUTPUT = resolve(ROOT, 'packages/client/public/models/nature.glb');

/** Пак смоделирован в сантиметрах: куст выходит ростом в полтора метра. */
const TO_METRES = 0.01;

/**
 * Палитра.
 *
 * Весь цвет пака лежал в текстурах, а их в раздаче не оказалось: цвета вершин
 * белые, материалы белые, ссылки на карты битые. Зато имена материалов
 * осмысленные — кора, хвоя, листва, трава, — и раскраска по ним выходит даже
 * лучше исходной: она наша, а не чужая яркая летняя.
 *
 * Тона приглушены под мрачное средневековье: зелень болотная и синеватая,
 * кора серая, цветы выцветшие. Сочный зелёный лес спорил бы со всем остальным.
 */
const PALETTE: Record<string, number> = {
  Bark_DeadTree: 0x4a423a,
  Bark_NormalTree: 0x53412e,
  Bark_TwistedTree: 0x443a2f,
  Leaves_NormalTree: 0x3c4f2f,
  Leaves_Pine: 0x2c4234,
  Leaves_TwistedTree: 0x4a4b2e,
  Leaves: 0x44552f,
  Grass: 0x515c38,
  Flowers: 0x8c7188,
  Mushrooms: 0x86674f,
  Rocks: 0x67635d,
  PathRocks: 0x78736a,
};

/** Чем красить материал, имени которого нет в палитре: сухие ветки куста. */
const FALLBACK = 0x4e4332;

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

/** Собирает все .fbx пака: имя папки не нужно, файлы названы осмысленно. */
function listSources(): { id: string; path: string }[] {
  const found: { id: string; path: string }[] = [];
  for (const dir of readdirSync(SOURCE)) {
    const full = resolve(SOURCE, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full)) {
      if (!file.toLowerCase().endsWith('.fbx')) continue;
      found.push({ id: file.replace(/\.fbx$/i, '').toLowerCase(), path: resolve(full, file) });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

const loader = new FBXLoader();
const scene = new THREE.Scene();

/**
 * Один материал на всю растительность.
 *
 * Цвет живёт в вершинах, поэтому разным видам разные материалы не нужны —
 * а общий материал позволяет слить каждую модель в одну геометрию.
 */
const shared = new THREE.MeshStandardMaterial({
  name: 'nature',
  vertexColors: true,
  roughness: 0.95,
  metalness: 0,
});
/** Материалы, которых нет в палитре: их красит запасной цвет, и это видно. */
const unknown = new Set<string>();
let sourceBytes = 0;
let triangles = 0;

for (const { id, path } of listSources()) {
  const bytes = readFileSync(path);
  sourceBytes += bytes.byteLength;
  const group = loader.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    '',
  );

  // Приводим к метрам и ставим основанием в ноль, центром — в начало координат.
  // Клиенту тогда достаточно позиции на земле: ни высоту, ни центр он не ищет.
  group.scale.setScalar(TO_METRES);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  group.position.set(
    -(bounds.min.x + bounds.max.x) / 2,
    -bounds.min.y,
    -(bounds.min.z + bounds.max.z) / 2,
  );
  group.updateMatrixWorld(true);

  /**
   * Вся модель сливается в одну геометрию, а цвет материала уезжает в вершины.
   *
   * Это главное в этом скрипте. В исходнике каждый лист — отдельный меш:
   * у обычного дерева их **восемьсот двенадцать**. Клиент рисует растения
   * пачками, то есть по вызову отрисовки на меш, — и одно такое дерево
   * стоило восемьсот вызовов на кадр, а лес из них вешал игру намертво.
   *
   * Сливать можно только потому, что текстур в паке нет и весь цвет —
   * это одно число на материал. Значит материал на всю растительность нужен
   * ровно один, а различия уходят в COLOR_0.
   */
  const pieces: ReturnType<Mesh['geometry']['clone']>[] = [];
  group.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);

    // Оставляем ровно те атрибуты, которые есть у всех: иначе слияние
    // молча выбросит половину геометрии.
    for (const key of Object.keys(geometry.attributes)) {
      if (key !== 'position' && key !== 'normal') geometry.deleteAttribute(key);
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const count = geometry.attributes.position!.count;
    const colors = new Float32Array(count * 3);

    /**
     * Цвет кладём **по группам**, а не на меш целиком.
     *
     * В этом паке кора и листва — один меш с двумя материалами, разложенными
     * по группам треугольников. Покрасишь меш одним цветом — и крона выйдет
     * цвета ствола.
     *
     * Через setHex с sRGB: three хранит рабочий цвет линейным, а палитра
     * записана так, как выглядит на экране.
     */
    const paint = (from: number, upto: number, material: Material | undefined): void => {
      const name = material?.name ?? '';
      if (!(name in PALETTE)) unknown.add(name);
      const color = new THREE.Color().setHex(PALETTE[name] ?? FALLBACK, THREE.SRGBColorSpace);
      const index = geometry.index;

      for (let i = from; i < upto; i++) {
        const vertex = index ? index.getX(i) : i;
        colors[vertex * 3] = color.r;
        colors[vertex * 3 + 1] = color.g;
        colors[vertex * 3 + 2] = color.b;
      }
    };

    const total = geometry.index ? geometry.index.count : count;
    if (geometry.groups.length === 0) paint(0, total, list[0] as Material | undefined);
    else {
      for (const chunk of geometry.groups) {
        paint(
          chunk.start,
          Math.min(chunk.start + chunk.count, total),
          list[chunk.materialIndex ?? 0] as Material | undefined,
        );
      }
    }

    // Группы больше не нужны: материал теперь один на всю растительность,
    // а по ним экспортёр разрезал бы модель обратно на сотни кусков.
    geometry.clearGroups();
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pieces.push(geometry);
  });

  const merged = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
  if (!merged) throw new Error(`${id}: геометрия не слилась`);
  for (const piece of pieces) if (piece !== merged) piece.dispose();

  const holder = new THREE.Mesh(merged, shared);
  holder.name = id;
  scene.add(holder);

  const position = merged.attributes.position!;
  triangles += (merged.index ? merged.index.count : position.count) / 3;

  console.log(
    `${id.padEnd(24)} ${(bounds.max.y - bounds.min.y).toFixed(2)} м  ` +
      `мешей ${String(pieces.length).padStart(4)} → 1`,
  );
}

if (unknown.size > 0) console.log(`
без своего цвета: ${[...unknown].join(', ')}`);

const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
writeFileSync(OUTPUT, Buffer.from(glb));
console.log(
  `\nсобрано моделей: ${scene.children.length}, треугольников ${Math.round(triangles)}`,
);
console.log(`исходник: ${megabytes(sourceBytes)} → сборка: ${megabytes(statSync(OUTPUT).size)}`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document_ = await io.read(OUTPUT);
await document_.transform(
  // weld склеивает совпадающие вершины: экспорт из FBX пишет их по одной на
  // каждый угол треугольника, и Draco на разваренной сетке работает вхолостую.
  weld(),
  /**
   * Упрощение.
   *
   * Весь вес растительности — в деревьях: одно кривое дерево это десять тысяч
   * треугольников, а их в чанке до двух десятков. В кадре набегало семьсот
   * тысяч, и на слабой видеокарте это заметно сразу.
   *
   * Порог ошибки важнее коэффициента: он не даёт упрощению съесть силуэт.
   * Крона у этих моделей набрана плоскими листьями, и по ней видно первой,
   * если перестараться.
   */
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.02 }),
  dedup(),
  prune(),
  draco(),
);
await io.write(OUTPUT, document_);

console.log(`после сжатия: ${megabytes(statSync(OUTPUT).size)}`);
