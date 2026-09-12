import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAVERN } from '@grimhold/shared';

/**
 * Обстановка таверны.
 *
 * Здесь только вид. Телесность стоящим на полу вещам даёт уровень
 * (`hidden`-коробки в shared/src/level.ts), потому что столкновения считает
 * сервер: существуй стол лишь на клиенте, игрок проходил бы сквозь него
 * на сервере, и предсказание дёргало бы его назад.
 *
 * Свет зала сюда не относится — весь огонь мира заведён в lights.ts.
 *
 * Расстановка сделана по образцу: стойка у дальней стены, столы со скамьями
 * в середине зала, припасы по углам, посуда на столах. Пустой стол читается
 * как недоделанный уровень, поэтому на каждом что-то стоит.
 */

const MODEL_URL = '/models/tavern_props.glb';

interface Prop {
  /** Имя узла в модели. */
  model: string;
  /** Смещение от центра таверны, в метрах. */
  x: number;
  z: number;
  /** Высота низа над полом: посуда стоит на столах, полки висят на стене. */
  y?: number;
  /** Поворот вокруг вертикали, радианы. */
  yaw?: number;
  /**
   * Целевая высота в метрах.
   *
   * Обычно не нужна: пак смоделирован в метрах, и вещи приезжают нужного
   * размера. Задаётся там, где образец не того калибра.
   */
  height?: number;
}

const HALF_W = TAVERN.width / 2;
const HALF_D = TAVERN.depth / 2;

/** Стойка собирается из одинаковых секций: в паке она одна, длиной в метр. */
function counter(): Prop[] {
  const props: Prop[] = [];
  for (let i = 0; i < 8; i++) {
    props.push({ model: 'counter', x: -5 + i * 0.64, z: -HALF_D + 1.0, yaw: 0 });
  }
  return props;
}

/** Потолочные балки: без них зал выглядит коробкой с плоской крышкой. */
function beams(): Prop[] {
  const props: Prop[] = [];
  for (let i = 0; i < 5; i++) {
    props.push({
      model: 'beam',
      x: -4.5 + i * 2.25,
      z: 0,
      y: TAVERN.height - 0.35,
      yaw: Math.PI / 2,
      height: 0.35,
    });
  }
  return props;
}

const TAVERN_PROPS: Prop[] = [
  ...counter(),
  ...beams(),

  // За стойкой — посудный шкаф, полка и буфет.
  { model: 'cupboard', x: -4.6, z: -HALF_D + 0.35, yaw: Math.PI },
  { model: 'shelf', x: -3.2, z: -HALF_D + 0.35, yaw: Math.PI },
  { model: 'sideboard', x: -1.4, z: -HALF_D + 0.4, yaw: Math.PI },

  // Посуда на стойке: ради неё за стойку и подходят.
  { model: 'tankard', x: -4.4, z: -HALF_D + 1.0, y: 1.01 },
  { model: 'tankard', x: -3.7, z: -HALF_D + 1.05, y: 1.01 },
  { model: 'jug', x: -2.9, z: -HALF_D + 0.95, y: 1.01 },
  { model: 'bowl', x: -1.9, z: -HALF_D + 1.0, y: 1.01 },
  { model: 'cup', x: -0.9, z: -HALF_D + 1.05, y: 1.01 },

  // Табуреты вдоль стойки.
  { model: 'stool', x: -4.4, z: -HALF_D + 2.0 },
  { model: 'stool', x: -3.4, z: -HALF_D + 2.0 },
  { model: 'stool', x: -2.4, z: -HALF_D + 2.0 },
  { model: 'stool', x: -1.2, z: -HALF_D + 2.0 },

  // Западный стол: скамьи по бокам, на столе ужин.
  { model: 'table_long', x: -3, z: 1.2 },
  { model: 'chair', x: -4.4, z: 0.6, yaw: Math.PI / 2 },
  { model: 'chair', x: -4.4, z: 1.9, yaw: Math.PI / 2 },
  { model: 'stool', x: -1.7, z: 0.7 },
  { model: 'stool', x: -1.7, z: 1.8 },
  { model: 'plate', x: -3, z: 0.8, y: 0.78, height: 0.06 },
  { model: 'tankard', x: -3.3, z: 1.5, y: 0.78 },
  { model: 'cup', x: -2.7, z: 1.7, y: 0.78 },
  { model: 'jug', x: -3.1, z: 2.0, y: 0.78 },

  // Восточный стол: тот же ужин, но другая расстановка — одинаковые столы
  // выглядят как копипаста, даже если на них ничего не написано.
  { model: 'table_long', x: 3, z: 1.2 },
  { model: 'chair', x: 4.4, z: 1.0, yaw: -Math.PI / 2 },
  { model: 'stool', x: 1.7, z: 0.7 },
  { model: 'stool', x: 1.7, z: 1.9 },
  { model: 'stool', x: 3.2, z: 2.6, yaw: Math.PI },
  { model: 'bowl', x: 3.1, z: 0.9, y: 0.78, height: 0.1 },
  { model: 'tankard', x: 2.7, z: 1.4, y: 0.78 },
  { model: 'book', x: 3.3, z: 1.9, y: 0.78, yaw: 0.4 },
  { model: 'book', x: 3.5, z: 1.7, y: 0.78, yaw: -0.2 },

  // Припасы у входа и за стойкой.
  { model: 'barrel', x: -HALF_W + 0.9, z: HALF_D - 1.1 },
  { model: 'barrel_big', x: -HALF_W + 0.8, z: -HALF_D + 1.1 },
  { model: 'crate', x: -HALF_W + 0.7, z: HALF_D - 2.2 },
  { model: 'crate', x: -HALF_W + 0.7, z: HALF_D - 2.2, y: 0.8, yaw: 0.3 },
  { model: 'barrel', x: HALF_W - 0.8, z: HALF_D - 1.0 },
  { model: 'barrel', x: HALF_W - 0.8, z: HALF_D - 1.8, yaw: 0.6 },

  // У очага: поленья и кружка — место, где сидят и греются.
  { model: 'stool', x: HALF_W - 2.6, z: -HALF_D + 2.6, yaw: -0.5 },
  { model: 'stool', x: HALF_W - 1.4, z: -HALF_D + 2.9, yaw: -0.9 },
  { model: 'tankard', x: HALF_W - 2.6, z: -HALF_D + 2.6, y: 0.52 },
];

