// Съёмка кадров для кейса: разбор блоков страницы, полный кадр, кадры секций с запасом.
//
//   node shoot.js --url https://example.ru/ --measure
//   node shoot.js --url https://example.ru/ --tech
//   node shoot.js --url https://example.ru/ --out cases/example.ru/screenshots \
//     --full pages/01-home.png --shots "#1,01-hero;#2,02-company"
//   node shoot.js --url https://example.ru/ --width 767 --out ... --screen hero-mobile
//
// Запас сверху и снизу добавляется к каждой секции (--pad, по умолчанию 30)
// и сам подрезается, чтобы не захватить содержимое соседнего блока.

const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) {
    args[key] = true;
  } else {
    args[key] = next;
    i++;
  }
}

if (!args.url) {
  console.error('Нужен --url');
  process.exit(1);
}

const width = Number(args.width || 1440);
const mobile = width <= 820;
// мобильный кадр держим в пропорции телефона (как 390x844), иначе экран выглядит приплюснутым
const height = Number(args.height || (mobile ? Math.round((width * 844) / 390) : 900));
const pad = Number(args.pad === undefined ? 30 : args.pad);

function requirePuppeteer() {
  const candidates = [path.join(__dirname, 'node_modules', 'puppeteer-core')];
  let dir = process.cwd();
  while (true) {
    candidates.push(path.join(dir, 'node_modules', 'puppeteer-core'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // проекты внутри воркспейса держат свой node_modules
  try {
    for (const entry of fs.readdirSync(process.cwd(), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push(path.join(process.cwd(), entry.name, 'node_modules', 'puppeteer-core'));
      }
    }
  } catch (e) {
    /* нет прав на чтение каталога — не страшно */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  try {
    return require('puppeteer-core');
  } catch (e) {
    console.error(
      'Не найден puppeteer-core. Установить в папку скилла:\n' +
        `  npm install --prefix "${__dirname}" puppeteer-core`
    );
    process.exit(1);
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || '';
  const guesses = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local && local.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const g of guesses) {
    if (g && fs.existsSync(g)) return g;
  }
  console.error('Не найден Chrome. Указать путь через CHROME_PATH.');
  process.exit(1);
}

// Оверлеи, которые портят длинный кадр. Большой полупрозрачный слой на весь экран
// чаще всего декор или фон, его не трогаем, кроме явных диалогов.
const OVERLAY_WORDS =
  'cookie|consent|gdpr|privacy|fides|chat|widget|popup|modal|dialog|banner|notice|notify|' +
  'subscribe|promo|sticky|float|fixed-|callback|whatsapp|telegram|viber|scroll-?top|to-?top|up-?btn|' +
  'back-to-top|toast|alert|panel-bottom|bottom-bar|top-bar';

const prepareInPage = (overlayWords, keepOverlays) => {
  const re = new RegExp(overlayWords, 'i');
  const hidden = [];
  const kept = [];

  // анимации доводим до конца мгновенно: иначе блок попадёт в кадр полупрозрачным
  const style = document.createElement('style');
  style.textContent =
    '*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;' +
    'transition-duration:0.001s !important;transition-delay:0s !important;' +
    'scroll-behavior:auto !important;}';
  document.head.appendChild(style);

  // кадр раскрытого меню или диалога: ничего не прячем и шапку не трогаем
  if (keepOverlays) return { hidden: [], kept: ['всё оставлено по --keep-overlays'] };

  const vp = window.innerWidth * window.innerHeight;
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.width < 4) continue;

    const name = [el.id, String(el.className), el.getAttribute('aria-label') || ''].join(' ');
    const isDialog = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
    const looksOverlay = re.test(name) || isDialog;
    // шапка и верхняя полоса бывают любым тегом: судим по месту и ширине, а не по имени тега
    const isHeader = !looksOverlay && r.top < 150 && r.width > window.innerWidth * 0.6;

    if (isHeader) {
      // шапка нужна на первом экране и должна стоять сверху документа
      el.style.setProperty('position', 'absolute', 'important');
      kept.push('шапка: ' + (el.tagName + '.' + String(el.className)).slice(0, 50));
      continue;
    }
    if (!looksOverlay && r.width * r.height > vp * 0.55) {
      // слой на весь экран без признаков баннера — это фон или декор
      kept.push('слой: ' + (el.tagName + '.' + String(el.className)).slice(0, 50));
      continue;
    }
    el.style.setProperty('display', 'none', 'important');
    hidden.push((el.tagName + '.' + String(el.className)).slice(0, 50));
  }
  return { hidden, kept };
};

const scrollThrough = async () => {
  const step = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await step(180);
    }
    // ленивый контент мог удлинить страницу — проходим ещё раз
    if (document.documentElement.scrollHeight === last) break;
    last = document.documentElement.scrollHeight;
  }
  window.scrollTo(0, 0);
  await step(400);
  return document.documentElement.scrollHeight;
};

