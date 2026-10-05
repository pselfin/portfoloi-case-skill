// Видеообход сайта: десктоп 1920×1080 и мобильный 767×1660.
// Курсор, субтитры жестов, прокрутка, ховеры, переходы по меню.
//
//   node record.js --url https://example.ru/
//   node record.js --url https://example.ru/ --plan
//   node record.js --url https://example.ru/ --pages "https://a;https://b" --headful
//
// Анимации не отключаются. Запись — CDP-скринкаст и ffmpeg.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { domainToUnicode } = require('node:url');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args[key] = true;
  else {
    args[key] = next;
    i++;
  }
}

const DESKTOP = { width: 1920, height: 1080, mobile: false, file: 'tour.mp4' };
const MOBILE = {
  width: 767,
  height: Math.round((767 * 844) / 390),
  mobile: true,
  file: 'tour-mobile.mp4'
};
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

const SKIP_RE =
  /политик|privacy|cookie|consent|login|signin|sign-in|войти|регистрац|корзин|cart|checkout|search|поиск|соглашен|оферт|персональн|terms|legal|sitemap|\.pdf($|\?)|\.(jpg|jpeg|png|gif|webp|zip|rar)($|\?)/i;

let compact = false;
let cursor = { x: 200, y: 200 };
let view = { w: 1920, h: 1080 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requirePuppeteer() {
  const candidates = [path.join(__dirname, 'node_modules', 'puppeteer-core')];
  let dir = process.cwd();
  while (true) {
    candidates.push(path.join(dir, 'node_modules', 'puppeteer-core'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    for (const entry of fs.readdirSync(process.cwd(), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push(path.join(process.cwd(), entry.name, 'node_modules', 'puppeteer-core'));
      }
    }
  } catch (e) {
    /* нет прав на чтение каталога */
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

function ensureFfmpeg() {
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true });
    return bin;
  } catch (e) {
    console.error(
      'Не найден ffmpeg. Указать путь через FFMPEG_PATH или установить:\n' +
        '  winget install Gyan.FFmpeg\n' +
        'После установки откройте новый терминал.'
    );
    process.exit(1);
  }
}

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 12000) err = err.slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(cmd + ' завершился с кодом ' + code + '\n' + err.slice(-1500)));
    });
  });
}

function domainOf(urlString) {
  const host = domainToUnicode(new URL(urlString).hostname);
  return host.replace(/^www\./i, '');
}

function norm(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./i, '');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return host + pathname;
  } catch (e) {
    return '';
  }
}

function sameSite(href, origin) {
  try {
    const a = new URL(href).hostname.replace(/^www\./i, '');
    const b = new URL(origin).hostname.replace(/^www\./i, '');
    return a === b;
  } catch (e) {
    return false;
  }
}

function classify(blob) {
  if (!blob || SKIP_RE.test(blob)) return null;
  const tests = [
    ['contacts', /контакт|contacts?/i, 5],
    ['article', /блог|стать[яиею]|новост|\bnews\b|\bblog\b|journal/i, 4],
    ['service', /услуг|\bservices?\b/i, 4],
    ['catalog', /каталог|catalog|магазин|\bshop\b|товар|\bproducts?\b|продукц/i, 5],
    ['catalog', /объект|проект|ваканс|portfolio|\bworks\b/i, 3]
  ];
  let best = null;
  let score = 0;
  for (const [type, re, sc] of tests) {
    if (re.test(blob) && sc > score) {
      best = type;
      score = sc;
    }
  }
  return best ? { type: best, score } : null;
}

function scrollPlan(type) {
  if (type === 'home') return 'end';
  if (type === 'catalog') return { desktop: 4, mobile: 4 };
  return { desktop: 7, mobile: 12 };
}

function blankError(facts) {
  const err = new Error(
    `Страница почти пустая (${facts.textLength} символов текста, адрес ${facts.url}).\n` +
      'Похоже на защиту от ботов или редирект. Попробовать: --headful, свой --ua, другой адрес.'
  );
  err.code = 'BLANK';
  return err;
}

