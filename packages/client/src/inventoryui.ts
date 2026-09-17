import {
  CLASSES,
  DASH_WEIGHT_LIMIT,
  RACES,
  attributesFor,
  type CharacterSummary,
  type SelfState,
  EQUIP_SLOTS,
  HOTBAR_SIZE,
  SKILLS,
  type ProgressMessage,
  type Vital,
  recipesForRace,
  type Race,
  type RecipeId,
  SLOT_NAMES,
  countOf,
  itemAt,
  isItemId,
  itemDef,
  sizeOf,
  type EquipSlot,
  type Equipment,
  type Grid,
  type BankMessage,
  type CraftingMessage,
  type TradeMessage,
  type InventoryMessage,
  type PlacedItem,
  type SpellId,
} from '@grimhold/shared';
import { createPortrait } from './portrait.js';

/**
 * Инвентарь-сетка.
 *
 * Здесь только отображение и перетаскивание. Ни одна проверка на клиенте не
 * является решающей: мы показываем предполагаемое место подсветкой, но кладёт
 * вещь сервер, и рисуем мы ровно то, что он вернул. Иначе в игре с полной
 * потерей лута картинка рано или поздно разошлась бы с правдой.
 */

const CELL = 44; // размер клетки вместе с зазором, синхронно с CSS
/**
 * Клетка умений — мельче обычной.
 *
 * Их двенадцать, а лечь они должны **в ту же длину, что рюкзак** (десять
 * клеток): ряд шире сетки развалил бы строку окна, и кукла с рюкзаком
 * перестали бы стоять рядом. Число синхронно с CSS.
 */
const SCROLL_CELL = 36;
// Отступ сетки от угла обёртки: рамка 1 px плюс внутреннее поле 2 px.
// Без него предметы стоят на пиксель левее и выше своих клеток.
const GRID_INSET = 3;

/** Шаг клетки у этой сетки: у клеток умений он свой. */
function sizeOfCell(grid: GridKind): number {
  return grid === 'scrolls' ? SCROLL_CELL : CELL;
}

