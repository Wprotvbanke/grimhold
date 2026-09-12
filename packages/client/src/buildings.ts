import * as THREE from 'three';
import { TAVERN } from '@grimhold/shared';

/**
 * Постройки: то, чего не сделать коробкой.
 *
 * Стены, пол и потолок таверны — обычные коробки уровня: они телесны, и
 * считает их сервер. А скат кровли, открытая дверь, окна и вывеска телесности
 * не имеют и в прямоугольник не укладываются, поэтому живут здесь.
 *
 * Текстуры — модульные панели Kenney (CC0). Они не бесшовные: один файл это
 * одна панель. Отсюда правило — **развёртку считать в панелях, а не в метрах**,
 * иначе фахверк поедет, а окно окажется разрезанным пополам.
 *
 * Подробности — docs/buildings.md.
 */

const TEXTURE_PATH = '/textures/buildings/';

/** Скат кровли: насколько конёк выше карниза. */
const ROOF_RISE = 2.3;
/** Свес кровли за стену. */
const ROOF_OVERHANG = 0.55;

export interface Buildings {
  /**
   * Всё убранство одной группой: город выгружается вместе со своим чанком,
   * и эта группа обязана уходить с ним. Иначе кровля и окна висят в воздухе
   * над пустым местом.
   */
  readonly group: THREE.Group;
  /** `daylight` 0..1: по нему в окнах зажигается свет. */
  update(daylight: number): void;
}

const loader = new THREE.TextureLoader();

/** Панель Kenney: чёткие пиксели и нужное число повторов. */
function panel(file: string, repeatX = 1, repeatY = 1): THREE.Texture | null {
  if (typeof document === 'undefined') return null;

  const map = loader.load(`${TEXTURE_PATH}${file}.png`);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.NearestFilter;
  map.repeat.set(repeatX, repeatY);
  return map;
}

export function createBuildings(scene: THREE.Scene): Buildings {
  const group = new THREE.Group();
  group.position.set(TAVERN.centerX, 0, TAVERN.centerZ);
  scene.add(group);

  const windows: THREE.MeshStandardMaterial[] = [];

  addRoof(group);
  addDoor(group);
  addWindows(group, windows);
  addSign(group);
  addBeams(group);

  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  return {
    group,
    update(daylight) {
      // Свет в окнах — единственное, что показывает снаружи, что внутри
      // кто-то есть. Днём он не нужен: на солнце окно и так тёмное пятно.
      const night = Math.max(0, 1 - daylight * 1.3);
      for (const material of windows) material.emissiveIntensity = night * 1.6;
    },
  };
}

/**
 * Двускатная кровля.
 *
 * Коробкой её не выразить, а ступеньками из коробок она превращается
 * в зиккурат. Поэтому два наклонных щита и два фронтона отдельной геометрией,
 * поверх плоского потолка, который и держит игрока.
 */