// Курсор и подписи живут в странице. setBypassCSP нужен, чтобы строгий CSP
// не выкинул эту разметку. Нативный курсор в headless в кадр не попадает.
function installTour(isCompact) {
  const font = isCompact ? '22px' : '32px';
  const css =
    'html,html *{cursor:none !important}' +
    '#__tour-root{position:fixed;inset:0;z-index:2147483646;pointer-events:none}' +
    '#__tour-root .tip{position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;' +
    'filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}' +
    '#__tour-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
    'z-index:2147483646;pointer-events:none;background:rgba(12,12,12,.78);color:#fff;' +
    'font:600 ' +
    font +
    '/1.2 "Segoe UI",Arial,sans-serif;padding:10px 22px;border-radius:999px;opacity:0;' +
    'letter-spacing:.02em;white-space:nowrap}';

  const mount = () => {
    if (!document.head || !document.body) return;
    const prevStyle = document.getElementById('__tour-style');
    if (prevStyle) prevStyle.remove();
    const prev = document.getElementById('__tour-root');
    if (prev) prev.remove();
    const style = document.createElement('style');
    style.id = '__tour-style';
    style.textContent = css;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.id = '__tour-root';
    root.innerHTML =
      '<div class="tip"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">' +
      '<path d="M3 2.2L3.2 22.2L9.2 16.4L14.2 25.2L17.6 23.6L12.4 14.6L20.2 14.2Z" fill="#fff" stroke="#141414" stroke-width="1.6" stroke-linejoin="round"/>' +
      '</svg></div><div id="__tour-cap"></div>';
    document.body.appendChild(root);
  };

  const move = (x, y) => {
    const tip = document.querySelector('#__tour-root .tip');
    if (!tip) return;
    tip.style.transform = 'translate(' + Math.round(x - 3) + 'px,' + Math.round(y - 2) + 'px)';
  };

  const caption = (text) => {
    const el = document.getElementById('__tour-cap');
    if (!el) return;
    if (!text) {
      el.style.opacity = '0';
      el.textContent = '';
      return;
    }
    el.textContent = text;
    el.style.opacity = '1';
  };

  const scan = () => {
    const empty = {
      cookie: null,
      chat: null,
      chatClose: null,
      messengers: [],
      toTop: null,
      burger: null,
      nav: [],
      menuLinks: [],
      hovers: [],
      cards: []
    };
    if (!document.body) return empty;

    const acceptRe = /принять|согласен|согласна|accept|allow|разрешить|хорошо|понятно|^ok$/i;
    const avoidRe = /настрой|reject|decline|отклон|подробн|политик/i;
    const cookieRe = /cookie|consent|gdpr|куки|соглас/i;
    const chatRe = /chat|jivo|carrot|intercom|tidio|verbox|talkme|консультант/i;
    const messengerRe = /whatsapp|wa\.me|t\.me|telegram|viber|vk\.me|vk\.com\/im/i;
    const topRe = /to-?top|scroll-?top|up-?btn|back-to-top|наверх|вверх|scroll top/i;
    const burgerRe = /burger|hamburger|menu-toggle|nav-toggle|toggle-icon|меню|menu|навигац/i;
    const hoverRe = /btn|button|card|product|item|service|project/i;
    const cardRe = /card|product|item|project|service|news|post/i;

    const textOf = (el) =>
      (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

    const elements = [];
    const walk = (root) => {
      if (elements.length > 6000) return;
      for (const el of root.querySelectorAll('*')) {
        if (el.id === '__tour-root' || el.closest && el.closest('#__tour-root')) continue;
        elements.push(el);
        if (elements.length > 6000) return;
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);

    const boxOf = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return null;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
      return r;
    };

    const fixedOf = (el) => {
      let n = el;
      let depth = 0;
      while (n && n !== document.documentElement && depth < 8) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return true;
        n = n.parentElement;
        depth++;
      }
      return false;
    };

    const point = (r) => ({
      x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
      y: Math.round(Math.min(innerHeight - 8, Math.max(8, r.top + r.height / 2)))
    });

    let cookie = null;
    let chat = null;
    let chatClose = null;
    let toTop = null;
    let burger = null;
    const messengers = [];
    const nav = [];
    const menuLinks = [];
    const hovers = [];
    const cards = [];
    const seenNav = new Set();
    const seenMenu = new Set();
    const seenCards = new Set();

    for (const el of elements) {
      const r = boxOf(el);
      if (!r) continue;
      const text = textOf(el);
      const href = el.href || el.getAttribute('href') || '';
      const name = [el.id, String(el.className), el.getAttribute('aria-label') || '', href].join(' ');
      const tag = el.tagName;
      const clickable = tag === 'A' || tag === 'BUTTON' || el.getAttribute('role') === 'button';
      const fixed = fixedOf(el);

      const hrefPath = (() => {
        try {
          return new URL(href, location.href).pathname;
        } catch (e) {
          return '';
        }
      })();
      const leavesPage = tag === 'A' && hrefPath && hrefPath !== location.pathname;
      if (!cookie && clickable && text.length < 32 && acceptRe.test(text) && !avoidRe.test(text) && !leavesPage) {
        let host = el;
        let looks = false;
        for (let i = 0; i < 6 && host; i++) {
          const blob = [host.id, String(host.className), (host.innerText || '').slice(0, 180)].join(' ');
          if (cookieRe.test(blob)) looks = true;
          host = host.parentElement;
        }
        if (looks || fixed) cookie = point(r);
      }

      if (clickable && fixed && r.width < 90 && r.height < 90 && r.top > innerHeight * 0.35) {
        const closeRe = /закрыть|close|×|✕/i;
        if (!chatClose && closeRe.test(text + ' ' + name)) chatClose = point(r);
      }

      if (
        !chat &&
        clickable &&
        fixed &&
        r.width < 160 &&
        r.height < 160 &&
        r.width > 24 &&
        chatRe.test(name + ' ' + text) &&
        !messengerRe.test(href)
      ) {
        chat = { ...point(r), external: /^https?:/i.test(href) && !href.startsWith(location.origin) };
      }

      if (tag === 'A' && fixed && messengerRe.test(name) && messengers.length < 4 && r.width < 220) {
        messengers.push(point(r));
      }

      if (
        !toTop &&
        clickable &&
        fixed &&
        r.width < 120 &&
        r.height < 120 &&
        r.top > innerHeight * 0.45 &&
        topRe.test(name + ' ' + text)
      ) {
        toTop = point(r);
      }

      if (
        !burger &&
        r.top < 160 &&
        r.width < 88 &&
        r.height < 64 &&
        r.width > 16 &&
        burgerRe.test(name + ' ' + text)
      ) {
        burger = point(r);
      }

      if (tag === 'A' && href && r.top < 200 && r.height < 80 && r.width > 16 && text) {
        const key = href.split('#')[0];
        if (!seenNav.has(key)) {
          seenNav.add(key);
          const parent = el.parentElement;
          const hasPopup =
            el.getAttribute('aria-haspopup') === 'true' ||
            el.getAttribute('aria-expanded') != null ||
            !!(parent && parent.querySelector('ul, [class*="sub"], [class*="dropdown"]'));
          nav.push({ ...point(r), href, text, hasPopup });
        }
      }

      if (tag === 'A' && href && text && r.width > 20) {
        const key = href.split('#')[0];
        if (!seenMenu.has(key) && menuLinks.length < 30) {
          seenMenu.add(key);
          menuLinks.push({ ...point(r), href, text });
        }
      }

      if (
        clickable &&
        !fixed &&
        r.top > 90 &&
        r.bottom < innerHeight - 80 &&
        r.width > 36 &&
        r.height > 28 &&
        r.width < innerWidth * 0.7 &&
        hovers.length < 10 &&
        (hoverRe.test(name) || tag === 'BUTTON')
      ) {
        hovers.push({ ...point(r), key: (href || text || name).slice(0, 120) });
      }

      if (tag === 'A' && href && r.width > 100 && r.height > 64 && text.length > 1 && cards.length < 15) {
        const inHeader = r.top < 160 && r.height < 70;
        const looks =
          cardRe.test(name) ||
          !!el.querySelector('img, picture') ||
          !!(el.closest && el.closest('article, li'));
        if (!inHeader && looks && !seenCards.has(href)) {
          seenCards.add(href);
          cards.push({
            ...point(r),
            href,
            text,
            inView: r.top > 70 && r.bottom < innerHeight - 20,
            top: Math.round(r.top + window.scrollY)
          });
        }
      }
    }

    return { cookie, chat, chatClose, messengers, toTop, burger, nav, menuLinks, hovers, cards };
  };

  window.__tour = { mount, move, caption, scan };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

async function prepare(page, profile) {
  compact = profile.mobile;
  const ua = args.ua && args.ua !== true ? String(args.ua) : profile.mobile ? MOBILE_UA : DESKTOP_UA;
  await page.setBypassCSP(true);
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' });
  await page.setViewport({
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: 1,
    isMobile: profile.mobile,
    hasTouch: profile.mobile
  });
  page.setDefaultNavigationTimeout(60000);
  page.on('dialog', (d) => {
    d.dismiss().catch(() => {});
  });
  await page.evaluateOnNewDocument(installTour, profile.mobile);
}

async function settle(page) {
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  await page
    .evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    })
    .catch(() => {});
  await sleep(350);
}

