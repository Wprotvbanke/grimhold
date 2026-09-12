/**
 * Подготовка модели рук к вебу.
 *
 *   npx tsx scripts/prepare-arms.ts
 *
 * Руки видно всегда, поэтому они грузятся при входе в мир — и весить десять
 * с лишним мегабайт не могут. Почти весь вес в текстурах: на экране руки
 * занимают угол кадра, и двух тысяч пикселей им не нужно никогда.
 *
 * Анимации (стойка, ходьба, бег, удары) остаются как есть — они и есть
 * главная ценность этой модели.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, resample, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const INPUT = resolve(ROOT, 'assets/source/hands_raw.glb');
const OUTPUT = resolve(ROOT, 'packages/client/public/models/hands.glb');

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} МБ`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const document = await io.read(INPUT);
const root = document.getRoot();

/**
 * Из сцены автора приезжает лишняя геометрия: фон-плоскость позади рук
 * и небо. В игре фон висит прямо перед камерой и закрывает весь обзор.
 *
 * Убираем всё, что не привязано к скелету: руки скиннуты, а подставки
 * и задники — нет. Это надёжнее списка имён, который приходится дополнять
 * после каждой новой модели.
 */
let backdrops = 0;
for (const node of root.listNodes()) {
  if (node.getMesh() === null || node.getSkin() !== null) continue;
  node.setMesh(null);
  backdrops++;
}
console.log(`убрано лишней геометрии из сцены автора: ${backdrops}`);

/**
 * Клипы, которые игра действительно проигрывает. Остальные — второй вариант
 * бега, осмотр и убирание рук — весят столько же, сколько нужные: анимация
 * идёт по сотням костей, и каждый лишний клип это сотни дорожек.
 */
const USED_CLIPS = /(Equip|Idle|Idle_Fidget|Walk|Sprint_Type_1|Punch_R|Punch_L|Block_|Take_)/i;

for (const animation of root.listAnimations()) {
  if (!USED_CLIPS.test(animation.getName())) animation.dispose();
}

/**
 * Дорожки, которые ни на что не влияют.
 *
 * В риге больше тысячи костей, а кожу двигают лишь те, что перечислены
 * в скине, и их предки. Остальные — служебные: цели обратной кинематики,
 * маркеры, вспомогательные оси. В Blender они управляют позой через связи,
 * но в glTF связей нет — поза уже запечена, и эти дорожки просто вес.
 */
const driving = new Set<unknown>();
for (const skin of root.listSkins()) {
  for (const joint of skin.listJoints()) {
    let node: ReturnType<typeof skin.listJoints>[number] | null = joint;
    while (node && !driving.has(node)) {
      driving.add(node);
      node = node.listParents().find((parent) => parent.propertyType === 'Node') as typeof node;
    }
  }
}

let dropped = 0;
for (const animation of root.listAnimations()) {
  for (const channel of animation.listChannels()) {
    const target = channel.getTargetNode();
    if (target && !driving.has(target)) {
      channel.dispose();
      dropped++;
    }
  }
}
console.log(`выброшено дорожек, ничего не двигающих: ${dropped}`);

const before = root.listTextures().map((t) => t.getSize()?.join('×') ?? '?');
console.log(`исходник: ${megabytes(statSync(INPUT).size)}, текстуры ${before.join(', ')}`);

await document.transform(
  // Прореживает ключи: экспорт из Blender пишет их на каждый кадр, даже
  // когда кость почти не двигается. Допуск выбран на глаз по весу — руки
  // занимают угол экрана, и доли градуса там неразличимы.
  resample({ tolerance: 0.002 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }),
  dedup(),
  prune(),
  draco(),
);

await io.write(OUTPUT, document);

const after = root.listTextures().map((t) => t.getSize()?.join('×') ?? '?');
console.log(`результат: ${megabytes(statSync(OUTPUT).size)}, текстуры ${after.join(', ')}`);
console.log(`выигрыш по весу: в ${(statSync(INPUT).size / statSync(OUTPUT).size).toFixed(1)} раза`);
