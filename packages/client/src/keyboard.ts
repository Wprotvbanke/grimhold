/**
 * Захват клавиатуры.
 *
 * У браузеров свои горячие клавиши, и они пересекаются с игровыми: пробел
 * листает страницу, «/» открывает поиск в Firefox, Ctrl+S сохраняет страницу,
 * F-клавиши и цифры с модификаторами разбросаны по вкладкам. Пока игрок в игре,
 * клавиатура принадлежит игре.
 *
 * Возможностей ровно две, и они разного уровня:
 *
 * 1. `preventDefault` на всё, кроме служебного списка. Отменяет то, что
 *    страница вправе отменить: пробел, стрелки, Tab, Backspace, «/», Ctrl+S,
 *    Ctrl+P, Ctrl+F и прочее.
 * 2. Keyboard Lock API — отдаёт странице даже Ctrl+W, Ctrl+T, Ctrl+N и Escape.
 *    Работает только в полноэкранном режиме и только в Chromium; в остальных
 *    браузерах молча отсутствует, и остаётся уровень 1.
 *
 * Ни при каких условиях не перехватываются клавиши выхода и отладки: игрок
 * должен уметь обновить страницу и уйти из игры, не убивая вкладку.
 *
 * F11 перехватывается намеренно: нативный полный экран браузера не считается
 * полноэкранным режимом для страницы (`document.fullscreenElement` остаётся
 * пустым), и захват клавиатуры в нём недоступен. Поэтому F11 обрабатывает
 * игра и входит в полный экран сама.
 */

/** Что игре не принадлежит никогда: обновление, отладка, выход из захвата. */
const NEVER_CAPTURE = new Set([
  'F5',
  'F6',
  'F12',
  'Escape',
  'PrintScreen',
  'Pause',
]);

/** Отладочные сочетания браузера: Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C. */
function isDevTools(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || !event.shiftKey) return false;
  return event.code === 'KeyI' || event.code === 'KeyJ' || event.code === 'KeyC';
}

/** Перезагрузка: Ctrl+R и Ctrl+Shift+R. Их отбирать у игрока нельзя. */
function isReload(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.code === 'KeyR';
}

/**
 * Гасит браузерные умолчания, пока `active()` говорит, что игрок в игре.
 *
 * Слушатель ставится в фазе перехвата, чтобы успеть до чужих обработчиков,
 * но `preventDefault` доставке события не мешает — игровые обработчики
 * получают своё нажатие как обычно.
 */
export function guardBrowserKeys(active: () => boolean): void {
  window.addEventListener(
    'keydown',
    (event) => {
      if (!active()) return;
      // Поле ввода всегда важнее игры: там печатают.
      const node = event.target as HTMLElement | null;
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return;
      if (NEVER_CAPTURE.has(event.code) || isDevTools(event) || isReload(event)) return;
      event.preventDefault();
    },
    { capture: true },
  );
}

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | null {
  const api = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
  return api && typeof api.lock === 'function' ? api : null;
}

/** Поддерживает ли браузер полный захват. Для подсказки в интерфейсе. */
export function fullCaptureAvailable(): boolean {
  return keyboardApi() !== null;
}

export function isFullscreen(): boolean {
  return document.fullscreenElement !== null;
}

/**
 * Полный экран и вместе с ним полный захват клавиатуры.
 *
 * Одно без другого не бывает: Keyboard Lock разрешён только в полном экране,
 * иначе страница могла бы запереть игрока во вкладке.
 */
export async function toggleFullCapture(element: HTMLElement): Promise<void> {
  if (isFullscreen()) {
    await document.exitFullscreen().catch(() => undefined);
    return;
  }
  await element.requestFullscreen().catch(() => undefined);
}

/**
 * Держит захват в согласии с полноэкранным режимом: вошли — забрали клавиши,
 * вышли (в том числе системным Escape) — вернули. Браузер снимает захват сам,
 * но `unlock` на выходе делает состояние явным.
 */
export function wireFullCapture(
  onChange?: (full: boolean, captured: boolean) => void,
): void {
  const api = keyboardApi();

  document.addEventListener('fullscreenchange', () => {
    const full = isFullscreen();
    if (api) {
      if (full) void api.lock().catch(() => undefined);
      else api.unlock();
    }
    onChange?.(full, full && api !== null);
  });
}