async function ensureTour(page) {
  const has = await page.evaluate(() => !!(window.__tour && window.__tour.scan)).catch(() => false);
  if (!has) await page.evaluate(installTour, compact).catch(() => {});
  await page.evaluate(() => {
    window.__tour && window.__tour.mount();
    if (window.__tourNoHash) return;
    window.__tourNoHash = true;
    document.addEventListener(
      'click',
      (e) => {
        const a = e.target && e.target.closest && e.target.closest('a');
        if (a && a.getAttribute('href') === '#') e.preventDefault();
      },
      true
    );
  }).catch(() => {});
}

async function pageFacts(page) {
  return page.evaluate(() => {
    const text = (document.body && document.body.innerText ? document.body.innerText : '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      title: document.title,
      url: location.href,
      textLength: text.length,
      notFound: /404|не найден|not found/i.test(document.title)
    };
  });
}

async function scan(page) {
  await ensureTour(page);
  const data = await page.evaluate(() => (window.__tour ? window.__tour.scan() : null)).catch(() => null);
  return (
    data || {
      cookie: null,
      chat: null,
      chatClose: null,
      messengers: [],
      toTop: null,
      burger: null,
      nav: [],
      menuLinks: [],
      hovers: [],
      cards: []
    }
  );
}

async function metrics(page) {
  return page.evaluate(() => ({
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth
  }));
}

function clampPoint(x, y) {
  return {
    x: Math.max(8, Math.min(view.w - 8, x)),
    y: Math.max(8, Math.min(view.h - 8, y))
  };
}

async function placeCursor(page, x, y) {
  const p = clampPoint(x, y);
  cursor = p;
  await page.mouse.move(p.x, p.y).catch(() => {});
  await page.evaluate((px, py) => window.__tour && window.__tour.move(px, py), p.x, p.y).catch(() => {});
}

async function resetCursor(page) {
  const m = await metrics(page);
  view = { w: m.innerWidth, h: m.innerHeight };
  await placeCursor(page, m.innerWidth * 0.62, m.innerHeight * 0.38);
}

async function glide(page, x, y, ms = 450) {
  const to = clampPoint(x, y);
  const from = { x: cursor.x, y: cursor.y };
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const cx = from.x + (to.x - from.x) * e;
    const cy = from.y + (to.y - from.y) * e;
    cursor = { x: cx, y: cy };
    await page.mouse.move(cx, cy).catch(() => {});
    await page.evaluate((px, py) => window.__tour && window.__tour.move(px, py), cx, cy).catch(() => {});
    await sleep(ms / steps);
  }
}

async function showCaption(page, text) {
  await page.evaluate((t) => window.__tour && window.__tour.caption(t), text).catch(() => {});
}

async function clearCaption(page) {
  await showCaption(page, '');
}

async function clickAction(page, x, y, waitNav) {
  await glide(page, x, y, 460);
  await showCaption(page, 'Клик');
  await sleep(620);
  const before = page.url();
  await page.mouse.click(cursor.x, cursor.y, { delay: 40 }).catch(() => {});
  if (waitNav) {
    await page.waitForFunction((u) => location.href !== u, { timeout: 2500 }, before).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 6000 }).catch(() => {});
  }
  await sleep(280);
  await clearCaption(page);
  await ensureTour(page);
}

// Короткий scrollBy, а не один долгий цикл в странице: длинный evaluate
// забивает канал скринкаста, и Chrome перестаёт отдавать кадры.
async function unlockScroll(page) {
  await page
    .evaluate(() => {
      let tag = document.getElementById('__tour-scroll');
      if (!tag) {
        tag = document.createElement('style');
        tag.id = '__tour-scroll';
        (document.head || document.documentElement).appendChild(tag);
      }
      tag.textContent = 'html,body{scroll-behavior:auto !important}';
    })
    .catch(() => {});
}

async function scrollSegment(page, dist, pxPerSec = 700) {
  if (!dist) return;
  await unlockScroll(page);
  const step = pxPerSec > 1500 ? 160 : 48;
  const steps = Math.max(1, Math.round(Math.abs(dist) / step));
  const stepPx = dist / steps;
  const dt = Math.max(8, (Math.abs(stepPx) / pxPerSec) * 1000);
  let last = null;
  let stuck = 0;
  for (let i = 0; i < steps; i++) {
    const y = await page
      .evaluate((dy) => {
        window.scrollBy(0, dy);
        return window.scrollY;
      }, stepPx)
      .catch(() => null);
    if (y == null) break;
    if (last != null && Math.abs(y - last) < 1) {
      stuck += 1;
      if (stuck > 4) break;
    } else stuck = 0;
    last = y;
    await sleep(dt);
  }
}

async function holdScroll(page, y) {
  for (let i = 0; i < 8; i++) {
    const now = (await metrics(page)).scrollY;
    if (Math.abs(now - y) > 80) await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
    await sleep(100);
  }
}

async function scrollToY(page, target) {
  const m = await metrics(page);
  const dist = target - m.scrollY;
  if (Math.abs(dist) < 8) return;
  await showCaption(page, 'Свайп');
  await scrollSegment(page, dist, dist < 0 ? 3600 : 700);
  await clearCaption(page);
}

async function tryStep(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error('Шаг «' + name + '» пропущен: ' + e.message);
  }
}

async function opening(page, mobile) {
  await sleep(700);
  await tryStep('cookie', async () => {
    const s = await scan(page);
    if (!s.cookie) return;
    await clickAction(page, s.cookie.x, s.cookie.y, false);
    await sleep(400);
  });
  await tryStep('chat', async () => {
    const s = await scan(page);
    if (!s.chat) return;
    if (s.chat.external) {
      await glide(page, s.chat.x, s.chat.y, 400);
      if (!mobile) {
        await showCaption(page, 'Наведение');
        await sleep(600);
        await clearCaption(page);
      } else await sleep(500);
      return;
    }
    await clickAction(page, s.chat.x, s.chat.y, false);
    await sleep(900);
    const next = await scan(page);
    if (next.chatClose) await clickAction(page, next.chatClose.x, next.chatClose.y, false);
    else if (next.chat) await clickAction(page, next.chat.x, next.chat.y, false);
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
  });
  await tryStep('мессенджеры', async () => {
    const list = ((await scan(page)).messengers || []).slice(0, 2);
    for (const m of list) {
      await glide(page, m.x, m.y, 400);
      if (!mobile) {
        await showCaption(page, 'Наведение');
        await sleep(650);
        await clearCaption(page);
      } else await sleep(500);
    }
  });
}

