/**
 * Клипы оружия от владельца — в наши руки.
 *
 *   npx tsx scripts/prepare-sword.ts
 *
 * Исходник — `Animacija_Sword/SwordAnims.fbx`: стойка с оружием и замах,
 * сделанные владельцем **на нашем же риге**. Имена костей совпадают номер
 * в номер (`DEF-handR_0583`), поэтому переносить позу, как у лука, не нужно
 * вовсе: дорожки поворотов просто перекладываются в hands.glb.
 *
 * Отсюда и вся ценность этих клипов. Перенос с чужого скелета всегда
 * приблизителен — на нём споткнулись и лук, и меч; здесь приближения нет.
 *
 * Порядок сборки: сперва `prepare-arms.ts` (он собирает модель с нуля
 * и стирает всё дописанное), потом этот.
 */

/** Заглушка DOM: FBXLoader заводит img под каждую текстуру, а в node его нет. */
(globalThis as unknown as { document: unknown }).document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};

import { NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnimationClip, QuaternionKeyframeTrack } from 'three';

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Animacija_Sword/SwordAnims.fbx';
const MODEL = resolve(ROOT, 'packages/client/public/models/hands.glb');

/** Какие клипы берём. Приставка rig| — как у остальных: так их пишет экспортёр. */
const WANTED = ['Sword_Idle', 'Sword_Slash'];

/**
 * Какие кости берём: **только ветка руки от плеча вниз**.
 *
 * Клип сделан на человеке целиком, и в нём поворачивается корпус. У нас
 * корпус спрятан, а руки поставлены в кадр посадкой по позе покоя (anchor):
 * возьми повороты груди и плеч — и руки уедут из кадра совсем. Так и вышло
 * с первого раза: в замахе кадр оставался пустым.
 */
const ARM_BONES = /^DEF-(upper_arm|forearm|hand|palm|f_|thumb)/i;

/**
 * Приглушать вынос руки **не надо**.
 *
 * Сперва плечо и предплечье тянули обратно к позе покоя, чтобы кисть
 * не уходила за край экрана. Владелец забраковал: у топора инерция, и он
 * обязан уходить вверх на замахе и вниз на ударе, хоть бы и за кадр.
 * Размах — часть удара, а не помеха.
 */

const bytes = readFileSync(SOURCE);
const group = new FBXLoader().parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  '',
);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const document = await io.read(MODEL);
const root = document.getRoot();
const buffer = root.listBuffers()[0]!;

/** Узлы модели по имени: в клипе кости названы точно так же. */
const byName = new Map<string, Node>();
for (const node of root.listNodes()) byName.set(node.getName(), node);

for (const wanted of WANTED) {
  const clip = group.animations.find(
    (candidate: AnimationClip) => (candidate.name.split('|').pop() ?? candidate.name) === wanted,
  );
  if (!clip) {
    console.log(`в выгрузке нет клипа ${wanted}`);
    continue;
  }

  const name = `rig|${wanted}`;
  // Пересборка заменяет клип, а не плодит второй с тем же именем.
  for (const existing of root.listAnimations()) {
    if (existing.getName() === name) existing.dispose();
  }

  const animation = document.createAnimation(name);
  let written = 0;
  const missing: string[] = [];

  for (const track of clip.tracks) {
    // Берём только повороты: корпус у нас спрятан, и сдвиги костей от чужой
    // сцены растащили бы руки — та же причина, что у лука.
    if (!track.name.endsWith('.quaternion')) continue;

    const boneName = track.name.slice(0, -'.quaternion'.length);
    if (!ARM_BONES.test(boneName)) continue;
    const node = byName.get(boneName);
    if (!node) {
      missing.push(boneName);
      continue;
    }

    const times = (track as QuaternionKeyframeTrack).times;
    const values = new Float32Array((track as QuaternionKeyframeTrack).values);

    const input = document
      .createAccessor(`${name}-${boneName}-time`)
      .setArray(new Float32Array(times))
      .setType('SCALAR')
      .setBuffer(buffer);
    const output = document
      .createAccessor(`${name}-${boneName}`)
      .setArray(values)
      .setType('VEC4')
      .setBuffer(buffer);

    const sampler = document
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation('LINEAR');

    animation.addSampler(sampler);
    animation.addChannel(
      document
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath('rotation')
        .setSampler(sampler),
    );
    written++;
  }

  console.log(
    `${name}: ${written} костей, ${clip.duration.toFixed(2)} с` +
      (missing.length > 0 ? `, не нашлось в модели: ${missing.length}` : ''),
  );
}

await io.write(MODEL, document);
console.log(`готово: ${(statSync(MODEL).size / 1048576).toFixed(2)} МБ`);
