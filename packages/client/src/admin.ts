import { ITEMS, type ClientMessage, type ItemKind } from '@grimhold/shared';

/**
 * Служебное меню ведущего (F2).
 *
 * Это инструмент разработки, а не часть игры: выдать себе вещь, чтобы
 * посмотреть её в руках, и перевести часы, чтобы увидеть город ночью,
 * не дожидаясь двадцати минут игровых суток.
 *
 * Меню рисуется только тому, кому сервер разрешил (`welcome.admin`), но
 * скрытое окно — не защита: право проверяет сервер на каждой команде.
 * Здесь только удобство.
 *
 * Список предметов берётся из общего кода, а не приходит по сети: предметы
 * знают обе стороны, и пересылать то, что и так есть, незачем.
 */

const KIND_NAMES: Record<ItemKind, string> = {
  resource: 'Ресурсы',
  consumable: 'Расходники',
  weapon: 'Оружие',
  armor: 'Броня',
  tool: 'Инструменты',
  scroll: 'Свитки',
  spell: 'Заклинания',
};

/** Часы, ради которых меню и заведено: рассвет, полдень, закат, полночь. */
const HOURS: { label: string; time: number }[] = [
  { label: 'Рассвет', time: 0.25 },
  { label: 'Полдень', time: 0.5 },
  { label: 'Закат', time: 0.75 },
  { label: 'Полночь', time: 0 },
];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`нет элемента #${id}`);
  return node as T;
}

export interface AdminUi {
  readonly open: boolean;
  /** Разрешено ли меню этому аккаунту. Решает сервер. */
  allow(allowed: boolean): void;
  show(): void;
  hide(): void;
  toggle(): void;
}

export function createAdmin(
  send: (message: ClientMessage) => void,
  onClose: () => void,
): AdminUi {
  const panel = el<HTMLDivElement>('admin');
  const search = el<HTMLInputElement>('adminSearch');
  const list = el<HTMLDivElement>('adminItems');
  const count = el<HTMLInputElement>('adminCount');
  const hours = el<HTMLDivElement>('adminHours');

  let allowed = false;

  for (const hour of HOURS) {
    const button = document.createElement('button');
    button.textContent = hour.label;
    button.addEventListener('click', () => send({ t: 'admin', do: 'time', time: hour.time }));
    hours.append(button);
  }

  /**
   * Отпереть порталы, не убивая хозяина глубины.
   *
   * Стоит рядом с часами, потому что это то же самое: способ посмотреть конец
   * вылазки, не проводя перед этим боя. В самой игре порталы отпирает только
   * смерть босса.
   */
  const portals = document.createElement('button');
  portals.textContent = 'Отпереть порталы';
  portals.addEventListener('click', () => send({ t: 'admin', do: 'portals' }));
  hours.append(portals);

  /**
   * Список строится заново на каждый ввод в строке поиска.
   *
   * Предметов пара сотен, и это меню открыто редко: экономить тут нечего,
   * а перестроить целиком — честнее, чем прятать строки классом и однажды
   * забыть показать обратно.
   */
  function render(): void {
    const needle = search.value.trim().toLowerCase();
    list.replaceChildren();

    const byKind = new Map<ItemKind, HTMLDivElement>();

    for (const item of Object.values(ITEMS)) {
      if (needle && !item.name.toLowerCase().includes(needle) && !item.id.includes(needle)) continue;

      let group = byKind.get(item.kind);
      if (!group) {
        group = document.createElement('div');
        group.className = 'group';
        const title = document.createElement('h3');
        title.textContent = KIND_NAMES[item.kind];
        group.append(title);
        byKind.set(item.kind, group);
        list.append(group);
      }

      const button = document.createElement('button');
      button.textContent = item.name;
      button.title = item.id;
      button.addEventListener('click', () => {
        send({
          t: 'admin',
          do: 'give',
          itemId: item.id,
          count: Math.max(1, Math.min(999, Number(count.value) || 1)),
        });
      });
      group.append(button);
    }

    if (list.childElementCount === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Ничего не нашлось';
      list.append(empty);
    }
  }

  search.addEventListener('input', render);

  // Escape закрывает меню и из поля поиска: общий обработчик окна туда
  // не доходит — пока печатают, клавиши принадлежат полю.
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    api.hide();
    onClose();
  });
  el<HTMLButtonElement>('adminClose').addEventListener('click', () => {
    api.hide();
    onClose();
  });
  render();

  const api: AdminUi = {
    get open() {
      return !panel.hidden;
    },
    allow(value) {
      allowed = value;
      if (!allowed) panel.hidden = true;
    },
    show() {
      if (!allowed) return;
      panel.hidden = false;
      search.focus();
    },
    hide() {
      panel.hidden = true;
    },
    toggle() {
      if (panel.hidden) api.show();
      else api.hide();
    },
  };
  return api;
}
