import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MOBS, RACES, type MobId, type Race } from '@grimhold/shared';
import { applyPs1Look } from './ps1.js';

/**
 * Загрузка и клонирование моделей персонажей и мобов.
 *
 * Модели: KayKit Adventurers и KayKit Skeletons (Kay Lousberg), лицензия CC0 —
 * см. public/models/LICENSE*.txt. Скелет и анимации общие для всего пака,
 * поэтому клоны разделяют геометрию и клипы, а миксеры у каждого свои.
 */

/** Файл модели на расу. Пока дворф; человек и эльф получат свои позже. */
const RACE_MODELS: Partial<Record<Race, string>> = {
  dwarf: '/models/dwarf.glb',
};

/** Файл модели на моба. Остальные пока блокаут. */
const MOB_MODELS: Partial<Record<MobId, string>> = {
  skeleton: '/models/skeleton.glb',
};

/** Каким моделям давать обработку в духе King's Field. */
const PS1_MODELS = new Set<string>(['/models/skeleton.glb']);

/**
 * Разворот модели вокруг вертикали.
 *
 * Наша симуляция считает «вперёд» направлением -Z (при yaw = 0), а экспортёр
 * Blender разворачивает персонажа лицом в +Z. Отсюда пол-оборота.
 * Если персонаж будет ходить спиной вперёд — менять надо ровно это число.
 */
const MODEL_YAW_OFFSET = Math.PI;

export type ClipName = 'idle' | 'walk' | 'attack' | 'death';

/** Имена клипов в паках KayKit. Один набор на все модели этих паков. */
const CLIPS: Record<ClipName, string[]> = {
  idle: ['Idle', 'Unarmed_Idle'],
  walk: ['Walking_A', 'Walking_B', 'Walking_C'],
  attack: ['1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Unarmed_Melee_Attack_Punch_A'],
  death: ['Death_A', 'Death_B'],
};

export interface CharacterModel {
  /** Корень для добавления в сцену: модель уже отмасштабирована под рост. */
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  play(clip: ClipName): void;
  update(dt: number): void;
  /** Есть ли такой клип: смерть и атака есть не у всех моделей. */
  has(clip: ClipName): boolean;
}

const loader = new GLTFLoader();
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
  return buildModel(url, MOBS[mobId].height);
}

async function loadSource(url: string): Promise<THREE.Group> {
  let pending = cache.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => {
      clips.set(url, gltf.animations);
      // Обработка делается один раз на исходнике: клоны её унаследуют.
      if (PS1_MODELS.has(url)) applyPs1Look(gltf.scene);
      return gltf.scene;
    });
    cache.set(url, pending);
  }
  return pending;
}

async function buildModel(url: string, targetHeight: number): Promise<CharacterModel> {
  const source = await loadSource(url);
  const model = cloneSkinned(source) as THREE.Group;

  // Приводим модель к нужному росту — тому же числу, по которому сервер
  // считает хитбокс. Иначе силуэт врал бы о том, куда попадёшь.
  const bounds = new THREE.Box3().setFromObject(model);
  const modelHeight = bounds.max.y - bounds.min.y;
  const scale = modelHeight > 0 ? targetHeight / modelHeight : 1;
  model.scale.setScalar(scale);

  // Ставим ноги ровно в ноль: позиция сущности на сервере — точка на полу.
  model.position.y = -bounds.min.y * scale;
  model.rotation.y = MODEL_YAW_OFFSET;

  const root = new THREE.Group();
  root.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const available = clips.get(url) ?? [];
  const actions = new Map<ClipName, THREE.AnimationAction>();

  for (const [name, candidates] of Object.entries(CLIPS) as [ClipName, string[]][]) {
    for (const candidate of candidates) {
      const clip = THREE.AnimationClip.findByName(available, candidate);
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
      }
      actions.set(name, action);
      break;
    }
  }

  let current: THREE.AnimationAction | null = null;
  let currentName: ClipName | null = null;

  return {
    root,
    mixer,
    has: (clip) => actions.has(clip),
    play(name) {
      if (name === currentName) return;
      const next = actions.get(name);
      if (!next) return;

      // Смерть перебивает всё и обратно не отыгрывается.
      if (currentName === 'death' && name !== 'death') return;

      next.reset().fadeIn(name === 'attack' ? 0.05 : 0.2).play();
      current?.fadeOut(name === 'death' ? 0.1 : 0.2);
      current = next;
      currentName = name;
    },
    update(dt) {
      mixer.update(dt);
    },
  };
}
