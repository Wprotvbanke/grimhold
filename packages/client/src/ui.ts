import {
  CLASSES,
  RACES,
  type CharacterClass,
  type CharacterSummary,
  type ChatBroadcast,
  type GatheringMessage,
  type Race,
} from '@grimhold/shared';

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
  private readonly gatherBar = el<HTMLDivElement>('gatherBar');
  /** Текущая добыча: полосу двигает клиент по присланной длительности. */
  private gathering: { duration: number; endsAt: number } | null = null;
  private gatherTimer = 0;
  private readonly chatLog = el<HTMLDivElement>('chatLog');
  private readonly chatInput = el<HTMLInputElement>('chatInput');

  /** Пока открыт чат, ввод не должен уходить в движение. */
  chatFocused = false;

  constructor(private readonly handlers: UiHandlers) {
    this.fillSelects();
    this.wireAuth();
    this.wireCharacters();
    this.wireChat();
  }

  // ---------- экраны ----------

  showAuth(error?: string): void {
    this.authScreen.hidden = false;
    this.charScreen.hidden = true;
    el<HTMLParagraphElement>('authError').textContent = error ?? '';
  }

  showCharacters(username: string, characters: CharacterSummary[], max: number): void {
    this.authScreen.hidden = true;
    this.charScreen.hidden = false;
    el<HTMLParagraphElement>('charError').textContent = '';
    el<HTMLParagraphElement>('charSubtitle').textContent = `${username} · ${characters.length} из ${max}`;

    const list = el<HTMLDivElement>('charList');
    list.replaceChildren();

    for (const character of characters) {
      const row = document.createElement('div');
      row.className = 'char';

      const left = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = character.name;

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent =
        `${RACES[character.race].name} · ${CLASSES[character.characterClass].name}` +
        ` · в игре ${formatPlaytime(character.playtimeSeconds)}`;
      left.append(name, meta);

      const enter = document.createElement('button');
      enter.textContent = 'Войти';
      enter.style.width = 'auto';
      enter.style.marginTop = '0';

      row.append(left, enter);

      const enterWorld = () => this.handlers.onEnterWorld(character.id);
      row.addEventListener('click', enterWorld);
      enter.addEventListener('click', (event) => {
        event.stopPropagation();
        enterWorld();
      });

      list.append(row);
    }

    el<HTMLDivElement>('createBlock').hidden = characters.length >= max;
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
  setNodeHint(name: string, tool: string | null, ready: boolean, verb = 'добыть'): void {
    // Пока идёт работа, подсказка молчит: под прицелом уже стоит полоса
    // с тем же названием, и повторять его дважды незачем.
    if (this.gathering) {
      this.nodeHint.hidden = true;
      return;
    }
    if (!name) {
      this.nodeHint.hidden = true;
      return;
    }

    const how = ready ? `<b>E</b> — ${verb}` : `<span>нужен в руке: ${tool}</span>`;
    this.nodeHint.innerHTML = `${name} · ${how}`;
    this.nodeHint.hidden = false;
  }

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

  private fillSelects(): void {
    const raceSelect = el<HTMLSelectElement>('newRace');
    for (const race of Object.values(RACES)) {
      const option = document.createElement('option');
      option.value = race.id;
      option.textContent = race.name;
      raceSelect.append(option);
    }

    const classSelect = el<HTMLSelectElement>('newClass');
    for (const profile of Object.values(CLASSES)) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      classSelect.append(option);
    }

    const hint = el<HTMLParagraphElement>('raceHint');
    const updateHint = () => {
      const race = RACES[raceSelect.value as Race];
      const profile = CLASSES[classSelect.value as CharacterClass];
      hint.textContent = `${race.name}: крафтит ${race.craft}. ${profile.description}.`;
    };
    raceSelect.addEventListener('change', updateHint);
    classSelect.addEventListener('change', updateHint);
    updateHint();
  }

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
    el<HTMLButtonElement>('createBtn').addEventListener('click', () => {
      this.handlers.onCreateCharacter(
        el<HTMLInputElement>('newName').value.trim(),
        el<HTMLSelectElement>('newRace').value as Race,
        el<HTMLSelectElement>('newClass').value as CharacterClass,
      );
    });
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
