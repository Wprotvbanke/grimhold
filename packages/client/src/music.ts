import { insideTavern, isDaylight, isSafe } from '@grimhold/shared';

/**
 * Музыка: разная по сценарию.
 *
 * Музыка звучит **только в городе** — днём, ночью и в таверне по-своему.
 * Таверна узнаётся по залу новой модели (`insideTavern`), а не по улице рядом.
 * В диких землях и в подземелье её нет намеренно: там слух работает на
 * выживание — шаги за стеной, чужой замах, — и мелодия глушила бы ровно то,
 * ради чего заведён звук. Город — единственное место, где можно выдохнуть.
 *
 * **Между треками — тишина.** Музыка без перерыва за полчаса становится
 * шумом, который хочется выключить; пауза делает каждый новый трек событием.
 * Это то же правило, что у всего постоянного звука: фон тише и реже события.
 *
 * Треки играются потоком (`<audio>`), а не буфером: восемь треков по три-пять
 * минут в памяти расшифрованными — это сотни мегабайт.
 *
 * Все треки — CC0, источники в docs/assets.md.
 */

export type MusicScene = 'day' | 'night' | 'tavern' | 'lobby';

/** Место в смысле музыки: смена места обрывает трек, смена дня и ночи — нет. */
type Place = 'town' | 'tavern' | 'lobby';

const ROOT = '/music/';

export const PLAYLISTS: Record<MusicScene, readonly string[]> = {
  /** Днём — спокойная площадь и рынок. */
  day: ['town_theme.ogg', 'bards_tale.ogg', 'market_day.ogg'],
  /** Ночью — ветер и тоска: город тот же, а настроение другое. */
  night: ['rising_moon.ogg', 'lament.ogg'],
  /** В таверне — весело: единственное тёплое место в мире. */
  tavern: ['old_tower_inn.ogg', 'minstrel_dance.ogg', 'kings_feast.ogg'],
  /**
   * Лобби — **главная тема**, одна и та же всегда.
   *
   * У игры должна быть мелодия, которую узнают с первой секунды; случайный
   * трек из списка такой не станет. Играет кругом, без тишины между
   * повторами: в лобби сидят минуту, и пауза съела бы половину этого.
   */
  lobby: ['main_theme.ogg'],
};

/** Громкость трека под общей и под ползунком «Музыка»: музыка — фон. */
const TRACK_GAIN = 0.35;
/** Сколько секунд трек уходит и приходит. */
const FADE = 2.5;
/** Тишина между треками, секунды: от и до. */
const PAUSE_MIN = 20;
const PAUSE_MAX = 45;
/**
 * Сколько секунд новое место должно продержаться, прежде чем сменить музыку.
 * Иначе шаг туда-обратно через городские ворота дёргает треки.
 */
const SETTLE = 1.5;

/** Какая музыка положена в этой точке. `null` — тишина: дикие земли и подземелье. */
export function musicSceneAt(
  x: number,
  z: number,
  underground: boolean,
  time: number,
): MusicScene | null {
  if (underground) return null;
  if (insideTavern(x, z)) return 'tavern';
  if (!isSafe(x, z)) return null;
  return isDaylight(time) ? 'day' : 'night';
}

function placeOf(scene: MusicScene | null): Place | null {
  if (scene === null) return null;
  if (scene === 'tavern') return 'tavern';
  if (scene === 'lobby') return 'lobby';
  return 'town';
}

export interface Music {
  /** Каждый кадр: где слушатель и который час. */
  update(dt: number, x: number, z: number, underground: boolean, time: number): void;
  /**
   * Лобби открыто — играет главная тема, и мир на музыку не влияет.
   *
   * Отдельной ручкой, а не через `update`: лобби живёт до входа в мир,
   * когда ни позиции, ни часов ещё нет.
   */
  setLobby(open: boolean): void;
}

