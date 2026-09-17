import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RACES, type Race } from '@grimhold/shared';

/**
 * Живой портрет персонажа: в арке рюкзака и во весь рост в лобби.
 *
 * Модель своей расы стоит в арке посреди слотов снаряжения и дышит — как
 * в старых ролевых играх, где на куклу вешают вещи. Это отдельный маленький
 * рендер на своём холсте, а не кадр из мира: у окна свой свет и своя камера,
 * и мглу подземелья он не наследует.
 *
 * Рисуется **только пока окно открыто** (`start`/`stop`): второй рендер
 * каждый кадр за закрытым окном — это пустая работа на каждой машине.
 *
 * Одна дверь на два места намеренно. Лобби (docs/lobby.md) показывает ту же
 * фигуру, только крупнее и в другом развороте, и заводить ради этого второй
 * рендер значило бы чинить свет и посадку дважды.
 */

/** Модель и клип портрета на расу. Клип один — стойка: кукла не танцует. */
const PORTRAITS: Record<Race, { url: string; clip: string }> = {
  human: { url: '/models/human_exhibit.glb', clip: 'Idle' },
  elf: { url: '/models/elf_exhibit.glb', clip: 'Idle' },
  dwarf: { url: '/models/dwarf_test.glb', clip: 'Idle' },
};

/** Разворот к зрителю в три четверти: анфас плоский, профиль прячет лицо. */
const TURN = -0.35;

/** Сколько роста помещается в кадр: запас сверху и снизу, чтобы не резать макушку. */
const FRAME = 1.12;

export interface PortraitOptions {
  /** Разворот фигуры, радианы. */
  turn?: number;
  /**
   * Сколько ростов помещается в кадр по вертикали.
   *
   * Больше единицы — фигура мельче и с запасом вокруг; в лобби запас нужен
   * побольше, чтобы человек стоял на полу задника, а не упирался в край.
   */
  frame?: number;
  /**
   * Куда смотрит камера по высоте, в долях роста.
   *
   * Половина — в середину фигуры. Ниже — фигура уезжает вверх кадра, и под
   * ней остаётся пол; в лобби это и нужно.
   */
  aim?: number;
}

export interface Portrait {
  /** Какую расу показывать. Та же раса второй раз — ничего. */
  setRace(race: Race): void;
  start(): void;
  stop(): void;
}

export function createPortrait(canvas: HTMLCanvasElement, options: PortraitOptions = {}): Portrait {
  const turn = options.turn ?? TURN;
  const frame = options.frame ?? FRAME;
  const aim = options.aim ?? 0.5;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);

  // Свет арки: мягкий общий, тёплый ключ сверху спереди и холодный контур
  // сзади — фигура отделяется от тёмного камня, а не тонет в нём.
  scene.add(new THREE.HemisphereLight(0xd8cfc0, 0x2a2622, 1.1));
  const key = new THREE.DirectionalLight(0xffe2b8, 2.2);
  key.position.set(1.2, 2.6, 2.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fa6c8, 1.3);
  rim.position.set(-2, 1.8, -2.2);
  scene.add(rim);

  const holder = new THREE.Group();
  holder.rotation.y = turn;
  scene.add(holder);

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);

  let race: Race | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  /** Номер запрошенного кадра анимации: по нему рендер и останавливают. */
  let ticking = 0;
  let last = 0;
  /** Номер загрузки: сменили расу, пока грузилась прошлая, — прошлую не ставим. */
  let loading = 0;

  function fit(height: number): void {
    const width = canvas.clientWidth || 1;
    const tall = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(width, tall, false);
    camera.aspect = width / tall;
    // Расстояние, на котором весь рост с запасом помещается по вертикали.
    const span = height * frame;
    const distance = span / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(0, height * (aim + 0.02), distance);
    camera.lookAt(0, height * aim, 0);
    camera.updateProjectionMatrix();
  }

  function render(): void {
    ticking = requestAnimationFrame(render);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    mixer?.update(dt);
    renderer.render(scene, camera);
  }

  return {
    setRace(next) {
      if (next === race) return;
      race = next;
      const ticket = ++loading;
      const { url, clip } = PORTRAITS[next];
      loader.load(
        url,
        (gltf) => {
          if (ticket !== loading) return;
          holder.clear();
          const model = gltf.scene;
          // Рост — как у расы, той же меркой, что у всех персонажей.
          model.updateMatrixWorld(true);
          const bounds = new THREE.Box3().setFromObject(model);
          const height = RACES[next].height;
          const scale = height / Math.max(0.001, bounds.max.y - bounds.min.y);
          model.scale.setScalar(scale);
          const center = bounds.getCenter(new THREE.Vector3());
          model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
          holder.add(model);

          mixer = new THREE.AnimationMixer(model);
          const action = gltf.animations.find((entry) => entry.name === clip) ?? gltf.animations[0];
          if (action) mixer.clipAction(action).play();
          fit(height);
        },
        undefined,
        () => console.warn(`[портрет] не загрузилась ${url}`),
      );
    },

    start() {
      if (ticking) return;
      if (race) fit(RACES[race].height);
      last = performance.now();
      render();
    },

    stop() {
      cancelAnimationFrame(ticking);
      ticking = 0;
    },
  };
}
