/**
 * Подготовка моделей рас на витрину площади — человек и эльф.
 *
 *   npx tsx scripts/prepare-exhibits.ts
 *
 * Модели от владельца — выгрузки Mixamo, по папке на расу. В каждом файле
 * анимации лежит та же сетка со скелетом и один клип; файл с именем расы —
 * голая сетка без скелета, он не нужен. Сетка и текстура берутся из стойки,
 * клипы — из всех файлов: скелет у выгрузок одной расы общий, имена костей
 * совпадают, и клипы ложатся на одну сетку. Так же собран пробный дворф
 * (prepare-dwarf-test.ts) — ловушки те же, см. docs/npc.md, «Как выглядит житель».
 *
 * В дальнейшем это будут расы, которые выбирает игрок. Пока — витрина.
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
import type { AnimationClip, Group, Mesh, MeshPhongMaterial } from 'three';

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = 'C:/Users/Wprot/OneDrive/Рабочий стол';

/** Выгрузки Mixamo — в сантиметрах. */
const TO_METRES = 0.01;

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

interface Target {
  /** Папка с выгрузками. */
  source: string;
  output: string;
  /** Имя материала — для узнаваемости в файле. */
  material: string;
  /** Какой клип в каком файле. Первым — стойка: из неё берутся сетка и текстура. */
  clips: { clip: string; file: RegExp }[];
}

const TARGETS: Target[] = [
  {
    source: `${DESKTOP}/Human_main`,
    output: 'human_exhibit.glb',
    material: 'Human',
    clips: [
      { clip: 'Idle', file: /breathing idle/i },
      { clip: 'Walk', file: /walking/i },
      { clip: 'Punch', file: /elbow punch/i },
      { clip: 'Dance', file: /hip hop/i },
    ],
  },
  {
    source: `${DESKTOP}/Elf_Main`,
    output: 'elf_exhibit.glb',
    material: 'Elf',
    clips: [
      { clip: 'Idle', file: /ninja idle/i },
      { clip: 'Run', file: /^run/i },
      { clip: 'Dance', file: /samba/i },
    ],
  },
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
 * Танцы из Mixamo водят таз по кругу на полметра и больше: фигура уплыла бы
 * со своего места на площади. Горизонталь прибивается к первому кадру,
 * вертикаль остаётся — присед и подскок и есть движение.
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

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

for (const target of TARGETS) {
  const output = resolve(ROOT, 'packages/client/public/models', target.output);
  const files = readdirSync(target.source).filter((name) => name.toLowerCase().endsWith('.fbx'));
  const loader = new FBXLoader();

  const load = (pattern: RegExp): { name: string; bytes: Buffer; group: Group } => {
    const name = files.find((file) => pattern.test(file));
    if (!name) throw new Error(`в ${target.source} нет файла под ${pattern}`);
    const bytes = readFileSync(`${target.source}/${name}`);
    const group = loader.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );
    return { name, bytes, group };
  };

  console.log(`\n== ${target.output}`);
  const sources = target.clips.map((wanted) => ({ ...wanted, source: load(wanted.file) }));
  const base = sources[0]!.source;
  const model = base.group;

  model.scale.setScalar(TO_METRES);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  console.log(`модель из ${base.name}, рост ${(bounds.max.y - bounds.min.y).toFixed(2)} м`);

  let triangles = 0;
  model.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const index = mesh.geometry.index;
    triangles += (index ? index.count : mesh.geometry.attributes.position!.count) / 3;
    // Phong с битой ссылкой на текстуру пересобирается на свой материал:
    // картинку вложим уже в GLB, а блик Phong в наших сумерках — пластик.
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const rebuilt = list.map(
      (material) =>
        new THREE.MeshStandardMaterial({
          name: (material as MeshPhongMaterial).name || target.material,
          color: 0xffffff,
          roughness: 0.9,
          metalness: 0,
        }),
    );
    mesh.material = rebuilt.length === 1 ? rebuilt[0]! : rebuilt;
  });
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
  writeFileSync(output, Buffer.from(glb));

  const document = await io.read(output);
  const png = embeddedPng(base.bytes);
  const picture = await sharp(png).metadata();
  console.log(`текстура из FBX: ${picture.width}×${picture.height}`);

  // У FBX начало развёртки внизу, у glTF — вверху: без переворота лицо уезжает
  // на живот. Так вышло у гнома с первого раза.
  const flipped = await sharp(png).flip().png().toBuffer();
  const texture = document
    .createTexture(target.material)
    .setImage(new Uint8Array(flipped))
    .setMimeType('image/png');
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
  await io.write(output, document);
  console.log(`готово: ${target.output}, ${kilobytes(statSync(output).size)}`);
}
