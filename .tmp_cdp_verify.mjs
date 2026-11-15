import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 9223;
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1280,720',
  '--no-sandbox',
  '--disable-gpu',
  'about:blank'
], { stdio: 'ignore' });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Timed out waiting for CDP');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  }
  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
    console.log('Saved screenshot:', path);
  }
  close() { this.ws.close(); }
}

try {
  const wsUrl = await getWsUrl();
  const cdp = new CDP(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'http://localhost:3000/necromancer.html' });
  await sleep(1600);

  await cdp.eval(`(() => {
    localStorage.clear();
    document.getElementById('btn-menu-play')?.click();
  })()`);
  await sleep(400);
  await cdp.eval(`(() => {
    const bNode = document.querySelector('.map-node--blessing.is-available');
    if (bNode) bNode.click();
  })()`);
  await sleep(300);
  await cdp.eval(`(() => {
    const opt = document.querySelector('.blessing-choice-card, .blessing-card, #blessing-choices-grid > button, #blessing-choices-grid > div, [data-blessing-id]');
    if (opt) opt.click();
  })()`);
  await sleep(300);
  await cdp.eval(`(() => {
    const node = document.querySelector('.map-node.is-available');
    if (node) node.click();
  })()`);
  await sleep(700);

  const baseSnapJson = await cdp.eval(`localStorage.getItem('necro_saved_run_v1')`);

  async function testEncounter(tag, enemiesSpec, vw = 1280, vh = 720) {
    await cdp.send('Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(300);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`(() => {
      const snap = JSON.parse(${JSON.stringify(baseSnapJson)});
      snap.run.screen = 'battle';
      snap.battle.enemies = ${JSON.stringify(enemiesSpec)};
      snap.battle.enemy = snap.battle.enemies[0];
      snap.battle.targetEnemyUid = snap.battle.enemies[0].uid;
      localStorage.setItem('necro_saved_run_v1', JSON.stringify(snap));
    })()`);
    await cdp.send('Page.navigate', { url: 'http://localhost:3000/necromancer.html' });
    await sleep(1400);
    await cdp.eval(`(() => {
      document.getElementById('btn-menu-continue')?.click();
    })()`);
    await sleep(800);

    const metrics = await cdp.eval(`(() => {
      const pWrap = document.getElementById('player-figure-wrap');
      const eWraps = [...document.querySelectorAll('.enemy-figure-wrap')];
      const huds = [...document.querySelectorAll('.unit-hud')];
      const cards = [...document.querySelectorAll('.hand-zone .card')];
      const minCardTop = cards.length ? Math.min(...cards.map(c => c.getBoundingClientRect().top)) : null;
      const maxHudBottom = huds.length ? Math.max(...huds.map(h => h.getBoundingClientRect().bottom)) : null;
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        playerBottom: pWrap ? Math.round(pWrap.getBoundingClientRect().bottom) : null,
        playerPctY: pWrap ? +(pWrap.getBoundingClientRect().bottom / window.innerHeight * 100).toFixed(1) : null,
        enemyBottoms: eWraps.map(e => Math.round(e.getBoundingClientRect().bottom)),
        enemyPctYs: eWraps.map(e => +(e.getBoundingClientRect().bottom / window.innerHeight * 100).toFixed(1)),
        maxHudBottom: maxHudBottom ? Math.round(maxHudBottom) : null,
        minCardTop: minCardTop ? Math.round(minCardTop) : null,
        clearancePx: (minCardTop && maxHudBottom) ? Math.round(minCardTop - maxHudBottom) : null
      };
    })()`);
    console.log(tag, JSON.stringify(metrics));
    await cdp.screenshot(`.tmp_verify_${tag}.png`);
  }

  const mkEnemy = (uid, id, name, img, hp, dmg) => ({
    uid, id, name, roleTitle: '', tier: 1, maxHp: hp, hp, armor: 0, fury: 0, weak: 0,
    blight: 0, vulnerable: 0, slow: 0, agonyShackles: 0, retributionCurse: 0, preserveBlightTurns: 0,
    isBoss: false, isElite: false, isEthereal: false, image: img, fallbackImage: 'public/' + img,
    intent: { id: 'atk', name: 'Удар', type: 'attack', damage: dmg, armor: 0, furyGain: 0 }
  });

  await testEncounter('Ref_2enemies', [
    mkEnemy('e0', 'cursed_warrior', 'Проклятый воин', 'assets/skeleton.png', 27, 6),
    mkEnemy('e1', 'skeleton_archer', 'Скелет-лучник', 'assets/enemy-skeleton-archer.png', 21, 8)
  ]);

  await testEncounter('C_3enemies', [
    mkEnemy('e0', 'cursed_warrior', 'Проклятый воин', 'assets/skeleton.png', 28, 6),
    mkEnemy('e1', 'skeleton_archer', 'Скелет-лучник', 'assets/enemy-skeleton-archer.png', 18, 5),
    mkEnemy('e2', 'infected_zombie', 'Заражённый зомби', 'assets/enemy-plague-ghoul.png', 33, 6)
  ]);

  await testEncounter('D_mobile_3enemies', [
    mkEnemy('e0', 'cursed_warrior', 'Проклятый воин', 'assets/skeleton.png', 28, 6),
    mkEnemy('e1', 'skeleton_archer', 'Скелет-лучник', 'assets/enemy-skeleton-archer.png', 18, 5),
    mkEnemy('e2', 'infected_zombie', 'Заражённый зомби', 'assets/enemy-plague-ghoul.png', 33, 6)
  ], 844, 390);

  cdp.close();
} finally {
  chrome.kill('SIGTERM');
}
