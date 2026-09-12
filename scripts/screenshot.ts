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
  await page.screenshot({ path: OUTPUT });
  console.log(`снимок сохранён: ${OUTPUT}`);
} finally {
  await browser.close();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