/** Какая клавиша будит ячейку: 1…9, а десятую — 0. */
export function hotbarKey(index: number): string {
  return String((index + 1) % 10);
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface InventoryHandlers {
  onMove(fromX: number, fromY: number, toX: number, toY: number, rotate: boolean): void;
  /** Повесить вид предмета на ячейку панели. Пустая строка очищает. */
  onAssignHotbar(index: number, itemId: string): void;
  /** Нажата ячейка панели. */
  onUseHotbar(index: number): void;
  onEquip(x: number, y: number): void;
  onUnequip(slot: EquipSlot, to?: DropTarget): void;
  onUse(x: number, y: number): void;
  onDrop(x: number, y: number): void;
  /** Изготовить по рецепту. Хватает ли сырья — решит сервер. */
  onCraft(recipeId: RecipeId): void;
  /**
   * Переложить вещь между рюкзаком и казной.
   *
   * Клетка назначения есть только у перетаскивания: щелчок её не знает,
   * и тогда место ищет сервер.
   */
  onDeposit(x: number, y: number, to?: DropTarget): void;
  onWithdraw(x: number, y: number, to?: DropTarget): void;
  /** Переложить вещь внутри казны — с точностью до клетки и с поворотом. */
  onBankArrange(fromX: number, fromY: number, toX: number, toY: number, rotate: boolean): void;
  /**
   * Перенести свиток между рюкзаком и клетками умений либо внутри них.
   *
   * Один обработчик на все четыре случая: для игрока это одно движение мышью,
   * а что именно дозволено, решает сервер.
   */
  onScrollMove(
    from: 'backpack' | 'scrolls',
    to: 'backpack' | 'scrolls',
    x: number,
    y: number,
    target?: { x: number; y: number },
  ): void;
  /** Положить вещь на стол обмена. */
  onTradeOffer(x: number, y: number): void;
  /** Снять со стола своё предложение под номером. */
  onTradeWithdraw(index: number): void;
  /** Подтвердить сделку или снять подтверждение. */
  onTradeLock(locked: boolean): void;
  /** Согласиться сесть за стол или отказаться. */
  onTradeRespond(accept: boolean): void;
  /** Уйти от стола. */
  onTradeCancel(): void;
  /** Вложить очко роста. Есть ли оно — решает сервер. */
  onSpendPoint(into: Vital): void;
  /** Закрытие рюкзака возвращает управление игрой. */
  onClose(): void;
}

/** Раздел окна — вкладка сверху. */
type Page = 'bag' | 'craft' | 'growth' | 'help';

/** Характеристики в карточке — в том порядке, в каком их читают. */
const STAT_NAMES: [keyof ReturnType<typeof attributesFor>, string][] = [
  ['strength', 'Сила'],
  ['endurance', 'Выносливость'],
  ['agility', 'Ловкость'],
  ['intellect', 'Интеллект'],
];

/** Откуда тянут вещь. От этого зависит, что значит «бросил сюда». */
type GridKind = 'backpack' | 'bank' | 'scrolls';

/** Куда именно вещь положили мышью. */
export interface DropTarget {
  x: number;
  y: number;
  rotate: boolean;
}

interface DragState {
  item: PlacedItem;
  rotated: boolean;
  node: HTMLElement;
  from: GridKind;
  /** Слот, из которого тянут надетое. `null` — тянут из сетки. */
  slot: EquipSlot | null;
  /** Откуда начали тянуть — по этому отличают перенос от простого щелчка. */
  startX: number;
  startY: number;
  moved: boolean;
}

export class InventoryUi {
  private readonly root = el<HTMLDivElement>('inventory');
  private readonly cells = el<HTMLDivElement>('backpackCells');
  private readonly wrap = el<HTMLDivElement>('backpackWrap');
  private readonly slotsBox = el<HTMLDivElement>('equipSlots');
  private readonly discard = el<HTMLDivElement>('discard');
  private readonly ghost = el<HTMLDivElement>('dragGhost');
  private readonly errorLine = el<HTMLParagraphElement>('itemError');
  private readonly scrollCells = el<HTMLDivElement>('scrollCells');
  private readonly scrollWrap = el<HTMLDivElement>('scrollWrap');
  private readonly bankCol = el<HTMLDivElement>('bankCol');
  private readonly bankTitle = el<HTMLDivElement>('bankTitle');
  private readonly bankCells = el<HTMLDivElement>('bankCells');
  private readonly bankWrap = el<HTMLDivElement>('bankWrap');
  private readonly tradeCol = el<HTMLDivElement>('tradeCol');
  private readonly craftCol = el<HTMLDivElement>('craftCol');
  private readonly helpCol = el<HTMLDivElement>('helpCol');
  private readonly skillCol = el<HTMLDivElement>('skillCol');
  private readonly skillList = el<HTMLDivElement>('skillList');

  /** Живая модель расы в арке куклы. Рисуется, только пока окно открыто. */
  private readonly portrait = createPortrait(el<HTMLCanvasElement>('portraitCanvas'));
  /** Открытая вкладка. */
  private page: Page = 'bag';

  private state: InventoryMessage | null = null;

  /** Сколько ещё нельзя пить, секунды. Приходит в снапшоте, считает сервер. */
  private sip = 0;
  /** Сколько ещё ждать каждому свитку. Тоже из снапшота: откат держит сервер. */
  private spellWaits: Record<string, number> = {};
  /** Раса персонажа: от неё зависит, какие рецепты вообще показывать. */
  private race: Race | null = null;
  private drag: DragState | null = null;
  /** Открыт ли сундук. От этого зависит, кладёт ли правая кнопка вещь в казну. */
  private bankOpen = false;
  /** Идёт ли обмен. Правая кнопка кладёт на стол, если сундук закрыт. */
  private tradeOpen = false;
  private myLock = false;
  /** Раскладка казны: нужна подсветке, чтобы знать её размеры. */
  private bankGrid: Grid | null = null;
  /** Раскладка клеток умений: нужна подсветке по той же причине. */
  private scrollGrid: Grid | null = null;
  /**
   * Последний щелчок был концом переноса, а не щелчком.
   *
   * Без этого поворот вещи на месте в казне читался бы как «забрать»: мышь
   * отпущена над той же клеткой, и браузер честно шлёт click.
   */
  private justDragged = false;
  /**
   * Начатая работа. Полосу двигает клиент: сервер присылает длительность
   * один раз, а гнать шкалу тиками — двадцать пакетов в секунду впустую.
   */
  private work: { name: string; duration: number; endsAt: number } | null = null;
  private workTimer = 0;
  private readonly slotNodes = new Map<EquipSlot, HTMLDivElement>();
  private readonly hotbarNodes: HTMLDivElement[] = [];

  constructor(private readonly handlers: InventoryHandlers) {
    this.buildSlots();
    this.buildHotbar();
    this.wireDrag();

    for (const tab of document.querySelectorAll<HTMLButtonElement>('.inv-tab')) {
      tab.addEventListener('click', () => this.showPage(tab.dataset.page as Page));
    }
    el<HTMLButtonElement>('invClose').addEventListener('click', () => this.hide());

    el<HTMLButtonElement>('tradeLock').addEventListener('click', () => {
      if (this.tradeOpen) this.handlers.onTradeLock(!this.myLock);
      else this.handlers.onTradeRespond(true);
    });
    el<HTMLButtonElement>('tradeCancel').addEventListener('click', () => {
      if (this.tradeOpen) this.handlers.onTradeCancel();
      else this.handlers.onTradeRespond(false);
    });

    this.discard.addEventListener('mouseup', () => {
      // Выбросить можно только из рюкзака: содержимое казны не на руках,
      // а надетое сперва снимают.
      if (this.drag?.from === 'backpack' && !this.drag.slot) {
        this.handlers.onDrop(this.drag.item.x, this.drag.item.y);
      }
    });
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /**
   * Какой свиток лежит в ячейке панели — или `null`, если там не свиток.
   *
   * Рукам нужно начать замах посоха **по нажатию**, не дожидаясь ответа
   * сервера: полпинга задержки в своих руках заметны сразу — так же
   * сделан удар. А что в ячейке лежит, знает только панель.
   */
  spellAt(index: number): SpellId | null {
    const defId = this.state?.hotbar[index];
    return defId && isItemId(defId) ? (itemDef(defId).spellId ?? null) : null;
  }

  toggle(): void {
    this.root.hidden ? this.show() : this.hide();
  }

  show(): void {
    this.root.hidden = false;
    this.errorLine.textContent = '';
    this.refreshHotbarMode();
    if (this.page === 'bag') this.portrait.start();
    this.refreshSide();
  }

  hide(): void {
    this.root.hidden = true;
    this.portrait.stop();
    this.cancelDrag();
    this.refreshHotbarMode();
    this.handlers.onClose();
  }

  /**
   * Переключает вкладку.
   *
   * Портрет рисуется только на вкладке рюкзака: на ремесле его не видно,
   * а второй рендер за скрытым разделом — работа впустую.
   */
  /**
   * Открыт ли сундук или стол обмена рядом с рюкзаком.
   *
   * Тогда кукла прячется: вторая сетка шириной с рюкзак рядом с ней в экран
   * не влезает, а у сундука человек пришёл разбирать добычу, не одеваться.
   * Портрет за спрятанной куклой не рисуется.
   */
  private refreshSide(): void {
    const side = this.bankOpen || !this.tradeCol.hidden;
    this.root.querySelector('.inv-panel')?.classList.toggle('side-open', side);
    if (side) this.portrait.stop();
    else if (this.open && this.page === 'bag') this.portrait.start();
  }

  showPage(page: Page): void {
    this.page = page;
    for (const section of this.root.querySelectorAll<HTMLElement>('.inv-page')) {
      section.hidden = section.dataset.page !== page;
    }
    for (const tab of this.root.querySelectorAll<HTMLElement>('.inv-tab')) {
      tab.classList.toggle('on', tab.dataset.page === page);
    }
    if (page === 'bag' && this.open) this.portrait.start();
    else this.portrait.stop();
    this.refreshSide();
  }

  /**
   * Персонаж: имя, раса, класс и характеристики в карточке слева,
   * модель расы — в арке куклы.
   */
  setCharacter(character: CharacterSummary): void {
    this.setRace(character.race);
    el<HTMLDivElement>('cardName').textContent = character.name;
    el<HTMLDivElement>('cardRace').textContent = RACES[character.race].name;
    el<HTMLDivElement>('cardClass').textContent = CLASSES[character.characterClass].name;

    const stats = el<HTMLElement>('cardStats');
    stats.replaceChildren();
    const attributes = attributesFor(character.race, character.characterClass);
    for (const [key, name] of STAT_NAMES) {
      const term = document.createElement('dt');
      term.textContent = name;
      const value = document.createElement('dd');
      value.textContent = String(attributes[key]);
      stats.append(term, value);
    }
    this.portrait.setRace(character.race);
  }

  /**
   * Жизнь, мана и стамина в карточке — из свежего снапшота.
   *
   * Зовётся двадцать раз в секунду, а видно карточку только при открытом
   * окне: закрытое в DOM не пишем.
   */
  setVitals(self: SelfState): void {
    if (!this.open) return;
    el<HTMLElement>('cardHealth').textContent = `${Math.round(self.health)} / ${self.maxHealth}`;
    el<HTMLElement>('cardMana').textContent = `${Math.round(self.mana)} / ${self.maxMana}`;
    el<HTMLElement>('cardStamina').textContent = `${Math.round(self.stamina)} / ${self.maxStamina}`;
  }

  /**
   * Панель переключается между «играю» и «разбираю вещи».
   *
   * Подсказки и поведение щелчка у неё разные по обе стороны рюкзака, а
   * рисуется она при обновлении вещей — значит при открытии и закрытии её
   * надо перерисовать, иначе подсказка будет врать до ближайшей находки.
   */
  private refreshHotbarMode(): void {
    el<HTMLDivElement>('hotbar').classList.toggle('editing', this.open);
    if (this.state) this.renderHotbar(this.state);
  }

  showError(message: string): void {
    this.errorLine.textContent = message;
    // Ошибка живёт недолго: она про последнее действие, а не про состояние.
    setTimeout(() => {
      if (this.errorLine.textContent === message) this.errorLine.textContent = '';
    }, 2500);
  }

  /** Принимает состояние от сервера и перерисовывает всё целиком. */
  /**
   * Откат расходников из снапшота.
   *
   * Панель перерисовывается, только пока идёт отсчёт или он только что
   * кончился: снапшот приходит двадцать раз в секунду, и дёргать DOM на
   * каждый было бы расточительно.
   */
  setSip(seconds: number, spells: Record<string, number> = {}): void {
    const was = this.sip || Object.keys(this.spellWaits).length;
    this.sip = seconds;
    this.spellWaits = spells;
    const now = seconds > 0 || Object.keys(spells).length > 0;
    if (this.state && (now || was)) this.renderHotbar(this.state);
  }

  update(state: InventoryMessage): void {
    this.state = state;
    this.cancelDrag();
    this.renderGrid(state.backpack);
    this.renderScrolls(state.scrolls);
    this.renderSlots(state.equipment);
    this.renderHotbar(state);
    this.renderWeight(state);
    this.renderCrafting(state);
  }

  /**
   * Раса приходит с персонажем, а не с рюкзаком, поэтому задаётся отдельно.
   * Без неё нельзя решить, какие рецепты вообще показывать.
   */
  setRace(race: Race): void {
    this.race = race;
    if (this.state) this.renderCrafting(this.state);
  }

  /**
   * Содержимое казны.
   *
   * Колонка появляется только когда сундук открыт: банк — не часть рюкзака,
   * а место в городе, и показывать его издалека значило бы врать.
   */
  setBank(message: BankMessage): void {
    this.bankOpen = message.open;
    // Казна или мешок павшего — окно одно, и подпись должна говорить, какое.
    if (message.open) this.bankTitle.textContent = message.title;
    this.bankCol.hidden = !message.open;
    // Казна встаёт рядом с рюкзаком: у сундука человек пришёл убрать добычу,
    // и открыться окно обязано на вкладке рюкзака, где бы его ни оставили.
    if (message.open) this.showPage('bag');
    this.refreshSide();
    if (!message.open) {
      this.bankGrid = null;
      this.bankCells.replaceChildren();
      for (const node of this.bankWrap.querySelectorAll('.inv-item')) node.remove();
      return;
    }

    // Сундук открывают из мира, а не из рюкзака: панель поднимаем сами.
    if (!this.open) this.show();
    this.renderBank(message.grid);
  }

  /**
   * Стол обмена.
   *
   * Как и казна, живёт колонкой в рюкзаке: вещи всё равно берутся оттуда,
   * а отдельное окно поверх рюкзака пришлось бы двигать мышью.
   */
  setTrade(message: TradeMessage): void {
    const closed = message.stage === 'closed' || message.stage === 'done';
    this.tradeOpen = message.stage === 'open';
    this.myLock = message.myLock;
    this.tradeCol.hidden = closed;
    // Стол обмена — рядом с рюкзаком: вещи на него кладут оттуда.
    if (!closed) this.showPage('bag');
    this.refreshSide();

    if (closed) {
      if (message.note) this.showError(message.note);
      return;
    }

    if (!this.open) this.show();

    el<HTMLDivElement>('tradeTitle').textContent = `Обмен · ${message.partner}`;
    const lock = el<HTMLButtonElement>('tradeLock');
    const cancel = el<HTMLButtonElement>('tradeCancel');

    // До согласия стола ещё нет: те же две кнопки отвечают на приглашение.
    if (message.stage === 'invited') {
      lock.textContent = 'Принять';
      cancel.textContent = 'Отказаться';
      lock.classList.remove('on');
    } else {
      lock.textContent = message.myLock ? 'Подтверждено' : 'Подтвердить';
      cancel.textContent = 'Уйти';
      lock.classList.toggle('on', message.myLock);
    }

    const mineHead = el<HTMLDivElement>('tradeMineHead');
    const theirsHead = el<HTMLDivElement>('tradeTheirsHead');
    mineHead.textContent = message.myLock ? 'Твоё · подтверждено' : 'Твоё';
    theirsHead.textContent = message.theirLock
      ? `${message.partner} · подтвердил`
      : message.partner;
    mineHead.classList.toggle('locked', message.myLock);
    theirsHead.classList.toggle('locked', message.theirLock);

    this.fillTradeList(el<HTMLDivElement>('tradeMine'), message.mine, true);
    this.fillTradeList(el<HTMLDivElement>('tradeTheirs'), message.theirs, false);
  }

  /**
   * Ход изготовления.
   *
   * Приходит дважды: в начале работы и в конце. Между ними полоса идёт сама
   * по известной длительности — сервер остаётся хозяином конца, но не тратит
   * на шкалу ни одного лишнего пакета.
   */
  /**
   * Прокачка: очки роста сверху, навыки под ними.
   *
   * Панель перерисовывается целиком на каждое сообщение. Это дёшево — семь
   * строк и раз в несколько секунд, — зато нет состояния, которое можно
   * забыть обновить: показанное всегда равно присланному.
   */
  setProgress(message: ProgressMessage): void {
    const toPoint = Math.max(1, message.toPoint);
    el<HTMLSpanElement>('pointText').textContent = `Опыт ${message.pool} / ${toPoint}`;
    el<HTMLSpanElement>('pointCount').textContent =
      message.points > 0 ? `очков: ${message.points}` : '';
    el<HTMLElement>('pointFill').style.transform = `scaleX(${Math.min(1, message.pool / toPoint)})`;
    // Та же полоса в карточке персонажа: опыт виден с любой вкладки.
    el<HTMLElement>('cardExpFill').style.transform = `scaleX(${Math.min(1, message.pool / toPoint)})`;
    el<HTMLElement>('cardExpText').textContent =
      message.points > 0 ? `${message.pool} / ${toPoint} · очков: ${message.points}` : `${message.pool} / ${toPoint}`;

    // Кнопки гаснут, когда вкладывать нечего: отказ после нажатия объясняет
    // хуже, чем видимая невозможность до него.
    for (const [id, into] of [
      ['spendHealth', 'health'],
      ['spendStamina', 'stamina'],
      ['spendMana', 'mana'],
    ] as [string, Vital][]) {
      const button = el<HTMLButtonElement>(id);
      button.disabled = message.points <= 0;
      button.onclick = () => this.handlers.onSpendPoint(into);
    }

    const { health, stamina, mana } = message.spent;
    el<HTMLDivElement>('pointSpent').textContent =
      health + stamina + mana === 0
        ? 'Ничего ещё не вложено'
        : `Вложено: жизнь ${health}, стамина ${stamina}, мана ${mana}`;

    this.skillList.replaceChildren();
    for (const entry of message.skills) {
      const row = document.createElement('div');
      row.className = 'skill-row';
      // Нетронутый навык приглушён: он просто есть, а не просит внимания.
      if (entry.level === 0 && entry.experience === 0) row.classList.add('idle');

      const head = document.createElement('div');
      head.className = 'skill-head';

      const name = document.createElement('b');
      name.textContent = SKILLS[entry.skill].name;
      const numbers = document.createElement('span');
      numbers.textContent = `${entry.level} · ${entry.experience}/${entry.next}`;
      head.append(name, numbers);

      const bar = document.createElement('div');
      bar.className = 'skill-bar';
      const fill = document.createElement('i');
      fill.style.transform = `scaleX(${Math.min(1, entry.experience / Math.max(1, entry.next))})`;
      bar.append(fill);

      row.append(head, bar);
      this.skillList.append(row);
    }
  }

  setCrafting(message: CraftingMessage): void {
    if (message.note) this.showError(message.note);

    if (!message.recipeId) {
      this.work = null;
      this.stopWorkTimer();
      el<HTMLDivElement>('craftBar').hidden = true;
      if (this.state) this.renderCrafting(this.state);
      return;
    }

    this.work = {
      name: message.name,
      duration: Math.max(0.1, message.duration),
      endsAt: performance.now() + message.remaining * 1000,
    };
    el<HTMLDivElement>('craftBar').hidden = false;
    el<HTMLSpanElement>('craftBarName').textContent = message.name;
    if (this.state) this.renderCrafting(this.state);

    this.stopWorkTimer();
    const tick = () => {
      if (!this.work) return;
      const left = Math.max(0, (this.work.endsAt - performance.now()) / 1000);
      const done = 1 - left / this.work.duration;
      el<HTMLElement>('craftBarFill').style.transform = `scaleX(${Math.min(1, Math.max(0, done))})`;
      el<HTMLSpanElement>('craftBarLeft').textContent = `${left.toFixed(1)} с`;
      // Полоса дошла до конца — ждём слова сервера, он и уберёт её.
      this.workTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Был ли это щелчок, а не конец переноса. Ответ одноразовый. */
  private takeClick(): boolean {
    if (!this.justDragged) return true;
    this.justDragged = false;
    return false;
  }

  private stopWorkTimer(): void {
    if (this.workTimer) cancelAnimationFrame(this.workTimer);
    this.workTimer = 0;
  }

  private fillTradeList(list: HTMLDivElement, entries: TradeMessage['mine'], own: boolean): void {
    list.classList.toggle('own', own);
    list.replaceChildren();

    entries.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'trade-row';
      row.textContent = entry.count > 1 ? `${entry.name} ×${entry.count}` : entry.name;
      if (own) {
        row.title = 'Щелчок — снять со стола';
        row.addEventListener('click', () => this.handlers.onTradeWithdraw(index));
      }
      list.append(row);
    });
  }

  private renderBank(grid: Grid): void {
    this.bankGrid = grid;
    this.bankCells.style.gridTemplateColumns = `repeat(${grid.width}, 42px)`;
    this.bankCells.replaceChildren();
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.grid = 'bank';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.bankCells.append(cell);
      }
    }

    for (const node of this.bankWrap.querySelectorAll('.inv-item')) node.remove();
    for (const item of grid.items) {
      const node = this.buildItemNode(item, 'bank');
      node.title += '\nЩелчок — забрать, перетаскивание — переложить';
      this.bankWrap.append(node);
    }
  }

  /**
   * Список рецептов.
   *
   * Показываем то же, что разрешит сервер (`recipesForRace`), и прямо в строке
   * пишем, чего не хватает. Кнопка, которая гарантированно откажет, — худший
   * вид интерфейса: человек жмёт и не понимает, почему ничего не вышло.
   */
  private renderCrafting(state: InventoryMessage): void {
    const list = el<HTMLDivElement>('craftList');
    list.replaceChildren();
    if (!this.race) return;

    for (const recipe of recipesForRace(this.race, state.knownRecipes)) {
      const row = document.createElement('div');
      row.className = 'recipe';

      const head = document.createElement('div');
      head.className = 'recipe-head';

      const name = document.createElement('span');
      name.className = 'recipe-name';
      const output = itemDef(recipe.output.itemId);
      name.textContent =
        recipe.output.count > 1 ? `${output.name} ×${recipe.output.count}` : output.name;
      head.append(name);

      const button = document.createElement('button');
      button.textContent = 'Сделать';
      button.addEventListener('click', () => this.handlers.onCraft(recipe.id));
      head.append(button);
      row.append(head);

      const inputs = document.createElement('div');
      inputs.className = 'recipe-inputs';
      let ready = true;

      for (const [index, need] of recipe.inputs.entries()) {
        const have = countOf(state.backpack, need.itemId);
        const enough = have >= need.count;
        if (!enough) ready = false;

        const part = document.createElement('span');
        if (!enough) part.className = 'lack';
        part.textContent = `${itemDef(need.itemId).name} ${have}/${need.count}`;
        if (index > 0) inputs.append(document.createTextNode(' · '));
        inputs.append(part);
      }

      row.append(inputs);
      if (recipe.race) {
        const mark = document.createElement('div');
        mark.className = 'recipe-race';
        mark.textContent = 'по свитку';
        row.append(mark);
      }

      // Пока идёт работа, взяться за вторую нельзя — и это видно по кнопкам.
      button.disabled = !ready || this.work !== null;
      row.classList.toggle('ready', ready);
      list.append(row);
    }
  }

  /**
   * Панель горячих клавиш. Живёт вне окна рюкзака и остаётся видимой всегда:
   * в неё кладут вещи перетаскиванием прямо во время игры.
   */
  private buildHotbar(): void {
    const bar = el<HTMLDivElement>('hotbar');

    for (let index = 0; index < HOTBAR_SIZE; index++) {
      const node = document.createElement('div');
      node.className = 'hot';

      /**
       * Щелчок значит разное по обе стороны рюкзака.
       *
       * Рюкзак закрыт — игра идёт, и щелчок применяет вещь. Рюкзак открыт —
       * идёт разбор вещей, и щелчок **снимает назначение**. Иначе приглушённую
       * ячейку с вещью, которой уже нет, нечем было убрать: правая кнопка тут
       * не годится, браузер открывает по ней своё меню.
       */
      node.addEventListener('click', () => {
        if (this.drag) return;
        if (this.open) this.handlers.onAssignHotbar(index, '');
        else this.handlers.onUseHotbar(index);
      });

      node.addEventListener('mouseenter', () => {
        if (this.drag) node.classList.add('hot-target');
      });
      node.addEventListener('mouseleave', () => node.classList.remove('hot-target'));
      node.addEventListener('mouseup', () => {
        if (this.drag) this.handlers.onAssignHotbar(index, this.drag.item.defId);
      });

      bar.append(node);
      this.hotbarNodes.push(node);
    }
  }

  private renderHotbar(state: InventoryMessage): void {
    for (let index = 0; index < this.hotbarNodes.length; index++) {
      const node = this.hotbarNodes[index]!;
      const defId = state.hotbar[index];

      node.replaceChildren();
      node.className = 'hot';

      const key = document.createElement('span');
      key.className = 'key';
      // Десятая ячейка — клавиша 0: после девятки на ряду цифр идёт она.
      key.textContent = hotbarKey(index);
      node.append(key);

      if (!defId) {
        node.title = 'Перетащи сюда вещь из рюкзака';
        continue;
      }

      const def = itemDef(defId);
      node.classList.add('filled', `kind-${def.kind}`);

      // Картинка вместо названия — там, где она есть: в бою читать некогда.
      if (def.icon) {
        const icon = document.createElement('div');
        icon.className = 'icon';
        icon.style.backgroundImage = `url(${def.icon})`;
        node.append(icon);
      } else {
        node.append(document.createTextNode(def.name));
      }

      /**
       * Сколько такого осталось. Ноль означает, что нажатие ничего не даст,
       * и это видно заранее, а не по сообщению об ошибке.
       *
       * У свитка «есть» значит «вставлен в клетки умений»: в рюкзаке он
       * просто вещь, и читать его оттуда нельзя (docs/magic.md).
       */
      const available =
        def.kind === 'spell' ? countOf(state.scrolls, defId) : countOf(state.backpack, defId);
      const equipped = Object.values(state.equipment).some((item) => item?.defId === defId);

      if (available === 0 && !equipped) node.classList.add('missing');
      if (def.kind !== 'spell' && available > 1) {
        const qty = document.createElement('span');
        qty.className = 'qty';
        qty.textContent = String(available);
        node.append(qty);
      }

      /**
       * Отсчёт отката прямо на ячейке.
       *
       * Игрок должен видеть, когда зелье снова готово, а не жать вслепую
       * и получать отказ. Считает откат сервер, здесь только отсчёт.
       */
      const left = def.spellId ? (this.spellWaits[def.spellId] ?? 0) : def.cooldown ? this.sip : 0;
      if (left > 0) {
        const wait = document.createElement('div');
        wait.className = 'wait';
        wait.textContent = left >= 1 ? String(Math.ceil(left)) : left.toFixed(1);
        node.append(wait);
      }

      const hint = this.open
        ? 'Щелчок — убрать с панели'
        : `Щелчок или клавиша ${hotbarKey(index)} — применить`;
      node.title = [def.name, def.description, hint].filter(Boolean).join(' · ');
    }
  }

  // ---------- отрисовка ----------

  private renderGrid(grid: Grid): void {
    this.cells.style.gridTemplateColumns = `repeat(${grid.width}, 42px)`;
    this.cells.replaceChildren();

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.grid = 'backpack';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.cells.append(cell);
      }
    }

    // Предметы рисуются поверх сетки, растягиваясь на свои клетки.
    for (const node of this.wrap.querySelectorAll('.inv-item')) node.remove();
    for (const item of grid.items) this.wrap.append(this.buildItemNode(item, 'backpack'));
  }

  /**
   * Клетки умений: ряд свитков под рюкзаком.
   *
   * Рисуются той же дверью, что рюкзак и казна: свиток тянут, кладут и
   * вынимают ровно теми же движениями, и разводить это по второму месту
   * значило бы однажды забыть про одно из них.
   */
  private renderScrolls(grid: Grid): void {
    this.scrollGrid = grid;
    this.scrollCells.style.gridTemplateColumns = `repeat(${grid.width}, ${SCROLL_CELL - 2}px)`;
    this.scrollCells.replaceChildren();

    for (let x = 0; x < grid.width; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.grid = 'scrolls';
      cell.dataset.x = String(x);
      cell.dataset.y = '0';
      this.scrollCells.append(cell);
    }

    for (const node of this.scrollWrap.querySelectorAll('.inv-item')) node.remove();
    for (const item of grid.items) {
      const node = this.buildItemNode(item, 'scrolls');
      node.title += '\nЩелчок — обратно в рюкзак, перетаскивание — в клетку';
      this.scrollWrap.append(node);
    }
  }

  /** Вид предмета без поведения: одинаков и в рюкзаке, и в казне. */
  private buildStaticItem(item: PlacedItem, cell = CELL): HTMLElement {
    const def = itemDef(item.defId);
    const size = sizeOf(item.defId, item.rotated);

    const node = document.createElement('div');
    node.className = `inv-item kind-${def.kind}`;
    node.style.left = `${GRID_INSET + item.x * cell}px`;
    node.style.top = `${GRID_INSET + item.y * cell}px`;
    node.style.width = `${size.width * cell - 2}px`;
    node.style.height = `${size.height * cell - 2}px`;
    node.title = `${def.name}\n${def.weight} кг${def.description ? `\n\n${def.description}` : ''}`;

    // Картинка вместо названия — там, где она есть. Имя не теряется:
    // оно в подсказке, вместе с весом и описанием.
    if (def.icon) {
      node.classList.add('with-icon');
      node.style.backgroundImage = `url(${def.icon})`;
    } else {
      node.textContent = def.name;
    }

    if (item.count > 1) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(item.count);
      node.append(count);
    }

    return node;
  }

  /**
   * Вещь со всем поведением.
   *
   * Одна дверь на рюкзак и на казну: вещи в сундуке тянут, поворачивают
   * и раскладывают ровно теми же движениями. Развести их по двум местам уже
   * пробовали — и казна молча осталась без перетаскивания, потому что правка
   * в одном месте не дошла до второго.
   */
  private buildItemNode(item: PlacedItem, from: GridKind): HTMLElement {
    const def = itemDef(item.defId);
    const node = this.buildStaticItem(item, sizeOfCell(from));

    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.beginDrag(item, node, event, from);
    });

    /**
     * Щелчок переносит вещь между рюкзаком и казной — одной и той же левой
     * кнопкой в обе стороны. Правая тут не годится: браузер открывает по ней
     * своё меню, и договориться с ним нельзя.
     *
     * Конец перетаскивания браузер тоже считает щелчком, поэтому спрашиваем
     * `takeClick`: иначе поворот вещи на месте читался бы как «забрать».
     */
    node.addEventListener('click', () => {
      if (!this.takeClick()) return;
      if (from === 'scrolls') this.handlers.onScrollMove('scrolls', 'backpack', item.x, item.y);
      else if (from === 'bank') this.handlers.onWithdraw(item.x, item.y);
      else if (this.bankOpen) this.handlers.onDeposit(item.x, item.y);
    });

    if (from === 'backpack') {
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!this.bankOpen && this.tradeOpen) this.handlers.onTradeOffer(item.x, item.y);
      });

      node.addEventListener('dblclick', (event) => {
        event.preventDefault();
        // У сундука тот же щелчок уже значит «положить»: надевать вещь заодно
        // с отправкой её в казну — не то, чего ждёшь.
        if (this.bankOpen) return;
        // Надеваемое надевается, съедобное используется — угадывать не надо,
        // это видно по определению предмета. Свиток вставляется в клетки
        // умений: это единственное, что с ним вообще делают.
        if (def.kind === 'spell') this.handlers.onScrollMove('backpack', 'scrolls', item.x, item.y);
        else if (def.slot) this.handlers.onEquip(item.x, item.y);
        else if (def.kind === 'consumable') this.handlers.onUse(item.x, item.y);
      });
    }

    return node;
  }

  private renderSlots(equipment: Equipment): void {
    for (const slot of EQUIP_SLOTS) {
      const node = this.slotNodes.get(slot);
      if (!node) continue;

      const item = equipment[slot];
      node.classList.toggle('filled', Boolean(item));
      node.replaceChildren();

      const label = document.createElement('div');
      label.className = 'slot-name';
      label.textContent = SLOT_NAMES[slot];
      node.append(label);

      if (item) {
        const def = itemDef(item.defId);
        const name = document.createElement('div');
        name.textContent = def.name;
        node.append(name);

        const bonus = document.createElement('div');
        bonus.className = 'slot-name';
        bonus.textContent = def.armor ? `броня ${def.armor}` : def.damage ? `урон ${def.damage}` : '';
        node.append(bonus);
        node.title = 'Щелчок — снять, перетаскивание — в нужную клетку';
      } else {
        node.title = '';
      }
    }
  }

  private renderWeight(state: InventoryMessage): void {
    const over = state.weight > state.capacity;
    /**
     * Рывок пропадает раньше, чем скорость, — и игрок должен видеть, где эта
     * черта, до того как в неё упрётся. Иначе вес остаётся штрафом, а не
     * выбором: непонятно, что именно ты теряешь, взяв ещё одно бревно.
     */
    const heavy = !over && state.weight > state.capacity * DASH_WEIGHT_LIMIT;

    const text = el<HTMLDivElement>('weightText');
    const note = over
      ? ' — перегруз, идёшь медленнее'
      : heavy
        ? ' — тяжело, рывок не выйдет'
        : '';
    text.textContent = `Нагрузка: ${state.weight.toFixed(1)} из ${state.capacity} кг${note}`;
    text.classList.toggle('over', over || heavy);

    const fill = el<HTMLElement>('weightFill');
    fill.style.transform = `scaleX(${Math.min(1, state.weight / Math.max(state.capacity, 1))})`;
    fill.classList.toggle('over', over);

    el<HTMLDivElement>('loadoutStats').textContent =
      `Броня: ${state.armor}   ·   Урон оружия: ${state.weaponDamage || 'кулаки'}`;
  }

  private buildSlots(): void {
    for (const slot of EQUIP_SLOTS) {
      const node = document.createElement('div');
      node.className = 'slot';
      node.dataset.slot = slot;

      node.addEventListener('click', () => {
        // Конец перетаскивания браузер тоже считает щелчком — спрашиваем.
        if (!this.takeClick()) return;
        if (this.state?.equipment[slot]) this.handlers.onUnequip(slot);
      });

      // Надетое можно вытащить мышью, как вещь из рюкзака: щелчок кладёт
      // его на первое свободное место, перетаскивание — в выбранную клетку.
      node.addEventListener('mousedown', (event) => {
        const worn = this.state?.equipment[slot];
        if (!worn) return;
        event.preventDefault();
        this.beginDrag(worn, node, event, 'backpack', slot);
      });

      // Слот — цель для перетаскивания: бросил сюда, значит надел.
      node.addEventListener('mouseup', () => {
        // Надеть можно только своё: из казны вещь сперва вынимают, а
        // надетое в другой слот не переставляют — слоты разного рода.
        if (this.drag?.from === 'backpack' && !this.drag.slot) {
          this.handlers.onEquip(this.drag.item.x, this.drag.item.y);
        }
      });
      node.addEventListener('mouseenter', () => {
        if (this.drag?.from === 'backpack' && !this.drag.slot) node.classList.add('hot');
      });
      node.addEventListener('mouseleave', () => node.classList.remove('hot'));

      this.slotsBox.append(node);
      this.slotNodes.set(slot, node);
    }
  }

  // ---------- перетаскивание ----------

  private beginDrag(
    item: PlacedItem,
    node: HTMLElement,
    event: MouseEvent,
    from: GridKind = 'backpack',
    slot: EquipSlot | null = null,
  ): void {
    const def = itemDef(item.defId);
    this.justDragged = false;
    this.drag = {
      item,
      rotated: item.rotated,
      node,
      from,
      slot,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    node.classList.add('dragging');

    this.ghost.hidden = false;
    this.ghost.textContent = def.name;
    this.updateGhost(event.clientX, event.clientY);
  }

  private wireDrag(): void {
    window.addEventListener('mousemove', (event) => {
      if (!this.drag) return;
      if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 4) {
        this.drag.moved = true;
      }
      this.updateGhost(event.clientX, event.clientY);
      this.highlightTarget(event);
      // Вещь вытащили за окно — корзина подсвечивается: отпустишь, и она упадёт.
      const outside = this.canThrowOut(this.drag) && this.outsidePanel(event);
      if (!this.discard.matches(':hover')) this.discard.classList.toggle('hot', outside);
    });

    window.addEventListener('mouseup', (event) => {
      if (!this.drag) return;

      const target = this.cellUnder(event);
      const drag = this.drag;
      this.justDragged = drag.moved || drag.rotated !== drag.item.rotated;
      // Отпустили мимо сетки — это могла быть цель-слот или корзина,
      // у них свои обработчики; здесь просто прекращаем перенос.
      if (target) this.dropOn(drag, target);
      // Вытащили за окно рюкзака и отпустили — вещь падает на землю, как из
      // корзины. Корзину искать глазами не надо: «выбросить» — это «вынести
      // из окна». Над панелью быстрого доступа не бросаем: там её назначают.
      else if (drag.moved && this.canThrowOut(drag) && this.outsidePanel(event)) {
        this.handlers.onDrop(drag.item.x, drag.item.y);
      }
      this.cancelDrag();
    });

    window.addEventListener('keydown', (event) => {
      if (!this.drag) return;

      if (event.code === 'KeyR') {
        event.preventDefault();
        this.drag.rotated = !this.drag.rotated;
        this.drag.moved = true;
        this.updateGhostSize();
      }
      if (event.code === 'Escape') this.cancelDrag();
    });
  }

  /**
   * Что значит «бросил сюда».
   *
   * Внутри рюкзака это перекладывание с точностью до клетки, между рюкзаком
   * и казной — перенос: раскладку в хранилище наводит сервер, и тащить вещь
   * в конкретную клетку сундука было бы обещанием, которого он не держит.
   */
  private dropOn(drag: DragState, target: { grid: GridKind; x: number; y: number }): void {
    const rotate = drag.rotated !== drag.item.rotated;
    const to: DropTarget = { x: target.x, y: target.y, rotate };

    // Надетое снимается в ту клетку, куда его притащили. В казну прямо
    // из слота не кладут: сперва сними — иначе это два действия за одно
    // движение, и на полпути между ними вещь негде держать.
    if (drag.slot) {
      if (target.grid === 'backpack') this.handlers.onUnequip(drag.slot, to);
      return;
    }

    // Клетки умений: любое движение с их участием — один и тот же перенос.
    // Из казны туда не тянут: вещь сперва вынимают в рюкзак.
    if (drag.from === 'scrolls' || target.grid === 'scrolls') {
      if (drag.from === 'bank' || target.grid === 'bank') return;
      this.handlers.onScrollMove(drag.from, target.grid, drag.item.x, drag.item.y, {
        x: target.x,
        y: target.y,
      });
      return;
    }

    if (drag.from === 'backpack' && target.grid === 'backpack') {
      this.handlers.onMove(drag.item.x, drag.item.y, target.x, target.y, rotate);
      return;
    }
    if (drag.from === 'bank' && target.grid === 'bank') {
      this.handlers.onBankArrange(drag.item.x, drag.item.y, target.x, target.y, rotate);
      return;
    }
    if (drag.from === 'backpack') this.handlers.onDeposit(drag.item.x, drag.item.y, to);
    else this.handlers.onWithdraw(drag.item.x, drag.item.y, to);
  }

  private updateGhost(clientX: number, clientY: number): void {
    this.ghost.style.left = `${clientX - 20}px`;
    this.ghost.style.top = `${clientY - 20}px`;
    this.updateGhostSize();
  }

  private updateGhostSize(): void {
    if (!this.drag) return;
    const size = sizeOf(this.drag.item.defId, this.drag.rotated);
    this.ghost.style.width = `${size.width * CELL - 2}px`;
    this.ghost.style.height = `${size.height * CELL - 2}px`;
  }

  /** Подсветка клеток под предметом: зелёная — влезает, красная — нет. */
  private highlightTarget(event: MouseEvent): void {
    this.clearCells();

    const target = this.cellUnder(event);
    if (!target || !this.drag || !this.state) return;

    const grid =
      target.grid === 'bank'
        ? this.bankGrid
        : target.grid === 'scrolls'
          ? this.scrollGrid
          : this.state.backpack;
    if (!grid) return;

    const size = sizeOf(this.drag.item.defId, this.drag.rotated);
    const inside = target.x + size.width <= grid.width && target.y + size.height <= grid.height;

    /**
     * Зелёным светится и чужая стопка того же вида.
     *
     * Складывать их правила умеют, и игрок должен видеть, что это можно,
     * а не гадать по красной клетке, которая на самом деле примет вещь.
     */
    const under = itemAt(grid, target.x, target.y);
    const stacks =
      under !== null &&
      under !== this.drag.item &&
      under.defId === this.drag.item.defId &&
      under.count < itemDef(under.defId).stack;

    const fits = inside || stacks;

    for (let dy = 0; dy < size.height; dy++) {
      for (let dx = 0; dx < size.width; dx++) {
        const cell = this.cellAt(target.grid, target.x + dx, target.y + dy);
        cell?.classList.add(fits ? 'hot' : 'bad');
      }
    }
  }

  private clearCells(): void {
    for (const box of [this.cells, this.bankCells, this.scrollCells]) {
      for (const cell of box.querySelectorAll('.cell')) cell.classList.remove('hot', 'bad');
    }
  }

  private cellAt(grid: GridKind, x: number, y: number): HTMLElement | null {
    const box = grid === 'bank' ? this.bankCells : grid === 'scrolls' ? this.scrollCells : this.cells;
    return box.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
  }

  /** Выбросить можно только из рюкзака: содержимое казны не на руках, надетое сперва снимают. */
  private canThrowOut(drag: DragState): boolean {
    return drag.from === 'backpack' && !drag.slot;
  }

  /**
   * Курсор за пределами окна рюкзака.
   *
   * Окно — это панель, а не затемнение вокруг неё: затемнение накрывает весь
   * экран, и «за окном» значит «на нём». Панель быстрого доступа лежит поверх
   * и за окно не считается — вещь туда назначают, а не выбрасывают.
   */
  private outsidePanel(event: MouseEvent): boolean {
    const node = document.elementFromPoint(event.clientX, event.clientY);
    if (!node) return false;
    return !node.closest('.inv-panel') && !node.closest('#hotbar');
  }

  /**
   * Какая клетка под курсором.
   *
   * Сперва спрашиваем саму клетку, но **над занятым местом её не достать**:
   * вещи лежат отдельным слоем поверх сетки, и `elementFromPoint` возвращает
   * вещь, а не клетку под ней. Пока это не учитывалось, стопку нельзя было
   * бросить на стопку — перетаскивание молча отменялось, хотя правила
   * складывать умеют.
   *
   * Поэтому второй заход: нашли вещь — считаем клетку по геометрии сетки,
   * в которой она лежит.
   */
  private cellUnder(event: MouseEvent): { grid: GridKind; x: number; y: number } | null {
    const node = document.elementFromPoint(event.clientX, event.clientY);

    const cell = node?.closest('.cell') as HTMLElement | null;
    if (cell) {
      return {
        grid: (cell.dataset.grid ?? 'backpack') as GridKind,
        x: Number(cell.dataset.x),
        y: Number(cell.dataset.y),
      };
    }

    const wrap = node?.closest('.grid-wrap') as HTMLElement | null;
    const cells = wrap?.querySelector('.grid-cells') as HTMLElement | null;
    if (!wrap || !cells) return null;

    const box = cells.getBoundingClientRect();
    const grid: GridKind =
      wrap.id === 'bankWrap' ? 'bank' : wrap.id === 'scrollWrap' ? 'scrolls' : 'backpack';
    const step = sizeOfCell(grid);

    const x = Math.floor((event.clientX - box.left - GRID_INSET) / step);
    const y = Math.floor((event.clientY - box.top - GRID_INSET) / step);
    if (x < 0 || y < 0) return null;

    return { grid, x, y };
  }

  private cancelDrag(): void {
    this.drag?.node.classList.remove('dragging');
    this.drag = null;
    this.ghost.hidden = true;
    this.discard.classList.remove('hot');
    this.clearCells();
    for (const node of this.slotNodes.values()) node.classList.remove('hot');
    for (const node of this.hotbarNodes) node.classList.remove('hot-target');
  }
}
