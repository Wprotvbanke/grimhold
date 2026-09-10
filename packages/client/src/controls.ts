/**
 * Ввод и захват мыши. Здесь собирается только НАМЕРЕНИЕ игрока —
 * ни позиции, ни результатов, потому что их считает сервер.
 */

export interface IntentSample {
  forward: number;
  right: number;
  jump: boolean;
  yaw: number;
  pitch: number;
}

const MOUSE_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export interface ControlsHooks {
  /** Открыть чат: Enter — локальный, Shift+Enter — общий. */
  onChatKey(channel: 'local' | 'global'): void;
  /** Захват мыши потерян или получен — по этому показывается экран паузы. */
  onLockChange(locked: boolean): void;
  /** Боевое намерение. Попал ли и хватило ли стамины — решит сервер. */
  onAction(kind: 'attack' | 'heavy' | 'dodge'): void;
  /** Щит поднят или опущен. */
  onBlock(active: boolean): void;
  /** Применить заклинание из панели, индекс 0..5. */
  onCast(index: number): void;
}

export class Controls {
  yaw = 0;
  pitch = 0;
  locked = false;
  /** Показывать ники — только пока зажата клавиша. */
  showNames = false;
  /** Пока игрок печатает, клавиши не должны двигать персонажа. */
  suspended = false;
  /** Держит ли игрок щит. */
  blocking = false;

  private readonly keys = new Set<string>();

  constructor(
    private readonly canvas: HTMLElement,
    private readonly hooks: ControlsHooks,
  ) {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.keys.clear();
      this.hooks.onLockChange(this.locked);
    });

    document.addEventListener('mousemove', (event) => {
      if (!this.locked) return;
      this.yaw -= event.movementX * MOUSE_SENSITIVITY;
      this.pitch -= event.movementY * MOUSE_SENSITIVITY;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    });

    window.addEventListener('keydown', (event) => {
      if (this.suspended) return;

      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        event.preventDefault();
        this.hooks.onChatKey(event.shiftKey ? 'global' : 'local');
        return;
      }

      this.keys.add(event.code);
      if (event.code === 'AltLeft' || event.code === 'AltRight') {
        this.showNames = true;
        event.preventDefault();
      }
      if (event.code === 'Space') event.preventDefault();
    });

    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.code);
      if (event.code === 'AltLeft' || event.code === 'AltRight') {
        this.showNames = false;
      }
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.showNames = false;
      // Отпущенный из фокуса щит не должен остаться поднятым навсегда.
      if (this.blocking) {
        this.blocking = false;
        this.hooks.onBlock(false);
      }
    });

    this.wireCombat();
  }

  /**
   * Боевой ввод. ЛКМ — быстрый удар, Shift+ЛКМ — тяжёлый, ПКМ удерживать —
   * блок, C — рывок, цифры — заклинания.
   */
  private wireCombat(): void {
    this.canvas.addEventListener('mousedown', (event) => {
      if (!this.locked || this.suspended) return;
      event.preventDefault();

      if (event.button === 0) {
        this.hooks.onAction(event.shiftKey ? 'heavy' : 'attack');
      } else if (event.button === 2) {
        this.blocking = true;
        this.hooks.onBlock(true);
      }
    });

    window.addEventListener('mouseup', (event) => {
      if (event.button !== 2 || !this.blocking) return;
      this.blocking = false;
      this.hooks.onBlock(false);
    });

    // Иначе ПКМ открывает контекстное меню поверх игры.
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    window.addEventListener('keydown', (event) => {
      if (this.suspended || !this.locked) return;

      if (event.code === 'KeyC') {
        event.preventDefault();
        this.hooks.onAction('dodge');
        return;
      }

      const digit = /^Digit([1-6])$/.exec(event.code);
      if (digit) {
        event.preventDefault();
        this.hooks.onCast(Number(digit[1]) - 1);
      }
    });
  }

  requestLock(): void {
    this.canvas.requestPointerLock();
  }

  sample(): IntentSample {
    const forward = (this.held('KeyW') ? 1 : 0) - (this.held('KeyS') ? 1 : 0);
    const right = (this.held('KeyD') ? 1 : 0) - (this.held('KeyA') ? 1 : 0);
    return {
      forward,
      right,
      jump: this.held('Space'),
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  private held(code: string): boolean {
    return this.locked && !this.suspended && this.keys.has(code);
  }
}