async function clickBackToTop(page) {
  const found = (await scan(page)).toTop;
  if (!found) return;
  await clickAction(page, found.x, found.y, false);
  await page.waitForFunction(() => window.scrollY < 90, { timeout: 1600 }).catch(() => {});
  const y = await page.evaluate(() => window.scrollY).catch(() => 0);
  if (y > 140) await scrollToY(page, 0);
}

async function lookStage(page, seen, want) {
  return page.evaluate((seen, want) => {
    const seenSet = new Set(seen || []);
    const sliderRe = /slider|swiper|slick|splide|owl-carousel|carousel|dragscroll/i;
    const nextRe = /swiper-button-next|slick-next|splide__arrow--next|owl-next|slider__next|slider-next|carousel__next|arrow--next|arrow-next/i;
    const popupRe = /смотреть|галере|lightbox|fancybox|photoswipe|glightbox|увеличить/i;
    const skipBlob = /cookie|consent|mw-modal|mw-overlay/i;

    const visible = (el) => {
      if (!el || (el.closest && el.closest('#__tour-root'))) return null;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      if (r.bottom < 8 || r.top > innerHeight - 8 || r.right < 0 || r.left > innerWidth) return null;
      return r;
    };
    const point = (r) => ({
      x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
      y: Math.round(Math.min(innerHeight - 8, Math.max(8, r.top + r.height / 2)))
    });
    const keyOf = (el) => {
      const top = Math.round(el.getBoundingClientRect().top + window.scrollY);
      return (String(el.className).slice(0, 80) || el.tagName) + '@' + top;
    };

    if (want.slider) {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const r = visible(el);
        if (!r || r.width > 88 || r.height > 88 || r.top < 70) continue;
        const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
        const blob = [el.className, label].join(' ');
        if (!nextRe.test(blob) && !/^(next|след\.?|вперёд|вперед)$/i.test(label)) continue;
        const host = el.closest('[class*="slider"], [class*="swiper"], [class*="carousel"], [class*="slick"], [class*="splide"]') || el.parentElement;
        const key = 'next:' + keyOf(host || el);
        if (seenSet.has(key)) continue;
        return { kind: 'next', key, ...point(r) };
      }

      let best = null;
      let bestEl = null;
      let bestOverflow = 120;
      for (const el of document.querySelectorAll('div, ul, section')) {
        const blob = String(el.className || '');
        if (!sliderRe.test(blob) || skipBlob.test(blob)) continue;
        const r = visible(el);
        if (!r || r.width < 260 || r.height < 120 || r.height > innerHeight * 1.4) continue;
        const visibleH = Math.min(r.bottom, innerHeight - 8) - Math.max(r.top, 8);
        if (visibleH < 140) continue;
        if (r.top > innerHeight * 0.72 || r.bottom < innerHeight * 0.28) continue;
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow < bestOverflow) continue;
        const key = 'slider:' + keyOf(el);
        if (seenSet.has(key)) continue;
        bestOverflow = overflow;
        const startX = Math.round(Math.min(innerWidth - 36, Math.max(36, r.right - 90)));
        bestEl = el;
        best = {
          kind: 'slider',
          key,
          x: startX,
          y: Math.round(Math.min(innerHeight - 24, Math.max(24, r.top + r.height / 2))),
          dx: Math.round(Math.min(520, Math.max(220, r.width * 0.34)))
        };
      }
      if (bestEl) {
        document.querySelectorAll('[data-tour-nudge]').forEach((el) => el.removeAttribute('data-tour-nudge'));
        bestEl.setAttribute('data-tour-nudge', '1');
      }
      if (best) return best;
    }

    if (want.popup) {
      for (const el of document.querySelectorAll('a, button, [role="button"]')) {
        if (el.closest && el.closest('#__tour-root')) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.height > 120 || r.width > innerWidth * 0.55) continue;
        if (r.right < 8 || r.left > innerWidth - 8) continue;
        const inBand = r.top > 70 && r.top < innerHeight + 460;
        if (!inBand) continue;
        const href = el.getAttribute('href') || '';
        let leaves = false;
        try {
          if (el.tagName === 'A' && href && !href.startsWith('#')) {
            const path = new URL(href, location.href).pathname.replace(/\/+$/, '') || '/';
            const here = location.pathname.replace(/\/+$/, '') || '/';
            leaves = path !== here;
          }
        } catch (e) {
          leaves = false;
        }
        if (leaves) continue;
        const blob = [
          el.className,
          el.getAttribute('data-fancybox'),
          el.getAttribute('data-lightbox'),
          el.getAttribute('data-gallery'),
          el.getAttribute('aria-label'),
          (el.innerText || '').slice(0, 40)
        ].join(' ');
        if (skipBlob.test(blob) || /меню|cookie|понятно/i.test(blob)) continue;
        const fancy = el.hasAttribute('data-fancybox') || el.hasAttribute('data-lightbox') || el.hasAttribute('data-gallery');
        if (!fancy && !popupRe.test(blob)) continue;
        const key = 'popup:' + keyOf(el);
        if (seenSet.has(key)) continue;
        const lift = Math.max(0, Math.round(r.bottom - (innerHeight - 190)));
        return { kind: 'popup', key, lift, ...point(r) };
      }
    }
    return null;
  }, seen, want);
}

