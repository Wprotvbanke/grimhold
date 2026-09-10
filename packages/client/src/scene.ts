import * as THREE from 'three';
import {
  CHUNK_SIZE,
  ChunkedWorld,
  MOBS,
  RACES,
  SPELLS,
  chunkKey,
  type LevelBox,
  type MobId,
  type Race,
  type SpellId,
} from '@grimhold/shared';

/**
 * Рендер мира. Геометрия чанков берётся из того же генератора, которым сервер
 * считает коллизии, — расхождение картинки и физики сразу ломало бы
 * предсказание, поэтому источник ровно один.
 *
 * Чанки строятся и выбрасываются по мере движения игрока: держать весь мир
 * в сцене незачем, а на большой карте — уже и нельзя.
 */

const MATERIALS: Record<LevelBox['kind'], THREE.Material> = {
  floor: new THREE.MeshStandardMaterial({ color: 0x6f6858, roughness: 0.95 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x8a8271, roughness: 0.9 }),
  pillar: new THREE.MeshStandardMaterial({ color: 0x9b917c, roughness: 0.85 }),
  platform: new THREE.MeshStandardMaterial({ color: 0xa3907a, roughness: 0.8 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x6a6459, roughness: 1 }),
  ruin: new THREE.MeshStandardMaterial({ color: 0x7d7360, roughness: 0.95 }),
};

interface Torch {
  light: THREE.PointLight;
  flame: THREE.Mesh;
  phase: number;
  baseIntensity: number;
}

export interface World3D {
  scene: THREE.Scene;
  /** Коллизии вокруг точки — тот же источник, что и у сервера. */
  collidersAt(x: number, z: number): ReturnType<ChunkedWorld['collidersAt']>;
  /** Подгружает и выгружает чанки вокруг наблюдателя. */
  streamChunks(x: number, z: number): void;
  /** Анимация света: мерцание факелов и медленный ход солнца. */
  update(elapsed: number): void;
  loadedChunks: number;
}

const TORCH_SPOTS = [
  { x: -14, z: 12 },
  { x: -10, z: 12 },
  { x: -6, z: 12 },
  { x: 6, z: 4 },
  { x: -2, z: -6 },
];

export function createScene(): World3D {
  const scene = new THREE.Scene();

  // Сумеречное небо вместо чёрной пустоты — картинка сразу читается.
  scene.background = new THREE.Color(0x5a6b82);
  scene.fog = new THREE.Fog(0x5a6b82, 40, 150);

  // Небо-земля: главный заполняющий свет, он и делает сцену светлой.
  scene.add(new THREE.HemisphereLight(0xbcd0e8, 0x6b5f4c, 1.6));

  // Тёплое солнце низко над горизонтом — длинные тени и объём.
  const sun = new THREE.DirectionalLight(0xffd9a0, 2.2);
  sun.position.set(-28, 34, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  sun.shadow.camera.left = -50;
  sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.bias = -0.0008;
  scene.add(sun);

  // Холодная подсветка с обратной стороны — чтобы тени не были глухими.
  const bounce = new THREE.DirectionalLight(0x7fa6d8, 0.5);
  bounce.position.set(24, 12, -20);
  scene.add(bounce);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const terrain = new ChunkedWorld();
  const loaded = new Map<string, THREE.Group>();

  const torches = TORCH_SPOTS.map((spot, index) => createTorch(scene, spot.x, spot.z, index));

  // Одинокий холодный светильник у ступеней — контраст к тёплым факелам.
  const cold = new THREE.PointLight(0x74b4ff, 26, 26, 2);
  cold.position.set(14, 3.5, -14);
  scene.add(cold);

  const api: World3D = {
    scene,
    loadedChunks: 0,

    collidersAt: (x, z) => terrain.collidersAt(x, z),

    streamChunks(x, z) {
      const needed = ChunkedWorld.chunksAround(x, z);
      const keep = new Set(needed.map((c) => chunkKey(c.cx, c.cz)));

      for (const { cx, cz } of needed) {
        const key = chunkKey(cx, cz);
        if (loaded.has(key)) continue;
        loaded.set(key, buildChunkMesh(scene, terrain.getChunk(cx, cz)));
      }

      for (const [key, group] of loaded) {
        if (keep.has(key)) continue;
        scene.remove(group);
        disposeGroup(group);
        loaded.delete(key);
      }

      api.loadedChunks = loaded.size;
    },

    update(elapsed) {
      for (const torch of torches) {
        // Два несинхронных синуса дают живое пламя без случайных скачков.
        const flicker =
          0.82 +
          0.12 * Math.sin(elapsed * 11 + torch.phase) +
          0.06 * Math.sin(elapsed * 23.5 + torch.phase * 2.3);
        torch.light.intensity = torch.baseIntensity * flicker;
        torch.flame.scale.setScalar(0.9 + flicker * 0.18);
      }

      // Солнце очень медленно ползёт — заготовка под цикл дня и ночи.
      const angle = elapsed * 0.02;
      sun.position.set(Math.cos(angle) * -34, 36, Math.sin(angle) * 26);
    },
  };

  return api;
}

/**
 * Собирает чанк одной группой. Меши с общим материалом объединять пока не нужно:
 * коробок в чанке десятки, а не тысячи.
 */
function buildChunkMesh(scene: THREE.Scene, boxes: LevelBox[]): THREE.Group {
  const group = new THREE.Group();

  for (const entry of boxes) {
    const { box } = entry;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ),
      MATERIALS[entry.kind],
    );
    mesh.position.set(
      (box.minX + box.maxX) / 2,
      (box.minY + box.maxY) / 2,
      (box.minZ + box.maxZ) / 2,
    );
    mesh.receiveShadow = true;
    mesh.castShadow = entry.kind !== 'floor';
    group.add(mesh);
  }

  scene.add(group);
  return group;
}

