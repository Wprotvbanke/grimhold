import * as THREE from 'three';

/**
 * Анимации скелета, собранные кодом.
 *
 * Сделаны под покадровую съёмку из старых фильмов — тех самых, где скелеты
 * Рэя Харрихаузена дёргано наступают с мечами. Приём там простой: куклу
 * переставляют руками и снимают по кадру, поэтому движение идёт скачками,
 * а между позами нет никакого плавного перехода.
 *
 * Отсюда два решения, которые и делают весь вид:
 *
 *   1. **Ступенчатая интерполяция** (`InterpolateDiscrete`). Поза держится
 *      до следующего ключа и меняется скачком. Обычная плавная интерполяция
 *      мгновенно превращает это в гладкую компьютерную анимацию.
 *   2. **Низкая частота ключей** — девять в секунду вместо шестидесяти.
 *
 * Плюс мелкая дрожь в каждой позе: руки кукольника не попадают дважды в одно
 * и то же положение, и именно эта неточность читается как «снято на плёнку».
 *
 * ## Оси берутся из модели, а не из мира
 *
 * Скелет экспортирован повёрнутым: его плечи лежат вдоль Z, а не поперёк.
 * Пока оси задавались мировыми (`наклон вперёд — вокруг X`), модель кренилась
 * вбок вместо наклона, а падение не работало вовсе. Поэтому оси считаются
 * по самому телу: линия плеч задаёт «лево-право», из неё выводится «вперёд».
 * Локальные оси костей для этого не годятся — у каждого рига они свои.
 */

/** Кадров в секунду у «съёмки». Ниже — слайд-шоу, выше — пропадает эффект. */
const FPS = 9;

/** Насколько кукла не попадает в одну и ту же позу, радианы. */
const JITTER = 0.035;

/** Оси тела: вокруг них и вращаются кости. */
interface BodyAxes {
  /** Мах вперёд-назад — вокруг линии плеч. */
  pitch: THREE.Vector3;
  /** Наклон вбок. */
  roll: THREE.Vector3;
  /** Разворот. */
  yaw: THREE.Vector3;
}

type AxisName = keyof BodyAxes;

/** Повторяемый шум — чтобы все скелеты дёргались одинаково, а не вразнобой. */
function noise(seed: number): number {
  const value = Math.sin(seed * 127.1) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

/**
 * `Bip01_L_Thigh_02` → `L_Thigh`, `_rootJoint` → `Root`.
 *
 * Корень важен отдельно: у этого рига таз и позвоночник — не родитель
 * с потомком, а два брата на общем корне. Поворот таза двигает только ноги,
 * поэтому всё, что должно валить или качать тело целиком, вешается на `Root`.
 */
function shortName(name: string): string {
  if (/rootjoint/i.test(name) || /^Bip\d*$/i.test(name)) return 'Root';
  return name.replace(/^Bip\d*_/i, '').replace(/_\d+$/, '');
}

export function boneMap(root: THREE.Object3D): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  root.traverse((node) => {
    const bone = node as THREE.Bone;
    if (!bone.isBone) return;
    const short = shortName(bone.name);
    if (!bones.has(short)) bones.set(short, bone);
  });
  return bones;
}

/**
 * Оси тела по линии плеч.
 *
 * Если плеч не нашлось, остаётся привычная раскладка «лицом к -Z»: она верна
 * для моделей, экспортированных как положено.
 */
export function bodyAxes(bones: Map<string, THREE.Bone>): BodyAxes {
  const up = new THREE.Vector3(0, 1, 0);
  const left = bones.get('L_UpperArm');
  const right = bones.get('R_UpperArm');

  if (!left || !right) {
    return { pitch: new THREE.Vector3(1, 0, 0), roll: new THREE.Vector3(0, 0, 1), yaw: up };
  }

  // Вычитание идёт от левой кости к правой, а не наоборот: кости L и R в этом
  // риге названы с точки зрения зрителя, и «лицо» у модели там, где по именам
  // должна быть спина. Иначе шаг и падение уходили бы назад.
  const across = right
    .getWorldPosition(new THREE.Vector3())
    .sub(left.getWorldPosition(new THREE.Vector3()))
    .setY(0)
    .normalize();

  // «Вперёд» — перпендикуляр к линии плеч. Знак roll подобран так, чтобы
  // положительные углы означали то же, что и у обычной модели лицом к -Z.
  const forward = new THREE.Vector3().crossVectors(up, across).normalize();

  return { pitch: across, roll: forward.clone().negate(), yaw: up };
}