async function nudgeSlider(page, stage) {
  for (let n = 0; n < 2; n++) {
    const from = await page.evaluate(() => {
      const el = document.querySelector('[data-tour-nudge]');
      return el ? el.scrollLeft : 0;
    });
    await glide(page, stage.x, stage.y, 280);
    await showCaption(page, 'Свайп');
    await page.mouse.down().catch(() => {});
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const cx = stage.x - (stage.dx * i) / steps;
      cursor = { x: cx, y: stage.y };
      await page.mouse.move(cx, stage.y).catch(() => {});
      await page.evaluate((px, py) => window.__tour && window.__tour.move(px, py), cx, stage.y).catch(() => {});
      await sleep(36);
    }
    await page.mouse.up().catch(() => {});
    await sleep(220);
    await page.evaluate((dx, start) => {
      const el = document.querySelector('[data-tour-nudge]');
      if (el && el.scrollLeft < start + dx * 0.35) el.scrollLeft = start + dx;
    }, stage.dx, from);
    await sleep(280);
    await clearCaption(page);
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function overlayControls(page) {
  return page.evaluate(() => {
    const point = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
        y: Math.round(Math.min(innerHeight - 8, Math.max(8, r.top + r.height / 2)))
      };
    };
    const dialogs = [...document.querySelectorAll('[role="dialog"], .ui-dialog, .fancybox-container, .pswp, .glightbox-container')]
      .filter((el) => {
        if (el.closest && el.closest('#__tour-root')) return false;
        const blob = String(el.className || '') + ' ' + (el.getAttribute('aria-label') || '');
        if (/cookie|mw-overlay|mw-modal/i.test(blob)) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        return r.width > innerWidth * 0.35 && r.height > innerHeight * 0.35;
      });
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return null;
    let close = null;
    let next = null;
    for (const el of dialog.querySelectorAll('button, a, [role="button"]')) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (s.display === 'none' || r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const blob = [el.className, el.getAttribute('aria-label') || '', el.getAttribute('title') || '', (el.innerText || '').slice(0, 24)].join(' ');
      if (!close && /close|закрыть|closethick|✕|×/i.test(blob)) close = point(el);
      if (!next && /next|след|arrow-right|вперёд|вперед/i.test(blob)) next = point(el);
    }
    return { close, next };
  });
}

async function openPopup(page, stage) {
  const back = page.url();
  if (stage.lift > 12) {
    await scrollSegment(page, stage.lift);
    const fresh = await lookStage(page, [], { slider: false, popup: true }).catch(() => null);
    if (fresh && fresh.kind === 'popup') {
      stage.x = fresh.x;
      stage.y = fresh.y;
    } else {
      stage.y = Math.max(48, stage.y - stage.lift);
    }
  }
  const yBefore = (await metrics(page)).scrollY;
  await clickAction(page, stage.x, stage.y, false);
  await holdScroll(page, yBefore);
  await sleep(400);
  if (norm(page.url()) !== norm(back)) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await ensureTour(page);
    return;
  }
  let controls = null;
  for (let i = 0; i < 3 && !controls; i++) {
    controls = await overlayControls(page);
    if (!controls) await sleep(250);
  }
  if (controls) {
    for (let i = 0; i < 2 && controls.next; i++) {
      await clickAction(page, controls.next.x, controls.next.y, false);
      await sleep(450);
      controls = (await overlayControls(page)) || controls;
    }
    await sleep(500);
    if (controls.close) await clickAction(page, controls.close.x, controls.close.y, false);
    else await page.keyboard.press('Escape').catch(() => {});
    await holdScroll(page, yBefore);
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await sleep(250);
  await ensureTour(page);
}

async function showStages(page, seen, budget) {
  const want = { slider: budget.sliders > 0, popup: budget.popups > 0 };
  if (!want.slider && !want.popup) return budget;
  const stage = await lookStage(page, seen, want).catch(() => null);
  if (!stage || seen.includes(stage.key)) return budget;
  seen.push(stage.key);
  await clearCaption(page);
  if (stage.kind === 'popup') {
    budget.popups -= 1;
    await openPopup(page, stage);
  } else if (stage.kind === 'next') {
    budget.sliders -= 1;
    await clickAction(page, stage.x, stage.y, false);
    await sleep(420);
    await clickAction(page, stage.x, stage.y, false);
  } else {
    budget.sliders -= 1;
    if (budget.popups > 0) {
      const popup = await lookStage(page, seen, { slider: false, popup: true }).catch(() => null);
      if (popup && !seen.includes(popup.key)) {
        seen.push(popup.key);
        budget.popups -= 1;
        await openPopup(page, popup);
      }
    }
    await nudgeSlider(page, stage);
  }
  return budget;
}

function capY(m, item, mobile) {
  const end = Math.max(0, m.scrollHeight - m.innerHeight);
  if (item.type === 'home') return end;
  const screens = item.type === 'catalog' ? 4 : mobile ? 12 : 7;
  return Math.min(end, Math.max(0, (screens - 1) * m.innerHeight));
}

async function scrollItem(page, item, mobile) {
  const start = await metrics(page);
  if (capY(start, item, mobile) - start.scrollY < 12) return;
  let screens = 0;
  let hovers = 0;
  const used = new Set();
  const seenStages = [];
  const stageBudget = { sliders: 2, popups: 1 };
  const hoverBudget = mobile ? 0 : item.type === 'catalog' ? 3 : 4;
  await showCaption(page, 'Свайп');
  while (true) {
    const m = await metrics(page);
    const limit = capY(m, item, mobile);
    if (m.scrollY >= limit - 6) break;
    if (item.type === 'home' && screens >= 40) {
      console.error('Главная длиннее 40 экранов, дальше не кручу.');
      break;
    }
    const dist = Math.min(m.innerHeight * 0.85, limit - m.scrollY);
    if (dist < 12) break;
    const before = m.scrollY;
    await scrollSegment(page, dist);
    const after = await page.evaluate(() => window.scrollY).catch(() => before);
    if (after < before + 8) break;
    screens += dist / m.innerHeight;
    if (stageBudget.sliders > 0 || stageBudget.popups > 0) {
      await showStages(page, seenStages, stageBudget);
      await showCaption(page, 'Свайп');
    }
    if (hovers < hoverBudget) {
      await clearCaption(page);
      const h = ((await scan(page)).hovers || []).find((el) => el && el.key && !used.has(el.key));
      if (h) {
        await glide(page, h.x, h.y, 420);
        await showCaption(page, 'Наведение');
        await sleep(680);
        await clearCaption(page);
        used.add(h.key);
        hovers++;
      } else await sleep(420);
      await showCaption(page, 'Свайп');
    } else await sleep(420);
  }
  await clearCaption(page);
  await sleep(300);
}

function findLink(links, want) {
  return (links || []).find((l) => l && l.href && norm(l.href) === want);
}

