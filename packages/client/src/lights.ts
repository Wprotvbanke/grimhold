import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LAMP_HEIGHT, TAVERN, TOWN_LAMPS } from '@grimhold/shared';

/**
 * Искусственный свет: фонари, факелы, костры, очаг таверны.
 *
 * Весь рукотворный огонь мира заведён здесь — в одном месте, потому что
 * у него общие правила: он мерцает, он греет картинку тёплым, и он **гаснет
 * днём**. Разложи это по модулям — и половина ламп однажды останется гореть
 * в полдень.
 *
 * Небесный свет сюда не относится: солнце, луна и заполняющий свет живут
 * в daynight.ts.
 */

/** Модели фонаря и костра. Один файл: и то и другое нужно сразу по всему городу. */
const MODEL_URL = '/models/lights.glb';

/**
 * Целевая высота огня в очаге.
 *
 * Костров под открытым небом в городе нет: модель из пака на площади
 * не смотрелась. В камине она читается иначе — там её держат каменный портал
 * и полумрак вокруг.
 */
const FIRE_HEIGHT = 0.9;

/**
 * Огонь как **данные**, а не как лампа.
 *
 * Ламп в сцене ровно `LIGHT_POOL` штук, и они переезжают к ближайшим огням.
 * Причина жёсткая: в прямом рендере three все источники живут в массивах
 * шейдера, и стоит их числу измениться — перекомпилируются **все** материалы
 * сцены. Гасили лампы на рассвете видимостью и получали фриз на полсекунды
 * каждый рассвет и закат. Плюс каждый лишний источник считается для каждого
 * пикселя, а их тут было полтора десятка.
 */
interface Flame {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Дальность затухания. */
  range: number;
  /** Видимое пламя: мерцает вместе со светом. */
  glow: THREE.Object3D | null;
  base: number;
  phase: number;
  /**
   * Гаснет ли днём.
   *
   * Уличный огонь — да: горящий в полдень фонарь выглядит бутафорией и вдобавок
   * зря съедает лимит источников. Огонь под крышей — нет: в таверне полумрак
   * круглые сутки, ради него она и нужна.
   */
  outdoor: boolean;
}

/**
 * Настенные факелы: колоннада и глухие простенки.
 *
 * Ставятся **на грань**, а не в середину того, к чему крепятся. Колонны здесь
 * толщиной 1.2 м, и факел по их координатам оказывался внутри камня: света
 * не видно, огонька не видно, и непонятно, что вообще не так.
 */
const TORCHES: { x: number; z: number; y?: number }[] = [
  // Южные грани колонн — те, что смотрят на площадь.
  { x: -14, z: 12.75 },
  { x: -10, z: 12.75 },
  { x: -6, z: 12.75 },
  // Западная грань рыночной стены и северная грань длинной.
  { x: 5.25, z: 4 },
  { x: -2.6, z: -5.15 },
];

const HALF_W = TAVERN.width / 2;
const HALF_D = TAVERN.depth / 2;

/** Огни таверны: тёплые пятна, разбавляющие тёмные углы зала. */
const TAVERN_LIGHTS: { x: number; y: number; z: number; color: number; intensity: number }[] = [
  // Очаг: самый яркий и самый тёплый источник зала.
  { x: HALF_W - 1.1, y: 0.8, z: -HALF_D + 1.2, color: 0xff8a34, intensity: 16 },
  // Настенные факелы по бокам.
  { x: -HALF_W + 0.5, y: 2.3, z: 0, color: 0xff9a3c, intensity: 9 },
  { x: HALF_W - 0.5, y: 2.3, z: -1.5, color: 0xff9a3c, intensity: 7 },
  // Свечи на стойке и над столами — от них зал и читается.
  { x: -2, y: 1.5, z: -HALF_D + 1.3, color: 0xffb066, intensity: 6 },
  { x: -3, y: 1.9, z: 1.2, color: 0xffc98a, intensity: 5 },
  { x: 3, y: 1.9, z: 1.2, color: 0xffc98a, intensity: 5 },
];

/**
 * Сколько ламп держим в сцене одновременно.
 *
 * Шесть — это столько, сколько глаз замечает: дальше огни всё равно
 * перекрывают друг друга. Число постоянное и не меняется никогда.
 */
const LIGHT_POOL = 6;

export interface WorldLights {
  /**
   * Весь огонь одной группой.
   *
   * Он весь городской, а город выгружается вместе со своим чанком. Спрятав
   * группу, разом гасим и лампы: источники в невидимой группе не попадают
   * в отрисовку, а лимит их на пиксель в WebGL не резиновый.
   */
  readonly group: THREE.Group;
  /**
   * `daylight` — насколько сейчас светло снаружи, 0..1. Уличный огонь гаснет
   * по этому числу, а не по признаку «день/ночь»: щелчок на рассвете было бы
   * видно.
   */
  update(elapsed: number, daylight: number, camera: THREE.Camera): void;
}

