import {
  CLASSES,
  DEFAULT_CLASS,
  DEFAULT_RACE,
  RACES,
  type CharacterClass,
  type CharacterSummary,
  type ChatBroadcast,
  type GatheringMessage,
  type Race,
} from '@grimhold/shared';
import { createPortrait } from './portrait.js';

/**
 * Экраны вне игры и чат. Здесь только DOM: никакой игровой логики,
 * никаких решений — всё, что важно, решает сервер.
 */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface UiHandlers {
  onLogin(username: string, password: string): void;
  onRegister(username: string, password: string): void;
  onCreateCharacter(name: string, race: Race, characterClass: CharacterClass): void;
  onEnterWorld(characterId: string): void;
  onChatSend(channel: 'local' | 'global', text: string): void;
}

export class Ui {
  private readonly authScreen = el<HTMLDivElement>('authScreen');
  private readonly charScreen = el<HTMLDivElement>('charScreen');
  private readonly resumeHint = el<HTMLDivElement>('resumeHint');
  private readonly captureHint = el<HTMLDivElement>('captureHint');
  private readonly nodeHint = el<HTMLDivElement>('nodeHint');
  private readonly delve = el<HTMLDivElement>('delve');
  private readonly gatherBar = el<HTMLDivElement>('gatherBar');
  /** Текущая добыча: полосу двигает клиент по присланной длительности. */
  private gathering: { duration: number; endsAt: number } | null = null;
  private gatherTimer = 0;
  private readonly chatLog = el<HTMLDivElement>('chatLog');
  private readonly chatInput = el<HTMLInputElement>('chatInput');

  /** Пока открыт чат, ввод не должен уходить в движение. */
  chatFocused = false;

  /**
   * Фигура в лобби: та же живая модель, что в арке рюкзака, только во весь
   * рост и почти анфас. Стоит на заднике и дышит, пока человек выбирает.
   *
   * Кадр с запасом (`frame`) и взгляд ниже середины (`aim`) — чтобы под
   * ногами оставался пол картинки, а не обрез.
   */
  private readonly stage = createPortrait(el<HTMLCanvasElement>('lobbyStage'), {
    turn: -0.18,
    frame: 1.62,
    // Взгляд выше середины — фигура опускается к полу картинки. Владелец
    // посмотрел и оставил как есть: ноги у нижнего края его устраивают.
    aim: 0.72,
    // Чуть правее середины: слева на окно заходит панель с персонажами.
    shift: 0.12,
    /**
     * Поправки на расу — всё, что владелец выправил глазами.
     *
     * Человеку и эльфу крупность поднята на треть: их рост и так больше,
     * но в кадре они смотрелись мельче дворфа, который шире в плечах.
     * Дворф стоит в своей крупности, зато ниже и правее прочих — так он
     * лучше ложится в перспективу коридора на заднике.
     */
    byRace: {
      human: { zoom: 1.17, shift: 0.32, aim: 0.82 },
      elf: { zoom: 1.3 },
      dwarf: { aim: 0.9, shift: 0.3 },
    },
  });

  /** Кого выбрали в списке. `null` — никого, тогда играть нечем. */
  private chosen: CharacterSummary | null = null;
  /** Открыто ли создание нового персонажа. */
  private creating = false;
  /** Что выбрано в создании. Раса решает, кто стоит на заднике. */
  private newRace: Race = DEFAULT_RACE;
  private newClass: CharacterClass = DEFAULT_CLASS;
  private characters: CharacterSummary[] = [];
  /** Сколько персонажей разрешено на учётную запись. Решает сервер. */
  private maxCharacters = 3;

  constructor(private readonly handlers: UiHandlers) {
    this.wireAuth();
    this.wireCharacters();
    this.wireChat();
  }

  // ---------- экраны ----------

  showAuth(error?: string): void {
    this.authScreen.hidden = false;
    this.charScreen.hidden = true;
    // За закрытым лобби фигуру рисовать незачем — это работа впустую.
    this.stage.stop();
    el<HTMLParagraphElement>('authError').textContent = error ?? '';
  }

