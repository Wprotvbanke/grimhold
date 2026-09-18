/**
 * Компас в правом камне панели.
 *
 * Роза ветров, которая крутится под взглядом: буква «С» всегда показывает,
 * где север, — как в старых ролевых играх от первого лица. Север в мире —
 * сторона, куда смотрит персонаж при нулевом развороте (−Z в three), это
 * условность: у мира нет своих сторон света, а игроку нужна опора.
 *
 * Чистая картинка: считается от разворота камеры, сервер о ней не знает.
 * Перерисовывается только когда разворот сменился — стоящий игрок
 * не должен стоить холста каждый кадр.
 */

const POINTS: readonly [string, number][] = [
  ['С', 0],
  ['В', Math.PI / 2],
  ['Ю', Math.PI],
  ['З', -Math.PI / 2],
];

export interface Compass {
  /** Разворот камеры вокруг вертикали, радианы (`controls.yaw`). */
  update(yaw: number): void;
}

export function createCompass(canvas: HTMLCanvasElement): Compass {
  const context = canvas.getContext('2d');
  let drawn = Number.NaN;
  let width = 0;
  let height = 0;

  function draw(yaw: number): void {
    if (!context) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (w !== width || h !== height) {
      canvas.width = w;
      canvas.height = h;
      width = w;
      height = h;
    }
    context.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.44;

    // Диск: тёмный, чуть светлее по краю — читается на любом камне.
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fillStyle = 'rgba(10, 10, 12, 0.72)';
    context.fill();
    context.lineWidth = Math.max(1, radius * 0.06);
    context.strokeStyle = '#6e6656';
    context.stroke();

    // Фосфор: тусклое зелёное свечение изнутри, гуще к середине —
    // как у старого циферблата в темноте. Владелец просил «совсем немного».
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, 'rgba(110, 220, 130, 0.22)');
    glow.addColorStop(0.7, 'rgba(90, 190, 110, 0.1)');
    glow.addColorStop(1, 'rgba(60, 140, 80, 0)');
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fillStyle = glow;
    context.fill();

    context.save();
    context.translate(cx, cy);
    /**
     * Знак поворота. Разворот вправо — это `yaw` в минус (controls.ts),
     * и север тогда уходит влево от взгляда: роза крутится на `yaw`,
     * по часовой при плюсе, — что и делает `rotate` холста.
     */
    context.rotate(yaw);

    // Штрихи через каждые 45°: длинные на сторонах света, короткие между.
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const long = i % 2 === 0;
      context.beginPath();
      context.moveTo(Math.sin(angle) * radius * 0.9, -Math.cos(angle) * radius * 0.9);
      context.lineTo(Math.sin(angle) * radius * (long ? 0.72 : 0.8), -Math.cos(angle) * radius * (long ? 0.72 : 0.8));
      context.lineWidth = Math.max(1, radius * (long ? 0.05 : 0.03));
      context.strokeStyle = long ? '#c9bd9c' : '#7d7466';
      context.stroke();
    }

    // Стрелка-север: красный клин к букве «С», как у настоящего компаса.
    context.beginPath();
    context.moveTo(0, -radius * 0.62);
    context.lineTo(radius * 0.1, 0);
    context.lineTo(-radius * 0.1, 0);
    context.closePath();
    context.fillStyle = '#b8443a';
    context.fill();
    context.beginPath();
    context.moveTo(0, radius * 0.62);
    context.lineTo(radius * 0.1, 0);
    context.lineTo(-radius * 0.1, 0);
    context.closePath();
    context.fillStyle = '#d6cbae';
    context.fill();

    // Буквы стоят вертикально, куда бы ни крутилась роза: каждую
    // разворачиваем обратно, иначе «Ю» на юге висит вверх ногами.
    context.font = `${Math.round(radius * 0.42)}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const [letter, angle] of POINTS) {
      context.save();
      context.translate(Math.sin(angle) * radius * 0.55, -Math.cos(angle) * radius * 0.55);
      context.rotate(-yaw);
      context.fillStyle = letter === 'С' ? '#f2c66d' : '#ddd3ba';
      // Буквы чуть светятся тем же фосфором.
      context.shadowColor = 'rgba(120, 230, 140, 0.55)';
      context.shadowBlur = radius * 0.12;
      context.fillText(letter, 0, 0);
      context.restore();
    }
    context.restore();
  }

  return {
    update(yaw) {
      // Дрожь мыши в тысячные радиана перерисовки не стоит.
      if (Math.abs(yaw - drawn) < 0.002 && canvas.width === width) return;
      drawn = yaw;
      draw(yaw);
    },
  };
}
