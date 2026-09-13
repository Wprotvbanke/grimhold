/**
 * Перенацеливание анимации лука на наши руки.
 *
 *   npx tsx scripts/prepare-bow.ts
 *
 * Исходник — клип Mixamo «Standing Draw Arrow»: скелет из сорока одной кости
 * с именами вроде mixamorigLeftArm и без единого меша. Наши руки — риг Rigify
 * на тысячу костей с именами вроде DEF-upper_armL_0454. **Ни одна кость
 * не совпадает**, поэтому клип нельзя просто положить в модель: он не сдвинет
 * ничего.
 *
 * Скрипт переносит позу с чужого скелета на наш и дописывает получившийся клип
 * в hands.glb. Порядок такой: сперва prepare-arms.ts (он собирает модель
 * с нуля), потом этот — иначе новый клип затрётся.
 *
 * ## Как переносится поза
 *
 * Не покостно и не «как есть», а **относительно груди**. Mixamo вращает
 * в клипе весь корпус, а у нас корпус спрятан: игрок видит только руки,
 * и туловище всегда в покое. Возьми мировые повороты как есть — руки уехали
 * бы вбок вслед за несуществующим разворотом плеч.
 *
 * Поэтому для каждой кости считается её поворот **в системе груди**, и он же
 * накладывается на нашу грудь в покое:
 *
 *   отн(t)    = мир(грудь, t)⁻¹ · мир(кость, t)        — у Mixamo
 *   поправка  = отн(покой, Mixamo)⁻¹ · отн(покой, наш) — разница поз покоя
 *   цель(t)   = мир(наша грудь, покой) · отн(t) · поправка
 *   локальный = мир(родитель, t)⁻¹ · цель(t)
 *
 * Поправка нужна потому, что позы покоя разные: у Mixamo руки в стороны
 * (T-поза), у нас опущены. Без неё персонаж на первом же кадре растопыривался
 * бы крестом. Проверка на месте: подставь в формулу позу покоя — получишь
 * ровно нашу позу покоя, кадр в кадр.
 */

/**
 * Заглушка DOM: FBXLoader заводит img под каждую текстуру, а в node его нет.
 * То же самое делает prepare-gnome.ts — см. docs/assets.md.
 */
(globalThis as unknown as { document: unknown }).document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};

import { NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Object3D, Quaternion as Quat } from 'three';

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'C:/Users/Wprot/OneDrive/Рабочий стол/Bow_Animation/Standing Draw Arrow.fbx';
const MODEL = resolve(ROOT, 'packages/client/public/models/hands.glb');

/** Имя нового клипа. Приставка rig| — как у остальных: так их пишет экспортёр. */
const CLIP_NAME = 'rig|Bow_Draw';

/** Частота выборки. Тридцати кадров руке хватает: она не дрожит. */
const FPS = 30;

/**
 * Кого куда переносим.
 *
 * Только руки и пальцы: ноги и голова у нас не видны, а корпус обязан
 * остаться в покое — см. заголовок. Наши кости ищутся по началу имени,
 * потому что экспортёр дописывает к ним номера.
 */
const MAP: [string, string][] = [];
for (const [mix, ours] of [
  ['Shoulder', 'DEF-shoulder'],
  ['Arm', 'DEF-upper_arm'],
  ['ForeArm', 'DEF-forearm'],
  ['Hand', 'DEF-hand'],
] as const) {
  MAP.push([`mixamorigLeft${mix}`, `${ours}L`], [`mixamorigRight${mix}`, `${ours}R`]);
}
for (const [mixFinger, ourFinger] of [
  ['Thumb', 'thumb0'],
  ['Index', 'f_index0'],
  ['Middle', 'f_middle0'],
  ['Ring', 'f_ring0'],
  ['Pinky', 'f_pinky0'],
] as const) {
  for (const joint of [1, 2, 3]) {
    MAP.push(
      [`mixamorigLeftHand${mixFinger}${joint}`, `DEF-${ourFinger}${joint}L`],
      [`mixamorigRightHand${mixFinger}${joint}`, `DEF-${ourFinger}${joint}R`],
    );
  }
}

const ourNameOf = new Map(MAP);

// ---------- чужой скелет ----------

const raw = readFileSync(SOURCE);
const fbx = new FBXLoader().parse(
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
  '',
);
const clip = fbx.animations[0];
if (!clip) throw new Error('в исходнике нет анимации');

const mixBones = new Map<string, Object3D>();
fbx.traverse((node) => {
  if ((node as unknown as { isBone?: boolean }).isBone) mixBones.set(node.name, node);
});
console.log(`исходник: клип «${clip.name}», ${clip.duration.toFixed(2)} с, костей ${mixBones.size}`);

/** Грудь: от неё считается всё остальное. Плечи растут именно из неё. */
const mixChest = mixBones.get('mixamorigSpine2') ?? mixBones.get('mixamorigSpine1');
if (!mixChest) throw new Error('у исходника нет груди — переносить не от чего');

/** Поза покоя чужого скелета: мировые повороты до всякой анимации. */
fbx.updateMatrixWorld(true);
const mixRest = new Map<string, Quat>();
for (const [name, bone] of mixBones) {
  mixRest.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
}
const mixChestRest = mixRest.get(mixChest.name)!;

/**
 * Проигрываем клип три десятка раз в секунду и снимаем мировые повороты.
 *
 * Через AnimationMixer, а не разбором дорожек руками: интерполяция ключей
 * и порядок применения у three уже написаны и проверены.
 */