/**
 * Доворачивает таз так, чтобы ноги смотрели туда же, куда корпус.
 *
 * В этом риге нижняя половина развёрнута: кости бёдер разнесены поперёк той
 * оси, вдоль которой разнесены плечи, — ноги оказываются одна за другой, а не
 * рядом, и скелет ходит враскоряку. Угол не подбирается на глаз: он считается
 * как разница между линией бёдер и линией плеч, поэтому перекос выправляется
 * любой величины.
 *
 * Вызывать надо до сборки клипов — они строятся от позы привязки.
 */
export function alignHips(bones: Map<string, THREE.Bone>): number {
  const pelvis = bones.get('Pelvis');
  const leftLeg = bones.get('L_Thigh');
  const rightLeg = bones.get('R_Thigh');
  const leftArm = bones.get('L_UpperArm');
  const rightArm = bones.get('R_UpperArm');
  if (!pelvis || !leftLeg || !rightLeg || !leftArm || !rightArm) return 0;

  const line = (a: THREE.Bone, b: THREE.Bone): THREE.Vector3 =>
    a
      .getWorldPosition(new THREE.Vector3())
      .sub(b.getWorldPosition(new THREE.Vector3()))
      .setY(0)
      .normalize();

  const hips = line(leftLeg, rightLeg);
  const shoulders = line(leftArm, rightArm);
  if (hips.lengthSq() < 0.5 || shoulders.lengthSq() < 0.5) return 0;

  // Угол со знаком: куда и насколько довернуть бёдра до линии плеч.
  const turn = Math.atan2(
    new THREE.Vector3().crossVectors(hips, shoulders).y,
    hips.dot(shoulders),
  );
  if (Math.abs(turn) < 0.05) return 0;

  const up = new THREE.Vector3(0, 1, 0);
  const parentWorld = new THREE.Quaternion();
  (pelvis.parent ?? pelvis).getWorldQuaternion(parentWorld);
  const world = pelvis.getWorldQuaternion(new THREE.Quaternion());

  pelvis.quaternion
    .copy(parentWorld.invert())
    .multiply(new THREE.Quaternion().setFromAxisAngle(up, turn))
    .multiply(world);
  pelvis.updateMatrixWorld(true);

  return turn;
}

/**
 * Дорожка поворотов кости: углы отсчитываются от позы привязки вокруг оси тела.
 */
function rotationTrack(
  bone: THREE.Bone,
  axis: THREE.Vector3,
  angles: number[],
  seed: number,
): THREE.KeyframeTrack {
  const parentWorld = new THREE.Quaternion();
  (bone.parent ?? bone).getWorldQuaternion(parentWorld);
  const inverseParent = parentWorld.invert();
  const boneWorld = bone.getWorldQuaternion(new THREE.Quaternion());

  const times: number[] = [];
  const values: number[] = [];
  const turn = new THREE.Quaternion();
  const result = new THREE.Quaternion();

  angles.forEach((angle, index) => {
    times.push(index / FPS);

    turn.setFromAxisAngle(axis, angle + JITTER * noise(seed + index * 3.7));
    result.copy(inverseParent).multiply(turn).multiply(boneWorld);

    values.push(result.x, result.y, result.z, result.w);
  });

  const track = new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values);
  // Вот она, вся суть: поза держится до следующего ключа и меняется рывком.
  track.setInterpolation(THREE.InterpolateDiscrete);
  return track;
}

