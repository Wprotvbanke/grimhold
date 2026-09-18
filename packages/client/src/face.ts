/**
 * Лицо в окне панели — картинки настроения от владельца.
 *
 * Прежде в окне дышала трёхмерная кукла (тот же портрет, что в рюкзаке);
 * владелец заменил её **картинками**, которые меняются от того, что
 * происходит с персонажем. Шесть картинок из `Human_Face_Radar`:
 *
 * | настроение | когда |
 * |---|---|
 * | `full`      | здоровье полное — и вообще спокойное состояние |
 * | `fight`     | начал бой: ударил, выстрелил, прочёл свиток — на несколько секунд |
 * | `hit`       | получил урон — на несколько секунд |
 * | `low`       | осталась треть здоровья и меньше — пока не подлечился |
 * | `trade`     | торгуется с игроком — пока окно торга открыто |
 * | `tradeEnd`  | торг завершён сделкой — на несколько секунд |
 *
 * Две ступени: **основа** (спокойное, мало здоровья, торг) — состояние,
 * которое держится, пока оно правда; и **вспышка** (бой, урон, сделка) —
 * событие, которое показывается несколько секунд поверх основы и гаснет.
 * Так получил урон при трети здоровья — мелькнёт боль и вернётся «мало
 * здоровья», а не «полное».
 *
 * Чистая картинка: всё выводится из того, что клиент и так знает
 * (снапшот, свои нажатия, сообщение торга). Сервер о лице не знает.
 */

export type Mood = 'full' | 'fight' | 'hit' | 'low' | 'trade' | 'tradeEnd';

/** Сколько держится вспышка, секунды. */
const FLASH = 2.5;
/** Доля здоровья, с которой начинается «мало». */
const LOW_HEALTH = 1 / 3;

const PICTURES: Record<Mood, string> = {
  full: '/ui/face/full.webp',
  fight: '/ui/face/fight.webp',
  hit: '/ui/face/hit.webp',
  low: '/ui/face/low.webp',
  trade: '/ui/face/trade.webp',
  tradeEnd: '/ui/face/trade_end.webp',
};

export interface Face {
  /** Свежие числа здоровья: по ним основа и вспышка урона. */
  vitals(health: number, maxHealth: number): void;
  /** Начал бой: удар, выстрел, свиток. */
  fight(): void;
  /** Торг: `open`/`invited` — идёт, `done` — сделка, `closed` — сорвался. */
  trade(stage: 'invited' | 'open' | 'done' | 'closed'): void;
  /** Вход в мир: забыть прошлое, начать со спокойного. */
  reset(): void;
  /** Каждый кадр: гасит вспышки. `now` — миллисекунды. */
  update(now: number): void;
}

export function createFace(image: HTMLImageElement): Face {
  let low = false;
  let trading = false;
  let lastHealth = Number.NaN;
  let flash: { mood: Mood; until: number } | null = null;
  let shown: Mood | null = null;
  let clock = 0;

  function base(): Mood {
    if (trading) return 'trade';
    if (low) return 'low';
    return 'full';
  }

  function show(mood: Mood): void {
    if (mood === shown) return;
    shown = mood;
    image.src = PICTURES[mood];
  }

  function burst(mood: Mood): void {
    flash = { mood, until: clock + FLASH * 1000 };
    show(mood);
  }

  return {
    vitals(health, maxHealth) {
      // Урон — по падению числа, как зелёная полоса по росту: отдельного
      // признака в снапшоте нет, и он не нужен.
      if (Number.isFinite(lastHealth) && health < lastHealth) burst('hit');
      lastHealth = health;
      low = maxHealth > 0 && health <= maxHealth * LOW_HEALTH;
    },

    fight() {
      burst('fight');
    },

    trade(stage) {
      trading = stage === 'invited' || stage === 'open';
      if (stage === 'done') burst('tradeEnd');
      if (!flash) show(base());
    },

    reset() {
      low = false;
      trading = false;
      lastHealth = Number.NaN;
      flash = null;
      show('full');
    },

    update(now) {
      clock = now;
      if (flash && now >= flash.until) flash = null;
      show(flash ? flash.mood : base());
    },
  };
}