const mixer = new THREE.AnimationMixer(fbx);
mixer.clipAction(clip).play();

const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
const times: number[] = [];
const mixWorld: Map<string, Quat>[] = [];
const chestWorld: Quat[] = [];

for (let frame = 0; frame < frames; frame++) {
  const time = (frame / (frames - 1)) * clip.duration;
  mixer.setTime(time);
  fbx.updateMatrixWorld(true);

  const shot = new Map<string, Quat>();
  for (const [name, bone] of mixBones) {
    shot.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
  }
  mixWorld.push(shot);
  chestWorld.push(mixChest.getWorldQuaternion(new THREE.Quaternion()));
  times.push(time);
}

// ---------- наш скелет ----------

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const document = await io.read(MODEL);
const root = document.getRoot();

/**
 * Наши кости по имени без номера.
 *
 * Экспортёр дописывает к каждому имени порядковый номер, и он меняется
 * от сборки к сборке — опираться на него нельзя.
 */
const byPrefix = new Map<string, Node>();
for (const node of root.listNodes()) {
  const name = node.getName().replace(/_\d+$/, '');
  if (!byPrefix.has(name)) byPrefix.set(name, node);
}

const parentOf = new Map<Node, Node>();
for (const node of root.listNodes()) {
  for (const child of node.listChildren()) parentOf.set(child, node);
}

/** Мировой поворот нашей кости в покое. Считается вверх по родителям. */
function restWorld(node: Node): Quat {
  const chain: Node[] = [];
  for (let current: Node | undefined = node; current; current = parentOf.get(current)) {
    chain.unshift(current);
  }
  const world = new THREE.Quaternion();
  for (const link of chain) {
    const [x, y, z, w] = link.getRotation();
    world.multiply(new THREE.Quaternion(x, y, z, w));
  }
  return world;
}

const ourChest = byPrefix.get('DEF-spine004') ?? byPrefix.get('DEF-spine003');
if (!ourChest) throw new Error('у наших рук не нашлось груди');
const ourChestRest = restWorld(ourChest);

// ---------- перенос ----------

interface Retarget {
  mixName: string;
  node: Node;
  /** Поправка на разницу поз покоя: без неё T-поза лезет в кадр. */
  fix: Quat;
  locals: Quat[];
}

const targets: Retarget[] = [];
const missing: string[] = [];

for (const [mixName, ourName] of MAP) {
  const node = byPrefix.get(ourName);
  const rest = mixRest.get(mixName);
  if (!node || !rest) {
    missing.push(`${mixName} → ${ourName}`);
    continue;
  }

  const restRelMix = mixChestRest.clone().invert().multiply(rest);
  const restRelOurs = ourChestRest.clone().invert().multiply(restWorld(node));

  targets.push({
    mixName,
    node,
    fix: restRelMix.clone().invert().multiply(restRelOurs),
    locals: [],
  });
}
if (missing.length > 0) console.log(`не нашлось пар: ${missing.length} — ${missing.join(', ')}`);
console.log(`переносим костей: ${targets.length}`);

const retargeted = new Set(targets.map((target) => target.node));

/**
 * Кадр за кадром: считаем цель в мире, потом вычитаем родителя.
 *
 * Родителя берём **уже пересчитанного**, если он тоже в списке: иначе кисть
 * считалась бы от покоящегося предплечья и уезжала бы вслед за ним дважды.
 */
const worldByNode = new Map<Node, Quat>();

for (let frame = 0; frame < frames; frame++) {
  worldByNode.clear();

  for (const target of targets) {
    const relMix = chestWorld[frame]!.clone().invert().multiply(mixWorld[frame]!.get(target.mixName)!);
    const world = ourChestRest.clone().multiply(relMix).multiply(target.fix);
    worldByNode.set(target.node, world);

    let parentWorld = new THREE.Quaternion();
    for (
      let parent: Node | undefined = parentOf.get(target.node);
      parent;
      parent = parentOf.get(parent)
    ) {
      // Родитель, который тоже переносится, уже посчитан в этом кадре;
      // родитель вне списка стоит в покое, и его поворот берётся из покоя.
      const computed = worldByNode.get(parent);
      if (computed || !retargeted.has(parent)) {
        parentWorld = computed ?? restWorld(parent);
        break;
      }
    }

    target.locals.push(parentWorld.clone().invert().multiply(world));
  }
}

// ---------- запись клипа ----------

for (const existing of root.listAnimations()) {
  // Пересборка заменяет клип, а не плодит второй с тем же именем.
  if (existing.getName() === CLIP_NAME) existing.dispose();
}

const animation = document.createAnimation(CLIP_NAME);
const buffer = root.listBuffers()[0]!;
const input = document
  .createAccessor(`${CLIP_NAME}-time`)
  .setArray(new Float32Array(times))
  .setType('SCALAR')
  .setBuffer(buffer);

for (const target of targets) {
  const values = new Float32Array(target.locals.length * 4);
  for (const [index, quat] of target.locals.entries()) {
    values.set([quat.x, quat.y, quat.z, quat.w], index * 4);
  }

  const output = document
    .createAccessor(`${CLIP_NAME}-${target.node.getName()}`)
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
      .setTargetNode(target.node)
      .setTargetPath('rotation')
      .setSampler(sampler),
  );
}

await io.write(MODEL, document);
console.log(
  `готово: ${CLIP_NAME} — ${frames} кадров, ${(statSync(MODEL).size / 1048576).toFixed(2)} МБ`,
);