async function locateHref(page, want) {
  return page.evaluate((want) => {
    const normHref = (href) => {
      try {
        const u = new URL(href, location.href);
        const host = u.hostname.replace(/^www\./i, '');
        const pathname = u.pathname.replace(/\/+$/, '') || '/';
        return host + pathname;
      } catch (e) {
        return '';
      }
    };
    let el = null;
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest && a.closest('#__tour-root')) continue;
      if (normHref(a.href) !== want) continue;
      const s = getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      el = a;
      const seen =
        r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      if (seen) break;
    }
    if (!el) return null;
    const before = el.getBoundingClientRect();
    const seen =
      before.top >= 0 &&
      before.bottom <= innerHeight &&
      before.left >= 0 &&
      before.right <= innerWidth;
    if (!seen) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
      y: Math.round(Math.min(innerHeight - 8, Math.max(8, r.top + r.height / 2)))
    };
  }, want);
}

async function openFromMenu(page, targetUrl, mobile) {
  const want = norm(targetUrl);
  if (norm(page.url()) === want) return { via: 'menu', url: page.url() };

  const here = await scan(page);
  if (!(here.nav && here.nav.length) && !here.burger) await scrollToY(page, 0);

  if (!mobile) {
    let s = await scan(page);
    let link = findLink(s.nav, want);
    if (!link) {
      for (const item of (s.nav || []).filter((n) => n.hasPopup).slice(0, 6)) {
        await glide(page, item.x, item.y, 420);
        await showCaption(page, 'Наведение');
        await sleep(700);
        await clearCaption(page);
        s = await scan(page);
        link = findLink([...(s.menuLinks || []), ...(s.nav || [])], want);
        if (link) break;
      }
    } else if (link.hasPopup) {
      await glide(page, link.x, link.y, 420);
      await showCaption(page, 'Наведение');
      await sleep(700);
      await clearCaption(page);
      const again = await scan(page);
      link = findLink(again.nav, want) || link;
    }
    if (link) {
      await clickAction(page, link.x, link.y, true);
      await settle(page);
      return { via: 'menu', url: page.url() };
    }
  } else {
    const s0 = await scan(page);
    if (s0.burger) {
      await clickAction(page, s0.burger.x, s0.burger.y, false);
      await sleep(800);
      const hit = await locateHref(page, want);
      if (hit) {
        await clickAction(page, hit.x, hit.y, true);
        await settle(page);
        return { via: 'menu', url: page.url() };
      }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    }
  }

  const loose = await locateHref(page, want);
  if (loose) {
    await clickAction(page, loose.x, loose.y, true);
    await settle(page);
    return { via: 'menu', url: page.url() };
  }

  console.error('Меню не нашёл, открываю адрес: ' + targetUrl);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page);
  return { via: 'address', url: page.url() };
}

async function clickCard(page, href) {
  const want = norm(href);
  let s = await scan(page);
  let cards = s.cards || [];
  let card = cards.find((c) => c.inView && norm(c.href) === want) || cards.find((c) => c.inView);
  if (!card && cards.length) {
    const planned = cards.find((c) => norm(c.href) === want) || cards[0];
    await scrollToY(page, Math.max(0, (planned.top || 0) - 160));
    await sleep(250);
    s = await scan(page);
    cards = s.cards || [];
    card = cards.find((c) => c.inView && norm(c.href) === want) || cards.find((c) => c.inView) || planned;
  }
  if (!card) {
    console.error('Карточку не нашёл, открываю адрес: ' + href);
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page);
    return { via: 'address', url: page.url() };
  }
  await clickAction(page, card.x, card.y, true);
  await settle(page);
  return { via: 'card', url: page.url(), href: card.href };
}

async function choicePlan(page) {
  return page.evaluate(() => {
    const groups = new Map();
    for (const input of document.querySelectorAll('input[type="radio"]')) {
      if (input.closest && input.closest('#__tour-root')) continue;
      const name = input.name || '';
      if (!name) continue;
      const label = input.id
        ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]')
        : input.closest('label');
      const el = label || input;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || r.width < 8 || r.height < 8) continue;
      const text = (el.innerText || input.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({
        text,
        checked: !!input.checked,
        x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
        y: Math.round(r.top + window.scrollY + r.height / 2)
      });
    }
    const picks = [];
    for (const [name, items] of groups) {
      if (items.length < 2) continue;
      const alt = items.find((it) => !it.checked) || items[1];
      if (!alt) continue;
      picks.push({ name, ...alt });
      if (picks.length >= 4) break;
    }
    let next = null;
    for (const el of document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')) {
      const t = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
      if (!/^далее$|^next$/i.test(t)) continue;
      if (/отправ|расч[её]т|заказ/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      next = {
        x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
        y: Math.round(r.top + window.scrollY + r.height / 2)
      };
      break;
    }
    const count = [...groups.values()].reduce((n, g) => n + g.length, 0);
    return { picks, next, count };
  });
}

async function clickDocPoint(page, docX, docY) {
  const m = await metrics(page);
  const target = Math.max(0, docY - m.innerHeight * 0.38);
  if (Math.abs(target - m.scrollY) > 36) await scrollToY(page, target);
  const now = await metrics(page);
  const y = docY - now.scrollY;
  if (y < 36 || y > now.innerHeight - 28) return false;
  await clickAction(page, docX, y, false);
  await sleep(650);
  return true;
}

async function demoChoices(page) {
  const used = new Set();
  let next = null;
  for (let i = 0; i < 4; i++) {
    const plan = await choicePlan(page).catch(() => null);
    if (!plan || plan.count < 6) return;
    next = plan.next || next;
    const pick = (plan.picks || []).find((p) => p && p.name && !used.has(p.name));
    if (!pick) break;
    used.add(pick.name);
    await clickDocPoint(page, pick.x, pick.y);
  }
  if (used.size < 2 || !next) return;
  const opened = await clickDocPoint(page, next.x, next.y);
  if (!opened) return;
  await sleep(900);
  const back = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, a')].find((n) =>
      /^назад$|^back$/i.test((n.innerText || '').replace(/\s+/g, ' ').trim())
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.top < 0 || r.bottom > innerHeight) return null;
    return {
      x: Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))),
      y: Math.round(Math.min(innerHeight - 8, Math.max(8, r.top + r.height / 2)))
    };
  });
  if (back) {
    await clickAction(page, back.x, back.y, false);
    await sleep(400);
  }
}

async function play(page, route, mobile) {
  for (const item of route.pages) {
    console.error('— ' + item.type + '  ' + item.url);
    try {
    await playItem(page, item, mobile);
    } catch (e) {
      console.error('Страница «' + item.type + '» прервана: ' + e.message.split('\n')[0]);
    }
  }
}

