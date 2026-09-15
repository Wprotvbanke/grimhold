import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RACES, type Race } from '@grimhold/shared';

/**
 * Витрина рас: человек и эльф стоят на площади и по очереди играют свои клипы.
 *
 * Модели от владельца; в дальнейшем это расы, которые выбирает игрок. Пока они
 * здесь затем же, зачем пробный дворф (showcase.ts): посмотреть модель
 * и анимации **в мире**, под нашим светом и рядом с мостовой. Сервер о них
 * не знает — ни столкновений, ни подписи.
 *
 * Стоят на месте: движение корня вырезано при сборке
 * (`scripts/prepare-exhibits.ts`), ходьба и бег идут на месте.
 */

interface Exhibit {
  url: string;
  race: Race;
  /** Где стоит — место выбрал владелец. */
  x: number;
  z: number;
}

const EXHIBITS: Exhibit[] = [
  { url: '/models/elf_exhibit.glb', race: 'elf', x: -2, z: -7 },
  { url: '/models/human_exhibit.glb', race: 'human', x: -13.8, z: -5.8 },
];

/** Сколько секунд стойка между номерами: сразу из танца в удар — суетливо. */
const IDLE_SECONDS = 4;

/** Короткий цикл (ходьба, бег) крутится столько секунд, а не один раз за 0.6 с. */
const LOOP_SECONDS = 4;

/** Длинный номер (танец) обрывается на этом: двадцать секунд самбы — перебор. */
const LONGEST = 10;

/** Сколько секунд один клип перетекает в другой. */
const BLEND = 0.3;

export interface Exhibits {
  /** Каждый кадр. `visible: false` — под землёй витрины нет. */
  update(dt: number, visible: boolean): void;
}

/** Поворот, при котором модель смотрит на точку. У наших моделей «вперёд» — +Z. */
function facing(x: number, z: number, toX: number, toZ: number): number {
  return Math.atan2(toX - x, toZ - z);
}

export function createExhibits(scene: THREE.Scene): Exhibits {
  const group = new THREE.Group();
  scene.add(group);

  const mixers: { mixer: THREE.AnimationMixer; step: () => void; left: number }[] = [];
  if (typeof document === 'undefined') return { update() {} };

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);

  for (const exhibit of EXHIBITS) {
    loader.load(
      exhibit.url,
      (gltf) => {
        const model = gltf.scene;
        // Рост — как у расы, той же меркой, что у всех персонажей.
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const height = bounds.max.y - bounds.min.y;
        const scale = height > 0 ? RACES[exhibit.race].height / height : 1;
        model.scale.setScalar(scale);
        model.position.y = -bounds.min.y * scale;
        model.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) node.castShadow = true;
        });

        const holder = new THREE.Group();
        holder.position.set(exhibit.x, 0, exhibit.z);
        // Лицом к середине площади — туда, откуда на них смотрят.
        holder.rotation.y = facing(exhibit.x, exhibit.z, 0, 0);
        holder.add(model);
        group.add(holder);

        const mixer = new THREE.AnimationMixer(model);
        const actions = new Map(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)]));
        const idle = actions.get('Idle');
        // Порядок показа: стойка между каждым номером.
        const numbers = gltf.animations.map((clip) => clip.name).filter((name) => name !== 'Idle');
        const program = numbers.flatMap((name) => ['Idle', name]);
        let index = -1;
        let current: THREE.AnimationAction | null = null;

        const entry = { mixer, left: 0, step: () => {} };
        entry.step = () => {
          index = (index + 1) % Math.max(1, program.length);
          const name = program[index] ?? 'Idle';
          const action = actions.get(name) ?? idle;
          if (!action) return;
          action.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(BLEND).play();
          if (current && current !== action) current.fadeOut(BLEND);
          current = action;
          const duration = action.getClip().duration;
          entry.left =
            name === 'Idle'
              ? IDLE_SECONDS
              : duration < 1.5
                ? LOOP_SECONDS
                : Math.min(duration, LONGEST);
        };
        entry.step();
        mixers.push(entry);
        console.info(`[витрина рас] ${exhibit.url}: ${gltf.animations.map((clip) => clip.name).join(', ')}`);
      },
      undefined,
      () => console.warn(`[витрина рас] не загрузилась ${exhibit.url}`),
    );
  }

  return {
    update(dt, visible) {
      group.visible = visible;
      if (!visible) return;
      for (const entry of mixers) {
        entry.mixer.update(dt);
        entry.left -= dt;
        if (entry.left <= 0) entry.step();
      }
    },
  };
}
