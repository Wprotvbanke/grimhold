import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TOWN_HOUSES } from '@grimhold/shared';

/**
 * Здания площади: ратуша и городской дом — готовые модели целиком.
 *
 * Не убранство вокруг коробок, как у таверны (buildings.ts), а здание одним
 * куском: внутрь не войти, телесность — одна невидимая коробка в `level.ts`.
 * Раскладка там же, в `TOWN_HOUSES`: разъедься она с моделями — игрок упирался
 * бы в воздух перед фасадом или проходил сквозь угол.
 *
 * Модели готовит `scripts/prepare-town.ts`: они уже в метрах, основанием на
 * нуле и фасадом в +Z, поэтому здесь их только ставят на место.
 */

export interface Houses {
  /** Уходит вместе с городом: см. `nearTown` в scene.ts. */
  readonly group: THREE.Group;
}

export function createHouses(scene: THREE.Scene): Houses {
  const group = new THREE.Group();
  scene.add(group);
  if (typeof document === 'undefined') return { group };

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);

  for (const house of TOWN_HOUSES) {
    const url = `/models/${house.model}.glb`;
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        model.position.set(house.x, 0, house.z);
        // Разворот тот же, что у коробки в level.ts: там пятно поворачивается
        // по той же формуле, иначе фасад и телесность разъедутся.
        model.rotation.y = house.turn;
        model.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        group.add(model);
      },
      undefined,
      // Нет модели — нет и здания на вид, но коробка стоит: в пустоту упрутся,
      // сквозь стену не пройдут. Скажем об этом, а не промолчим.
      () => console.warn(`[здания] не загрузилась ${url}`),
    );
  }

  return { group };
}