/**
 * Дорожка смещений кости по мировому направлению.
 *
 * Перевод идёт через матрицу родителя целиком, а не через один поворот:
 * у костей этой модели родитель ещё и масштабирован, и смещение, посчитанное
 * без масштаба, оказывалось в сотню раз меньше нужного — таз «опускался»,
 * не двигаясь с места.
 */
function offsetTrack(
  bone: THREE.Bone,
  direction: THREE.Vector3,
  amounts: number[],
): THREE.KeyframeTrack {
  const parent = bone.parent ?? bone;
  const toLocal = new THREE.Matrix4().copy(parent.matrixWorld).invert();

  const origin = bone.getWorldPosition(new THREE.Vector3());
  const base = origin.clone().applyMatrix4(toLocal);
  const shifted = origin.clone().add(direction).applyMatrix4(toLocal);
  const step = shifted.sub(base);

  const times: number[] = [];
  const values: number[] = [];

  amounts.forEach((amount, index) => {
    times.push(index / FPS);
    values.push(
      bone.position.x + step.x * amount,
      bone.position.y + step.y * amount,
      bone.position.z + step.z * amount,
    );
  });

  const track = new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values);
  track.setInterpolation(THREE.InterpolateDiscrete);
  return track;
}

/** Ряд углов для одной кости: по одному значению на кадр. */
interface Pose {
  bone: string;
  axis: AxisName;
  angles: number[];
}

/** Собирает клип из поз. Ряды — это и есть раскадровка. */
function buildClip(
  bones: Map<string, THREE.Bone>,
  name: string,
  poses: Pose[],
  frames: number,
): THREE.AnimationClip {
  const axes = bodyAxes(bones);
  const tracks: THREE.KeyframeTrack[] = [];

  poses.forEach((pose, index) => {
    const bone = bones.get(pose.bone);
    if (!bone) return;
    tracks.push(rotationTrack(bone, axes[pose.axis], pose.angles, index * 11.3));
  });

  return new THREE.AnimationClip(name, frames / FPS, tracks);
}

/**
 * Ходьба: восемь кадров, тяжёлый костяной шаг.
 *
 * Ноги идут в противофазе, руки — навстречу ногам, корпус переваливается.
 * Колено подгибается только на проносе: у Харрихаузена скелеты шагают жёстко,
 * почти на прямых ногах, и это как раз читается как «не живое».
 */
export function walkClip(bones: Map<string, THREE.Bone>): THREE.AnimationClip {
  const swing = [0.5, 0.3, -0.1, -0.4, -0.5, -0.3, 0.1, 0.4];
  const knee = [-0.1, -0.05, -0.5, -0.8, -0.6, -0.2, -0.05, -0.1];
  const shift = (row: number[], by: number): number[] =>
    row.map((_, i) => row[(i + by) % row.length]!);

  const clip = buildClip(
    bones,
    'Walk',
    [
      { bone: 'L_Thigh', axis: 'pitch', angles: swing },
      { bone: 'R_Thigh', axis: 'pitch', angles: shift(swing, 4) },
      { bone: 'L_Calf', axis: 'pitch', angles: knee },
      { bone: 'R_Calf', axis: 'pitch', angles: shift(knee, 4) },
      // Руки навстречу ногам, иначе походка разваливается.
      { bone: 'L_UpperArm', axis: 'pitch', angles: shift(swing, 4).map((a) => a * 0.55) },
      { bone: 'R_UpperArm', axis: 'pitch', angles: swing.map((a) => a * 0.55) },
      { bone: 'L_Forearm', axis: 'pitch', angles: swing.map((a) => -0.35 - a * 0.2) },
      { bone: 'R_Forearm', axis: 'pitch', angles: shift(swing, 4).map((a) => -0.35 - a * 0.2) },
      // Таз переваливается с ноги на ногу, плечи отыгрывают в другую сторону.
      { bone: 'Root', axis: 'roll', angles: [0.06, 0.04, -0.02, -0.06, -0.06, -0.04, 0.02, 0.06] },
      { bone: 'Spine2', axis: 'yaw', angles: [-0.12, -0.06, 0.06, 0.12, 0.12, 0.06, -0.06, -0.12] },
      { bone: 'Head1', axis: 'pitch', angles: [0.05, 0.1, 0.05, 0, 0.05, 0.1, 0.05, 0] },
    ],
    8,
  );

  // Тяжёлая поступь: на каждом шаге скелет слегка проседает. Без этого он
  // едет по земле, будто его тянут за верёвочку.
  const root = bones.get('Root');
  if (root) {
    clip.tracks.push(
      offsetTrack(root, new THREE.Vector3(0, -0.05, 0), [0, 0.4, 0.9, 0.4, 0, 0.4, 0.9, 0.4]),
    );
  }

  return clip;
}

