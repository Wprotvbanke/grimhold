import * as THREE from 'three';
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
    },
  };
}
