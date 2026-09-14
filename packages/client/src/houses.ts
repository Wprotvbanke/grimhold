import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BANK, TOWN_HOUSES, TOWN_WALLS, townWallLayout } from '@grimhold/shared';

/**
 * Здания площади: ратуша и городской дом — готовые модели целиком.
 *
 * Здание одним куском, а не коробки с убранством: внутрь не войти,
 * телесность — невидимые коробки в `level.ts`.
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

  /**
   * Казна — каменный ларец. Коробка у неё в `level.ts` (`BANK`), здесь вид.
   * Модель лежит длинной стороной вдоль Z — разворачиваем на четверть оборота,
   * чтобы совпасть с коробкой, вытянутой вдоль X.
   */
  loader.load(
    '/models/bank.glb',
    (gltf) => {
      const model = gltf.scene;
      model.position.set(BANK.x, 0, BANK.z);
      model.rotation.y = Math.PI / 2;
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      group.add(model);
    },
    undefined,
    () => console.warn('[здания] не загрузилась /models/bank.glb'),
  );

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

  loader.load(
    '/models/walls.glb',
    (gltf) => addWalls(group, gltf.scene),
    undefined,
    () => console.warn('[здания] не загрузилась /models/walls.glb'),
  );

  return { group };
}

/** Геометрия части стены: преобразования узла запечены, середина пятна — в нуле. */
function partGeometry(mesh: THREE.Mesh, center?: THREE.Vector3): { geometry: THREE.BufferGeometry; center: THREE.Vector3 } {
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();
  const middle = center ?? geometry.boundingBox!.getCenter(new THREE.Vector3());
  // Высоту не трогаем: низ у кладки ниже нуля — это фундамент, уходящий в землю.
  geometry.translate(-middle.x, 0, -middle.z);
  return { geometry, center: middle };
}

/**
 * Стены города по раскладке `townWallLayout` — той же, по которой коробки.
 *
 * Пролёты и вышки рисуются пачкой (`InstancedMesh`): их больше полусотни,
 * а материал у каждого вида один. Арки — по одной на сторону, со створками:
 * створки распахнуты наружу на петлях у опор, иначе ворота выглядели бы
 * запертыми, а проходить сквозь них — ошибкой.
 */
function addWalls(group: THREE.Group, source: THREE.Object3D): void {
  source.updateMatrixWorld(true);
  const find = (pattern: RegExp): THREE.Mesh | null => {
    let found: THREE.Mesh | null = null;
    source.traverse((node) => {
      if (!found && (node as THREE.Mesh).isMesh && pattern.test(node.name)) found = node as THREE.Mesh;
    });
    return found;
  };

  const towerMesh = find(/^Tower/);
  const wallMesh = find(/^Wall_Wall/);
  const archMesh = find(/^Wall001/);
  const doorLeft = find(/^Door_L/);
  const doorRight = find(/^Door_R/);
  if (!towerMesh || !wallMesh || !archMesh) {
    console.warn('[здания] в walls.glb нет вышки, стены или арки');
    return;
  }

  const layout = townWallLayout();
  const { tower, arch, wall } = TOWN_WALLS;
  const matrix = new THREE.Matrix4();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  const instanced = (mesh: THREE.Mesh, kind: 'tower' | 'wall'): void => {
    const pieces = layout.filter((piece) => piece.kind === kind);
    const { geometry } = partGeometry(mesh);
    const width = geometry.boundingBox!.max.x - geometry.boundingBox!.min.x;
    const batch = new THREE.InstancedMesh(geometry, mesh.material, pieces.length);
    for (const [index, piece] of pieces.entries()) {
      turn.setFromAxisAngle(up, piece.turn);
      const scale =
        kind === 'tower'
          ? new THREE.Vector3(tower.scale, tower.scale, tower.scale)
          : // Пролёт растягивается вдоль стены ровно по промежутку, толщину не трогаем.
            new THREE.Vector3(piece.length / width, 1, 1);
      matrix.compose(new THREE.Vector3(piece.x, 0, piece.z), turn, scale);
      batch.setMatrixAt(index, matrix);
    }
    // Сфера границ — по всем частям, а не по одной в начале координат:
    // иначе вся стена пропадала бы, стоит отвернуться от центра города.
    batch.computeBoundingSphere();
    batch.castShadow = true;
    batch.receiveShadow = true;
    group.add(batch);
  };

  instanced(towerMesh, 'tower');
  instanced(wallMesh, 'wall');
  void wall;

  const archPart = partGeometry(archMesh);
  for (const piece of layout.filter((entry) => entry.kind === 'arch')) {
    const holder = new THREE.Group();
    holder.position.set(piece.x, 0, piece.z);
    holder.rotation.y = piece.turn;
    holder.scale.setScalar(arch.scale);

    const body = new THREE.Mesh(archPart.geometry, archMesh.material);
    body.castShadow = true;
    body.receiveShadow = true;
    holder.add(body);

    // Створки: петля у внешнего края каждой, распахнуты наружу (+Z модели).
    for (const [door, hingeAtMax, angle] of [
      [doorLeft, true, Math.PI / 2],
      [doorRight, false, -Math.PI / 2],
    ] as const) {
      if (!door) continue;
      const { geometry } = partGeometry(door, archPart.center);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      const hingeX = hingeAtMax ? box.max.x : box.min.x;
      const hingeZ = (box.min.z + box.max.z) / 2;
      geometry.translate(-hingeX, 0, -hingeZ);

      const hinge = new THREE.Group();
      hinge.position.set(hingeX, 0, hingeZ);
      hinge.rotation.y = angle;
      hinge.add(new THREE.Mesh(geometry, door.material));
      holder.add(hinge);
    }

    group.add(holder);
  }
}
