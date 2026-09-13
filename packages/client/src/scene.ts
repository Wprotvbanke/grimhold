import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CHUNK_SIZE,
  ChunkedWorld,
  DUNGEON_EXIT,
  dungeonSeed,
  generateDungeonChunk,
  isDungeon,
  MOBS,
  RACES,
  SPELLS,
  chunkKey,
  sunHeight,
  type LevelBox,
  type MobId,
  type Race,
  type SpellId,
} from '@grimhold/shared';
import { createBuildings } from './buildings.js';
import { createDayNight } from './daynight.js';
import { createLights } from './lights.js';
import { createNature, disposeNature } from './nature.js';
import { createNodes, disposeNodes, type NodeField } from './nodes.js';
import { populateTavern } from './props.js';
import { createSky } from './sky.js';

/**
 * Рендер мира. Геометрия чанков берётся из того же генератора, которым сервер
 * считает коллизии, — расхождение картинки и физики сразу ломало бы
 * предсказание, поэтому источник ровно один.
 *
 * Чанки строятся и выбрасываются по мере движения игрока: держать весь мир
 * в сцене незачем, а на большой карте — уже и нельзя.
 */

/**
 * Сколько метров мира занимает один тайл текстуры.
 *
 * Число важнее, чем кажется: слишком мелкий тайл превращает землю в рябь,
 * слишком крупный — в размазанное пятно. Два метра примерно соответствуют
 * тому, как выглядит мостовая под ногами человека.
 */
export const TILE_METERS = 2.5;

const textures = new THREE.TextureLoader();

/**
 * Анизотропная фильтрация: сколько выборок делать на вытянутых по перспективе
 * пикселях.
 *
 * Земля уходит к горизонту почти плашмя, и без этого её тайлы в движении
 * рябят — на ходу это читается как дрожь всей картинки, хотя дрожит только
 * фильтрация. Число берётся у видеокарты (`renderer.capabilities`), потому что
 * потолок у разных машин разный, а платить за выборки сверх её предела нельзя.
 *
 * Значение проставляется и уже загруженным картам: материалы заводятся при
 * первом обращении к модулю, а рендерер появляется позже.
 */
let anisotropy = 4;
const loaded: THREE.Texture[] = [];

export function setAnisotropy(limit: number): void {
  anisotropy = Math.max(1, Math.floor(limit));
  for (const texture of loaded) {
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
  }
}

/**
 * Текстура поверхности. Повтор задаётся не здесь, а развёрткой каждой коробки:
 * одна общая текстура на все поверхности этого вида, иначе на каждый камень
 * пришлось бы заводить свою копию.
 *
 * Вне браузера картинок нет (тесты геометрии гоняются в Node), поэтому там
 * материал остаётся цветным. Геометрия и развёртка от этого не зависят,
 * а значит проверять их можно без графики.
 */
function surface(file: string, tint = 0xffffff, pixelated = false): THREE.MeshStandardMaterial {
  if (typeof document === 'undefined') {
    return new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95 });
  }

  const map = textures.load(`/textures/${file}`);
  if (pixelated) {
    // Панели Kenney рисованы в 64 пикселя. Сглаживание превращает их
    // в мыло: доски и камни задуманы чёткими, это часть вида.
    map.magFilter = THREE.NearestFilter;
    map.generateMipmaps = true;
  }
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  // Анизотропия нужна полу: без неё земля вдали превращается в кашу,
  // а в движении рябит.
  map.anisotropy = anisotropy;
  loaded.push(map);

  return new THREE.MeshStandardMaterial({ map, color: tint, roughness: 0.95 });
}

/**
 * Текстуры: Poly Haven, лицензия CC0 — см. public/textures/LICENSE.txt.
 * Оттенки приглушены: снимки сделаны при дневном свете, а у нас сумерки.
 */
const MATERIALS: Record<LevelBox['kind'], THREE.Material> = {
  floor: surface('pavement.jpg', 0xb9b4aa),
  ground: surface('ground.jpg', 0xa9a89c),
  wall: surface('stone.jpg', 0xb2ac9e),
  pillar: surface('stone.jpg', 0xc0b9a8),
  platform: surface('pavement.jpg', 0xa8a096),
  rock: surface('rock.jpg', 0x9a958b),
  ruin: surface('stone.jpg', 0x9d968a),
  timber: surface('planks.jpg', 0xa8998a),
  // Постройки города — пак Kenney, см. docs/buildings.md.
  frame: surface('buildings/wall_timber_structure.png', 0xb0a893, true),
  brick: surface('buildings/wall_brick_stone_center.png', 0x9fa0a2, true),
  plank: surface('buildings/floor_wood_planks.png', 0xa08a70, true),
  shingle: surface('buildings/roof_clay_grey_center.png', 0x8d99a6, true),
  // Сундук окован и темнее половиц: в полумраке зала его надо узнавать
  // с десяти шагов, иначе искать добычу приходится наощупь.
  chest: surface('planks.jpg', 0x6b4f33),
};