async function playItem(page, item, mobile) {
    if (item.entry === 'card') {
      if (item.parentUrl && norm(page.url()) !== norm(item.parentUrl)) {
        await openFromMenu(page, item.parentUrl, mobile);
      }
      const landed = await clickCard(page, item.url);
      item.via = landed.via;
      if (landed.href) item.url = landed.href;
    } else if (item.entry === 'menu-then-card') {
      await openFromMenu(page, item.parentUrl || item.url, mobile);
      await resetCursor(page);
      await sleep(500);
      const landed = await clickCard(page, item.url);
      item.via = landed.via;
      if (landed.href) item.url = landed.href;
    } else if (item.entry !== 'start') {
      const opened = await openFromMenu(page, item.url, mobile);
      item.via = opened.via;
    } else {
      item.via = 'start';
    }
    await settle(page);
    await ensureTour(page);
    await resetCursor(page);
    if (item.type === 'home') await opening(page, mobile);
    await sleep(item.type === 'home' ? 1100 : 1400);
    if (item.type !== 'home') await demoChoices(page);
    await scrollItem(page, item, mobile);
    if (item.type === 'home') await clickBackToTop(page);
    item.opened = page.url();
    item.title = await page.title().catch(() => item.title || '');
}

function startRecording(page, dir, profile) {
  const frames = [];
  let cdp = null;
  let n = 0;
  let writes = Promise.resolve();
  let lastFrame = Date.now();
  let stopped = false;
  let timer = null;
  const castOpts = {
    format: 'jpeg',
    quality: 80,
    maxWidth: profile.width,
    maxHeight: profile.height,
    everyNthFrame: 1
  };

  const bind = (session) => {
    session.on('Page.screencastFrame', (frame) => {
      lastFrame = Date.now();
      session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      const file = path.join(dir, 'f-' + String(n).padStart(6, '0') + '.jpg');
      n += 1;
      const data = Buffer.from(frame.data, 'base64');
      frames.push({ file, t: lastFrame });
      writes = writes.then(() => fs.promises.writeFile(file, data)).catch(() => {});
    });
  };

  const begin = async (session) => {
    bind(session);
    await session.send('Page.startScreencast', castOpts);
    lastFrame = Date.now();
  };

  return {
    async start() {
      cdp = await page.createCDPSession();
      await begin(cdp);
      timer = setInterval(() => {
        if (stopped || Date.now() - lastFrame < 2500) return;
        lastFrame = Date.now();
        cdp
          .send('Page.startScreencast', castOpts)
          .catch(async () => {
            cdp = await page.createCDPSession();
            await begin(cdp);
          })
          .catch(() => {});
      }, 2000);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
      await sleep(400);
      await writes.catch(() => {});
      return frames.slice();
    }
  };
}

async function encode(frames, profile, outFile, ffmpegBin) {
  if (!frames.length) throw new Error('Chrome не отдал кадры скринкаста. Нужен Chrome с поддержкой Page.startScreencast.');
  const evenW = profile.width + (profile.width % 2);
  const evenH = profile.height + (profile.height % 2);
  const list = path.join(path.dirname(frames[0].file), 'frames.txt');
  const listed = (file) => file.replace(/\\/g, '/');
  let body = 'ffconcat version 1.0\n';
  for (let i = 0; i < frames.length; i++) {
    const gap = i < frames.length - 1 ? (frames[i + 1].t - frames[i].t) / 1000 : 0.1;
    const dur = Math.max(0.02, Math.min(3, gap));
    body += "file '" + listed(frames[i].file) + "'\nduration " + dur.toFixed(3) + '\n';
  }
  body += "file '" + listed(frames[frames.length - 1].file) + "'\n";
  fs.writeFileSync(list, body);
  const vf =
    'scale=' +
    profile.width +
    ':' +
    profile.height +
    ':force_original_aspect_ratio=decrease,pad=' +
    evenW +
    ':' +
    evenH +
    ':(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p';
  await run(ffmpegBin, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    vf,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    outFile
  ]);
  const secs = ((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(1);
  console.error(path.basename(outFile) + '  ' + evenW + 'x' + evenH + '  ~' + secs + ' с');
}

async function recordPass(browser, route, profile, outFile, ffmpegBin) {
  const context = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await context.newPage();
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-'));
  const rec = startRecording(page, framesDir, profile);
  let playError = null;
  try {
    await prepare(page, profile);
    await page.goto(route.pages[0].url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page);
    const facts = await pageFacts(page);
    if (facts.textLength < 200) throw blankError(facts);
    await ensureTour(page);
    await resetCursor(page);
    await rec.start();
    try {
      await play(page, route, profile.mobile);
      await sleep(700);
    } catch (e) {
      playError = e;
    }
    const frames = await rec.stop();
    if (frames.length) await encode(frames, profile, outFile, ffmpegBin);
    if (playError) throw playError;
    if (!frames.length) throw new Error('Пустая запись: ' + outFile);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

function filterNav(links, origin) {
  const seen = new Set();
  const out = [];
  for (const link of links || []) {
    if (!link.href || !sameSite(link.href, origin)) continue;
    const blob = (link.text || '') + ' ' + link.href;
    if (SKIP_RE.test(blob)) continue;
    const key = norm(link.href);
    if (!key || seen.has(key)) continue;
    try {
      const pathname = new URL(link.href).pathname.replace(/\/+$/, '') || '/';
      if (pathname === '/') continue;
    } catch (e) {
      continue;
    }
    seen.add(key);
    out.push(link);
  }
  return out;
}

function bucketNav(links) {
  const buckets = { catalog: [], service: [], article: [], contacts: [] };
  links.forEach((link, index) => {
    const found = classify((link.text || '') + ' ' + link.href);
    if (!found || !buckets[found.type]) return;
    let depth = 9;
    try {
      depth = new URL(link.href).pathname.split('/').filter(Boolean).length;
    } catch (e) {
      /* оставляем глубину */
    }
    buckets[found.type].push({ ...link, score: found.score, depth, index });
  });
  return buckets;
}

function best(list) {
  if (!list || !list.length) return null;
  return list
    .slice()
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.index - b.index)[0];
}

function filled(facts, kind) {
  if (!facts || facts.notFound) return false;
  if (kind === 'contacts') return facts.textLength > 80;
  return facts.textLength > 350;
}

async function visit(page, href) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page);
  const facts = await pageFacts(page);
  const data = await scan(page);
  const cards = (data.cards || []).filter(
    (c) => c.href && norm(c.href) !== norm(facts.url) && !SKIP_RE.test(c.href + ' ' + (c.text || ''))
  );
  return { facts, cards };
}

