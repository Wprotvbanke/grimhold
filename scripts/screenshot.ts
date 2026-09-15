/**
 * Снимок игры настоящим браузером.
 *
 *   npx tsx scripts/screenshot.ts [файл.png]
 *
 * Нужен потому, что глазами картинку видит только человек, а правки вида от
 * первого лица приходится делать вслепую. Замеры по костям при этом врут:
 * однажды они показывали кулаки у краёв кадра, а на экране руки были
 * гигантскими и сведёнными в центр — ошибка нашлась только на снимке.
 *
 * Работает против запущенного `npm run dev` и входит тестовой учётной записью.
 */
import puppeteer from 'puppeteer';

const OUTPUT = process.argv[2] ?? 'screenshot.png';

const browser = await puppeteer.launch({
  headless: true,
  // Без этих флагов WebGL в headless не поднимается: нужен программный вывод.
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (message) => {
    const text = message.text();
    if (/ошибк|error/i.test(text)) console.log('  [браузер]', text.slice(0, 160));
  });

  /**
   * `GRIMHOLD_FX=off` — снять без постобработки.
   *
   * Сравнивать «с эффектами» и «без» можно только двумя снимками подряд:
   * часы мира идут, и кадр в сумерках против кадра ночью ничего не докажет.
   * Настройки живут в localStorage, поэтому кладём их туда до загрузки игры.
   */
  if (process.env.GRIMHOLD_FX === 'off') {
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('grimhold.settings', JSON.stringify({ effects: 'off' }));
    });
  }

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(2000);

  await page.type('#authUser', 'test');
  await page.type('#authPass', 'test123');
  await page.click('#loginBtn');
  await wait(4000);

  // Перебираем персонажей: часть может быть занята прошлой сессией.
  let entered = false;
  for (let index = 0; index < 3 && !entered; index++) {
    await page.evaluate((i) => {
      const buttons = [...document.querySelectorAll('#charList button')];
      (buttons[i] as HTMLButtonElement | undefined)?.click();
    }, index);
    await wait(2500);
    entered = await page.evaluate(() => document.querySelector('#charScreen')?.hasAttribute('hidden') === true);
  }
  if (!entered) throw new Error('не удалось войти ни одним персонажем');

  // Ждём загрузку моделей и пару секунд игры.
  await wait(12000);

  /**
   * `GRIMHOLD_WALK=секунды` — пройти вперёд перед снимком.
   *
   * С точки появления до городских стен семьдесят метров, и стыки кладки
   * или створки ворот оттуда не разглядеть. Прямо вперёд — северная арка.
   */
  /**
   * `GRIMHOLD_TP="x, z"` или `"x, y, z"` — перенестись в точку перед снимком,
   * через телепорт служебного меню. До люка за лавкой или до угла таверны
   * от точки появления не дойти одной клавишей W.
   */
  const place = process.env.GRIMHOLD_TP;
  if (place) {
    await page.keyboard.press('F2');
    await wait(600);
    await page.type('#adminTeleport', place);
    await page.keyboard.press('Enter');
    await wait(600);
    await page.click('#adminClose');
    await wait(3000);
  }

  /**
   * `GRIMHOLD_TORCH=1` — выдать факел и взять его в левую руку.
   *
   * Внизу мгла на пять метров и своего огня нет: без факела кадр подземелья
   * выходит чёрным, и по нему ничего не докажешь.
   */
  if (process.env.GRIMHOLD_TORCH === '1') {
    await page.keyboard.press('F2');
    await wait(600);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      buttons.find((button) => button.textContent === 'Факел')?.click();
    });
    await wait(800);
    await page.click('#adminClose');
    await wait(500);
    await page.keyboard.press('Tab');
    await wait(900);
    await page.evaluate(() => {
      const torch = [...document.querySelectorAll('.inv-item')].find((node) =>
        node.textContent?.includes('Факел'),
      );
      torch?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await wait(900);
    await page.keyboard.press('Tab');
    await wait(1500);
  }

  /**
   * `GRIMHOLD_DIVE=1` — спуститься в подземелье (E у люка), а `GRIMHOLD_TP2` —
   * перенестись уже внизу. Иначе обитателей дна снять нечем: пешком до них
   * идти через три этажа.
   */
  if (process.env.GRIMHOLD_DIVE === '1') {
    await page.click('canvas');
    await wait(500);
    await page.keyboard.press('KeyE');
    await wait(3500);
  }

  const under = process.env.GRIMHOLD_TP2;
  if (under) {
    await page.keyboard.press('F2');
    await wait(600);
    // Поле чистим прямо в DOM: в нём лежат координаты первого переноса,
    // а два набора чисел подряд телепорт считает мусором и молчит.
    await page.evaluate(() => {
      (document.getElementById('adminTeleport') as HTMLInputElement).value = '';
    });
    await page.type('#adminTeleport', under);
    await page.keyboard.press('Enter');
    await wait(600);
    await page.click('#adminClose');
    await wait(900);
  }

  const walk = Number(process.env.GRIMHOLD_WALK ?? 0);
  if (walk > 0) {
    await page.click('canvas');
    await wait(600);
    await page.keyboard.down('KeyW');
    await wait(walk * 1000);
    await page.keyboard.up('KeyW');
    await wait(1200);
  }

  /**
   * Второй аргумент — что открыть перед снимком.
   *
   * Панели живут за клавишей, и снять их иначе нельзя: мышь захвачена,
   * а интерфейс поверх мира. Пока был только мир, аргумента не требовалось.
   */
  const open = process.argv[3];
  if (open === 'inventory') {
    await page.keyboard.press('Tab');
    await wait(1200);
  }

  /**
   * `bow` — выдать себе лук со стрелами и выстрелить.
   *
   * Единственный способ снять выстрел: до лука в игре надо дойти ремеслом
   * и свитком, а снимок нужен сейчас. Идёт через служебное меню, то есть
   * теми же командами, что и у живого ведущего.
   */
  if (open === 'bow') {
    await page.keyboard.press('F2');
    await wait(600);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      for (const name of ['Охотничий лук', 'Стрелы']) {
        buttons.find((button) => button.textContent === name)?.click();
      }
    });
    await wait(900);
    await page.keyboard.press('F2');
    await wait(600);

    // Надеваем лук двойным щелчком по нему в рюкзаке.
    await page.keyboard.press('Tab');
    await wait(900);
    await page.evaluate(() => {
      const bow = [...document.querySelectorAll('.inv-item')].find((node) =>
        node.textContent?.includes('Охотничий лук'),
      );
      bow?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await wait(900);
    await page.keyboard.press('Tab');
    await wait(900);

    // Захват мыши нужен, чтобы дошёл удар: без него клик уходит браузеру.
    await page.click('canvas');
    await wait(700);
    await page.mouse.down({ button: 'left' });
    await wait(80);
    await page.mouse.up({ button: 'left' });
    await wait(Number(process.argv[4] ?? 250));
  }

  /**
   * `GRIMHOLD_SPIN=n` — n кадров по кругу вместо одного.
   *
   * Мышь в игре захвачена, и повернуться иначе нельзя. Нужно, когда знаешь,
   * что цель рядом, но не знаешь, с какой стороны: моб успевает отойти,
   * пока идёт вход в игру.
   */
  const spin = Number(process.env.GRIMHOLD_SPIN ?? 0);
  if (spin > 0) {
    await page.click('canvas');
    await wait(400);
    for (let shot = 0; shot < spin; shot++) {
      await page.mouse.move(800 + shot * 180, 450);
      await wait(450);
      await page.screenshot({ path: OUTPUT.replace(/\.png$/, `_${shot}.png`) });
    }
    console.log(`снимков по кругу: ${spin}`);
  }

  await page.screenshot({ path: OUTPUT });
  console.log(`снимок сохранён: ${OUTPUT}`);
} finally {
  await browser.close();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