/**
 * Размер тайла для видов, у которых он не квадратный.
 *
 * Панели Kenney — это не бесшовные текстуры, а модульные куски: файл 64×128
 * это одна панель стены высотой в этаж. Растянешь её квадратом — фахверк
 * поедет, брус окажется поперёк.
 */
const TILES: Partial<Record<LevelBox['kind'], [number, number]>> = {
  // Сундук маленький: доска в метр растянулась бы на весь бок одной полосой.
  chest: [0.55, 0.55],
  frame: [2.2, 4.4],
  brick: [1.3, 2.6],
  plank: [1.6, 1.6],
  shingle: [1.1, 1.1],
};

/**
 * Растягивает развёртку коробки по её размеру в мире.
 *
 * У BoxGeometry каждая грань размечена от нуля до единицы, поэтому без этой
 * правки текстура растянулась бы на всю грань: один камень мостовой на
 * шестьдесят метров пола. Здесь развёртка пересчитывается так, чтобы тайл
 * всегда занимал TILE_METERS вне зависимости от размера коробки.
 */
export function scaleBoxUv(
  geometry: THREE.BoxGeometry,
  width: number,
  height: number,
  depth: number,
  tile: [number, number] = [TILE_METERS, TILE_METERS],
): void {
  const uv = geometry.attributes.uv as THREE.BufferAttribute;

  // Порядок граней в BoxGeometry: +X, -X, +Y, -Y, +Z, -Z, по четыре вершины.
  const faces: [number, number][] = [
    [depth, height],
    [depth, height],
    [width, depth],
    [width, depth],
    [width, height],
    [width, height],
  ];

  for (let face = 0; face < faces.length; face++) {
    const [u, v] = faces[face]!;
    const repeatU = Math.max(u / tile[0], 0.05);
    const repeatV = Math.max(v / tile[1], 0.05);

    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) * repeatU, uv.getY(index) * repeatV);
    }
  }

  uv.needsUpdate = true;
}

export interface World3D {
  scene: THREE.Scene;
  /** Коллизии вокруг точки — тот же источник, что и у сервера. */
  collidersAt(x: number, z: number): ReturnType<ChunkedWorld['collidersAt']>;
  /** Подгружает и выгружает чанки вокруг наблюдателя. */
  streamChunks(x: number, z: number): void;
  /**
   * Переехать в другой инстанс: сменить землю под ногами.
   *
   * Геометрия не приходит по сети — она выводится из имени инстанса тем же
   * генератором, что и у сервера. Клиенту достаточно знать, где он.
   */
  setInstance(instanceId: string): void;
  /**
   * Живая часть картинки: ход солнца, мерцание огня, свет в окнах.
   *
   * `worldTime` — время суток из общих часов (0 — полночь). Оно приходит
   * из номера тика сервера, а не считается локально: ночь обязана наступать
   * у всех одновременно.
   */
  update(elapsed: number, worldTime: number, camera: THREE.Camera): void;
  /** Ресурсные ноды: вид, выбор цели и состояние с сервера. */
  readonly nodes: NodeField;
  loadedChunks: number;
}