/** Геометрию выгруженного чанка надо освобождать явно — иначе течёт видеопамять. */
function disposeGroup(group: THREE.Group): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}

function createTorch(scene: THREE.Scene, x: number, z: number, index: number): Torch {
  const baseIntensity = 34;

  const light = new THREE.PointLight(0xff9a3c, baseIntensity, 20, 2);
  light.position.set(x, 2.7, z);
  scene.add(light);

  const flame = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffcf7a }),
  );
  flame.position.copy(light.position);
  scene.add(flame);

  const bracket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a2d20, roughness: 1 }),
  );
  bracket.position.set(x, 2.4, z);
  scene.add(bracket);

  return { light, flame, phase: index * 1.7, baseIntensity };
}

/**
 * Заглушка тела для рас без модели. Габариты берутся из профиля расы —
 * тех же чисел, по которым сервер считает коллизии.
 */
export function createAvatar(race: Race): THREE.Group {
  const profile = RACES[race];
  const group = new THREE.Group();

  const { radius, cylinder } = capsuleFor(profile.radius, profile.height);
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, cylinder, 4, 12),
    new THREE.MeshStandardMaterial({ color: profile.color, roughness: 0.8 }),
  );
  body.position.y = profile.height / 2;
  body.castShadow = true;
  group.add(body);

  return group;
}

/** Высота, на которой висит подпись над телом. */
export function tagHeight(race: Race): number {
  return RACES[race].height + 0.35;
}

/**
 * Заглушка моба. Блокаут, но силуэты разные: крыса стелется по земле,
 * огр возвышается — по одному взгляду понятно, с кем имеешь дело.
 * Габариты те же, по которым сервер считает попадание.
 */
export function createMobMesh(mobId: MobId): THREE.Group {
  const profile = MOBS[mobId];
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: profile.color, roughness: 0.9 });

  const { radius, cylinder } = capsuleFor(profile.radius, profile.height);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius, cylinder, 4, 10), material);
  body.position.y = profile.height / 2;
  body.castShadow = true;
  group.add(body);

  // Метка направления взгляда: без неё непонятно, куда моб замахивается.
  // Держится внутри радиуса тела — силуэт не должен обещать досягаемость,
  // которой нет в хитбоксе на сервере.
  const snout = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.45, radius * 0.5, 6), material);
  snout.rotation.x = -Math.PI / 2;
  snout.position.set(0, profile.height * 0.72, -radius * 0.7);
  group.add(snout);

  return group;
}

/**
 * Размеры капсулы, у которой полная высота равна росту существа.
 *
 * Капсула в three.js имеет высоту `длина + 2 × радиус`. У приземистых существ
 * (крыса: рост 0.5 при радиусе 0.3) наивный расчёт даёт капсулу выше самого
 * существа, и она уходит под землю. Поэтому радиус ограничивается половиной
 * роста, а цилиндр добирает остаток.
 */
function capsuleFor(radius: number, height: number): { radius: number; cylinder: number } {
  const capped = Math.min(radius, height / 2);
  return { radius: capped, cylinder: Math.max(height - capped * 2, 0.001) };
}

export function mobTagHeight(mobId: MobId): number {
  return MOBS[mobId].height + 0.3;
}

/** Снаряд заклинания: светящийся шар, видимый издалека. */
export function createProjectileMesh(spellId: SpellId): THREE.Object3D {
  const colors: Record<SpellId, number> = {
    ember: 0xff7a30,
    frostbite: 0x7fd4ff,
    lightning: 0xc8b6ff,
    mend: 0x86c98a,
    wardskin: 0xb9a97e,
    lantern: 0xffe9a8,
  };
  const color = colors[spellId] ?? 0xffffff;

  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshBasicMaterial({ color }),
  );
  group.add(core);

  const glow = new THREE.PointLight(color, SPELLS[spellId].power * 0.5, 9, 2);
  group.add(glow);

  return group;
}

export { CHUNK_SIZE };
