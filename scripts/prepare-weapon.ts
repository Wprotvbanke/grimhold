/**
 * Подготовка оружия, которое видно в руке.
 *
 *   npx tsx scripts/prepare-weapon.ts
 *
 * Топор от владельца приезжает выгрузкой FBX с зашитой внутрь текстурой.
 * Здесь он переводится в наш формат: метры вместо сантиметров, текстура
 * в webp, вершины в draco. Геометрия крошечная (658 треугольников), поэтому
 * прореживать нечего — вес весь в картинке.
 *
 * Ставит модель в руку `client/src/viewmodel.ts`.
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
import { dedup, draco, flatten, join, prune, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mesh, MeshPhongMaterial } from 'three';

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = 'C:/Users/Wprot/OneDrive/Рабочий стол';

/** Выгрузки приходят в сантиметрах. */
const TO_METRES = 0.01;

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;

interface WeaponSpec {
  source: string;
  output: string;
  material: string;
}

const WEAPONS: WeaponSpec[] = [
  { source: `${DESKTOP}/Axe/Axe.fbx`, output: 'axe.glb', material: 'Axe' },
];

/** Картинка, зашитая в FBX: PNG сам себя обозначает подписью и меткой IEND. */
function embeddedPng(bytes: Buffer): Buffer {
  const start = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (start < 0) throw new Error('в FBX нет зашитой картинки PNG');
  const end = bytes.indexOf(Buffer.from('IEND'), start);
  if (end < 0) throw new Error('картинка в FBX оборвана: нет метки IEND');
  return bytes.subarray(start, end + 8);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

for (const weapon of WEAPONS) {
  const target = resolve(ROOT, 'packages/client/public/models', weapon.output);
  const bytes = readFileSync(weapon.source);
  const group = new FBXLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    '',
  );

  group.scale.setScalar(TO_METRES);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());
  console.log(
    `${weapon.output}: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} м, ` +
      `низ на ${bounds.min.y.toFixed(2)}`,
  );

  let triangles = 0;
  group.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const index = mesh.geometry.index;
    triangles += (index ? index.count : mesh.geometry.attributes.position!.count) / 3;
    // Phong с битой ссылкой на текстуру пересобирается на свой материал:
    // картинку вложим уже в GLB, а блик Phong в наших сумерках — пластик.
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.material = list.map(
      (material) =>
        new THREE.MeshStandardMaterial({
          name: (material as MeshPhongMaterial).name || weapon.material,
          color: 0xffffff,
          roughness: 0.85,
          metalness: 0,
        }),
    );
    if (Array.isArray(mesh.material) && mesh.material.length === 1) mesh.material = mesh.material[0]!;
  });
  console.log(`треугольников: ${triangles}`);

  const glb = (await new GLTFExporter().parseAsync(group, { binary: true })) as ArrayBuffer;
  writeFileSync(target, Buffer.from(glb));

  const document = await io.read(target);
  const png = embeddedPng(bytes);
  const picture = await sharp(png).metadata();
  console.log(`текстура из FBX: ${picture.width}×${picture.height}`);

  // У FBX начало развёртки внизу, у glTF — вверху: без переворота рисунок
  // на топорище уезжает. Так вышло у гнома с первого раза.
  const flipped = await sharp(png).flip().png().toBuffer();
  const texture = document
    .createTexture(weapon.material)
    .setImage(new Uint8Array(flipped))
    .setMimeType('image/png');
  for (const material of document.getRoot().listMaterials()) {
    material.setBaseColorTexture(texture);
    material.setBaseColorFactor([1, 1, 1, 1]);
  }

  await document.transform(
    flatten(),
    join(),
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
    draco(),
  );
  await io.write(target, document);
  console.log(`готово: ${weapon.output}, ${kilobytes(statSync(target).size)}`);
}
