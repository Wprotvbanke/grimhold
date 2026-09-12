import {
  DASH_WEIGHT_LIMIT,
  EQUIP_SLOTS,
  HOTBAR_SIZE,
  recipesForRace,
  type Race,
  type RecipeId,
  SLOT_NAMES,
  countOf,
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
} from '@grimhold/shared';

/**
 * Инвентарь-сетка.
 *
 * Здесь только отображение и перетаскивание. Ни одна проверка на клиенте не
 * является решающей: мы показываем предполагаемое место подсветкой, но кладёт
 * вещь сервер, и рисуем мы ровно то, что он вернул. Иначе в игре с полной
 * потерей лута картинка рано или поздно разошлась бы с правдой.
 */

const CELL = 44; // размер клетки вместе с зазором, синхронно с CSS
// Отступ сетки от угла обёртки: рамка 1 px плюс внутреннее поле 2 px.
// Без него предметы стоят на пиксель левее и выше своих клеток.
const GRID_INSET = 3;

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
  /** Закрытие рюкзака возвращает управление игрой. */
  onClose(): void;
}

/** Откуда тянут вещь. От этого зависит, что значит «бросил сюда». */
type GridKind = 'backpack' | 'bank';

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
  private readonly bankCol = el<HTMLDivElement>('bankCol');
  private readonly bankCells = el<HTMLDivElement>('bankCells');
  private readonly bankWrap = el<HTMLDivElement>('bankWrap');
  private readonly tradeCol = el<HTMLDivElement>('tradeCol');
  private readonly craftCol = el<HTMLDivElement>('craftCol');
  private readonly helpCol = el<HTMLDivElement>('helpCol');

  private state: InventoryMessage | null = null;
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

  toggle(): void {
    this.root.hidden ? this.show() : this.hide();
  }

  show(): void {
    this.root.hidden = false;
    this.errorLine.textContent = '';
    this.refreshHotbarMode();
  }

  hide(): void {
    this.root.hidden = true;
    this.cancelDrag();
    this.refreshHotbarMode();
    this.handlers.onClose();
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
  update(state: InventoryMessage): void {
    this.state = state;
    this.cancelDrag();
    this.renderGrid(state.backpack);
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
    this.bankCol.hidden = !message.open;
    // Казна велика, и впятером колонки не помещаются даже в широкий экран.
    // У сундука ремесло и справка не нужны — человек пришёл убрать добычу.
    this.craftCol.hidden = message.open;
    this.helpCol.hidden = message.open;
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
    this.craftCol.hidden = !closed;
    this.helpCol.hidden = !closed;

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
      key.textContent = String(index + 1);
      node.append(key);

      if (!defId) {
        node.title = 'Перетащи сюда вещь из рюкзака';
        continue;
      }

      const def = itemDef(defId);
      node.classList.add('filled', `kind-${def.kind}`);
      node.append(document.createTextNode(def.name));

      // Сколько такого осталось. Ноль означает, что нажатие ничего не даст,
      // и это видно заранее, а не по сообщению об ошибке.
      const available = countOf(state.backpack, defId);
      const equipped = Object.values(state.equipment).some((item) => item?.defId === defId);

      if (available === 0 && !equipped) node.classList.add('missing');
      if (available > 1) {
        const qty = document.createElement('span');
        qty.className = 'qty';
        qty.textContent = String(available);
        node.append(qty);
      }

      const hint = this.open
        ? 'Щелчок — убрать с панели'
        : 'Щелчок или клавиша ' + (index + 1) + ' — применить';
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

  /** Вид предмета без поведения: одинаков и в рюкзаке, и в казне. */
  private buildStaticItem(item: PlacedItem): HTMLElement {
    const def = itemDef(item.defId);
    const size = sizeOf(item.defId, item.rotated);

    const node = document.createElement('div');
    node.className = `inv-item kind-${def.kind}`;
    node.style.left = `${GRID_INSET + item.x * CELL}px`;
    node.style.top = `${GRID_INSET + item.y * CELL}px`;
    node.style.width = `${size.width * CELL - 2}px`;
    node.style.height = `${size.height * CELL - 2}px`;
    node.title = `${def.name}\n${def.weight} кг${def.description ? `\n\n${def.description}` : ''}`;
    node.textContent = def.name;

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
    const node = this.buildStaticItem(item);

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
      if (from === 'bank') this.handlers.onWithdraw(item.x, item.y);
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
        // это видно по определению предмета.
        if (def.slot) this.handlers.onEquip(item.x, item.y);
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
    });

    window.addEventListener('mouseup', (event) => {
      if (!this.drag) return;

      const target = this.cellUnder(event);
      const drag = this.drag;
      this.justDragged = drag.moved || drag.rotated !== drag.item.rotated;
      // Отпустили мимо сетки — это могла быть цель-слот или корзина,
      // у них свои обработчики; здесь просто прекращаем перенос.
      if (target) this.dropOn(drag, target);
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

    const grid = target.grid === 'bank' ? this.bankGrid : this.state.backpack;
    if (!grid) return;

    const size = sizeOf(this.drag.item.defId, this.drag.rotated);
    const fits =
      target.x + size.width <= grid.width && target.y + size.height <= grid.height;

    for (let dy = 0; dy < size.height; dy++) {
      for (let dx = 0; dx < size.width; dx++) {
        const cell = this.cellAt(target.grid, target.x + dx, target.y + dy);
        cell?.classList.add(fits ? 'hot' : 'bad');
      }
    }
  }

  private clearCells(): void {
    for (const box of [this.cells, this.bankCells]) {
      for (const cell of box.querySelectorAll('.cell')) cell.classList.remove('hot', 'bad');
    }
  }

  private cellAt(grid: GridKind, x: number, y: number): HTMLElement | null {
    const box = grid === 'bank' ? this.bankCells : this.cells;
    return box.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
  }

  private cellUnder(event: MouseEvent): { grid: GridKind; x: number; y: number } | null {
    const node = document.elementFromPoint(event.clientX, event.clientY);
    const cell = node?.closest('.cell') as HTMLElement | null;
    if (!cell) return null;
    return {
      grid: (cell.dataset.grid ?? 'backpack') as GridKind,
      x: Number(cell.dataset.x),
      y: Number(cell.dataset.y),
    };
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
