import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { generateNature, type Plant } from '@grimhold/shared';

/**
 * Растительность: деревья, кусты, трава, камни.
 *
 * Раскладку считает не этот модуль, а `shared/src/nature.ts` — та же, по
 * которой сервер ставит столкновения у стволов. Здесь только вид.
 *
 * Рисуется **пачками** (`InstancedMesh`): в одном чанке под сотню растений,
 * а в загруженных вокруг игрока — под тысячу. Отдельными мешами это тысяча
 * вызовов отрисовки на кадр, и кадр умирает. Пачками — по одному вызову
 * на вид растения.
 *
 * Подробности — docs/nature.md.
 */

const MODEL_URL = '/models/nature.glb';

/** Библиотека образцов: имя узла → его меши с геометрией и материалом. */
type Library = Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }[]>;

let library: Library | null = null;
let loading: Promise<Library | null> | null = null;

export interface NatureField {
  /** Собирает растительность чанка. Возвращает группу, которую чанк и уносит. */
  build(cx: number, cz: number): THREE.Group;
}

export function createNature(): NatureField {
  // Библиотека грузится один раз и в фоне: стены и земля не должны ждать траву.
  void ensureLibrary();

  const pending: { group: THREE.Group; cx: number; cz: number }[] = [];

  const fill = (group: THREE.Group, cx: number, cz: number, source: Library): void => {
    const plants = generateNature(cx, cz);
    if (plants.length === 0) return;

    // Растения одного вида собираем в одну пачку.
    const byId = new Map<string, Plant[]>();
    for (const plant of plants) {
      const list = byId.get(plant.id) ?? [];
      list.push(plant);
      byId.set(plant.id, list);
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (const [id, list] of byId) {
      const parts = source.get(id);
      if (!parts) continue;

      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        // Тени только у крупного: от травы их не видно, а карта теней
        // пересчитывается каждый кадр и платится за всё разом.
        mesh.castShadow = list[0]!.shadow;
        mesh.receiveShadow = true;

        for (const [index, plant] of list.entries()) {
          position.set(plant.x, 0, plant.z);
          quaternion.setFromAxisAngle(up, plant.yaw);
          scale.setScalar(plant.scale);
          mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
        }
        mesh.instanceMatrix.needsUpdate = true;

        /**
         * Сферу считаем сами и по местам растений.
         *
         * Пачка занимает весь чанк, а её собственная середина — в начале
         * координат, где ничего нет. Без пересчёта отсечка по кадру либо
         * выбрасывает пачку целыми полосами, либо (если её отключить)
         * заставляет рисовать за спиной весь загруженный лес.
         */
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    }
  };

  return {
    build(cx, cz) {
      const group = new THREE.Group();
      if (library) fill(group, cx, cz, library);
      else {
        // Модель ещё летит по сети. Запоминаем, что этот чанк не заполнен,
        // и вернёмся к нему, когда библиотека приедет: иначе первые чанки
        // навсегда остались бы голыми.
        pending.push({ group, cx, cz });
        void ensureLibrary().then((source) => {
          if (!source) return;
          for (const item of pending.splice(0)) {
            // Чанк мог уже выгрузиться, пока грузилась модель.
            if (item.group.parent) fill(item.group, item.cx, item.cz, source);
          }
        });
      }
      return group;
    },
  };
}

/**
 * Геометрия растений общая на весь мир, поэтому её не освобождают вместе
 * с чанком — иначе соседний чанк остался бы с выброшенными буферами.
 * Освобождать надо только сами пачки, а их геометрия здесь заимствована.
 */
export function disposeNature(group: THREE.Group): void {
  group.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh) mesh.dispose();
  });
}

async function ensureLibrary(): Promise<Library | null> {
  if (library) return library;
  if (loading) return loading;
  if (typeof document === 'undefined') return null;

  loading = (async () => {
    try {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('/draco/');
      loader.setDRACOLoader(draco);

      const gltf = await loader.loadAsync(MODEL_URL);
      const found: Library = new Map();

      for (const node of gltf.scene.children) {
        const parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
        node.updateMatrixWorld(true);

        node.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;

          // Запекаем положение внутри образца: у пачки своя матрица на
          // каждое растение, и вложенных преобразований она не знает.
          const geometry = mesh.geometry.clone();
          geometry.applyMatrix4(mesh.matrixWorld);

          const material = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
          // Листва смоделирована плоскостями: без двусторонней отрисовки
          // половина кроны пропадает, стоит зайти с другой стороны.
          (material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
          parts.push({ geometry, material });
        });

        if (parts.length > 0) found.set(node.name, parts);
      }

      library = found;
      return found;
    } catch (error) {
      console.warn('[растительность] модель не загрузилась:', error);
      return null;
    }
  })();

  return loading;
}
