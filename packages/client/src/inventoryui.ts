import {
  DASH_WEIGHT_LIMIT,
  EQUIP_SLOTS,
  HOTBAR_SIZE,
  SLOT_NAMES,
  countOf,
  itemDef,
  sizeOf,
  type EquipSlot,
  type Equipment,
  type Grid,
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
  onUnequip(slot: EquipSlot): void;
  onUse(x: number, y: number): void;
  onDrop(x: number, y: number): void;
  /** Закрытие рюкзака возвращает управление игрой. */
  onClose(): void;
}

interface DragState {
  item: PlacedItem;
  rotated: boolean;
  node: HTMLElement;
}

export class InventoryUi {
  private readonly root = el<HTMLDivElement>('inventory');
  private readonly cells = el<HTMLDivElement>('backpackCells');
  private readonly wrap = el<HTMLDivElement>('backpackWrap');
  private readonly slotsBox = el<HTMLDivElement>('equipSlots');
  private readonly discard = el<HTMLDivElement>('discard');
  private readonly ghost = el<HTMLDivElement>('dragGhost');
  private readonly errorLine = el<HTMLParagraphElement>('itemError');

  private state: InventoryMessage | null = null;
  private drag: DragState | null = null;
  private readonly slotNodes = new Map<EquipSlot, HTMLDivElement>();
  private readonly hotbarNodes: HTMLDivElement[] = [];

  constructor(private readonly handlers: InventoryHandlers) {
    this.buildSlots();
    this.buildHotbar();
    this.wireDrag();

    this.discard.addEventListener('mouseup', () => {
      if (this.drag) this.handlers.onDrop(this.drag.item.x, this.drag.item.y);
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
  }

  hide(): void {
    this.root.hidden = true;
    this.cancelDrag();
    this.handlers.onClose();
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

      node.addEventListener('click', () => {
        if (!this.drag) this.handlers.onUseHotbar(index);
      });

      // Правая кнопка снимает назначение: иначе освободить ячейку нечем.
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.handlers.onAssignHotbar(index, '');
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

      const hint = 'Щелчок или клавиша ' + (index + 1) + ' — применить, правая кнопка — снять';
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
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.cells.append(cell);
      }
    }

    // Предметы рисуются поверх сетки, растягиваясь на свои клетки.
    for (const node of this.wrap.querySelectorAll('.inv-item')) node.remove();
    for (const item of grid.items) this.wrap.append(this.buildItemNode(item));
  }

  private buildItemNode(item: PlacedItem): HTMLElement {
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

    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.beginDrag(item, node, event);
    });

    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      // Надеваемое надевается, съедобное используется — угадывать не надо,
      // это видно по определению предмета.
      if (def.slot) this.handlers.onEquip(item.x, item.y);
      else if (def.kind === 'consumable') this.handlers.onUse(item.x, item.y);
    });

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
        node.title = 'Щелчок — снять';
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
        if (this.state?.equipment[slot]) this.handlers.onUnequip(slot);
      });

      // Слот — цель для перетаскивания: бросил сюда, значит надел.
      node.addEventListener('mouseup', () => {
        if (this.drag) this.handlers.onEquip(this.drag.item.x, this.drag.item.y);
      });
      node.addEventListener('mouseenter', () => {
        if (this.drag) node.classList.add('hot');
      });
      node.addEventListener('mouseleave', () => node.classList.remove('hot'));

      this.slotsBox.append(node);
      this.slotNodes.set(slot, node);
    }
  }

  // ---------- перетаскивание ----------

  private beginDrag(item: PlacedItem, node: HTMLElement, event: MouseEvent): void {
    const def = itemDef(item.defId);
    this.drag = { item, rotated: item.rotated, node };
    node.classList.add('dragging');

    this.ghost.hidden = false;
    this.ghost.textContent = def.name;
    this.updateGhost(event.clientX, event.clientY);
  }

  private wireDrag(): void {
    window.addEventListener('mousemove', (event) => {
      if (!this.drag) return;
      this.updateGhost(event.clientX, event.clientY);
      this.highlightTarget(event);
    });

    window.addEventListener('mouseup', (event) => {
      if (!this.drag) return;

      const target = this.cellUnder(event);
      const drag = this.drag;
      // Отпустили мимо сетки — это могла быть цель-слот или корзина,
      // у них свои обработчики; здесь просто прекращаем перенос.
      if (target) {
        const rotate = drag.rotated !== drag.item.rotated;
        this.handlers.onMove(drag.item.x, drag.item.y, target.x, target.y, rotate);
      }
      this.cancelDrag();
    });

    window.addEventListener('keydown', (event) => {
      if (!this.drag) return;

      if (event.code === 'KeyR') {
        event.preventDefault();
        this.drag.rotated = !this.drag.rotated;
        this.updateGhostSize();
      }
      if (event.code === 'Escape') this.cancelDrag();
    });
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
    for (const cell of this.cells.querySelectorAll('.cell')) {
      cell.classList.remove('hot', 'bad');
    }

    const target = this.cellUnder(event);
    if (!target || !this.drag || !this.state) return;

    const size = sizeOf(this.drag.item.defId, this.drag.rotated);
    const grid = this.state.backpack;
    const fits =
      target.x + size.width <= grid.width && target.y + size.height <= grid.height;

    for (let dy = 0; dy < size.height; dy++) {
      for (let dx = 0; dx < size.width; dx++) {
        const cell = this.cellAt(target.x + dx, target.y + dy);
        cell?.classList.add(fits ? 'hot' : 'bad');
      }
    }
  }

  private cellAt(x: number, y: number): HTMLElement | null {
    return this.cells.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
  }

  private cellUnder(event: MouseEvent): { x: number; y: number } | null {
    const node = document.elementFromPoint(event.clientX, event.clientY);
    const cell = node?.closest('.cell') as HTMLElement | null;
    if (!cell) return null;
    return { x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
  }

  private cancelDrag(): void {
    this.drag?.node.classList.remove('dragging');
    this.drag = null;
    this.ghost.hidden = true;
    this.discard.classList.remove('hot');

    for (const cell of this.cells.querySelectorAll('.cell')) {
      cell.classList.remove('hot', 'bad');
    }
    for (const node of this.slotNodes.values()) node.classList.remove('hot');
    for (const node of this.hotbarNodes) node.classList.remove('hot-target');
  }
}
