import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAVERN } from '@grimhold/shared';

/**
 * Обстановка таверны.
 *
 * Здесь только вид. Телесность стоящим на полу вещам даёт уровень
 * (`TAVERN_FURNITURE` в shared/src/level.ts), потому что столкновения считает
 * сервер: существуй стол лишь на клиенте, игрок проходил бы сквозь него
 * на сервере, и предсказание дёргало бы его назад.
 *
 * Мебель — пак старой таверны (`tavern_props.glb`), возвращённый из истории
 * git: зал снесли, а столы, стулья и посуда перешли в новую таверну. Расставлены
 * под её Г-образный зал: стойка у северной стены, два стола в корпусе, припасы
 * в крыле и в углу. Координаты — от точки таверны, разворот у неё нулевой.
 *
 * Свет зала сюда не относится — весь огонь мира заведён в lights.ts.
 * Пустой стол читается как недоделанный уровень, поэтому на каждом что-то стоит.
 */

const MODEL_URL = '/models/tavern_props.glb';

interface Prop {
  /** Имя узла в модели. */
  model: string;
  /** Смещение от точки таверны, в метрах. */
  x: number;
  z: number;
  /** Высота низа над полом: посуда стоит на столах. */
  y?: number;
  /** Поворот вокруг вертикали, радианы. */
  yaw?: number;
  /** Целевая высота в метрах — там, где образец из пака не того калибра. */
  height?: number;
}

/** Стойка собирается из одинаковых секций: в паке она одна, длиной в метр. */
function counter(): Prop[] {
  const props: Prop[] = [];
  for (let i = 0; i < 8; i++) {
    props.push({ model: 'counter', x: -3.6 + i * 0.64, z: -4.35 });
  }
  return props;
}

const TAVERN_PROPS: Prop[] = [
  ...counter(),

  // За стойкой, у северной стены — посудный шкаф, полка и буфет.
  { model: 'cupboard', x: -3.4, z: -5.0, yaw: Math.PI },
  { model: 'shelf', x: -1.9, z: -5.0, yaw: Math.PI },
  { model: 'sideboard', x: -0.4, z: -4.95, yaw: Math.PI },

  // Посуда на стойке.
  { model: 'tankard', x: -3.5, z: -4.35, y: 1.01 },
  { model: 'tankard', x: -2.8, z: -4.3, y: 1.01 },
  { model: 'jug', x: -2.0, z: -4.4, y: 1.01 },
  { model: 'bowl', x: -1.1, z: -4.35, y: 1.01 },
  { model: 'cup', x: -0.1, z: -4.3, y: 1.01 },

  // Табуреты вдоль стойки.
  { model: 'stool', x: -3.3, z: -3.3 },
  { model: 'stool', x: -2.4, z: -3.3 },
  { model: 'stool', x: -1.5, z: -3.3 },
  { model: 'stool', x: -0.5, z: -3.3 },

  // Стол у западной стены: стулья с одной стороны, табуреты с другой, ужин.
  { model: 'table_long', x: -2.4, z: 0.8 },
  { model: 'chair', x: -3.5, z: 0.3, yaw: Math.PI / 2 },
  { model: 'chair', x: -3.5, z: 1.4, yaw: Math.PI / 2 },
  { model: 'stool', x: -1.3, z: 0.3 },
  { model: 'stool', x: -1.3, z: 1.4 },
  { model: 'plate', x: -2.4, z: 0.4, y: 0.78, height: 0.06 },
  { model: 'tankard', x: -2.7, z: 1.1, y: 0.78 },
  { model: 'cup', x: -2.1, z: 1.3, y: 0.78 },
  { model: 'jug', x: -2.5, z: 1.6, y: 0.78 },

  // Второй стол — тоже вдоль западной стены, рядом с первым. Стоял у двери
  // и мешал войти. Накрыт иначе: одинаковые столы выглядят копипастой.
  { model: 'table_long', x: -2.4, z: 3.6 },
  { model: 'chair', x: -3.5, z: 3.1, yaw: Math.PI / 2 },
  { model: 'chair', x: -3.5, z: 4.2, yaw: Math.PI / 2 },
  { model: 'stool', x: -1.3, z: 3.1 },
  { model: 'stool', x: -1.3, z: 4.2 },
  { model: 'bowl', x: -2.3, z: 3.2, y: 0.78, height: 0.1 },
  { model: 'tankard', x: -2.6, z: 3.7, y: 0.78 },
  { model: 'book', x: -2.2, z: 4.2, y: 0.78, yaw: 0.4 },
  { model: 'book', x: -2.0, z: 4.0, y: 0.78, yaw: -0.2 },

  // Барная стойка в крыле — ящики рядом, как прилавок. За ней проход:
  // заходят с севера и стоят, как за стойкой. Кружки на ящиках.
  ...barCrates(),
  { model: 'tankard', x: 2.55, z: -2.6, y: 0.8 },
  { model: 'jug', x: 2.5, z: -1.4, y: 0.8 },
  { model: 'tankard', x: 2.6, z: -0.8, y: 0.8 },
  // Бочка и ящики в северных углах крыла — запас за стойкой.
  { model: 'barrel', x: 3.6, z: -4.9 },
  { model: 'crate', x: 2.5, z: -4.9 },
  { model: 'crate', x: 2.5, z: -4.9, y: 0.8, yaw: 0.3 },

  // Припасы у южной стены, в стороне от двери.
  { model: 'barrel', x: 1.5, z: 4.75 },
  { model: 'crate', x: 0.9, z: 4.75 },
];

/** Барная стойка из ящиков: вдоль крыла, от северного прохода до южной стены. */
function barCrates(): Prop[] {
  const props: Prop[] = [];
  for (let i = 0; i < 4; i++) props.push({ model: 'crate', x: 2.5, z: -3.0 + i * 0.8, yaw: Math.PI / 2 });
  return props;
}

/**
 * Обставляет таверну и отдаёт группу, в которой всё лежит.
 *
 * Группой — потому что город выгружается вместе со своим чанком, и мебель
 * обязана уходить с ним: иначе, отойдя от города, увидишь столы и бочки,
 * висящие в чистом поле.
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
 * отрисовки каждый кадр, при том что материалов на них полтора десятка. Зал
 * стоит на месте и никогда не двигается, поэтому сливается раз и навсегда.
 *
 * Матрицы обновляются до замера: у свежего клона они не посчитаны.
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

  model.position.set(TAVERN.x + prop.x, (prop.y ?? 0) - bounds.min.y * scale, TAVERN.z + prop.z);
  model.rotation.y = prop.yaw ?? 0;
  model.updateMatrixWorld(true);

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)!;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // Второй набор развёртки и цвета вершин в пакe не участвуют, а слияние
    // падает, стоит атрибутам разойтись хоть на один.
    for (const key of Object.keys(geometry.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') geometry.deleteAttribute(key);
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const list = batches.get(material) ?? [];
    list.push(geometry);
    batches.set(material, list);
  });
}

/** Загрузка в фоне: пока обстановка летит, стены уже стоят и войти можно. */
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