async function firstFilledCard(page, cards) {
  for (const card of (cards || []).slice(0, 3)) {
    try {
      const v = await visit(page, card.href);
      if (v && filled(v.facts, 'product')) return { url: v.facts.url, title: v.facts.title };
    } catch (e) {
      console.error('Карточка не открылась: ' + card.href);
    }
  }
  return null;
}

async function resolveDetail(page, href, type) {
  let v;
  try {
    v = await visit(page, href);
  } catch (e) {
    console.error('Страница не открылась: ' + href);
    return null;
  }
  const thinList = v.facts.textLength < 700 && v.cards.length >= 3;
  if (thinList) {
    const child = await firstFilledCard(page, v.cards);
    if (!child) return null;
    return {
      type,
      url: child.url,
      title: child.title,
      parentUrl: v.facts.url,
      entry: 'menu-then-card',
      scroll: scrollPlan(type)
    };
  }
  if (!filled(v.facts, type)) return null;
  return {
    type,
    url: v.facts.url,
    title: v.facts.title,
    parentUrl: null,
    entry: 'menu',
    scroll: scrollPlan(type)
  };
}

async function discover(browser, startUrl) {
  const context = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await context.newPage();
  try {
    await prepare(page, DESKTOP);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page);
    const homeFacts = await pageFacts(page);
    if (homeFacts.textLength < 200) throw blankError(homeFacts);
    const origin = await page.evaluate(() => location.origin);
    const nav = filterNav((await scan(page)).nav, origin);
    const buckets = bucketNav(nav);
    const pages = [
      {
        type: 'home',
        url: homeFacts.url,
        title: homeFacts.title,
        parentUrl: null,
        entry: 'start',
        scroll: 'end'
      }
    ];

    const catalogLink = best(buckets.catalog);
    if (catalogLink) {
      try {
        const cat = await visit(page, catalogLink.href);
        if (cat && filled(cat.facts, 'catalog')) {
          pages.push({
            type: 'catalog',
            url: cat.facts.url,
            title: cat.facts.title,
            parentUrl: null,
            entry: 'menu',
            scroll: scrollPlan('catalog')
          });
          const product = await firstFilledCard(page, cat.cards);
          if (product) {
            pages.push({
              type: 'product',
              url: product.url,
              title: product.title,
              parentUrl: cat.facts.url,
              entry: 'card',
              scroll: scrollPlan('product')
            });
          }
        }
      } catch (e) {
        console.error('Каталог не открылся: ' + catalogLink.href);
      }
    }

    const serviceLink = best(buckets.service);
    if (serviceLink) {
      const svc = await resolveDetail(page, serviceLink.href, 'service');
      if (svc) pages.push(svc);
    }
    const articleLink = best(buckets.article);
    if (articleLink) {
      const art = await resolveDetail(page, articleLink.href, 'article');
      if (art) pages.push(art);
    }
    const contactLink = best(buckets.contacts);
    if (contactLink) {
      try {
        const c = await visit(page, contactLink.href);
        if (c && filled(c.facts, 'contacts')) {
          pages.push({
            type: 'contacts',
            url: c.facts.url,
            title: c.facts.title,
            parentUrl: null,
            entry: 'menu',
            scroll: scrollPlan('contacts')
          });
        }
      } catch (e) {
        console.error('Контакты не открылись: ' + contactLink.href);
      }
    }

    const order = ['home', 'catalog', 'product', 'service', 'article', 'contacts'];
    pages.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    return { url: startUrl, domain: domainOf(startUrl), pages: pages.slice(0, 6) };
  } finally {
    await context.close().catch(() => {});
  }
}

function manualRoute(raw, startUrl) {
  const list = String(raw)
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) {
    console.error('Пустой --pages');
    process.exit(1);
  }
  const pages = list.slice(0, 8).map((href, i) => {
    const abs = new URL(href, startUrl).href;
    let type = i === 0 ? 'home' : (classify(abs) || {}).type || 'page';
    try {
      const depth = new URL(abs).pathname.split('/').filter(Boolean).length;
      if (type === 'catalog' && depth > 1) type = 'page';
    } catch (e) {
      /* адрес без пути остаётся как есть */
    }
    return {
      type,
      url: abs,
      title: '',
      parentUrl: null,
      entry: i === 0 ? 'start' : 'menu',
      scroll: scrollPlan(type === 'page' ? 'service' : type)
    };
  });
  if (list.length > 8) console.error('В --pages больше восьми адресов, лишние не снимаю.');
  return { url: startUrl, domain: domainOf(startUrl), pages };
}

(async () => {
  if (!args.url || args.url === true) {
    console.error('Нужен --url');
    process.exit(1);
  }
  let startUrl;
  try {
    startUrl = new URL(args.url).href;
  } catch (e) {
    console.error('Некорректный --url');
    process.exit(1);
  }

  if (args.pages && args.pages !== true && args.plan) {
    console.log(JSON.stringify(manualRoute(args.pages, startUrl), null, 2));
    return;
  }

  const ffmpegBin = args.plan ? null : ensureFfmpeg();
  const puppeteer = requirePuppeteer();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !args.headful,
    defaultViewport: null,
    args: [
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-features=IsolateOrigins',
      '--lang=ru-RU',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run'
    ]
  });

  try {
    const route =
      args.pages && args.pages !== true ? manualRoute(args.pages, startUrl) : await discover(browser, startUrl);
    if (args.plan) {
      console.log(JSON.stringify(route, null, 2));
      return;
    }
    const outDir = args.out && args.out !== true ? path.resolve(args.out) : path.join(process.cwd(), 'cases', route.domain, 'video');
    fs.mkdirSync(outDir, { recursive: true });
    const routePath = path.join(outDir, 'route.json');
    fs.writeFileSync(routePath, JSON.stringify(route, null, 2));
    console.error(route.pages.map((p) => p.type + ': ' + p.url).join('\n'));
    await recordPass(browser, route, DESKTOP, path.join(outDir, DESKTOP.file), ffmpegBin);
    await recordPass(browser, route, MOBILE, path.join(outDir, MOBILE.file), ffmpegBin);
    fs.writeFileSync(routePath, JSON.stringify(route, null, 2));
    console.log(path.join(outDir, DESKTOP.file));
    console.log(path.join(outDir, MOBILE.file));
    console.log(routePath);
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(e && e.code === 'BLANK' ? 2 : 1);
});
