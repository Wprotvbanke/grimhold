import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BANK, DUNGEON_GATE, TAVERN, TOWN_HOUSES, TOWN_WALLS, townWallLayout } from '@grimhold/shared';

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
  /** Каждый кадр у города: кружит туман над люком. */
  update(elapsed: number): void;
}

/**
 * Проём люка в метрах — по крышке в `trapdoor.glb`: 2.2 м поперёк петли,
 * 2.4 м от петли (z ≈ −1.2) к краю. Рама шире — 2.7 × 2.9.
 */
const HATCH = { minX: -1.1, maxX: 1.1, minZ: -1.2, maxZ: 1.2 };

/**
 * Туман из люка: модель в 7 м шириной ужата до 2.8 — чуть шире рамы, чтобы
 * переливался через край. Слои у модели лежат на 0.2…0.95 м ниже её нуля:
 * подъём ставит нижний слой в проём, а верхний — невысоко над рамой
 * (верх рамы — 0.19 м).
 */
const HATCH_FOG = { scale: 0.4, lift: 0.42, opacity: 0.35 };

export function createHouses(scene: THREE.Scene): Houses {
  const group = new THREE.Group();
  scene.add(group);
  /** Слои тумана и скорость, с которой каждый кружит. */
  const fogLayers: { mesh: THREE.Object3D; speed: number }[] = [];
  const update = (elapsed: number): void => {
    for (const { mesh, speed } of fogLayers) mesh.rotation.y = elapsed * speed;
  };
  if (typeof document === 'undefined') return { group, update };

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
        model.scale.setScalar(house.scale ?? 1);
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

  /**
   * Таверна — модель с залом внутри; стены и мебель телесны в level.ts,
   * мебель рисует props.ts. Опущена на `TAVERN.sink`: пол зала в модели
   * поднят, а шага через порог в движении нет.
   */
  loader.load(
    '/models/tavern.glb',
    (gltf) => {
      const model = gltf.scene;
      model.position.set(TAVERN.x, -TAVERN.sink, TAVERN.z);
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      group.add(model);
    },
    undefined,
    () => console.warn('[здания] не загрузилась /models/tavern.glb'),
  );

  /**
   * Люк в подземелье — рама с дощатой крышкой. Клип в модели открывает
   * крышку; ставим его на последний кадр, крышка распахнута: закрытый люк
   * читается как пол, а не как вход. Кадр ставится один раз — каждый кадр
   * гонять анимацию незачем.
   */
  loader.load(
    '/models/trapdoor.glb',
    (gltf) => {
      const model = gltf.scene;
      model.position.set(DUNGEON_GATE.x, 0, DUNGEON_GATE.z);
      const clip = gltf.animations[0];
      if (clip) {
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        mixer.setTime(clip.duration);
      }
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      group.add(model);
    },
    undefined,
    () => console.warn('[здания] не загрузилась /models/trapdoor.glb'),
  );

  /**
   * Под крышкой — чернота: глубина, которой не разглядеть.
   *
   * Без неё в проёме видна мостовая, и люк читается как крышка на земле.
   * Материал без освещения и без тумана сцены: ни факел, ни фонарь, ни день
   * не должны высветить дно.
   */
  const pit = new THREE.Mesh(
    new THREE.PlaneGeometry(HATCH.maxX - HATCH.minX, HATCH.maxZ - HATCH.minZ),
    new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }),
  );
  pit.rotation.x = -Math.PI / 2;
  // Выше мостовой на пару сантиметров — иначе земля пробивается сквозь черноту.
  pit.position.set(
    DUNGEON_GATE.x + (HATCH.minX + HATCH.maxX) / 2,
    0.03,
    DUNGEON_GATE.z + (HATCH.minZ + HATCH.maxZ) / 2,
  );
  group.add(pit);

  /**
   * Туман над проёмом. Слои полупрозрачные: пишут в глубину — и прячут друг
   * друга квадратами, поэтому глубину не пишут. Кружат в разные стороны
   * и с разной скоростью — одинаково кружащий туман выглядит диском.
   */
  loader.load(
    '/models/trapdoor_fog.glb',
    (gltf) => {
      const model = gltf.scene;
      model.position.set(DUNGEON_GATE.x, HATCH_FOG.lift, DUNGEON_GATE.z);
      model.scale.setScalar(HATCH_FOG.scale);
      let index = 0;
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        material.transparent = true;
        material.depthWrite = false;
        // Слои в модели плотные: пять подряд сливались в белый диск и прятали
        // черноту проёма. Туман должен дымиться над глубиной, а не закрывать её.
        material.opacity *= HATCH_FOG.opacity;
        mesh.renderOrder = 1;
        // Геометрия после сборки в мировых координатах модели и по центру —
        // кружить можно сам меш вокруг его оси.
        fogLayers.push({ mesh, speed: (index % 2 === 0 ? 1 : -1) * (0.05 + index * 0.02) });
        index++;
      });
      group.add(model);
    },
    undefined,
    () => console.warn('[здания] не загрузилась /models/trapdoor_fog.glb'),
  );

  loader.load(
    '/models/walls.glb',
    (gltf) => addWalls(group, gltf.scene),
    undefined,
    () => console.warn('[здания] не загрузилась /models/walls.glb'),
  );

  return { group, update };
}

/**
 * Пятно **тела** части — по вершинам на высоте человека, без зубцов и карниза.
 *
 * Габарит у кладки врёт: верх шире тела, и стыковка по габариту оставляла
 * щели между пролётами и у вышек. Меряем там, где стена стоит, а не где
 * у неё выступы.
 */
function bodyBox(geometry: THREE.BufferGeometry): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < 0.2 || y > 3) continue;
    const x = position.getX(i);
    const z = position.getZ(i);
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minZ = Math.min(box.minZ, z);
    box.maxZ = Math.max(box.maxZ, z);
  }
  return box;
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
    // Пролёт растягивается по телу, а не по габариту: иначе соседние пролёты
    // смыкаются зубцами, а между телами остаётся щель.
    const body = bodyBox(geometry);
    const width = body.maxX - body.minX;
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

    /**
     * Створки: петля у края прохода **на внешней грани арки**, распахнуты
     * наружу (+Z модели).
     *
     * Сначала петля стояла посреди толщины арки, где створки висят закрытыми,
     * и распахнутая створка ложилась внутрь прохода, уходя в кладку опоры —
     * владелец увидел это у ворот. С петлёй на внешней грани створка
     * торчит из стены наружу и камня не касается.
     */
    // Грань тела, а не карниза: по габариту створка повисла бы в воздухе
    // перед стеной.
    const outerFace = bodyBox(archPart.geometry).maxZ;
    for (const [door, hingeAtMax, angle] of [
      [doorLeft, true, Math.PI / 2],
      [doorRight, false, -Math.PI / 2],
    ] as const) {
      if (!door) continue;
      const { geometry } = partGeometry(door, archPart.center);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      const hingeX = hingeAtMax ? box.max.x : box.min.x;
      geometry.translate(-hingeX, 0, -(box.min.z + box.max.z) / 2);

      const hinge = new THREE.Group();
      hinge.position.set(hingeX, 0, outerFace);
      hinge.rotation.y = angle;
      hinge.add(new THREE.Mesh(geometry, door.material));
      holder.add(hinge);
    }

    group.add(holder);
  }
}