export function createScene(): World3D {
  const scene = new THREE.Scene();

  // Небо, свет и туман — одним куском: порознь они разъезжаются.
  const sky = createSky(scene);
  const daynight = createDayNight(scene, sky);
  const lights = createLights(scene);
  const buildings = createBuildings(scene);
  const nature = createNature();
  const nodes = createNodes();
  // Обстановка таверны: мебель приезжает отдельными моделями, а не коробками.
  const furniture = populateTavern(scene);

  /**
   * Свет над кольцом портала.
   *
   * Заводится сразу и навсегда, гасится силой, а не удалением: число источников
   * вшито в шейдер, и добавить лампу посреди игры — значит пересобрать все
   * материалы сцены разом. На этом уже спотыкались, см. performance.md.
   */
  const portalLight = new THREE.PointLight(0x7fc9d8, 0, 16, 2);
  portalLight.position.set(DUNGEON_EXIT.x, 2.2, DUNGEON_EXIT.z);
  scene.add(portalLight);

  let instanceId = 'overworld';
  let underground = false;
  let terrain = new ChunkedWorld();
  const loaded = new Map<string, THREE.Group>();

  /** Снимает всё построенное: при переезде старая земля не нужна. */
  function dropChunks(): void {
    for (const [key, group] of loaded) {
      const [cx, cz] = key.split(':').map(Number);
      nodes.forget(cx!, cz!);
      scene.remove(group);
      disposeGroup(group);
    }
    loaded.clear();
  }

  const api: World3D = {
    scene,
    nodes,
    loadedChunks: 0,

    collidersAt: (x, z) => terrain.collidersAt(x, z),

    setInstance(next) {
      if (next === instanceId) return;

      instanceId = next;
      underground = isDungeon(next);
      // Небо, солнце и туман переключаются вместе с землёй: светило сквозь
      // потолок — это тени ниоткуда и туман цвета неба, которого не видно.
      daynight.underground = underground;
      sky.mesh.visible = !underground;
      // Портал светится только там, где он есть.
      portalLight.intensity = underground ? 9 : 0;
      terrain = new ChunkedWorld(
        underground ? generateDungeonChunk(dungeonSeed(next)) : undefined,
      );
      dropChunks();
      api.loadedChunks = 0;
    },

    streamChunks(x, z) {
      const needed = ChunkedWorld.chunksAround(x, z);
      const keep = new Set(needed.map((c) => chunkKey(c.cx, c.cz)));

      /**
       * За кадр собираем **один** чанк.
       *
       * Чанк это сотни коробок и десяток пачек растительности, и строить их
       * все разом — это заметный рывок каждый раз, когда пересекаешь границу,
       * а на входе в мир и вовсе девять штук подряд. Ждать соседний чанк
       * лишние пару кадров не страшно: игрок в это время только подходит
       * к его краю.
       */
      for (const { cx, cz } of needed) {
        const key = chunkKey(cx, cz);
        if (loaded.has(key)) continue;

        const group = buildChunkMesh(scene, terrain.getChunk(cx, cz));
        // Под землёй не растёт ни леса, ни руды: раскладка диких земель
        // к подземелью отношения не имеет, и строить её там — деревья
        // посреди зала.
        if (!underground) {
          // Растительность живёт и выгружается вместе с чанком: раскладка
          // у неё общая с сервером, а вот меши — забота клиента.
          group.add(nature.build(cx, cz));
          // Ресурсные ноды — там же: раскладка общая, меши наши.
          group.add(nodes.build(cx, cz));
        }
        loaded.set(key, group);
        break;
      }

      for (const [key, group] of loaded) {
        if (keep.has(key)) continue;
        const [cx, cz] = key.split(':').map(Number);
        nodes.forget(cx!, cz!);
        scene.remove(group);
        disposeGroup(group);
        loaded.delete(key);
      }

      api.loadedChunks = loaded.size;
    },

    update(elapsed, worldTime, camera) {
      daynight.update(worldTime, camera);

      /**
       * Город показываем, только пока он рядом.
       *
       * Его коробки выгружаются вместе с чанком, а всё, что построено моделями
       * — кровля, мебель, фонари, — живёт в сцене всю сессию. Без этой проверки
       * они оставались висеть в воздухе над пустым местом, да ещё и считались
       * каждый кадр.
       */
      const nearTown = Math.hypot(camera.position.x, camera.position.z) < CHUNK_SIZE;
      buildings.group.visible = nearTown;
      furniture.visible = nearTown;
      /**
       * Огонь нужен и в городе, и под землёй — значит группу не прячем там,
       * где он есть. Городские факелы при этом не мешают: пул выбирает
       * ближайшие, а город из подземелья за восемь километров.
       */
      lights.group.visible = nearTown || underground;

      // Насколько светло снаружи: по этому числу гаснет уличный огонь
      // и загорается свет в окнах. Плавно, а не щелчком на рассвете.
      const daylight = Math.max(0, Math.min(1, sunHeight(worldTime) * 3));
      lights.update(elapsed, daylight, camera);
      buildings.update(daylight);
    },
  };

  return api;
}

/**
 * Собирает чанк, сливая коробки по виду поверхности.
 *
 * Отдельным мешем на коробку выходило по полсотни вызовов отрисовки на чанк
 * и под три сотни на девять загруженных — а рисуется при этом один и тот же
 * камень одним и тем же материалом. После слияния чанк стоит столько вызовов,
 * сколько в нём разных поверхностей: обычно три-четыре.
 *
 * Развёртка считается до слияния, поэтому текстура на каждой коробке остаётся
 * своего размера — `scaleBoxUv` запекает повторы прямо в вершины.
 */
