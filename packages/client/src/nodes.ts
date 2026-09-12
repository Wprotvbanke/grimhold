import * as THREE from 'three';
import {
  DEPLETED_SCALE,
  HARVEST_RANGE,
  NODES,
  generateNodes,
  type ResourceNode,
} from '@grimhold/shared';
import { plantLibrary, type Library } from './nature.js';

/**
 * Ресурсные ноды: то, что в мире добывают.
 *
 * Раскладку считает `shared/src/nodes.ts` — та же, по которой сервер ставит
 * столкновения и проверяет чужие запросы. Здесь только вид и выбор цели.
 *
 * Модели берутся из библиотеки растительности: отдельный пак ради шести видов
 * был бы лишним запросом. Отличает ноду от декорации подкраска — иначе игрок
 * не поймёт, почему по одному валуну кирка работает, а по другому нет.
 *
 * Подробности — docs/nodes.md.
 */

/** Одна нода в сцене: где её матрица, чтобы осадить её в пень при истощении. */
interface Placed {
  node: ResourceNode;
  mesh: THREE.InstancedMesh;
  index: number;
}

export interface NodeField {
  /** Собирает ноды чанка. Группу уносит и выгружает сам чанк. */
  build(cx: number, cz: number): THREE.Group;
  /** Чанк выгрузился: его ноды больше не наши. */
  forget(cx: number, cz: number): void;
  /** Имена истощённых нод — приходят снапшотом с сервера. */
  setDepleted(ids: readonly string[]): void;
  /**
   * Нода под перекрестием: луч из глаза в центр экрана.
   * `null`, если целиться не во что.
   */
  targetAt(ray: THREE.Ray): ResourceNode | null;
  /** Истощена ли нода — по этому подсказка молчит про пустую выработку. */
  isDepleted(id: string): boolean;
}

/**
 * Насколько «толще» цель для прицеливания, чем её коробка столкновений.
 *
 * Точное попадание пикселем в ствол было бы мучением: игрок целится в дерево,
 * а не в его геометрию. Но и конус в семьдесят градусов, который тут стоял
 * раньше, врал в другую сторону — подсказка загоралась, когда ноду даже не
 * видно на экране.
 */
const AIM_PADDING = 0.25;
/** Нижняя граница размера цели: трава и волокно лежат почти плашмя. */
const AIM_MIN_RADIUS = 0.5;
const AIM_MIN_HEIGHT = 0.6;

export function createNodes(): NodeField {
  const placed = new Map<string, Placed>();
  /** Ноды загруженных чанков — по ним ищется цель. */
  const loaded = new Map<string, ResourceNode[]>();
  const depleted = new Set<string>();

  let library: Library | null = null;
  const pending: { group: THREE.Group; cx: number; cz: number }[] = [];

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  // Прицеливание считается каждый кадр — временные объекты переиспользуем.
  const aimBox = new THREE.Box3();
  const aimPoint = new THREE.Vector3();

  /** Матрица ноды с учётом того, цела она или выработана. */
  function poseOf(node: ResourceNode): THREE.Matrix4 {
    const squat = depleted.has(node.id) ? DEPLETED_SCALE : 1;
    position.set(node.x, 0, node.z);
    quaternion.setFromAxisAngle(up, node.yaw);
    // Оседает только по высоте: пень занимает то же место на земле, что
    // и дерево, и коробка столкновений остаётся честной.
    scale.set(node.scale, node.scale * squat, node.scale);
    return matrix.compose(position, quaternion, scale);
  }

  function fill(group: THREE.Group, cx: number, cz: number, source: Library): void {
    const nodes = generateNodes(cx, cz);
    if (nodes.length === 0) return;
    loaded.set(`${cx}:${cz}`, nodes);

    const byModel = new Map<string, ResourceNode[]>();
    for (const node of nodes) {
      const list = byModel.get(node.model) ?? [];
      list.push(node);
      byModel.set(node.model, list);
    }

    for (const [model, list] of byModel) {
      const parts = source.get(model);
      if (!parts) continue;

      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        for (const [index, node] of list.entries()) {
          mesh.setMatrixAt(index, poseOf(node));
          // Подкраска умножается на цвет вершин: руда отдаёт синевой, глина
          // рыжим, и по одному и тому же валуну видно, что из него добудут.
          mesh.setColorAt(index, tint.setHex(NODES[node.nodeId].tint));
          placed.set(node.id, { node, mesh, index });
        }

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    }
  }

  void plantLibrary().then((source) => {
    if (!source) return;
    library = source;
    for (const item of pending.splice(0)) {
      if (item.group.parent) fill(item.group, item.cx, item.cz, source);
    }
  });

  return {
    build(cx, cz) {
      const group = new THREE.Group();
      if (library) fill(group, cx, cz, library);
      else pending.push({ group, cx, cz });
      return group;
    },

    forget(cx, cz) {
      const nodes = loaded.get(`${cx}:${cz}`);
      if (!nodes) return;
      // Ссылки на пачки выгруженного чанка держать нельзя: меши уже
      // освобождены, и запись в них ничего не даст, кроме путаницы.
      for (const node of nodes) placed.delete(node.id);
      loaded.delete(`${cx}:${cz}`);
    },

    setDepleted(ids) {
      const next = new Set(ids);

      // Меняем только то, что действительно изменилось: снапшот приходит
      // двадцать раз в секунду, а трогать матрицы пачки на каждый — дорого.
      const touched = new Set<THREE.InstancedMesh>();
      for (const id of new Set([...depleted, ...next])) {
        if (depleted.has(id) === next.has(id)) continue;

        const item = placed.get(id);
        if (next.has(id)) depleted.add(id);
        else depleted.delete(id);
        if (!item) continue;

        item.mesh.setMatrixAt(item.index, poseOf(item.node));
        touched.add(item.mesh);
      }

      for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    },

    targetAt(ray) {
      let best: ResourceNode | null = null;
      let bestHit = Infinity;

      for (const nodes of loaded.values()) {
        for (const node of nodes) {
          // Дальность считает сервер по горизонтали — здесь та же мерка,
          // иначе подсказка обещала бы то, в чём он откажет.
          const flat = Math.hypot(node.x - ray.origin.x, node.z - ray.origin.z);
          if (flat > HARVEST_RANGE) continue;

          const profile = NODES[node.nodeId];
          const radius = Math.max(profile.solid * node.scale, AIM_MIN_RADIUS) + AIM_PADDING;
          const height = Math.max(profile.height * node.scale, AIM_MIN_HEIGHT) + AIM_PADDING;

          aimBox.min.set(node.x - radius, 0, node.z - radius);
          aimBox.max.set(node.x + radius, height, node.z + radius);
          if (!ray.intersectBox(aimBox, aimPoint)) continue;

          // Ближайшая по лучу, а не по земле: за стволом может стоять второй.
          const hit = aimPoint.distanceToSquared(ray.origin);
          if (hit >= bestHit) continue;

          best = node;
          bestHit = hit;
        }
      }

      return best;
    },

    isDepleted(id) {
      return depleted.has(id);
    },
  };
}

/**
 * Пачки нод освобождаются вместе с чанком. Геометрия у них заимствованная,
 * общая на весь мир, — её трогать нельзя.
 */
export function disposeNodes(group: THREE.Group): void {
  group.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh) mesh.dispose();
  });
}