/**
 * Обставляет таверну и отдаёт группу, в которой всё лежит.
 *
 * Группой — потому что город выгружается вместе со своим чанком, и мебель
 * обязана уходить с ним: иначе, отойдя от города на сотню метров, увидишь
 * столы и бочки, висящие в чистом поле.
 */
export function populateTavern(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  scene.add(group);
  void load(group);
  return group;
}

/**
 * Ставит вещь на пол таверны и отдаёт её геометрию, разложенную по материалам.
 *
 * Отдаёт, а не добавляет в сцену: полсотни вещей — это полсотни вызовов
 * отрисовки каждый кадр, пока игрок в городе, при том что материалов на них
 * полтора десятка. Зал стоит на месте и никогда не двигается, поэтому его
 * можно слить в несколько мешей раз и навсегда.
 *
 * Матрицы обновляются до замера: у свежего клона они не посчитаны, и габариты
 * выходят произвольными — на этом уже обжигались с моделями мобов.
 */
function place(
  batches: Map<THREE.Material, THREE.BufferGeometry[]>,
  source: THREE.Object3D,
  prop: Prop,
): void {
  const model = source.clone(true);
  model.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.max.y - bounds.min.y;
  const scale = prop.height && size > 0 ? prop.height / size : 1;
  model.scale.setScalar(scale);

  model.position.set(
    TAVERN.centerX + prop.x,
    (prop.y ?? 0) - bounds.min.y * scale,
    TAVERN.centerZ + prop.z,
  );
  model.rotation.y = prop.yaw ?? 0;
  model.updateMatrixWorld(true);

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)!;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // Развёртка второго набора и цвета вершин в этом паке не участвуют,
    // а слияние падает, стоит атрибутам разойтись хоть на один.
    for (const key of Object.keys(geometry.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') geometry.deleteAttribute(key);
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const list = batches.get(material) ?? [];
    list.push(geometry);
    batches.set(material, list);
  });
}

/**
 * Загрузка идёт в фоне и ничего не блокирует: пока обстановка летит по сети,
 * стены уже стоят, и войти внутрь можно.
 */
async function load(group: THREE.Group): Promise<void> {
  if (typeof document === 'undefined') return;

  try {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);

    const gltf = await loader.loadAsync(MODEL_URL);
    const missing = new Set<string>();
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();

    for (const prop of TAVERN_PROPS) {
      const source = gltf.scene.getObjectByName(prop.model);
      if (!source) {
        missing.add(prop.model);
        continue;
      }
      place(batches, source, prop);
    }

    for (const [material, pieces] of batches) {
      const merged = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
      if (!merged) {
        console.warn('[таверна] геометрия не слилась:', material.name);
        continue;
      }
      for (const piece of pieces) if (piece !== merged) piece.dispose();

      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    if (missing.size > 0) console.warn('[таверна] нет таких вещей в паке:', [...missing].join(', '));
  } catch (error) {
    console.warn('[таверна] обстановка не загрузилась:', error);
  }
}