/**
 * Стойка: почти неподвижно, но кукла «дышит» — покачивается и поводит черепом.
 * Полностью замерший моб выглядит сломанным, а не грозным.
 */
export function idleClip(bones: Map<string, THREE.Bone>): THREE.AnimationClip {
  return buildClip(
    bones,
    'Idle',
    [
      { bone: 'Root', axis: 'roll', angles: [0, 0.02, 0.03, 0.02, 0, -0.02, -0.03, -0.02] },
      { bone: 'Spine1', axis: 'pitch', angles: [0.02, 0.03, 0.04, 0.03, 0.02, 0.01, 0, 0.01] },
      { bone: 'Head1', axis: 'yaw', angles: [0, 0, 0.18, 0.18, 0.1, 0, -0.15, -0.05] },
      { bone: 'L_UpperArm', axis: 'pitch', angles: [0, 0, 0, 0.05, 0.05, 0, 0, 0] },
      { bone: 'R_UpperArm', axis: 'pitch', angles: [0, 0.05, 0.05, 0, 0, 0, 0.04, 0] },
    ],
    16,
  );
}

/**
 * Удар: замах через голову и рубящий бросок корпусом.
 *
 * Кадры нарочно неравномерны по смыслу — долгий замах и мгновенный удар.
 * Длительность подгоняется под замах моба на сервере в `models.ts`, чтобы
 * попадание совпадало с картинкой.
 */
export function attackClip(bones: Map<string, THREE.Bone>): THREE.AnimationClip {
  return buildClip(
    bones,
    'Attack',
    [
      { bone: 'R_UpperArm', axis: 'pitch', angles: [0, -0.9, -1.9, -2.3, -2.2, 0.6, 1.0, 0.3, 0] },
      { bone: 'R_Forearm', axis: 'pitch', angles: [0, -0.5, -1.1, -1.4, -1.3, -0.2, -0.1, -0.2, -0.1] },
      { bone: 'Spine2', axis: 'yaw', angles: [0, -0.15, -0.3, -0.35, -0.35, 0.3, 0.35, 0.15, 0] },
      { bone: 'Head1', axis: 'yaw', angles: [0, -0.1, -0.2, -0.2, -0.2, 0.15, 0.2, 0.1, 0] },
      { bone: 'L_UpperArm', axis: 'pitch', angles: [0, 0.2, 0.4, 0.5, 0.5, -0.3, -0.4, -0.2, 0] },
      // Шаг вперёд под удар — вес переносится на переднюю ногу.
      { bone: 'L_Thigh', axis: 'pitch', angles: [0, 0.1, 0.2, 0.3, 0.3, 0.45, 0.4, 0.2, 0] },
      { bone: 'R_Thigh', axis: 'pitch', angles: [0, -0.05, -0.1, -0.2, -0.2, -0.35, -0.3, -0.15, 0] },
    ],
    9,
  );
}

/**
 * Получение урона: короткий рывок назад всем корпусом и запрокинутый череп.
 * Четыре кадра — больше и не надо, удар должен читаться мгновенно.
 */