  showCharacters(username: string, characters: CharacterSummary[], max: number): void {
    this.authScreen.hidden = true;
    this.charScreen.hidden = false;
    this.characters = characters;
    this.maxCharacters = max;
    el<HTMLParagraphElement>('charError').textContent = '';
    el<HTMLDivElement>('charSubtitle').textContent = `${username} · ${characters.length} из ${max}`;

    /**
     * Кого показать на заднике.
     *
     * Держимся прежнего выбора, если он ещё существует: список приходит
     * заново после каждого создания, и сбрасывать выбор значило бы каждый
     * раз возвращать человека к первому персонажу.
     */
    const keep = characters.find((entry) => entry.id === this.chosen?.id);
    this.chosen = keep ?? characters[0] ?? null;

    // Персонажей нет вовсе — первый экран сразу про создание: пустое лобби
    // с недоступной кнопкой «Играть» ничего человеку не объясняет.
    this.setCreating(characters.length === 0);
    this.renderCharacters();
    this.stage.start();
  }

  /** Список персонажей слева. Выбранный подсвечен, он же стоит на заднике. */
  private renderCharacters(): void {
    const list = el<HTMLDivElement>('charList');
    list.replaceChildren();

    for (const character of this.characters) {
      const row = document.createElement('div');
      row.className = character.id === this.chosen?.id ? 'char on' : 'char';

      const left = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = character.name;

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent =
        `${RACES[character.race].name} · ${CLASSES[character.characterClass].name}` +
        ` · в игре ${formatPlaytime(character.playtimeSeconds)}`;
      left.append(name, meta);
      row.append(left);

      /**
       * Щелчок **выбирает**, а не входит в мир.
       *
       * Раньше он входил, и это было единственное действие экрана. Теперь
       * вход — отдельная кнопка внизу: посмотреть своего эльфа во весь рост,
       * не проваливаясь сразу в игру, человек тоже вправе.
       */
      row.addEventListener('click', () => {
        this.chosen = character;
        this.setCreating(false);
        this.renderCharacters();
      });

      list.append(row);
    }

    this.refreshStage();
  }

  /**
   * Кто стоит на заднике и что написано на кнопке.
   *
   * Одно место на оба режима: в создании показываем выбранную расу, иначе —
   * расу выбранного персонажа. Разведи это по двум местам, и однажды фигура
   * останется от прошлого режима.
   */
  private refreshStage(): void {
    const race = this.creating ? this.newRace : this.chosen?.race;
    if (race) this.stage.setRace(race);

    const play = el<HTMLButtonElement>('playBtn');
    play.textContent = this.creating ? 'Создать' : 'Играть';
    play.disabled = !this.creating && !this.chosen;
  }

  /** Переключает лобби между выбором и созданием. */
  private setCreating(on: boolean): void {
    this.creating = on;
    el<HTMLElement>('createBlock').hidden = !on;
    // Пока создание открыто, звать в него второй раз незачем.
    el<HTMLButtonElement>('newCharBtn').hidden = on || this.characters.length >= this.maxCharacters;
    // Отменять нечего, когда персонажей нет вовсе: лобби без них пустое.
    el<HTMLButtonElement>('cancelCharBtn').hidden = this.characters.length === 0;
    if (on) this.renderRaceButtons();
    this.refreshStage();
  }

  /** Кнопки рас и путей. Расы три, и выбор виден фигурой, а не подписью. */
  private renderRaceButtons(): void {
    const races = el<HTMLDivElement>('raceButtons');
    races.replaceChildren();
    for (const race of Object.values(RACES)) {
      const button = document.createElement('button');
      button.textContent = race.name;
      button.className = race.id === this.newRace ? 'on' : '';
      button.addEventListener('click', () => {
        this.newRace = race.id;
        this.renderRaceButtons();
      });
      races.append(button);
    }

    const classes = el<HTMLDivElement>('classButtons');
    classes.replaceChildren();
    for (const profile of Object.values(CLASSES)) {
      const button = document.createElement('button');
      button.textContent = profile.name;
      button.className = profile.id === this.newClass ? 'on' : '';
      button.addEventListener('click', () => {
        this.newClass = profile.id;
        this.renderRaceButtons();
      });
      classes.append(button);
    }

    const race = RACES[this.newRace];
    el<HTMLParagraphElement>('raceHint').textContent =
      `${race.name}: крафтит ${race.craft}. ${CLASSES[this.newClass].description}.`;

    this.refreshStage();
  }