export function createMusic(context: AudioContext, output: AudioNode): Music {
  /** Один голос на трек, заведённый заранее: так узел источника не пересоздаётся. */
  interface Voice {
    element: HTMLAudioElement;
    gain: GainNode;
  }

  function voice(): Voice {
    const element = new Audio();
    element.preload = 'auto';
    const gain = context.createGain();
    gain.gain.value = 0;
    context.createMediaElementSource(element).connect(gain);
    gain.connect(output);
    return { element, gain };
  }

  /** Два голоса: уходящий трек и приходящий звучат вместе на время перетекания. */
  const voices = [voice(), voice()];
  let playing: Voice | null = null;

  let place: Place | null = null;
  let scene: MusicScene | null = null;
  let candidate: Place | null = null;
  let settled = 0;
  /** Сколько ещё тишины до следующего трека. */
  let silence = 0;
  /** Трек поставлен, но браузер ещё не дал играть — нет жеста. */
  let blocked = false;
  /** Открыто ли лобби: пока открыто, играет главная тема. */
  let lobby = false;
  const lastTrack: Partial<Record<MusicScene, string>> = {};

  function fadeOut(target: Voice): void {
    target.gain.gain.cancelScheduledValues(context.currentTime);
    target.gain.gain.setTargetAtTime(0, context.currentTime, FADE / 3);
    const element = target.element;
    setTimeout(() => {
      if (playing !== target) element.pause();
    }, FADE * 1000 * 1.5);
  }

  function start(): void {
    if (!scene) return;
    const list = PLAYLISTS[scene];
    // Не тот же, что звучал последним: иначе один трек бывает дважды подряд.
    const choices = list.length > 1 ? list.filter((track) => track !== lastTrack[scene!]) : list;
    const track = choices[Math.floor(Math.random() * choices.length)]!;
    lastTrack[scene] = track;

    const next = voices.find((candidateVoice) => candidateVoice !== playing) ?? voices[0]!;
    next.element.src = ROOT + track;
    next.element.currentTime = 0;
    // Главная тема идёт кругом; треки мира — по разу, с тишиной между.
    next.element.loop = scene === 'lobby';
    next.gain.gain.cancelScheduledValues(context.currentTime);
    next.gain.gain.value = 0;
    next.gain.gain.setTargetAtTime(TRACK_GAIN, context.currentTime, FADE / 3);
    if (playing) fadeOut(playing);
    playing = next;
    blocked = false;
    play(next);
  }

  /**
   * Запустить голос, а при отказе — дождаться жеста и попробовать снова.
   *
   * Браузер не даёт играть, пока человек ничего не нажал. В мире это чинится
   * само: `update` идёт каждый кадр и перезапускает трек, как только контекст
   * оживёт. **В лобби кадров игры нет**, и без этой ловушки первый вход
   * в игру проходил бы в тишине — до самого мира.
   */
  function play(voice: Voice): void {
    voice.element.play().catch(() => {
      blocked = true;
      const retry = (): void => {
        removeEventListener('pointerdown', retry);
        removeEventListener('keydown', retry);
        // За время ожидания трек мог смениться — тогда пробовать нечего.
        if (playing !== voice) return;
        blocked = false;
        play(voice);
      };
      addEventListener('pointerdown', retry, { once: true });
      addEventListener('keydown', retry, { once: true });
    });
  }

  function stop(): void {
    if (playing) fadeOut(playing);
    playing = null;
    blocked = false;
  }

  /** Перейти на новую сцену: трек уходит, новый приходит. */
  function goTo(next: MusicScene | null): void {
    place = placeOf(next);
    scene = next;
    candidate = place;
    settled = 0;
    if (place === null) stop();
    else start();
  }

  return {
    setLobby(open) {
      if (open === lobby) return;
      lobby = open;
      // Вход в мир обрывает тему сразу: следующий кадр подберёт музыку
      // по месту, а тянуть её в город незачем — она про ожидание.
      if (open) goTo('lobby');
      else goTo(null);
    },

    update(dt, x, z, underground, time) {
      // Пока открыто лобби, мир на музыку не влияет вовсе.
      if (lobby) return;

      const wanted = musicSceneAt(x, z, underground, time);
      const wantedPlace = placeOf(wanted);

      if (wantedPlace !== place) {
        if (wantedPlace !== candidate) {
          candidate = wantedPlace;
          settled = 0;
        }
        settled += dt;
        if (settled < SETTLE) return;
        place = wantedPlace;
        scene = wanted;
        if (place === null) {
          stop();
          return;
        }
        // Пришёл в новое место — музыка сразу, без паузы: смена места и есть событие.
        start();
        return;
      }
      candidate = place;
      // День и ночь сменяются не обрывом, а следующим треком.
      scene = wanted;
      if (place === null) return;

      if (blocked && context.state === 'running' && playing) {
        blocked = false;
        play(playing);
      }

      if (playing && playing.element.ended) {
        playing = null;
        silence = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
      }
      if (!playing) {
        silence -= dt;
        if (silence <= 0) start();
      }
    },
  };
}
