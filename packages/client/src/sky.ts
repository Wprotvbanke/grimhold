import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { sunHeight } from '@grimhold/shared';

/**
 * Небо.
 *
 * Купол со сферической панорамой вместо сплошного цвета: в мрачной игре небо
 * почти всё время тёмное, и без облаков верх кадра превращается в плоское
 * пятно, по которому не понять ни времени суток, ни того, что вообще ночь.
 *
 * Купол нарочно огромный и рисуется первым с выключенной глубиной: он не
 * должен ни обрезаться дальней плоскостью, ни попадать под туман. Ощущение
 * дали даёт не расстояние до купола, а то, что он не двигается вместе с
 * игроком по высоте и всегда центрирован на камере.
 */

/**
 * Подкраска панорамы ночью.
 *
 * Сама картинка тёмная, и без этого просветления её облака не отличить
 * от фона.
 */
const NIGHT_TINT = 0xb9c6e0;

/**
 * Радиус купола.
 *
 * Обязан быть **меньше дальней плоскости камеры**: она отсекает по геометрии,
 * и купол радиусом в полкилометра при дальности отрисовки в двести метров
 * не рисуется вовсе — небо становится плоской заливкой. Глубина при этом
 * выключена, поэтому мир всё равно рисуется поверх, как бы близко купол
 * ни стоял.
 */
const RADIUS = 120;

/** Луна: модель от владельца, собрана prepare-moon.ts. */
const MOON_URL = '/models/moon.glb';

const MOON = {
  /**
   * Как далеко от камеры висит — чуть ближе купола.
   *
   * Дальше него нельзя: купол рисуется фоном без проверки глубины, и луна
   * за ним просто не появилась бы.
   */
  distance: RADIUS * 0.92,
  /**
   * Радиус в метрах на этом расстоянии.
   *
   * Настоящая луна занимает полградуса — на экране это была бы крупинка.
   * Берём заметно крупнее: небо в игре читают мельком и с земли.
   */
  size: 5.5,
  /**
   * Насколько быстро она пропадает на рассвете.
   *
   * Владелец просил, чтобы луна уходила, когда светлеет: множитель делает
   * это раньше восхода — к тому времени, как солнце показалось из-за
   * горизонта, её уже нет.
   */
  fade: 4,
};

export interface Sky {
  readonly mesh: THREE.Mesh;
  /**
   * Красит небо под время суток.
   *
   * Картинка одна и та же — ночная, — а день получается подкраской и
   * осветлением. Держать по панораме на каждое время суток было бы честнее,
   * но вчетверо дороже по весу при том же результате: облака в дымке всё
   * равно читаются только силуэтом.
   */
  update(time: number, tint: THREE.Color, camera: THREE.Camera): void;
}

/**
 * Куда смотреть за луной.
 *
 * Она ходит по той же дуге, что и солнце, но с обратной стороны — так же,
 * как считает свет ночью (`daynight.ts`). Отсюда и сдвиг на полсуток, и знак
 * у высоты: когда солнце внизу, луна вверху.
 */
function moonAt(time: number, out: THREE.Vector3): THREE.Vector3 {
  const angle = (time + 0.5) * Math.PI * 2;
  const height = -sunHeight(time);
  const flat = Math.sqrt(Math.max(0, 1 - height * height));
  return out.set(Math.cos(angle) * flat, height, Math.sin(angle) * flat);
}