// Блоки, которые так и остались прозрачными после прокрутки: доводим вручную.
// Сдвиг без прозрачности не трогаем: так стоят выезжающие меню, слайды и шторки.
const forceReveal = () => {
  const forced = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.getAttribute('aria-hidden') === 'true') continue;
    const s = getComputedStyle(el);
    if (s.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 20 || r.width < 60) continue;
    if (parseFloat(s.opacity) >= 0.1) continue;
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('transform', 'none', 'important');
    forced.push((el.tagName + '.' + String(el.className)).slice(0, 50));
  }
  return forced.slice(0, 20);
};

// Разбор блоков живёт в странице: замер и съёмка смотрят на одну и ту же вёрстку,
// поэтому координаты не устаревают между запусками.
const installHelpers = () => {
  const isSection = (el) => {
    const r = el.getBoundingClientRect();
    return r.height > 150 && r.width > window.innerWidth * 0.4;
  };
  // блоки страницы стоят друг под другом; слайды карусели стоят рядом и в кадр не годятся
  const isStack = (kids) => {
    if (kids.length < 2) return false;
    const tops = kids.map((k) => k.getBoundingClientRect().top).sort((a, b) => a - b);
    return tops.every((t, i) => i === 0 || t - tops[i - 1] > 50);
  };
  const coverage = (kids) => kids.reduce((sum, k) => sum + k.getBoundingClientRect().height, 0);

  // контейнер блоков страницы: больше всего вертикально сложенного содержимого
  const findContainer = () => {
    let best = null;
    let bestScore = 0;
    let bestDepth = -1;
    const walk = (el, depth) => {
      if (!el || !el.children) return;
      const kids = [...el.children].filter(isSection);
      if (isStack(kids)) {
        const score = coverage(kids);
        if (score > bestScore || (score === bestScore && depth > bestDepth)) {
          best = el;
          bestScore = score;
          bestDepth = depth;
        }
      }
      for (const k of kids) walk(k, depth + 1);
    };
    walk(document.body, 0);
    if (best) return best;
    // страница из одного блока: берём блок с содержимым, а не обёртку на всю страницу
    const h1 = document.querySelector('h1');
    let node = h1 ? h1.parentElement : document.body;
    while (node && node.getBoundingClientRect().height < document.documentElement.scrollHeight * 0.3) {
      node = node.parentElement;
    }
    return node || document.body;
  };

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const h = el.querySelector('h1, h2, h3') || (/^H[1-3]$/.test(el.tagName) ? el : null);
    return {
      el,
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      title: h ? h.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
    };
  };

  // куски блока: порог ниже, внутри блока элементы мельче
  const rawParts = (el) =>
    [...el.children].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.height > 40 && r.width > window.innerWidth * 0.3;
    });

  // разметка заворачивает содержимое в цепочки одиночных обёрток — разворачиваем до развилки
  const partsOf = (el, minHeight) => {
    let parts = rawParts(el);
    let guard = 0;
    while (parts.length === 1 && guard++ < 15) {
      const deeper = rawParts(parts[0]);
      if (!deeper.length) break;
      parts = deeper;
    }
    const big = parts.filter((p) => p.getBoundingClientRect().height > (minHeight || 0));
    return (big.length >= 2 ? big : parts).map(describe);
  };

  // блок выше полутора экранов — это обёртка нескольких блоков, разбираем её
  const tooTall = (s) => s.height > Math.max(window.innerHeight * 1.5, 1300);
  const splitTall = (list, depth) => {
    if (depth > 6) return list;
    const out = [];
    for (const s of list) {
      if (!tooTall(s)) {
        out.push(s);
        continue;
      }
      const parts = partsOf(s.el, 150);
      if (parts.length >= 2) out.push(...splitTall(parts, depth + 1));
      else out.push(s);
    }
    return out;
  };

  // Одинокий заголовок или тонкая подпись — не блок, а начало следующего блока.
  const mergeThin = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const next = list[i + 1];
      if (s.height < 140 && next && next.top - (s.top + s.height) < 160) {
        out.push({ ...next, top: s.top, height: next.top + next.height - s.top, title: s.title || next.title });
        i++;
        continue;
      }
      out.push(s);
    }
    return out;
  };

  const clampOverlap = (list) =>
    list.map((s, i) => {
      const next = list[i + 1];
      if (!next || next.top >= s.top + s.height) return s;
      return { ...s, height: next.top - s.top, rawHeight: s.height };
    });

  // путь: '' — блоки страницы, '3' — куски третьего блока, '3.2' — куски второго куска.
  // Нумерация одна и та же в замере, в --inspect и в --shots "#3.2".
  const listAt = (p) => {
    const parts = String(p || '')
      .split('.')
      .filter(Boolean)
      .map(Number);
    let list = clampOverlap(mergeThin(splitTall([...findContainer().children].filter(isSection).map(describe), 0)));
    for (const idx of parts) {
      const parent = list[idx - 1];
      if (!parent) return null;
      list = clampOverlap(partsOf(parent.el, 0));
    }
    return list;
  };

  // Настоящие границы кадра: содержимое вылезает за рамку блока, а заголовок
  // нередко стоит выше самого блока. И то и другое должно попасть в кадр.
  const boundsOf = (el) => {
    const r = el.getBoundingClientRect();
    let top = r.top;
    let bottom = r.bottom;
    for (const d of el.querySelectorAll('*')) {
      const s = getComputedStyle(d);
      if (s.position === 'fixed' || s.display === 'none') continue;
      const dr = d.getBoundingClientRect();
      if (dr.width < 2 || dr.height < 2) continue;
      if (dr.bottom > bottom && dr.bottom - r.bottom < 600) bottom = dr.bottom;
      if (dr.top < top && top - dr.top < 600) top = dr.top;
    }
    const hasHeading = el.querySelector('h1, h2, h3') || /^H[1-3]$/.test(el.tagName);
    if (!hasHeading) {
      for (const h of document.querySelectorAll('h1, h2, h3')) {
        if (el.contains(h)) continue;
        const hr = h.getBoundingClientRect();
        if (hr.height < 10 || !h.textContent.trim()) continue;
        const gap = top - hr.bottom;
        if (gap >= 0 && gap < 160 && hr.width > 60) top = Math.min(top, hr.top);
      }
    }
    return {
      top: Math.round(top + window.scrollY),
      height: Math.round(bottom - top)
    };
  };

  window.__pc = {
    docHeight: () => document.documentElement.scrollHeight,
    list: (p) => {
      const list = listAt(p);
      return list && list.map(({ el, ...rest }) => rest);
    },
    // '#3.2' — блок замера, '@.selector' — элемент по селектору
    resolve: (ref) => {
      if (ref.startsWith('@')) {
        const el = document.querySelector(ref.slice(1));
        return el ? boundsOf(el) : null;
      }
      const parts = ref.split('.');
      const idx = Number(parts.pop()) - 1;
      const list = listAt(parts.join('.'));
      const section = list && list[idx];
      if (!section) return null;
      const b = boundsOf(section.el);
      // накладывающиеся блоки режем по началу следующего, остальные берём целиком
      const height = section.rawHeight ? section.height : Math.max(section.height, b.height);
      return { top: Math.min(section.top, b.top), height: height + (section.top - Math.min(section.top, b.top)) };
    },
    container: () => {
      const c = findContainer();
      return c.tagName + '.' + String(c.className).slice(0, 50);
    }
  };
};

