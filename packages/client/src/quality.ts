import * as THREE from 'three';

/**
 * Подстройка качества под машину.
 *
 * Одно и то же число пикселей стоит на разных машинах по-разному, и угадать
 * заранее нельзя: на экране с двойной плотностью кадр вчетверо дороже, чем
 * на обычном, а видеокарта может быть при этом слабее. Поэтому разрешение
 * не задаётся раз и навсегда, а **отступает при просадке и возвращается**,
 * когда запас появился.
 *
 * Решение принимается по медиане, а не по последнему кадру: один тяжёлый кадр
 * при подгрузке чанка — не повод портить картинку на всю сессию.
 *
 * Меняется редко и мелкими шагами: частая смена разрешения сама по себе
 * видна как пульсация резкости, и это хуже, чем стабильно чуть мягче.
 */

/** Кадр дороже этого считаем просадкой (мс). Это примерно 45 кадров в секунду. */
const SLOW_MS = 22;
/** Дешевле этого — есть запас, можно вернуть резкость. Это 80 кадров в секунду. */
const FAST_MS = 12.5;

/** Насколько менять множитель разрешения за один шаг. */
const STEP = 0.15;
/** Ниже этого не опускаемся: дальше уже каша, играть неприятно. */
const FLOOR = 0.7;

/** Как часто разрешено менять качество, мс. */
const SETTLE_MS = 1500;
/**
 * По скольким кадрам судим.
 *
 * Полсотни — это меньше секунды на здоровой машине и пара секунд на слабой.
 * Больше значило бы терпеть просадку дольше, меньше — дёргать разрешение
 * от каждой случайной заминки.
 */
const WINDOW = 50;

export interface Quality {
  /** Текущий множитель разрешения — его же показывает отладочная строка. */
  readonly scale: number;
  /** Зовётся каждый кадр перед отрисовкой. */
  frame(now: number): void;
  /**
   * Выбор игрока из меню настроек.
   *
   * Ручное разрешение выключает подстройку целиком: если человек выставил
   * число сам, подкручивать его за него — значит спорить с ним же.
   */
  configure(options: { resolution: 'auto' | number; shadows: 'every' | 'half' | 'off' }): void;
}

export function createQuality(renderer: THREE.WebGLRenderer): Quality {
  // Потолок — то, что просил браузер, но не больше двойного: выше разницы
  // не видно, а платить приходится вчетверо.
  const ceiling = Math.min(devicePixelRatio || 1, 2);
  let scale = ceiling;

  const times: number[] = [];
  let last = performance.now();
  let changedAt = last;
  let frames = 0;

  /** Что выбрал игрок. `auto` — подстраиваемся сами, как раньше. */
  let wantedResolution: 'auto' | number = 'auto';
  let wantedShadows: 'every' | 'half' | 'off' = 'half';
  /** Когда карту теней обновляли в последний раз. */
  let shadowsAt = 0;

  /** Сколько раз в секунду пересчитывать тени в щадящем режиме. */
  const SHADOW_RATE = 30;

  renderer.setPixelRatio(scale);

  /**
   * Тени пересчитываем **по времени, а не по кадрам**.
   *
   * Карта теней строится заново и стоит как ещё один проход по сцене. Счёт
   * по кадрам привязывал эту цену к частоте экрана: на ста восьмидесяти
   * кадрах выходило девяносто пересчётов в секунду — втрое больше, чем нужно
   * глазу, и каждый второй кадр получался вдвое дороже соседнего. На высокой
   * частоте, где на кадр отведено пять миллисекунд, этого хватало, чтобы
   * часть кадров не успевала к развёртке.
   *
   * Тридцать раз в секунду достаточно: карта стоит на сетке своих пикселей
   * (см. sun.md), тени в мире неподвижны, и отставание на тридцать
   * миллисекунд увидеть нечем.
   */
  renderer.shadowMap.autoUpdate = false;

  const api: Quality = {
    get scale() {
      return scale;
    },

    configure(options) {
      wantedResolution = options.resolution;
      wantedShadows = options.shadows;

      /**
       * Тени выключаются **флагом рендерера**, а не снятием castShadow
       * с каждого объекта: смена флага у объектов пересобирает шейдеры всех
       * материалов сцены, и это фриз на полсекунды посреди игры.
       */
      renderer.shadowMap.enabled = options.shadows !== 'off';
      renderer.shadowMap.needsUpdate = true;

      const wanted = options.resolution === 'auto' ? ceiling : options.resolution;
      if (wanted === scale) return;

      scale = wanted;
      renderer.setPixelRatio(scale);
      // Размер задаём заново: three пересоздаёт буфер кадра только по нему.
      renderer.setSize(innerWidth, innerHeight);
      changedAt = performance.now();
      times.length = 0;
    },

    frame(now) {
      // Тени: каждый кадр честнее, тридцать раз в секунду заметно дешевле,
      // выключенные — самый большой запас.
      frames++;
      const due = wantedShadows === 'half' && now - shadowsAt >= 1000 / SHADOW_RATE;
      if (due) shadowsAt = now;
      renderer.shadowMap.needsUpdate = wantedShadows === 'every' || due;

      times.push(now - last);
      last = now;
      if (times.length > WINDOW) times.shift();

      // Разрешение выставлено вручную — подстраивать нечего.
      if (wantedResolution !== 'auto') return;
      if (times.length < WINDOW || now - changedAt < SETTLE_MS) return;

      const sorted = [...times].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;

      let wanted = scale;
      if (median > SLOW_MS) wanted = Math.max(FLOOR, scale - STEP);
      else if (median < FAST_MS) wanted = Math.min(ceiling, scale + STEP);
      if (wanted === scale) return;

      scale = wanted;
      renderer.setPixelRatio(scale);
      // Размер задаём заново: three пересоздаёт буфер кадра только по нему.
      renderer.setSize(innerWidth, innerHeight);
      changedAt = now;
      times.length = 0;
    },
  };

  return api;
}
