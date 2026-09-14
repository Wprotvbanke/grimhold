import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RACES } from '@grimhold/shared';

/**
 * Витрина: пробная модель на площади, которая стоит и по очереди играет
 * свои клипы.
 *
 * Нужна, чтобы посмотреть новую модель и анимации **в мире** — под нашим
 * светом, рядом с Громи и мостовой, — а не только на сером фоне model.html.
 * Сервер о витрине не знает: это картинка, как декорация, у неё нет ни
 * столкновений, ни подписи. Проверили модель — витрину убирают или делают
 * из модели настоящего жителя.
 *
 * Сейчас здесь пробный дворф (`scripts/prepare-dwarf-test.ts`).
 */

const URL = '/models/dwarf_test.glb';

/** Середина маршрута Громи: он обходит витрину кругом и всегда рядом. */
const SPOT = { x: -3, y: 0, z: 4 };

/** Лицом к югу площади, откуда подходят из таверны. */
const FACING = 0;

/**
 * Порядок показа. Между клипами — стойка: так видно, как модель входит
 * в движение и выходит из него, а не только само движение.
 * `seconds: null` — клип играется один раз целиком.
 */
const PROGRAM: { clip: string; seconds: number | null }[] = [
  { clip: 'Idle', seconds: 2 },
  { clip: 'Kick', seconds: null },
  { clip: 'Idle', seconds: 2 },
  { clip: 'Run', seconds: 3 },
];

/** Сколько секунд один клип перетекает в другой. */
const BLEND = 0.25;

export interface Showcase {
  /** Каждый кадр. `visible: false` — под землёй витрины нет. */
  update(dt: number, visible: boolean): void;
}

export function createShowcase(scene: THREE.Scene): Showcase {
  const root = new THREE.Group();
  root.position.set(SPOT.x, SPOT.y, SPOT.z);
  root.rotation.y = FACING;
  scene.add(root);

  let mixer: THREE.AnimationMixer | null = null;
  const actions = new Map<string, THREE.AnimationAction>();
  let step = -1;
  let left = 0;
  let current: THREE.AnimationAction | null = null;

  function next(): void {
    step = (step + 1) % PROGRAM.length;
    const { clip, seconds } = PROGRAM[step]!;
    const action = actions.get(clip);
    if (!action) {
      left = 1;
      return;
    }
    const once = seconds === null;
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = once;
    action.reset().fadeIn(BLEND).play();
    if (current && current !== action) current.fadeOut(BLEND);
    current = action;
    // Однократный клип уступает место чуть раньше конца — на время перетекания.
    left = once ? Math.max(BLEND, action.getClip().duration - BLEND) : seconds;
  }

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);

  loader.load(
    URL,
    (gltf) => {
      const model = gltf.scene;
      // Рост — как у расы, по той же мерке, что у всех персонажей.
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const height = bounds.max.y - bounds.min.y;
      const scale = height > 0 ? RACES.dwarf.height / height : 1;
      model.scale.setScalar(scale);
      model.position.y = -bounds.min.y * scale;
      model.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) node.castShadow = true;
      });
      root.add(model);

      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
      console.info(`[витрина] ${URL}: ${gltf.animations.map((clip) => clip.name).join(', ')}`);
      next();
    },
    undefined,
    () => console.warn(`[витрина] не загрузилась ${URL}`),
  );

  return {
    update(dt, visible) {
      root.visible = visible;
      if (!mixer || !visible) return;
      mixer.update(dt);
      left -= dt;
      if (left <= 0) next();
    },
  };
}