  showCharacterError(message: string): void {
    if (this.charScreen.hidden) {
      this.showAuth(message);
      return;
    }
    el<HTMLParagraphElement>('charError').textContent = message;
  }

  enterGame(): void {
    this.authScreen.hidden = true;
    this.charScreen.hidden = true;
    // Игра началась — второй рендер за спрятанным лобби не нужен.
    this.stage.stop();
  }

  /**
   * Подсказка «щёлкни, чтобы управлять». Пришла на смену экрану паузы:
   * тот закрывал собой мир и останавливал игру там, где она не останавливается —
   * сервер-то продолжает считать, и мобы продолжают бить.
   */
  setResumeHint(visible: boolean): void {
    this.resumeHint.hidden = !visible;
  }

  /**
   * Ход добычи: полоса под прицелом.
   *
   * Сервер присылает начало и конец, между ними шкалу двигает клиент — ровно
   * как с ремеслом. Двадцать пакетов в секунду ради картинки того не стоят,
   * а конец всё равно назначает сервер.
   */
  setGathering(message: GatheringMessage): void {
    if (message.note) this.system(message.note);

    if (this.gatherTimer) cancelAnimationFrame(this.gatherTimer);
    this.gatherTimer = 0;

    if (!message.nodeId) {
      this.gathering = null;
      this.gatherBar.hidden = true;
      return;
    }

    this.gathering = {
      duration: Math.max(0.1, message.duration),
      endsAt: performance.now() + message.remaining * 1000,
    };
    this.gatherBar.hidden = false;
    el<HTMLDivElement>('gatherName').textContent = message.name;

    const fill = el<HTMLElement>('gatherFill');
    const tick = (): void => {
      if (!this.gathering) return;
      const left = Math.max(0, (this.gathering.endsAt - performance.now()) / 1000);
      const done = 1 - left / this.gathering.duration;
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, done))})`;
      // Дошла до края — ждём слова сервера, он и уберёт полосу.
      this.gatherTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  /**
   * Что за ресурсная нода перед игроком и чем её брать.
   *
   * Без подсказки добыча превращается в угадайку: модели нод взяты из того же
   * пака, что и декорации, и отличить рудную жилу от валуна на глаз нельзя.
   * Пустая строка убирает подсказку.
   */
  /**
   * Что было написано в подсказке в прошлый раз.
   *
   * Подсказка считается каждый кадр, а меняется редко. Писать `innerHTML`
   * по сто восемьдесят раз в секунду — это разбор разметки и пересчёт стилей
   * на каждый кадр, то есть заметная доля бюджета там, где меняется нечего.
   */
  private lastHint = '';

  setNodeHint(name: string, tool: string | null, ready: boolean, verb = 'добыть'): void {
    // Пока идёт работа, подсказка молчит: под прицелом уже стоит полоса
    // с тем же названием, и повторять его дважды незачем.
    if (this.gathering || !name) {
      if (this.lastHint !== '') {
        this.lastHint = '';
        this.nodeHint.hidden = true;
      }
      return;
    }

    const how = ready ? `<b>E</b> — ${verb}` : `<span>нужен в руке: ${tool}</span>`;
    const html = `${name} · ${how}`;
    if (html === this.lastHint) return;

    this.lastHint = html;
    this.nodeHint.innerHTML = html;
    this.nodeHint.hidden = false;
  }

  /**
   * Строка вылазки: этаж, хозяин глубины и обратный отсчёт порталов.
   *
   * Три вещи в одной строке, потому что они об одном: сколько тебе ещё
   * осталось. Наверху её нет вовсе — там не от кого убегать.
   *
   * Пишется только при изменении текста: строка обновляется каждый кадр,
   * а запись в DOM на ста восьмидесяти кадрах стоит дороже самой строки.
   */
  setDelve(html: string): void {
    if (html === this.lastDelve) return;
    this.lastDelve = html;
    this.delve.innerHTML = html;
    this.delve.hidden = html === '';
  }

  private lastDelve = '';

  /**
   * Сообщает, кому принадлежат клавиши браузера. Показывается ненадолго при
   * входе в полный экран и выходе из него: молчаливый захват Ctrl+W пугал бы
   * сильнее, чем помогал.
   */
  setCaptureHint(full: boolean, captured: boolean): void {
    if (!full) this.captureHint.textContent = 'Клавиши браузера возвращены';
    else if (captured)
      this.captureHint.textContent = 'Клавиатура захвачена игрой — удержи Escape, чтобы выйти';
    else
      // Полный захват умеет только Chromium. В остальных браузерах игре
      // достаётся всё, что страница вправе отменить, но не Ctrl+W и Ctrl+T.
      this.captureHint.textContent = 'Полный экран. Ctrl+W и Ctrl+T этот браузер игре не отдаёт';
    this.captureHint.hidden = false;

    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureHint.hidden = true;
    }, 3500);
  }

  private captureTimer: ReturnType<typeof setTimeout> | undefined;

  get inMenus(): boolean {
    return !this.authScreen.hidden || !this.charScreen.hidden;
  }

  // ---------- чат ----------

  appendChat(message: ChatBroadcast): void {
    const line = document.createElement('div');
    line.className = `ch-${message.channel}`;

    if (message.channel === 'system') {
      line.textContent = message.text;
    } else {
      const from = document.createElement('span');
      from.className = 'ch-from';
      from.textContent =
        message.channel === 'global' ? `[общий] ${message.from}: ` : `${message.from}: `;
      line.append(from, document.createTextNode(message.text));
    }

    this.chatLog.append(line);
    while (this.chatLog.childElementCount > 60) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  system(text: string): void {
    this.appendChat({ t: 'chatMessage', channel: 'system', from: '', text });
  }

  /** Enter открывает локальный чат, Shift+Enter — общий. */
  openChat(channel: 'local' | 'global'): void {
    this.chatFocused = true;
    this.chatInput.hidden = false;
    this.chatInput.dataset.channel = channel;
    this.chatInput.placeholder = channel === 'global' ? 'Общий канал…' : 'Сказать рядом…';
    this.chatInput.focus();
  }

  closeChat(): void {
    this.chatFocused = false;
    this.chatInput.hidden = true;
    this.chatInput.value = '';
    this.chatInput.blur();
  }

  // ---------- проводка ----------

  private wireAuth(): void {
    const user = el<HTMLInputElement>('authUser');
    const pass = el<HTMLInputElement>('authPass');

    el<HTMLButtonElement>('loginBtn').addEventListener('click', () =>
      this.handlers.onLogin(user.value.trim(), pass.value),
    );
    el<HTMLButtonElement>('registerBtn').addEventListener('click', () =>
      this.handlers.onRegister(user.value.trim(), pass.value),
    );
    pass.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.handlers.onLogin(user.value.trim(), pass.value);
    });
  }

  private wireCharacters(): void {
    /**
     * «Играть» — одна кнопка на два смысла: войти выбранным или создать
     * нового. Так задумано владельцем: внизу экрана всегда одно действие,
     * и какое именно — видно по надписи.
     */
    el<HTMLButtonElement>('playBtn').addEventListener('click', () => {
      if (this.creating) {
        this.handlers.onCreateCharacter(
          el<HTMLInputElement>('newName').value.trim(),
          this.newRace,
          this.newClass,
        );
        return;
      }
      if (this.chosen) this.handlers.onEnterWorld(this.chosen.id);
    });

    // Имя вводят с клавиатуры, и Enter там значит то же, что кнопка.
    el<HTMLInputElement>('newName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') el<HTMLButtonElement>('playBtn').click();
    });

    el<HTMLButtonElement>('newCharBtn').addEventListener('click', () => this.setCreating(true));
    el<HTMLButtonElement>('cancelCharBtn').addEventListener('click', () => this.setCreating(false));
    el<HTMLButtonElement>('logoutBtn').addEventListener('click', () => location.reload());
  }

  private wireChat(): void {
    this.chatInput.addEventListener('keydown', (event) => {
      event.stopPropagation();

      if (event.key === 'Escape') {
        this.closeChat();
        return;
      }
      if (event.key !== 'Enter') return;

      const text = this.chatInput.value.trim();
      if (text) {
        const channel = (this.chatInput.dataset.channel ?? 'local') as 'local' | 'global';
        this.handlers.onChatSend(channel, text);
      }
      this.closeChat();
    });
  }
}

function formatPlaytime(seconds: number): string {
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
