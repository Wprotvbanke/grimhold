import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MOBS, RACES, type MobId, type Race } from '@grimhold/shared';
import { alignHips, attackClip, boneMap, deathClip, hurtClip, idleClip, walkClip } from './stopmotion.js';

/**
 * Загрузка и клонирование моделей персонажей и мобов.
 *
 * Модели: KayKit Adventurers (Kay Lousberg), CC0 — см. public/models/LICENSE*.txt.
 * Человеческий скелет собирается отдельно в boneskeleton.ts: у него нет скина,
 * и анимация берётся из чужого рига. Арматура и клипы общие для исходника,
 * поэтому клоны разделяют геометрию и анимации, а миксеры у каждого свои.
 */

/** Файл модели на расу. Пока дворф; человек и эльф получат свои позже. */
const RACE_MODELS: Partial<Record<Race, string>> = {
  dwarf: '/models/dwarf.glb',
};

/** Файл модели на моба. Остальные пока рисуются примитивами из scene.ts. */
const MOB_MODELS: Partial<Record<MobId, string>> = {
  skeleton: '/models/skeleton_human.glb',
};

/**
 * Разворот модели вокруг вертикали.
 *
 * Наша симуляция считает «вперёд» направлением -Z (при yaw = 0), а экспортёр
 * Blender разворачивает персонажа лицом в +Z. Отсюда пол-оборота.
 * Если персонаж будет ходить спиной вперёд — менять надо ровно это число.
 */
const MODEL_YAW_OFFSET = Math.PI;

/**
 * Разворот для отдельных моделей, если их экспортировали иначе.
 *
 * Скелет собран повёрнутым на четверть оборота: его плечи лежат вдоль Z,
 * а не поперёк, то есть модель смотрит вдоль X. С общим разворотом он ходил
 * боком, а с четвертью оборота — спиной: кости L и R у этого рига названы
 * с точки зрения зрителя, а не персонажа, поэтому «лицо» оказалось сзади.
 * Отсюда три четверти.
 */
const MODEL_YAW: Partial<Record<MobId, number>> = {
  skeleton: -Math.PI / 2,
};

export type ClipName = 'idle' | 'walk' | 'attack' | 'hurt' | 'death';

/**
 * Имена клипов. Первый найденный побеждает, поэтому в списке сначала имена
 * KayKit, затем короткие имена Quaternius.
 */
const CLIPS: Record<ClipName, string[]> = {
  idle: ['Idle', 'Unarmed_Idle'],
  walk: ['Walking_A', 'Walking_B', 'Walking_C', 'Walk'],
  attack: [
    '1H_Melee_Attack_Chop',
    '2H_Melee_Attack_Chop',
    'Unarmed_Melee_Attack_Punch_A',
    'Attack',
  ],
  death: ['Death_A', 'Death_B', 'Death'],
  hurt: ['Hit_A', 'Hit_B', 'Hurt'],
};

/**
 * Ищет клип по имени.
 *
 * FBX2glTF склеивает имя арматуры с именем клипа: «EnemyArmature|EnemyArmature|
 * EnemyArmature|Attack». Поэтому после точного совпадения пробуем хвост после
 * последней вертикальной черты — иначе анимации молча не находятся и моб
 * стоит столбом.
 */
function findClip(available: THREE.AnimationClip[], name: string): THREE.AnimationClip | null {
  const exact = THREE.AnimationClip.findByName(available, name);
  if (exact) return exact;

  const wanted = name.toLowerCase();
  return (
    available.find((clip) => {
      const tail = clip.name.split('|').pop() ?? clip.name;
      return tail.toLowerCase() === wanted;
    }) ?? null
  );
}

export interface CharacterModel {
  /** Корень для добавления в сцену: модель уже отмасштабирована под рост. */
  root: THREE.Group;
  play(clip: ClipName): void;
  update(dt: number): void;
  /** Есть ли такой клип: смерть и атака есть не у всех моделей. */
  has(clip: ClipName): boolean;
}

const loader = new GLTFLoader();
// Скелет сжат Draco: декодер лежит локально, чтобы игра не зависела от CDN.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/draco/');
loader.setDRACOLoader(dracoLoader);
const cache = new Map<string, Promise<THREE.Group>>();
const clips = new Map<string, THREE.AnimationClip[]>();

export function hasModel(race: Race): boolean {
  return RACE_MODELS[race] !== undefined;
}

export function hasMobModel(mobId: MobId): boolean {
  return MOB_MODELS[mobId] !== undefined;
}

export function createCharacterModel(race: Race): Promise<CharacterModel | null> {
  const url = RACE_MODELS[race];
  if (!url) return Promise.resolve(null);
  return buildModel(url, RACES[race].height);
}