export function createLights(scene: THREE.Scene): WorldLights {
  const flames: Flame[] = [];
  const group = new THREE.Group();
  scene.add(group);

  // Пул ламп. Заводится один раз и живёт, не меняя ни числа, ни видимости.
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < LIGHT_POOL; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 20, 2);
    group.add(light);
    pool.push(light);
  }

  for (const [index, spot] of TORCHES.entries()) {
    flames.push(makeTorch(group, spot.x, spot.y ?? 2.7, spot.z, index));
  }

  for (const [index, spot] of TAVERN_LIGHTS.entries()) {
    flames.push({
      x: TAVERN.centerX + spot.x,
      y: spot.y,
      z: TAVERN.centerZ + spot.z,
      color: spot.color,
      range: 12,
      glow: null,
      base: spot.intensity,
      phase: index * 2.1,
      outdoor: false,
    });
  }

  void loadModels(group, flames);

  /**
   * Отбор ближайших огней. Записи переиспользуются, а не создаются заново:
   * это кадр за кадром, и мусор отсюда потом аукается рывками сборки.
   *
   * Растёт по месту: список огней пополняется асинхронно, когда приезжают
   * модели фонарей и костров. Выделенный «сразу на всех» массив оказывался
   * коротким, и первый же кадр после загрузки падал.
   */
  const lit: { flame: Flame; power: number; weight: number }[] = [];
  let litCount = 0;
  const eye = new THREE.Vector3();

  return {
    group,
    update(elapsed, daylight, camera) {
      // Днём уличный огонь не просто тускнеет, а гаснет совсем: горящий
      // в полдень фонарь читается как ошибка.
      const outdoorScale = Math.max(0, 1 - daylight * 1.4);
      camera.getWorldPosition(eye);
      litCount = 0;

      for (const flame of flames) {
        // Два несинхронных синуса дают живое пламя без случайных скачков.
        const flicker =
          0.82 +
          0.12 * Math.sin(elapsed * 11 + flame.phase) +
          0.06 * Math.sin(elapsed * 23.5 + flame.phase * 2.3);

        const power = flame.base * flicker * (flame.outdoor ? outdoorScale : 1);

        if (flame.glow) {
          flame.glow.visible = power > 0.01;
          flame.glow.scale.setScalar(0.9 + flicker * 0.18);
        }
        if (power <= 0.01) continue;

        // Вес: чем ярче и ближе, тем нужнее. Квадрат расстояния — потому что
        // так же спадает и сам свет.
        const dx = eye.x - flame.x;
        const dy = eye.y - flame.y;
        const dz = eye.z - flame.z;
        const distance = Math.max(0.25, dx * dx + dy * dy + dz * dz);

        const slot = (lit[litCount] ??= { flame, power: 0, weight: 0 });
        litCount++;
        slot.flame = flame;
        slot.power = power;
        slot.weight = power / distance;
      }

      // Сортируем только заполненную часть: хвост — это записи прошлого кадра.
      const chosenLights = lit.slice(0, litCount).sort((a, b) => b.weight - a.weight);

      for (const [index, light] of pool.entries()) {
        const chosen = chosenLights[index];
        if (!chosen) {
          // Лишние лампы не выключаем, а обнуляем: пропавший источник меняет
          // число света в шейдере, и это стоит перекомпиляции всей сцены.
          light.intensity = 0;
          continue;
        }
        light.position.set(chosen.flame.x, chosen.flame.y, chosen.flame.z);
        light.color.setHex(chosen.flame.color);
        light.distance = chosen.flame.range;
        light.intensity = chosen.power;
      }
    },
  };
}

/**
 * Факел-заглушка: кронштейн и огонёк примитивами.
 *
 * Модели у настенного факела нет, и она не нужна: на стене он читается
 * пятном света, а не силуэтом.
 */
function makeTorch(group: THREE.Group, x: number, y: number, z: number, index: number): Flame {
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffcf7a }),
  );
  glow.position.set(x, y, z);
  group.add(glow);

  const bracket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a2d20, roughness: 1 }),
  );
  bracket.position.set(x, y - 0.3, z);
  group.add(bracket);

  return { x, y, z, color: 0xff9a3c, range: 20, glow, base: 34, phase: index * 1.7, outdoor: true };
}