function addRoof(group: THREE.Group): void {
  const { width, depth, height, wall } = TAVERN;
  const outerW = width + wall * 2 + ROOF_OVERHANG * 2;
  const halfD = depth / 2 + wall + ROOF_OVERHANG;
  const eaves = height + 0.3;

  const slope = Math.hypot(halfD, ROOF_RISE);
  const pitch = Math.atan2(ROOF_RISE, halfD);

  const material = new THREE.MeshStandardMaterial({
    map: panel('roof_clay_grey_center', Math.round(outerW / 1.1), Math.round(slope / 1.1)),
    color: 0x8d99a6,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  for (const direction of [1, -1]) {
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(outerW, slope), material);
    slab.rotation.x = -Math.PI / 2 + direction * pitch;
    slab.rotation.z = direction > 0 ? 0 : Math.PI;
    slab.position.set(0, eaves + ROOF_RISE / 2, (direction * halfD) / 2);
    group.add(slab);
  }

  // Фронтоны: без них с торца видно пустоту под коньком.
  const gableMaterial = new THREE.MeshStandardMaterial({
    map: panel('wall_timber_structure', 2, 1),
    color: 0xb0a893,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });

  const shape = new THREE.Shape();
  shape.moveTo(-halfD, 0);
  shape.lineTo(halfD, 0);
  shape.lineTo(0, ROOF_RISE);
  shape.closePath();

  for (const direction of [1, -1]) {
    const gable = new THREE.Mesh(new THREE.ShapeGeometry(shape), gableMaterial);
    gable.rotation.y = (direction * Math.PI) / 2;
    gable.position.set((direction * (width + wall * 2)) / 2, eaves, 0);
    group.add(gable);
  }
}

/**
 * Открытая дверь.
 *
 * Именно открытая: закрытая створка в единственном проходимом проёме города
 * читалась бы как запертая дверь, а проходить сквозь неё — как ошибка.
 */
function addDoor(group: THREE.Group): void {
  const { depth, wall, doorWidth } = TAVERN;
  const leaf = new THREE.Mesh(
    new THREE.BoxGeometry(doorWidth * 0.95, 2.4, 0.08),
    new THREE.MeshStandardMaterial({
      map: panel('door_wood_window'),
      color: 0x9a7f5e,
      roughness: 0.9,
    }),
  );

  // Створка распахнута внутрь и прижата к косяку.
  const hinge = new THREE.Group();
  hinge.position.set(-doorWidth / 2, 1.2, depth / 2 + wall / 2);
  leaf.position.set(doorWidth * 0.47, 0, -doorWidth * 0.47);
  leaf.rotation.y = -Math.PI / 2.2;
  hinge.add(leaf);
  group.add(hinge);
}

/** Окна: панели поверх стен, светящиеся изнутри в темноте. */
function addWindows(group: THREE.Group, collect: THREE.MeshStandardMaterial[]): void {
  const { width, depth, wall, stone } = TAVERN;
  const y = stone + 0.95;

  const spots: { x: number; z: number; yaw: number; tall: boolean }[] = [
    { x: -width / 2 + 2.2, z: depth / 2 + wall, yaw: 0, tall: true },
    { x: width / 2 - 2.2, z: depth / 2 + wall, yaw: 0, tall: true },
    { x: width / 2 + wall, z: 1.6, yaw: Math.PI / 2, tall: false },
    { x: -width / 2 - wall, z: 1.6, yaw: -Math.PI / 2, tall: false },
    { x: -width / 2 - wall, z: -1.8, yaw: -Math.PI / 2, tall: false },
  ];

  for (const spot of spots) {
    const file = spot.tall ? 'window_tall_divided' : 'window_square_divided';
    const material = new THREE.MeshStandardMaterial({
      map: panel(file),
      // Светится тот же рисунок, но в «зажжённом» варианте: за стеклом
      // загорается огонь, а переплёт остаётся тем же.
      emissiveMap: panel(`${file}_lit`),
      emissive: new THREE.Color(0xffb463),
      emissiveIntensity: 0,
      color: 0x8e8574,
      roughness: 0.8,
      transparent: false,
    });
    collect.push(material);

    const size = spot.tall ? [1.0, 1.7] : [0.9, 0.9];
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(size[0]!, size[1]!), material);
    pane.rotation.y = spot.yaw;
    // Чуть наружу от стены: иначе панель спорит с коробкой за один и тот же
    // пиксель и мерцает полосами.
    pane.position.set(
      spot.x + Math.sin(spot.yaw) * 0.03,
      y,
      spot.z + Math.cos(spot.yaw) * 0.03,
    );
    group.add(pane);
  }
}

/** Вывеска над дверью: по ней таверну находят с площади. */
function addSign(group: THREE.Group): void {
  const { depth, wall } = TAVERN;
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 1 });

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.1), wood);
  arm.position.set(1.7, 3.05, depth / 2 + wall + 0.5);
  group.add(arm);

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.7, 0.06),
    new THREE.MeshStandardMaterial({
      map: panel('timber_square_clay'),
      color: 0x8a6f4e,
      roughness: 0.95,
    }),
  );
  board.position.set(1.7, 2.6, depth / 2 + wall + 0.95);
  group.add(board);
}

/** Угловые стойки и балка над цоколем: фахверк должен на чём-то стоять. */
function addBeams(group: THREE.Group): void {
  const { width, depth, height, wall, stone } = TAVERN;
  const wood = new THREE.MeshStandardMaterial({ color: 0x4f3a27, roughness: 1 });

  const halfW = width / 2 + wall;
  const halfD = depth / 2 + wall;

  for (const x of [-halfW, halfW]) {
    for (const z of [-halfD, halfD]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, height - stone, 0.22), wood);
      post.position.set(x, (stone + height) / 2, z);
      group.add(post);
    }
  }

  // Балка по верху цоколя — линия, по которой читается этаж.
  for (const z of [-halfD, halfD]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 + 0.2, 0.22, 0.22), wood);
    beam.position.set(0, stone + 0.11, z);
    group.add(beam);
  }
  for (const x of [-halfW, halfW]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, halfD * 2), wood);
    beam.position.set(x, stone + 0.11, 0);
    group.add(beam);
  }
}
