/**
 * Подготовка пробного дворфа — модели на проверку, которая стоит на площади
 * и по очереди играет свои клипы.
 *
 *   npx tsx scripts/prepare-dwarf-test.ts
 *
 * В папке три выгрузки Mixamo одного персонажа: стойка, удар ногой и бег.
 * В каждой — та же сетка со скелетом и один клип. Сетка и текстура берутся
 * из стойки, клипы — из всех трёх: скелет у выгрузок один, имена костей
 * совпадают, и клипы ложатся на одну сетку.
 *
 * Здесь файлы различаются по именам — в отличие от гнома (prepare-gnome.ts),
 * где имена меняются от заказа к заказу. Все три файла одинаковы по устройству,
 * и содержимое их не различает; не нашёлся файл — скрипт скажет, какой.
 *
 * Про ловушки выгрузок Mixamo — docs/npc.md, «Как выглядит житель».
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
import type { AnimationClip, Group, KeyframeTrack, Mesh, MeshPhongMaterial } from 'three';

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/dwarf_test';
const OUTPUT = resolve(ROOT, 'packages/client/public/models/dwarf_test.glb');

/** Выгрузки Mixamo — в сантиметрах. */
const TO_METRES = 0.01;

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

/** Какой клип в каком файле. Имя клипа в GLB — то, что ищет витрина на клиенте. */
const WANTED: { clip: string; file: RegExp }[] = [
  { clip: 'Idle', file: /idle/i },
  { clip: 'Kick', file: /kick/i },
  { clip: 'Run', file: /run/i },
];

/** Картинка, зашитая в FBX: PNG сам себя обозначает подписью и меткой IEND. */
function embeddedPng(bytes: Buffer): Buffer {
  const start = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (start < 0) throw new Error('в FBX нет зашитой картинки PNG');
  const end = bytes.indexOf(Buffer.from('IEND'), start);
  if (end < 0) throw new Error('картинка в FBX оборвана: нет метки IEND');
  return bytes.subarray(start, end + 8);
}

/**
 * Убирает движение корня по горизонтали.
 *
 * Бег из Mixamo заказан с перемещением: таз уходит вперёд, и модель уплыла бы
 * со своего места. Горизонталь прибивается к первому кадру, вертикаль
 * остаётся — подскок на бегу и присед на ударе и есть движение.
 */
function inPlace(clip: AnimationClip): number {
  let drift = 0;
  for (const track of clip.tracks) {
    if (!track.name.endsWith('Hips.position')) continue;
    const values = track.values;
    const x = values[0] ?? 0;
    const z = values[2] ?? 0;
    for (let i = 0; i < values.length; i += 3) {
      drift = Math.max(drift, Math.hypot((values[i] ?? 0) - x, (values[i + 2] ?? 0) - z));
      values[i] = x;
      values[i + 2] = z;
    }
  }
  return drift * TO_METRES;
}

interface Source {
  name: string;
  bytes: Buffer;
  group: Group;
}

const loader = new FBXLoader();
const files = readdirSync(SOURCE).filter((name) => name.toLowerCase().endsWith('.fbx'));

function load(pattern: RegExp): Source {
  const name = files.find((file) => pattern.test(file));
  if (!name) throw new Error(`в ${SOURCE} нет файла под ${pattern}`);
  const bytes = readFileSync(`${SOURCE}/${name}`);
  const group = loader.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    '',
  );
  return { name, bytes, group };
}

const sources = WANTED.map((wanted) => ({ ...wanted, source: load(wanted.file) }));
const base = sources[0]!.source;
const model = base.group;

model.scale.setScalar(TO_METRES);
model.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(model);
console.log(`модель: ${base.name}, рост ${(bounds.max.y - bounds.min.y).toFixed(2)} м`);

let triangles = 0;
let uv = false;
model.traverse((node) => {
  const mesh = node as Mesh;
  if (!mesh.isMesh) return;
  uv = uv || mesh.geometry.attributes.uv !== undefined;
  const index = mesh.geometry.index;
  triangles += (index ? index.count : mesh.geometry.attributes.position!.count) / 3;

  // Phong с битой ссылкой на текстуру пересобирается на свой материал:
  // картинку вложим уже в GLB, а блик Phong в наших сумерках — пластик.
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const rebuilt = list.map(
    (material) =>
      new THREE.MeshStandardMaterial({
        name: (material as MeshPhongMaterial).name || 'DwarfTest',
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0,
      }),
  );
  mesh.material = rebuilt.length === 1 ? rebuilt[0]! : rebuilt;
});
if (!uv) throw new Error('у модели нет развёртки — текстуру наложить некуда');
console.log(`треугольников: ${triangles}`);

const clips: AnimationClip[] = [];
for (const { clip: name, source } of sources) {
  const clip = source.group.animations[0];
  if (!clip) throw new Error(`в ${source.name} нет клипа`);
  clip.name = name;
  const drift = inPlace(clip);
  console.log(`${name}: ${clip.duration.toFixed(2)} с из ${source.name}; корень уходил на ${drift.toFixed(2)} м`);
  clips.push(clip);
}

const glb = (await new GLTFExporter().parseAsync(model, { binary: true, animations: clips })) as ArrayBuffer;
writeFileSync(OUTPUT, Buffer.from(glb));
console.log(`сборка: ${kilobytes(statSync(OUTPUT).size)}`);

// ---------- текстура и сжатие ----------

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(OUTPUT);
const png = embeddedPng(base.bytes);
const picture = await sharp(png).metadata();
console.log(`текстура из FBX: ${picture.width}×${picture.height}, ${kilobytes(png.byteLength)}`);

// У FBX начало развёртки внизу, у glTF — вверху: без переворота лицо уезжает
// на живот. Так вышло у гнома с первого раза.
const flipped = await sharp(png).flip().png().toBuffer();
const texture = document.createTexture('DwarfTest').setImage(new Uint8Array(flipped)).setMimeType('image/png');
for (const material of document.getRoot().listMaterials()) {
  material.setBaseColorTexture(texture);
  material.setBaseColorFactor([1, 1, 1, 1]);
}

await document.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  draco(),
);
await io.write(OUTPUT, document);
console.log(`готово: ${OUTPUT}, после сжатия ${kilobytes(statSync(OUTPUT).size)}`);