export function hurtClip(bones: Map<string, THREE.Bone>): THREE.AnimationClip {
  return buildClip(
    bones,
    'Hurt',
    [
      { bone: 'Spine1', axis: 'pitch', angles: [-0.45, -0.3, -0.12, 0] },
      { bone: 'Head1', axis: 'pitch', angles: [-0.5, -0.35, -0.1, 0] },
      { bone: 'L_UpperArm', axis: 'pitch', angles: [-0.6, -0.4, -0.15, 0] },
      { bone: 'R_UpperArm', axis: 'pitch', angles: [-0.5, -0.35, -0.1, 0] },
      { bone: 'Root', axis: 'pitch', angles: [-0.16, -0.1, -0.04, 0] },
      { bone: 'L_Thigh', axis: 'pitch', angles: [-0.25, -0.15, -0.05, 0] },
    ],
    4,
  );
}

/**
 * Смерть: скелет подламывается и падает.
 *
 * Держится один кадр — будто ещё не понял, что всё, — потом уходят колени,
 * проседает таз, и тело валится вперёд. Кости остаются вместе: разлёт врозь
 * выглядел мешаниной, а не гибелью.
 *
 * Уложиться надо в первые секунды: дальше игра сама утягивает тело под землю
 * (`CORPSE_SECONDS` в shared, `animateCorpse` в main.ts).
 */
export function deathClip(bones: Map<string, THREE.Bone>): THREE.AnimationClip {
  const clip = buildClip(
    bones,
    'Death',
    [
      // Ноги уходят первыми — с них и начинается падение.
      { bone: 'L_Calf', axis: 'pitch', angles: [0, -0.4, -1.2, -1.9, -2.2, -2.3, -2.3, -2.3] },
      { bone: 'R_Calf', axis: 'pitch', angles: [0, -0.3, -1.0, -1.8, -2.2, -2.3, -2.3, -2.3] },
      { bone: 'L_Thigh', axis: 'pitch', angles: [0, 0.15, 0.5, 0.9, 1.2, 1.3, 1.35, 1.35] },
      { bone: 'R_Thigh', axis: 'pitch', angles: [0, 0.1, 0.45, 0.85, 1.15, 1.3, 1.35, 1.35] },
      // Корпус кренится вперёд и ложится.
      { bone: 'Root', axis: 'pitch', angles: [0, -0.1, -0.45, -0.95, -1.35, -1.55, -1.6, -1.6] },
      { bone: 'Spine1', axis: 'pitch', angles: [0, -0.05, -0.2, -0.35, -0.3, -0.15, -0.1, -0.1] },
      { bone: 'Spine2', axis: 'roll', angles: [0, 0.05, 0.12, 0.2, 0.26, 0.3, 0.3, 0.3] },
      // Череп запрокидывается и обвисает.
      { bone: 'Head1', axis: 'pitch', angles: [0, 0.25, 0.45, 0.2, -0.25, -0.5, -0.55, -0.55] },
      // Руки безвольно выбрасывает вперёд.
      { bone: 'L_UpperArm', axis: 'pitch', angles: [0, -0.2, -0.6, -1.1, -1.5, -1.7, -1.75, -1.75] },
      { bone: 'R_UpperArm', axis: 'pitch', angles: [0, -0.15, -0.5, -1.0, -1.45, -1.7, -1.75, -1.75] },
      { bone: 'L_Forearm', axis: 'pitch', angles: [0, -0.1, -0.3, -0.5, -0.65, -0.7, -0.7, -0.7] },
      { bone: 'R_Forearm', axis: 'pitch', angles: [0, -0.1, -0.25, -0.45, -0.6, -0.7, -0.7, -0.7] },
    ],
    8,
  );

  // Тело оседает к земле: без этого скелет кренится, оставаясь на своей высоте.
  const root = bones.get('Root');
  if (root) {
    clip.tracks.push(
      offsetTrack(
        root,
        // Ровно столько, чтобы лечь на землю: с большим тело уходит в пол,
        // а его ещё утягивать вниз при растворении.
        new THREE.Vector3(0, -0.34, 0),
        [0, 0.06, 0.27, 0.6, 0.85, 0.97, 1, 1],
      ),
    );
  }

  return clip;
}