/**
 * Ставит модель: приводит к нужной высоте и опускает основанием на землю.
 *
 * Матрицы обновляются до замера: у свежего клона они не посчитаны, и габариты
 * выходят произвольными — на этом уже обжигались с моделями мобов.
 */
function place(source: THREE.Object3D, height: number): THREE.Object3D {
  const model = source.clone(true);

  /**
   * Своё смещение узла обнуляем до замера.
   *
   * В файле у модели есть собственное смещение, и масштаб его **не трогает**:
   * содержимое ужимается в десять раз, а сдвиг остаётся прежним. Костёр от
   * этого расползался на два метра мимо своей точки. Поэтому и низ, и середину
   * считаем сами и ставим уже в масштабе.
   */
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.max.y - bounds.min.y;
  const scale = size > 0 ? height / size : 1;
  const base = footprint(model, bounds);

  model.scale.setScalar(scale);
  model.position.set(-base.x * scale, -bounds.min.y * scale, -base.z * scale);

  const holder = new THREE.Group();
  holder.add(model);
  holder.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  return holder;
}

/**
 * Где модель **стоит** — середина её основания, а не середина габаритов.
 *
 * У фонаря плафон вынесен на кронштейн в сторону, и по габаритам столб
 * оказывался в полуметре от своей точки: коробка столкновений в одном месте,
 * видимый столб в другом, и игрок упирался в воздух. Считаем по нижнему слою
 * вершин — это и есть то, чем вещь касается земли.
 */
function footprint(model: THREE.Object3D, bounds: THREE.Box3): { x: number; z: number } {
  const height = bounds.max.y - bounds.min.y;
  const ceiling = bounds.min.y + Math.max(height * 0.15, 0.001);

  let count = 0;
  let x = 0;
  let z = 0;
  const point = new THREE.Vector3();

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;

    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
      if (point.y > ceiling) continue;
      x += point.x;
      z += point.z;
      count++;
    }
  });

  // Ни одной вершины у земли не бывает, но если так — габариты не хуже.
  if (count === 0) {
    return { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
  }
  return { x: x / count, z: z / count };
}

/**
 * Зажигает само пламя.
 *
 * Огонь в модели — обычный меш, и в темноте он освещается наравне с поленьями:
 * костёр читался кучей дров. Пламя обязано светиться само, независимо от того,
 * досталась ли этому костру лампа из пула, — иначе дальний костёр выглядит
 * потухшим.
 */
function kindleFlame(model: THREE.Object3D): void {
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !/^Fuego/i.test(mesh.name)) return;

    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const standard = material as THREE.MeshStandardMaterial;
      if (!standard.emissive) continue;
      // Тёплым, а не своим цветом: материал пламени в модели почти белый,
      // и как есть костёр светился как лампа дневного света.
      standard.emissive.setHex(0xff7a22);
      standard.emissiveIntensity = 2.2;
    }
    // Тень от пламени — бессмыслица, а в проход теней оно попадает как все.
    mesh.castShadow = false;
  });
}

async function loadModels(group: THREE.Group, flames: Flame[]): Promise<void> {
  if (typeof document === 'undefined') return;

  try {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);

    const gltf = await loader.loadAsync(MODEL_URL);
    const lamp = gltf.scene.getObjectByName('streetlight');
    const fire = gltf.scene.getObjectByName('bonfire');

    if (lamp) {
      for (const [index, spot] of TOWN_LAMPS.entries()) {
        const model = place(lamp, LAMP_HEIGHT);
        model.position.x = spot.x;
        model.position.z = spot.z;
        group.add(model);

        // Свет висит в плафоне, а не в центре модели.
        flames.push({
          x: spot.x,
          y: LAMP_HEIGHT - 0.35,
          z: spot.z,
          color: 0xffc27a,
          range: 18,
          glow: null,
          base: 26,
          phase: index * 0.9,
          outdoor: true,
        });
      }
    }

    if (fire) {
      // Очаг таверны — единственный огонь такого рода в городе.
      const spots = [
        {
          x: TAVERN.centerX + HALF_W - 1.1,
          z: TAVERN.centerZ - HALF_D + 1.2,
          y: 0.1,
          outdoor: false,
        },
      ];

      for (const [index, spot] of spots.entries()) {
        const model = place(fire, FIRE_HEIGHT);
        model.position.set(spot.x, spot.y, spot.z);
        kindleFlame(model);
        group.add(model);

        flames.push({
          x: spot.x,
          y: spot.y + 0.6,
          z: spot.z,
          color: 0xff7a28,
          range: 16,
          glow: model,
          base: 30,
          phase: 4 + index * 1.3,
          outdoor: spot.outdoor,
        });
      }
    }
  } catch (error) {
    console.warn('[свет] модели не загрузились:', error);
  }
}
