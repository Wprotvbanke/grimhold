import * as THREE from 'three';

/**
 * Экран загрузки.
 *
 * Между «выбрал персонажа» и «вижу город» уходят секунды: только руки весят
 * без малого шесть мегабайт, а за ними идут стены, дома и звук. Без экрана
 * это выглядит не как загрузка, а как сломавшаяся игра — человек смотрит
 * в пустоту и не знает, ждать ему или перезагружать вкладку.
 *
 * Прогресс берётся у **общего загрузчика three** (`DefaultLoadingManager`):
 * все наши загрузчики создаются без своего менеджера, то есть докладывают
 * именно ему — и модели, и текстуры, и звуки. Отдельный счётчик заводить
 * не надо, а главное — он не разойдётся с правдой, когда добавят новый ассет.
 */

/** Сколько экран висит минимум: мигнувший на долю секунды хуже, чем никакой. */
const MIN_SHOWN = 0.6;

/**
 * Через сколько секунд гасить силой.
 *
 * Страховка от застрявшей загрузки: пусть лучше игрок войдёт в недогруженный
 * мир и увидит, как всё дорисовывается, чем останется перед полосой навсегда.
 */
const GIVE_UP = 25;

/** Раз в сколько секунд проверяем, не кончились ли загрузки втихую. */
const IDLE_CHECK = 0.4;

/**
 * Сколько ждать первой загрузки, прежде чем поверить, что грузить нечего.
 *
 * К моменту входа в мир очередь пуста: город за спиной экрана входа уже
 * построен. Руки заводятся мгновением позже, и без этой паузы экран
 * схлопывался раньше, чем они начинали грузиться.
 */
const WARMUP = 2.5;

export interface LoadingScreen {
  /** Показать экран: вход в мир начался. */
  show(): void;
  /** Идёт ли загрузка прямо сейчас. */
  readonly busy: boolean;
}

export function createLoading(): LoadingScreen {
  const screen = document.getElementById('loading');
  const fill = document.getElementById('loadingFill');
  const text = document.getElementById('loadingText');
  if (!screen || !fill || !text) return { show: () => {}, busy: false };

  const manager = THREE.DefaultLoadingManager;
  let shownAt = 0;
  let busy = false;
  let idle = 0;
  let ticking = 0;

  /**
   * Доля готового.
   *
   * Общий счётчик менеджера считает **все** загрузки за сеанс, в том числе
   * прошедшие на экране входа. Поэтому запоминаем, сколько их было к началу
   * показа, и меряем только то, что грузится сейчас: иначе полоса открывалась
   * бы сразу на девяноста процентах.
   */
  let from = 0;
  let loaded = 0;
  let total = 0;

  const paint = (): void => {
    const done = Math.max(0, loaded - from);
    const want = Math.max(1, total - from);
    const part = Math.max(0, Math.min(1, done / want));
    const percent = Math.round(part * 100);
    fill.style.width = `${percent}%`;
    text.textContent = `ЗАГРУЗКА · ${percent}%`;
  };

  const hide = (): void => {
    if (!busy) return;
    busy = false;
    window.clearInterval(ticking);
    loaded = total;
    paint();

    // Даём полосе дойти до края, а картинке — раствориться, а не пропасть.
    const waited = (performance.now() - shownAt) / 1000;
    const rest = Math.max(0, MIN_SHOWN - waited) * 1000;
    window.setTimeout(() => {
      screen.classList.add('gone');
      window.setTimeout(() => {
        screen.setAttribute('hidden', '');
        screen.classList.remove('gone');
      }, 500);
    }, rest);
  };

  manager.onProgress = (_url, itemsLoaded, itemsTotal) => {
    loaded = itemsLoaded;
    total = itemsTotal;
    idle = 0;
    if (busy) paint();
  };
  manager.onLoad = () => {
    // Только если после показа что-то действительно грузилось: иначе это
    // хвост прежней очереди, а нашей ещё и не начиналось.
    if (loaded > from) hide();
  };
  // Не загрузилось — это не повод держать игрока: мир построится без этого.
  manager.onError = () => {
    idle = 0;
  };

  return {
    show(): void {
      if (busy) return;
      busy = true;
      shownAt = performance.now();
      from = loaded;
      idle = 0;
      screen.style.backgroundImage = 'url(/textures/loading.webp)';
      screen.classList.remove('gone');
      screen.removeAttribute('hidden');
      paint();

      /**
       * Менеджер молчит, когда грузить нечего.
       *
       * Если всё нужное уже лежит в кеше, `onLoad` не придёт вовсе — он
       * сообщает о **конце очереди**, а очередь и не начиналась. Поэтому
       * ещё и сами следим: нет новостей пару проверок подряд — считаем,
       * что загрузка кончилась.
       */
      ticking = window.setInterval(() => {
        idle += IDLE_CHECK;
        const waited = (performance.now() - shownAt) / 1000;
        const quiet = idle > 1.2 && loaded >= total;
        if (waited > GIVE_UP || (waited > WARMUP && quiet)) hide();
      }, IDLE_CHECK * 1000);
    },
    get busy(): boolean {
      return busy;
    },
  };
}