function buildChunkMesh(scene: THREE.Scene, boxes: LevelBox[]): THREE.Group {
  const group = new THREE.Group();
  const byKind = new Map<LevelBox['kind'], THREE.BufferGeometry[]>();

  for (const entry of boxes) {
    // Невидимые коробки только преграждают путь: их вид дают модели
    // обстановки, см. props.ts.
    if (entry.hidden) continue;

    const { box } = entry;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    const depth = box.maxZ - box.minZ;

    const geometry = new THREE.BoxGeometry(width, height, depth);
    scaleBoxUv(geometry, width, height, depth, TILES[entry.kind]);
    geometry.translate(
      (box.minX + box.maxX) / 2,
      (box.minY + box.maxY) / 2,
      (box.minZ + box.maxZ) / 2,
    );

    const list = byKind.get(entry.kind) ?? [];
    list.push(geometry);
    byKind.set(entry.kind, list);
  }

  for (const [kind, pieces] of byKind) {
    const merged = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
    if (!merged) continue;
    for (const piece of pieces) if (piece !== merged) piece.dispose();

    const mesh = new THREE.Mesh(merged, MATERIALS[kind]);
    mesh.receiveShadow = true;
    // Пол тени не отбрасывает: он и так лежит, а в проходе теней стоит как все.
    mesh.castShadow = kind !== 'floor';
    group.add(mesh);
  }

  scene.add(group);
  return group;
}

/** Геометрию выгруженного чанка надо освобождать явно — иначе течёт видеопамять. */
function disposeGroup(group: THREE.Group): void {
  // Растительность освобождается отдельно: геометрия у неё общая на весь мир
  // и принадлежит библиотеке, а не этому чанку.
  disposeNature(group);
  disposeNodes(group);
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && !(node as THREE.InstancedMesh).isInstancedMesh) mesh.geometry.dispose();
  });
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

const SPELL_COLORS: Record<SpellId, number> = {
  ember: 0xff7a30,
  frostbite: 0x7fd4ff,
  lightning: 0xc8b6ff,
  mend: 0x86c98a,
  wardskin: 0xb9a97e,
  lantern: 0xffe9a8,
};

/**
 * Снаряд заклинания: светящийся шар, видимый издалека.
 *
 * Своего источника света у снаряда **нет**. Он был, и это оказалось дорого
 * не силой света, а самим фактом: в прямом рендере three число источников
 * зашито в шейдер, и появление снаряда перекомпилировало все материалы сцены.
 * В бою заклинаниями это давало рывок на каждый выстрел и на каждое попадание.
 * Светят снарядам лампы из пула — см. `createProjectileLights`.
 */
export function createProjectileMesh(spellId: SpellId): THREE.Object3D {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    // Шар светится сам: ему свет и не нужен, он сам себе источник картинки.
    new THREE.MeshBasicMaterial({ color: SPELL_COLORS[spellId] ?? 0xffffff }),
  );
  group.add(core);
  return group;
}

/**
 * Мешок павшего: мешковина, перетянутая верёвкой.
 *
 * Геометрия своя, а не из пака: мешок должен читаться мгновенно и с любого
 * ракурса — это единственная вещь в зале, ради которой стоит рискнуть,
 * и искать её в полумраке игрок будет глазами, а не подсказкой.
 */
export function createBagMesh(): THREE.Object3D {
  const group = new THREE.Group();

  const cloth = new THREE.MeshStandardMaterial({ color: 0x7a6a4f, roughness: 1 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), cloth);
  body.scale.set(1, 0.85, 1);
  body.position.y = 0.27;
  body.castShadow = true;
  group.add(body);

  // Горловина: по ней мешок отличается от камня, которых в зале хватает.
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.16, 0.22, 8),
    new THREE.MeshStandardMaterial({ color: 0x5f5238, roughness: 1 }),
  );
  neck.position.y = 0.56;
  group.add(neck);

  return group;
}

/** Сколько снарядов освещают мир одновременно. */
const PROJECTILE_LIGHTS = 3;

export interface ProjectileLights {
  /** Зовётся каждый кадр со списком живых снарядов. */
  update(list: readonly { x: number; y: number; z: number; spellId: SpellId }[]): void;
}

/**
 * Лампы для снарядов: постоянный пул, переезжающий к ближайшим.
 *
 * Число ламп в сцене не меняется никогда — в этом весь смысл. Трёх хватает:
 * летящих одновременно снарядов в кадре обычно один-два, а их свет всё равно
 * перекрывается.
 */
export function createProjectileLights(scene: THREE.Scene): ProjectileLights {
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < PROJECTILE_LIGHTS; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 9, 2);
    scene.add(light);
    pool.push(light);
  }

  return {
    update(list) {
      for (const [index, light] of pool.entries()) {
        const projectile = list[index];
        if (!projectile) {
          // Гасим силой, а не видимостью: исчезнувший источник — это опять
          // перекомпиляция всей сцены.
          light.intensity = 0;
          continue;
        }
        light.position.set(projectile.x, projectile.y, projectile.z);
        light.color.setHex(SPELL_COLORS[projectile.spellId] ?? 0xffffff);
        light.intensity = SPELLS[projectile.spellId].power * 0.5;
      }
    },
  };
}

export { CHUNK_SIZE };