export function createMobModel(mobId: MobId): Promise<CharacterModel | null> {
  const url = MOB_MODELS[mobId];
  if (!url) return Promise.resolve(null);
  // Замах сервера задаёт темп клипа атаки: анимация должна кончаться ударом,
  // иначе моб машет в пустоту и бьёт когда-то потом.
  //
  // Скелет вдобавок переключает позы рывком: его анимации покадровые.
  return buildModel(
    url,
    MOBS[mobId].height,
    MOBS[mobId].windup,
    mobId === 'skeleton',
    MODEL_YAW[mobId],
  );
}

async function loadSource(url: string): Promise<THREE.Group> {
  let pending = cache.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => {
      const own = url === MOB_MODELS.skeleton ? skeletonClips(gltf) : gltf.animations;
      clips.set(url, own);
      return gltf.scene;
    });
    cache.set(url, pending);
  }
  return pending;
}

/**
 * Набор клипов скелета — весь собран кодом, см. stopmotion.ts.
 *
 * Готовых анимаций у модели нет: своя не про ходьбу, а перенесённая с чужого
 * рига выглядела слишком гладко. Здесь она нарочно дёрганая — под покадровую
 * съёмку старых фильмов, где скелеты двигаются рывками.
 */
function skeletonClips(gltf: { scene: THREE.Group }): THREE.AnimationClip[] {
  const bones = boneMap(gltf.scene);

  // У этого рига нижняя половина развёрнута относительно корпуса — ноги стоят
  // одна за другой. Выправляем до сборки клипов: они строятся от позы привязки.
  const turn = alignHips(bones);
  if (turn !== 0) {
    console.info(`[скелет] таз довёрнут на ${((turn * 180) / Math.PI).toFixed(0)}°`);
  }

  return [walkClip(bones), idleClip(bones), attackClip(bones), hurtClip(bones), deathClip(bones)];
}

async function buildModel(
  url: string,
  targetHeight: number,
  windup?: number,
  /**
   * Переключать позы рывком, без плавного перехода. Нужно покадровой
   * анимации: смешивание клипов сглаживает ровно ту дёрганость,
   * ради которой она и сделана.
   */
  snap = false,
  /** Разворот модели, если общий ей не подходит. */
  yaw = MODEL_YAW_OFFSET,
): Promise<CharacterModel> {
  const source = await loadSource(url);
  const model = cloneSkinned(source) as THREE.Group;

  // Приводим модель к нужному росту — тому же числу, по которому сервер
  // считает хитбокс. Иначе силуэт врал бы о том, куда попадёшь.
  //
  // Матрицы обновляем явно: свежий клон их ещё не считал, а по несчитанным
  // габариты выходят от балды — на скелете Quaternius получалось 127 метров
  // вместо трёх, и модель ужималась почти в точку.
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const modelHeight = bounds.max.y - bounds.min.y;
  const scale = modelHeight > 0 ? targetHeight / modelHeight : 1;
  model.scale.setScalar(scale);

  // Ставим ноги ровно в ноль: позиция сущности на сервере — точка на полу.
  model.position.y = -bounds.min.y * scale;
  model.rotation.y = yaw;

  const root = new THREE.Group();
  root.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const available = clips.get(url) ?? [];
  const actions = new Map<ClipName, THREE.AnimationAction>();

  for (const [name, candidates] of Object.entries(CLIPS) as [ClipName, string[]][]) {
    for (const candidate of candidates) {
      const clip = findClip(available, candidate);
      if (!clip) continue;

      const action = mixer.clipAction(clip);
      if (name === 'death') {
        // Смерть не зациклена и замирает в последней позе — это и есть тело.
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      if (name === 'attack') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        // Клип подгоняется под замах: у сервера он свой у каждого моба,
        // и расхождение здесь читается как «ударил, не занося руку».
        if (windup && clip.duration > 0) action.timeScale = clip.duration / (windup + 0.25);
      }
      if (name === 'hurt') {
        action.setLoop(THREE.LoopOnce, 1);
      }
      actions.set(name, action);
      break;
    }
  }

  let current: THREE.AnimationAction | null = null;
  let currentName: ClipName | null = null;

  return {
    root,
    has: (clip) => actions.has(clip),
    play(name) {
      // Повторный удар должен вздрагивать заново, даже если предыдущий
      // ещё не доиграл. Остальные состояния переключаются только при смене.
      if (name === currentName && name !== 'hurt') return;

      const next = actions.get(name);
      if (!next) return;

      // Смерть перебивает всё и обратно не отыгрывается.
      if (currentName === 'death' && name !== 'death') return;

      if (snap) {
        current?.stop();
        next.reset().play();
      } else {
        next.reset().fadeIn(name === 'attack' ? 0.05 : 0.2).play();
        current?.fadeOut(name === 'death' ? 0.1 : 0.2);
      }

      current = next;
      currentName = name;
    },
    update(dt) {
      mixer.update(dt);
    },
  };
}
