import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RACES } from '@grimhold/shared';

/**
 * Витрина: пробная модель на площади, которая бегает по дорожке и бьёт
 * на каждом краю — так видны все её клипы и переходы между ними.
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

/**
 * Концы дорожки — поперёк середины маршрута Громи: он обходит витрину
 * кругом и всегда рядом, а восьми метров хватает, чтобы разбежаться.
 */
const ENDS = [
  { x: -7, y: 0, z: 4 },
  { x: 1, y: 0, z: 4 },
] as const;

/**
 * Скорость бега, м/с. Клип нарисован на месте (корень в нём почти не
 * уходит), поэтому своей скорости не подсказывает — подобрано на глаз.
 */
const RUN_SPEED = 3.6;

/**
 * Порядок показа: добежал до края — остановился — ударил — развернулся
 * и бежит обратно. `seconds: null` у бега — до края, у удара — клип целиком.
 */
type Step =
  | { clip: 'Run' }
  | { clip: 'Idle'; seconds: number; turn: boolean }
  | { clip: 'Kick' };

const PROGRAM: Step[] = [
  { clip: 'Run' },
  { clip: 'Idle', seconds: 0.4, turn: false },
  { clip: 'Kick' },
  { clip: 'Idle', seconds: 0.6, turn: true },
];

/** Сколько секунд один клип перетекает в другой. */
const BLEND = 0.25;

/** Поворот вокруг вертикали, при котором модель смотрит из `from` на `to`. У glTF «вперёд» — +Z. */
function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Что дворф выкрикивает над головой — по кругу, по фразе на `LINE_SECONDS`.
 * Одно облачко, текст в нём сменяется: это один разговор, а не два.
 */
const LINES = [
  'Эта ведьма сливала что-то в канализацию, я видел!!',
  'Я вииидел это существо! Это мало похоже на крысу...',
];
const LINE_SECONDS = 7;
/** Дальше — облачко не показываем: над крошечной фигуркой оно заслоняет площадь. */
const BUBBLE_RANGE = 25;
/** Над макушкой, в метрах от земли. */
const BUBBLE_HEIGHT = RACES.dwarf.height + 0.35;

export interface Showcase {
  /** Каждый кадр. `visible: false` — под землёй витрины нет. */
  update(dt: number, visible: boolean, camera: THREE.Camera): void;
}

export function createShowcase(scene: THREE.Scene): Showcase {
  /**
   * Облачко реплики — DOM поверх кадра, как ники: текст в three пришлось бы
   * рисовать в текстуру, а здесь он чёткий на любом расстоянии.
   */
  const bubble = typeof document === 'undefined' ? null : document.createElement('div');
  if (bubble) {
    bubble.className = 'speech';
    bubble.style.display = 'none';
    (document.getElementById('labels') ?? document.body).append(bubble);
  }
  let spoken = 0;
  let line = -1;
  const projected = new THREE.Vector3();

  function speak(dt: number, visible: boolean, camera: THREE.Camera): void {
    if (!bubble) return;
    spoken += dt;
    const now = Math.floor(spoken / LINE_SECONDS) % LINES.length;
    if (now !== line) {
      line = now;
      bubble.textContent = LINES[now]!;
    }

    const far = Math.hypot(root.position.x - camera.position.x, root.position.z - camera.position.z) > BUBBLE_RANGE;
    projected.set(root.position.x, root.position.y + BUBBLE_HEIGHT, root.position.z).project(camera);
    if (!visible || far || projected.z > 1) {
      bubble.style.display = 'none';
      return;
    }
    bubble.style.display = 'block';
    bubble.style.left = `${((projected.x + 1) / 2) * innerWidth}px`;
    bubble.style.top = `${((1 - projected.y) / 2) * innerHeight}px`;
  }

  const root = new THREE.Group();
  root.position.set(ENDS[0].x, ENDS[0].y, ENDS[0].z);
  root.rotation.y = yawTowards(ENDS[0], ENDS[1]);
  scene.add(root);

  let mixer: THREE.AnimationMixer | null = null;
  const actions = new Map<string, THREE.AnimationAction>();
  let step = -1;
  let left = 0;
  let current: THREE.AnimationAction | null = null;
  /** К какому концу бежит сейчас — или побежит после разворота. */
  let target = 1;
  /** Поворот в начале и в конце разворота. */
  let turnFrom = 0;
  let turnTo = 0;
  let turnLength = 1;

  function next(): void {
    step = (step + 1) % PROGRAM.length;
    const program = PROGRAM[step]!;
    const action = actions.get(program.clip);
    if (!action) {
      left = 1;
      return;
    }
    const once = program.clip === 'Kick';
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = once;
    action.reset().fadeIn(BLEND).play();
    if (current && current !== action) current.fadeOut(BLEND);
    current = action;

    if (program.clip === 'Run') {
      // Бег кончается не по часам, а на краю — см. update.
      left = Infinity;
    } else if (program.clip === 'Kick') {
      // Однократный клип уступает место чуть раньше конца — на время перетекания.
      left = Math.max(BLEND, action.getClip().duration - BLEND);
    } else {
      left = program.seconds;
      if (program.turn) {
        target = 1 - target;
        turnFrom = root.rotation.y;
        turnTo = yawTowards(root.position, ENDS[target]!);
        // Кратчайшим путём, а не через полный оборот.
        turnTo = turnFrom + Math.atan2(Math.sin(turnTo - turnFrom), Math.cos(turnTo - turnFrom));
        turnLength = program.seconds;
      }
    }
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
    update(dt, visible, camera) {
      root.visible = visible;
      speak(dt, visible, camera);
      if (!mixer || !visible) return;
      mixer.update(dt);
      const program = PROGRAM[step];

      if (program?.clip === 'Run') {
        const end = ENDS[target]!;
        const dx = end.x - root.position.x;
        const dz = end.z - root.position.z;
        const distance = Math.hypot(dx, dz);
        const travel = RUN_SPEED * dt;
        if (travel >= distance) {
          root.position.set(end.x, end.y, end.z);
          next();
        } else {
          root.position.x += (dx / distance) * travel;
          root.position.z += (dz / distance) * travel;
        }
        return;
      }

      left -= dt;
      if (program?.clip === 'Idle' && program.turn) {
        const done = Math.min(1, 1 - left / turnLength);
        // Плавно в начале и в конце: разворот на месте, а не щелчок.
        const eased = done * done * (3 - 2 * done);
        root.rotation.y = turnFrom + (turnTo - turnFrom) * eased;
      }
      if (left <= 0) next();
    },
  };
}