export function createSky(scene: THREE.Scene): Sky {
  const geometry = new THREE.SphereGeometry(RADIUS, 32, 16);

  const material = new THREE.MeshBasicMaterial({
    // Смотрим изнутри сферы.
    side: THREE.BackSide,
    // Небо само себе источник: тени и свет на нём смотрелись бы бредом.
    fog: false,
    depthWrite: false,
    // Глубину не проверяем: купол рисуется первым и служит фоном, а не телом.
    depthTest: false,
    color: 0xffffff,
  });

  if (typeof document !== 'undefined') {
    const map = new THREE.TextureLoader().load('/textures/sky.webp');
    map.colorSpace = THREE.SRGBColorSpace;
    map.mapping = THREE.EquirectangularReflectionMapping;
    map.wrapS = THREE.RepeatWrapping;
    material.map = map;
  }

  /**
   * Луна — отдельная модель, а не пятно на панораме.
   *
   * На панораме она всходила бы и заходила вместе с облаками, то есть никак:
   * картинка одна на все сутки. Своим телом она ходит по небу и уходит
   * на рассвете.
   */
  const moon = new THREE.Group();
  /**
   * Рисуется **после купола**.
   *
   * У купола проверки глубины нет, и он закрашивает всё, что нарисовано
   * раньше: с одинаковым порядком ночное небо оставалось пустым, хотя модель
   * была на месте. Мир луну не заботит — её от него отделяет глубина.
   */
  moon.renderOrder = -0.5;
  moon.frustumCulled = false;
  moon.visible = false;
  scene.add(moon);

  const moonMaterials: THREE.MeshBasicMaterial[] = [];
  if (typeof document !== 'undefined') {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);
    void loader
      .loadAsync(MOON_URL)
      .then((gltf) => {
        gltf.scene.traverse((node) => {
          const part = node as THREE.Mesh;
          if (!part.isMesh) return;
          part.frustumCulled = false;
          const source = (
            Array.isArray(part.material) ? part.material[0] : part.material
          ) as THREE.MeshStandardMaterial;
          /**
           * Луна светится сама, но **глубину проверяет**.
           *
           * Свет на неё не падает — единственная лампа сцены и есть она же
           * (см. daynight.ts): со светочувствительным материалом мы бы видели
           * чёрный кружок.
           *
           * А вот глубину, в отличие от купола, выключать нельзя. Луна
           * полупрозрачна (так она гаснет к утру), а прозрачное рисуется
           * после всего непрозрачного — то есть после домов и стен. Без
           * проверки глубины она проступала сквозь них, будто нарисована
           * поверх кадра. Сама она глубину не пишет: за ней ничего нет.
           */
          const flat = new THREE.MeshBasicMaterial({
            map: source.map,
            fog: false,
            transparent: true,
            depthWrite: false,
            depthTest: true,
          });
          part.material = flat;
          moonMaterials.push(flat);
        });
        moon.add(gltf.scene);
      })
      .catch((error: unknown) => {
        // Нет луны — просто нет луны: ночь от этого не ломается.
        console.warn('[небо] луна не загрузилась:', error);
      });
  }

  const toMoon = new THREE.Vector3();

  const mesh = new THREE.Mesh(geometry, material);
  // Рисуем раньше всего остального и не пишем глубину: тогда купол не
  // закрывает мир, что бы ни случилось с его размером.
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    mesh,
    update(time, tint, camera) {
      // Купол всегда вокруг камеры: иначе, уйдя от города на полкилометра,
      // игрок увидел бы его край.
      mesh.position.copy(camera.position);

      // Небо медленно поворачивается вслед за солнцем — облака идут по кругу
      // за сутки, а не висят гвоздём прибитые.
      mesh.rotation.y = time * Math.PI * 2;

      /**
       * Ночью показываем панораму как есть, днём уводим её в цвет дымки.
       *
       * Гасить купол дымкой круглые сутки нельзя: ночная дымка почти чёрная,
       * и нарисованные облака пропадали вместе с ней — небо снова становилось
       * заливкой, ради ухода от которой купол и заводили.
       */
      const day = Math.max(0, sunHeight(time));
      material.color
        .setHex(NIGHT_TINT)
        .lerp(tint, day * 0.85)
        .multiplyScalar(0.8 + day * 0.5);

      /**
       * Луна видна, пока темно, и гаснет, как только светлеет.
       *
       * Прозрачностью, а не выключением: иначе она пропадала бы посреди неба
       * в один кадр. Ниже горизонта не рисуем вовсе — светить из-под земли
       * ей нечем.
       */
      const night = Math.max(0, Math.min(1, -sunHeight(time) * MOON.fade));
      moon.visible = night > 0.01 && moonMaterials.length > 0;
      if (!moon.visible) return;

      moon.position
        .copy(camera.position)
        .addScaledVector(moonAt(time, toMoon), MOON.distance);
      moon.scale.setScalar(MOON.size);
      for (const face of moonMaterials) face.opacity = night;
    },
  };
}