// Запас — это воздух, а не чужой контент: подрезаем его по содержимому соседних блоков.
const limitPad = (sectionTop, sectionBottom, pad) => {
  const hasOwnContent = (el) => {
    if (el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'VIDEO') return true;
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim()) return true;
    }
    return false;
  };
  let prevBottom = 0;
  let nextTop = document.documentElement.scrollHeight;
  for (const el of document.querySelectorAll('body *')) {
    if (!hasOwnContent(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 1 || r.width < 1) continue;
    const top = r.top + window.scrollY;
    const bottom = r.bottom + window.scrollY;
    if (bottom <= sectionTop && bottom > prevBottom) prevBottom = bottom;
    if (top >= sectionBottom && top < nextTop) nextTop = top;
  }
  const clamp = (v) => Math.max(0, Math.min(pad, Math.floor(v) - 2));
  return {
    before: clamp(sectionTop - prevBottom),
    after: clamp(nextTop - sectionBottom)
  };
};

// Чем занят сайт: CMS, аналитика, карты, защита форм, счётные факты.
const techInPage = () => {
  const html = document.documentElement.outerHTML;
  const has = (re) => re.test(html);
  const platform = [];
  if (window.drupalSettings || has(/\/sites\/(default|all)\/(files|themes|modules)/)) platform.push('Drupal');
  if (has(/wp-content|wp-json|wp-includes/)) platform.push('WordPress');
  if (has(/\/bitrix\//)) platform.push('1C-Bitrix');
  if (has(/tilda|t-records|tildacdn/i)) platform.push('Tilda');
  if (window.__NEXT_DATA__ || has(/\/_next\//)) platform.push('Next.js');
  if (window.__NUXT__ || has(/\/_nuxt\//)) platform.push('Nuxt');
  if (has(/cdn\.shopify|shopify/i)) platform.push('Shopify');
  if (has(/webflow/i)) platform.push('Webflow');
  if (has(/joomla|\/media\/jui\//i)) platform.push('Joomla');
  if (has(/modx|assets\/components/i)) platform.push('MODX');
  if (has(/opencart|index\.php\?route=/i)) platform.push('OpenCart');
  if (has(/insales|assets\/insales/i)) platform.push('InSales');
  if (has(/static\.parastorage|wix/i)) platform.push('Wix');
  if (has(/data-reactroot|__REACT|react-dom/i) && !platform.length) platform.push('React');

  const analytics = [];
  if (has(/mc\.yandex|metrika/i)) analytics.push('Яндекс Метрика');
  if (has(/googletagmanager\.com\/gtm/i)) analytics.push('Google Tag Manager');
  if (has(/gtag\(|google-analytics/i)) analytics.push('Google Analytics');
  if (has(/vk\.com\/rtrg|vk-pixel/i)) analytics.push('VK пиксель');
  if (has(/top-fwz1\.mail\.ru|top\.mail\.ru/i)) analytics.push('Top.Mail.ru');
  if (has(/roistat/i)) analytics.push('Roistat');
  if (has(/calltouch/i)) analytics.push('Calltouch');

  const maps = [];
  if (has(/api-maps\.yandex|yandex\.ru\/map/i)) maps.push('Яндекс Карты');
  if (has(/maps\.googleapis|google\.com\/maps/i)) maps.push('Google Maps');
  if (has(/leaflet/i)) maps.push('Leaflet');
  if (has(/2gis|api\.2gis/i)) maps.push('2ГИС');

  const sliders = ['slick', 'swiper', 'owl-carousel', 'glide', 'splide', 'flickity', 'keen-slider'].filter((s) =>
    new RegExp(s, 'i').test(html)
  );

  const forms = [...document.querySelectorAll('form')].map((f) => ({
    action: f.getAttribute('action') || f.id || '',
    fields: f.querySelectorAll('input, textarea, select').length
  }));
  const protection = [];
  if (has(/recaptcha|grecaptcha/i)) protection.push('reCAPTCHA');
  if (has(/smartcaptcha|yandex.*captcha/i)) protection.push('Яндекс SmartCaptcha');
  if (has(/honeypot|antibot|url_check/i)) protection.push('honeypot');
  if (has(/hcaptcha/i)) protection.push('hCaptcha');

  // счётные факты: сколько страниц в каждом разделе видно со страницы
  const groups = {};
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const seg = href.split('/').filter(Boolean);
    if (seg.length < 2) continue;
    groups[seg[0]] = groups[seg[0]] || new Set();
    groups[seg[0]].add(href.split('?')[0]);
  }
  const counts = Object.entries(groups)
    .map(([k, v]) => ({ section: '/' + k, pages: v.size }))
    .sort((a, b) => b.pages - a.pages)
    .slice(0, 8);

  return {
    title: document.title,
    generatorMeta: (document.querySelector('meta[name=generator]') || {}).content || null,
    platform,
    analytics,
    maps,
    sliders,
    forms: forms.slice(0, 8),
    formProtection: protection,
    linkCounts: counts,
    lang: document.documentElement.lang || null
  };
};

const blankWarning = (file) => {
  const bytes = fs.statSync(file).size;
  return { bytes };
};

(async () => {
  const puppeteer = requirePuppeteer();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !args.headful,
    args: [
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-features=IsolateOrigins',
      '--lang=ru-RU'
    ]
  });

  try {
    const page = await browser.newPage();
    // headless-агент часто ловит заглушку или защиту от ботов
    const defaultUA = mobile
      ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    await page.setUserAgent(args.ua && args.ua !== true ? String(args.ua) : defaultUA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' });
    await page.setViewport({
      width,
      height,
      deviceScaleFactor: 1,
      isMobile: mobile,
      hasTouch: mobile
    });
    // сайты с анимацией по скроллу чаще отдают статичную версию
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

    // networkidle ломается на сайтах с постоянными запросами: ждём разметку, потом тишину по возможности
    const response = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const headers = response ? response.headers() : {};
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      return true;
    });

    // пустая страница значит заглушку, редирект или защиту от ботов, а не плохую вёрстку
    const sanity = await page.evaluate(() => ({
      title: document.title,
      textLength: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().length,
      url: location.href
    }));
    if (sanity.textLength < 200) {
      console.error(
        `Страница почти пустая (${sanity.textLength} символов текста, адрес ${sanity.url}).\n` +
          'Похоже на защиту от ботов или редирект. Попробовать: --headful, свой --ua, другой адрес.'
      );
    }

    if (args.tech) {
      const info = await page.evaluate(techInPage);
      console.log(
        JSON.stringify(
          {
            url: args.url,
            serverHeaders: {
              'x-generator': headers['x-generator'] || null,
              'x-powered-by': headers['x-powered-by'] || null,
              server: headers['server'] || null
            },
            ...info
          },
          null,
          2
        )
      );
      return;
    }

    // клики до скрытия оверлеев: кнопка фильтра, бургер, согласие с cookie ещё на месте
    if (args.click && args.click !== true) {
      for (const sel of String(args.click).split(';')) {
        const target = sel.trim();
        if (!target) continue;
        const done = await page
          .evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }, target)
          .catch(() => false);
        console.error(done ? `клик: ${target}` : `не найден селектор: ${target}`);
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (args.wait && args.wait !== true) {
      await new Promise((r) => setTimeout(r, Number(args.wait)));
    }

    const overlays = await page.evaluate(prepareInPage, OVERLAY_WORDS, !!args['keep-overlays']);
    const docHeight = await page.evaluate(scrollThrough);
    const forced = await page.evaluate(forceReveal);
    await page.evaluate(installHelpers);

    const inspect = args.inspect && args.inspect !== true ? String(args.inspect) : '';
    const onlyMeasuring = !args.shots && !args.full && !args.screen;
    const needList =
      !!args.measure ||
      !!inspect ||
      onlyMeasuring ||
      (args.shots && args.shots !== true && String(args.shots).includes('#'));
    const sections = needList
      ? await page.evaluate((p) => window.__pc.list(p), inspect)
      : [];
    if (args.measure || args.inspect || onlyMeasuring) {
      console.log(
        JSON.stringify(
          {
            path: inspect || 'блоки страницы',
            docHeight,
            innerWidth: await page.evaluate(() => window.innerWidth),
            container: await page.evaluate(() => window.__pc.container()),
            скрыто: overlays.hidden,
            оставлено: overlays.kept,
            доведеноАнимаций: forced.length,
            sections
          },
          null,
          2
        )
      );
      if (onlyMeasuring) return;
    }

    const outDir = args.out;
    if (!outDir) {
      console.error('Нужен --out');
      process.exit(1);
    }

    const report = (file, w, h, extra) => {
      const { bytes } = blankWarning(file);
      const perPixel = bytes / (w * h);
      const name = path.basename(file);
      console.log(`${name}  ${w}x${h}  ${extra || ''}`.trim());
      if (perPixel < 0.02) {
        console.log(`  ВНИМАНИЕ: ${name} почти пустой (${perPixel.toFixed(4)} байт на пиксель). Открыть и посмотреть.`);
      }
    };

    if (args.full) {
      const target = path.join(outDir, args.full);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: true });
      report(target, width, docHeight, 'полная страница');
    }

    // кадр ровно в размер экрана, без запаса: так снимают первый экран и раскрытое меню
    if (args.screen && args.screen !== true) {
      const target = path.join(outDir, String(args.screen).trim() + '.png');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await page.screenshot({
        path: target,
        clip: { x: 0, y: 0, width, height: Math.min(height, docHeight), scale: 1 }
      });
      report(target, width, Math.min(height, docHeight), 'экран');
    }

    if (args.shots && args.shots !== true) {
      for (const spec of String(args.shots).split(';')) {
        if (!spec.trim()) continue;
        let [topRaw, heightRaw, name] = spec.split(',');
        // "#3" и "#3.2" — номер блока и куска внутри блока, "@.selector" — элемент по селектору.
        // Координаты берутся из страницы сейчас, а не из прошлого запуска.
        const ref = String(topRaw).trim();
        if (ref.startsWith('#') || ref.startsWith('@')) {
          const found = await page.evaluate(
            (r) => window.__pc.resolve(r.startsWith('#') ? r.slice(1) : r),
            ref
          );
          if (!found) {
            console.error(`Не нашёл ${ref}`);
            continue;
          }
          name = heightRaw;
          topRaw = found.top;
          heightRaw = found.height;
        }
        const limits = await page.evaluate(limitPad, Number(topRaw), Number(topRaw) + Number(heightRaw), pad);
        const top = Math.max(0, Number(topRaw) - limits.before);
        const bottom = Math.min(docHeight, Number(topRaw) + Number(heightRaw) + limits.after);
        const target = path.join(outDir, name.trim() + '.png');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await page.screenshot({
          path: target,
          clip: { x: 0, y: top, width, height: bottom - top, scale: 1 }
        });
        report(target, width, bottom - top, `y=${top}`);
      }
    }
  } finally {
    await browser.close();
  }
})();
