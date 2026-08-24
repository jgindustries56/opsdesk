const { chromium } = require('playwright');

// Target under test. Defaults to the standalone file; once Switchboard is served by
// OpsDesk, run against the live local server instead:
//   SB_TARGET=http://localhost:3000/switchboard.html node test/switchboard.js
const TARGET = process.env.SB_TARGET || 'file://' + require('path').resolve(__dirname, 'switchboard.html');

const results = { pass: [], fail: [], consoleErrors: [] };
function ok(n, d) { results.pass.push(n + (d ? ' — ' + d : '')); }
function bad(n, d) { results.fail.push(n + (d ? ' — ' + d : '')); }
async function check(name, fn) {
  try { const d = await fn(); ok(name, d); }
  catch (e) { bad(name, e.message); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  page.on('console', m => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
  page.on('pageerror', e => results.consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(TARGET);
  await page.waitForTimeout(500);

  // ---------- 1. all nav pages render ----------
  for (const p of ['overview', 'inbox', 'payments', 'contacts', 'settings']) {
    await check('nav → ' + p, async () => {
      await page.click(`[data-action="nav"][data-page="${p}"]`);
      await page.waitForTimeout(150);
      const h1 = await page.textContent('.page-head h1');
      const count = await page.locator('#view *').count();
      if (count < 20) throw new Error('page rendered near-empty (' + count + ' nodes)');
      return `h1="${h1}", ${count} nodes`;
    });
  }

  // ---------- 2. every data-action button on every page is wired ----------
  await check('no unwired data-action values', async () => {
    const known = await page.evaluate(() => Object.keys(window.__sb.actions));
    const found = new Set();
    for (const p of ['overview','inbox','payments','contacts','settings']) {
      await page.click(`[data-action="nav"][data-page="${p}"]`);
      await page.waitForTimeout(120);
      const acts = await page.$$eval('[data-action]', els => els.map(e => e.dataset.action));
      acts.forEach(a => found.add(a));
    }
    const unwired = [...found].filter(a => !known.includes(a));
    if (unwired.length) throw new Error('unwired: ' + unwired.join(', '));
    return found.size + ' distinct actions, all wired';
  });

  // ---------- 3. quick capture: validation then success ----------
  await page.click('[data-action="nav"][data-page="overview"]');
  await page.waitForTimeout(150);

  await check('capture rejects empty name', async () => {
    await page.click('[data-action="save-capture"][data-prefix="qc"]');
    await page.waitForTimeout(200);
    const invalid = await page.locator('#qc-nameF.invalid').count();
    const toastTxt = await page.locator('.toast.err .tt').first().textContent().catch(() => '');
    if (!invalid) throw new Error('no invalid state applied');
    return 'field marked invalid, toast="' + toastTxt + '"';
  });

  await check('capture creates message + contact', async () => {
    const before = await page.evaluate(() => ({ m: window.__sb.state.messages.length, c: window.__sb.state.contacts.length }));
    await page.fill('#qc-name', 'Test Customer');
    await page.fill('#qc-phone', '(678) 555-0000');
    await page.selectOption('#qc-chan', 'text');
    await page.fill('#qc-note', 'Automated test entry');
    await page.click('[data-action="save-capture"][data-prefix="qc"]');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ m: window.__sb.state.messages.length, c: window.__sb.state.contacts.length }));
    if (after.m !== before.m + 1) throw new Error('message not added');
    if (after.c !== before.c + 1) throw new Error('contact not added');
    return `messages ${before.m}→${after.m}, contacts ${before.c}→${after.c}`;
  });

  // ---------- 4. attention queue responds when acted on ----------
  // Reminding an overdue invoice does not remove it from the queue anymore —
  // it is still genuinely overdue against a real due date — but the
  // goal-gradient "cleared today" counter should register the action.
  await check('attention queue responds to action', async () => {
    const before = await page.evaluate(() => window.__sb.clearProgress().done);
    const items = await page.locator('.attention-item').count();
    if (!items) throw new Error('no attention items seeded');
    await page.click('.attention-item [data-action="remind-invoice"]');
    await page.waitForTimeout(200);
    const modalOpen = await page.locator('.modal').count();
    if (!modalOpen) throw new Error('remind modal did not open');
    await page.click('[data-action="confirm-remind"]');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__sb.clearProgress().done);
    if (after <= before) throw new Error(`cleared-today did not increase (${before}→${after})`);
    return `cleared-today ${before}→${after}`;
  });

  // ---------- 5. inbox filters ----------
  await page.click('[data-action="nav"][data-page="inbox"]');
  await page.waitForTimeout(150);
  for (const f of ['call','text','email','walkin','unread','missed','all']) {
    await check('inbox filter: ' + f, async () => {
      await page.click(`[data-action="inbox-filter"][data-filter="${f}"]`);
      await page.waitForTimeout(120);
      const rows = await page.locator('.inbox-item').count();
      const empty = await page.locator('.empty-state').count();
      if (rows === 0 && empty === 0) throw new Error('zero rows and no empty state');
      return rows + ' rows';
    });
  }

  await check('mark all read clears badge', async () => {
    await page.click('[data-action="inbox-filter"][data-filter="all"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="mark-all-read"]');
    await page.waitForTimeout(200);
    const badge = await page.locator('.nav-count').count();
    if (badge !== 0) throw new Error('badge still present');
    return 'badge removed';
  });

  await check('reply flow sends and closes thread', async () => {
    await page.evaluate(() => { window.__sb.state.messages[0].status = 'new'; window.__sb.state.messages[0].unread = true; });
    await page.click('[data-action="inbox-filter"][data-filter="all"]');
    await page.waitForTimeout(150);
    await page.click('[data-action="reply"]');
    await page.waitForTimeout(200);
    const body = await page.inputValue('#rp-body');
    if (!body.trim()) throw new Error('reply template empty');
    await page.click('[data-action="confirm-reply"]');
    await page.waitForTimeout(250);
    const stat = await page.evaluate(() => window.__sb.state.messages[0].status);
    if (stat !== 'done') throw new Error('status is ' + stat);
    return 'template prefilled (' + body.length + ' chars), status→done';
  });

  await check('callback flow logs outcome', async () => {
    await page.evaluate(() => { const m = window.__sb.state.messages.find(x => x.status !== 'missed'); m.status = 'missed'; });
    await page.click('[data-action="inbox-filter"][data-filter="missed"]');
    await page.waitForTimeout(150);
    await page.click('[data-action="call-back"]');
    await page.waitForTimeout(200);
    await page.selectOption('#cb-outcome', { index: 1 });
    await page.click('[data-action="confirm-callback"]');
    await page.waitForTimeout(250);
    const anyMissed = await page.evaluate(() => window.__sb.state.messages.filter(m => m.status === 'missed').length);
    return 'remaining missed: ' + anyMissed;
  });

  // ---------- 6. payments ----------
  await page.click('[data-action="nav"][data-page="payments"]');
  await page.waitForTimeout(150);
  for (const f of ['overdue','sent','draft','paid','all']) {
    await check('invoice filter: ' + f, async () => {
      await page.click(`[data-action="invoice-filter"][data-filter="${f}"]`);
      await page.waitForTimeout(120);
      const rows = await page.locator('table.data tbody tr').count();
      return rows + ' rows';
    });
  }

  await check('new invoice rejects bad amount', async () => {
    await page.click('[data-action="new-invoice"]');
    await page.waitForTimeout(200);
    await page.fill('#ni-amt', 'abc');
    await page.click('[data-action="create-invoice"][data-mode="send"]');
    await page.waitForTimeout(200);
    const invalid = await page.locator('#ni-amtF.invalid').count();
    if (!invalid) throw new Error('accepted non-numeric amount');
    return 'rejected "abc"';
  });

  await check('new invoice creates record', async () => {
    const before = await page.evaluate(() => window.__sb.state.invoices.length);
    await page.fill('#ni-amt', '425');
    await page.fill('#ni-desc', 'Automated test line item');
    await page.click('[data-action="create-invoice"][data-mode="send"]');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => window.__sb.state.invoices.length);
    if (after !== before + 1) throw new Error('not created');
    return `invoices ${before}→${after}`;
  });

  await check('mark paid updates AR + contact LTV', async () => {
    await page.click('[data-action="invoice-filter"][data-filter="all"]');
    await page.waitForTimeout(150);
    const arBefore = await page.evaluate(() => window.__sb.state.summary.outstanding_cents);
    await page.click('[data-action="mark-paid"]');
    await page.waitForTimeout(200);
    await page.click('[data-action="confirm-paid"]');
    await page.waitForTimeout(400);
    const arAfter = await page.evaluate(() => window.__sb.state.summary.outstanding_cents);
    if (arAfter >= arBefore) throw new Error(`AR did not drop (${arBefore}→${arAfter})`);
    return `AR ${arBefore}c→${arAfter}c`;
  });

  await check('aging buckets recompute', async () => {
    const vals = await page.$$eval('.aging-row .val', els => els.map(e => e.textContent));
    if (vals.length !== 4) throw new Error('expected 4 buckets, got ' + vals.length);
    return vals.join(' / ');
  });

  await check('bulk remind-all works', async () => {
    await page.evaluate(() => { window.__sb.state.invoices[0].status='overdue'; window.__sb.state.invoices[0].days=45; window.__sb.actions['noop'](); });
    await page.click('[data-action="nav"][data-page="payments"]');
    await page.waitForTimeout(150);
    await page.click('[data-action="remind-all"]');
    await page.waitForTimeout(200);
    const hasConfirm = await page.locator('[data-action="confirm-remind-all"]').count();
    if (!hasConfirm) throw new Error('confirm button missing');
    await page.click('[data-action="confirm-remind-all"]');
    await page.waitForTimeout(250);
    const od = await page.evaluate(() => window.__sb.state.invoices.filter(i=>i.status==='overdue').length);
    if (od !== 0) throw new Error(od + ' still overdue');
    return 'all overdue cleared';
  });

  await check('CSV export renders preview', async () => {
    await page.click('[data-action="export-csv"]');
    await page.waitForTimeout(250);
    const pre = await page.textContent('.modal pre');
    if (!pre.includes('Invoice') || pre.length < 100) throw new Error('preview too short');
    await page.click('[data-action="close-modal"]');
    return pre.split('\n').length + ' CSV rows';
  });

  // ---------- 7. contacts ----------
  await page.click('[data-action="nav"][data-page="contacts"]');
  await page.waitForTimeout(150);
  for (const s of ['value','stale','recent']) {
    await check('contact sort: ' + s, async () => {
      await page.click(`[data-action="contact-sort"][data-sort="${s}"]`);
      await page.waitForTimeout(120);
      const first = await page.textContent('table.data tbody tr:first-child .who');
      return 'top = ' + first.trim().split('\n')[0];
    });
  }

  await check('contact history modal shows timeline', async () => {
    await page.click('[data-action="view-contact"]');
    await page.waitForTimeout(250);
    const stats = await page.locator('.cd-stat').count();
    const tl = await page.locator('.tl-item, .empty-state').count();
    if (stats !== 3) throw new Error('expected 3 stats, got ' + stats);
    await page.click('[data-action="close-modal"]');
    return stats + ' stats, ' + tl + ' timeline entries';
  });

  await check('add contact works', async () => {
    const before = await page.evaluate(() => window.__sb.state.contacts.length);
    await page.click('[data-action="new-contact"]');
    await page.waitForTimeout(200);
    await page.click('[data-action="create-contact"]');
    await page.waitForTimeout(200);
    const stillOpen = await page.locator('#nc-nameF.invalid').count();
    if (!stillOpen) throw new Error('accepted empty name');
    await page.fill('#nc-name', 'QA Tester');
    await page.fill('#nc-vehicle', '2022 Test Vehicle');
    await page.click('[data-action="create-contact"]');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => window.__sb.state.contacts.length);
    if (after !== before + 1) throw new Error('not added');
    return `validated empty, then ${before}→${after}`;
  });

  // ---------- 8. settings ----------
  await page.click('[data-action="nav"][data-page="settings"]');
  await page.waitForTimeout(150);

  // Real (server-saved) settings live in state.serverSettings; branding/module
  // toggles are a cosmetic-only preview in state.settings. Read whichever the
  // key actually lives in.
  await check('all toggles flip state', async () => {
    const toggles = await page.locator('.toggle').count();
    const changed = [];
    for (let i = 0; i < toggles; i++) {
      const t = page.locator('.toggle').nth(i);
      const key = await t.getAttribute('data-key');
      const before = await page.evaluate(k => (k in window.__sb.state.settings ? window.__sb.state.settings[k] : window.__sb.state.serverSettings[k]), key);
      await t.click();
      await page.waitForTimeout(300);
      const after = await page.evaluate(k => (k in window.__sb.state.settings ? window.__sb.state.settings[k] : window.__sb.state.serverSettings[k]), key);
      if (before === after) throw new Error(key + ' did not change');
      changed.push(key);
    }
    return toggles + ' toggles all flipped';
  });

  await check('threshold sliders update state + label', async () => {
    const keys = await page.$$eval('[data-action="threshold"]', els => els.map(e => e.dataset.key));
    for (const k of keys) {
      const el = page.locator(`[data-action="threshold"][data-key="${k}"]`);
      await el.evaluate(e => { e.value = e.max; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForTimeout(300);
      const v = await page.evaluate(kk => window.__sb.state.serverSettings[kk], k);
      const lbl = await page.textContent('#v-' + k);
      if (String(v) !== lbl.replace(/[^0-9]/g, '')) throw new Error(k + ' label/state mismatch: ' + v + ' vs ' + lbl);
    }
    return keys.length + ' sliders in sync';
  });

  await check('threshold change re-evaluates attention queue', async () => {
    await page.evaluate(() => {
      window.__sb.state.invoices.forEach(i => { if (i.status==='paid') { i.status='overdue'; i.days=40; } });
    });
    await page.click('[data-action="nav"][data-page="overview"]');
    await page.waitForTimeout(200);
    const items = await page.locator('.attention-item').count();
    if (items === 0) throw new Error('queue empty after seeding overdue');
    return items + ' items now surfaced';
  });

  await page.click('[data-action="nav"][data-page="settings"]');
  await page.waitForTimeout(150);

  await check('accent swatches re-theme app', async () => {
    await page.click('[data-action="set-accent"][data-color="#c4291d"]');
    await page.waitForTimeout(200);
    const brand = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());
    if (brand.toLowerCase() !== '#c4291d') throw new Error('--brand is ' + brand);
    return '--brand → ' + brand;
  });

  await check('danger zone requires exact name', async () => {
    await page.click('[data-action="wipe-tenant"]');
    await page.waitForTimeout(200);
    await page.fill('#wipe-confirm', 'wrong name');
    await page.click('[data-action="confirm-wipe"]');
    await page.waitForTimeout(200);
    const stillOpen = await page.locator('.modal').count();
    if (!stillOpen) throw new Error('proceeded with wrong name');
    await page.click('[data-action="close-modal"]');
    return 'blocked mismatched confirmation';
  });

  // ---------- 9. tenant switch ----------
  await check('tenant switch re-themes + renames', async () => {
    await page.click('[data-action="switch-tenant"]');
    await page.waitForTimeout(200);
    await page.click('[data-action="pick-tenant"][data-key="amberlyn"]');
    await page.waitForTimeout(250);
    const name = await page.textContent('#tenantName');
    const brand = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());
    if (!name.includes('Amberlyn')) throw new Error('name is ' + name);
    return name + ', --brand ' + brand;
  });

  // ---------- 10. search ----------
  await check('search returns matches', async () => {
    await page.fill('#search', 'brennan');
    await page.waitForTimeout(500);
    const hits = await page.locator('.search-results .sr').count();
    if (hits === 0) throw new Error('no hits for "brennan"');
    return hits + ' hits';
  });

  await check('search handles no matches', async () => {
    await page.fill('#search', 'zzzzqqq');
    await page.waitForTimeout(250);
    const empty = await page.locator('.search-results .empty').count();
    if (!empty) throw new Error('no empty state shown');
    await page.fill('#search', '');
    return 'empty state shown';
  });

  await check('search result navigates', async () => {
    await page.fill('#search', 'okafor');
    await page.waitForTimeout(500);
    await page.click('.search-results .sr');
    await page.waitForTimeout(250);
    const modalOrPage = await page.locator('.modal, .page-head h1').count();
    if (!modalOrPage) throw new Error('nothing happened');
    await page.keyboard.press('Escape');
    return 'navigated / opened detail';
  });

  // ---------- 11. range selector ----------
  await check('range selector switches', async () => {
    await page.click('[data-action="range"][data-range="90"]');
    await page.waitForTimeout(150);
    const active = await page.getAttribute('[data-action="range"][data-range="90"]', 'class');
    if (!active.includes('active')) throw new Error('not marked active');
    return '90d active';
  });

  // ---------- 12. modal dismissal ----------
  await check('modal closes on Escape', async () => {
    await page.click('[data-action="switch-tenant"]');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const open = await page.locator('.modal').count();
    if (open) throw new Error('still open');
    return 'closed';
  });

  // ---------- 13. dark mode ----------
  await check('dark mode renders with distinct tokens', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(250);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const ink = await page.evaluate(() => getComputedStyle(document.body).color);
    if (bg === 'rgba(0, 0, 0, 0)') throw new Error('transparent body background');
    await page.screenshot({ path: '/home/claude/shot-dark.png', fullPage: false });
    await page.emulateMedia({ colorScheme: 'light' });
    return 'bg ' + bg + ', ink ' + ink;
  });

  // ---------- 14. responsive ----------
  await check('no horizontal page overflow at 1440 / 900 / 420', async () => {
    const bad = [];
    for (const w of [1440, 900, 420]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(200);
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (over) bad.push(w);
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    if (bad.length) throw new Error('overflow at: ' + bad.join(', '));
    return 'clean at all three widths';
  });

  // ================= CYCLE 1 ADDITIONS =================

  await page.reload();
  await page.waitForTimeout(400);

  // ---------- goal gradient ----------
  await check('goal gradient ring renders', async () => {
    const ring = await page.locator('.ring-fg').count();
    if (!ring) throw new Error('no ring element');
    const label = await page.textContent('.ring-label');
    if (!/cleared/.test(label)) throw new Error('label missing: ' + label);
    return label.replace(/\s+/g, ' ').trim().slice(0, 46);
  });

  await check('ring advances when an item is cleared', async () => {
    // Earlier tests may have paid off the only seeded overdue invoice —
    // persisted state, unlike the old in-memory demo, doesn't reset on
    // reload. Guarantee a fresh one exists so this test is self-sufficient.
    await page.evaluate(async () => {
      const contacts = await (await fetch('/api/contacts')).json();
      await fetch('/api/invoices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contacts[0].id, status: 'Sent',
          issue_date: '2020-01-01', due_date: '2020-01-15',
          items: [{ description: 'Ring-advance test fixture', qty: 1, unit_price: 100 }],
        }),
      });
    });
    await page.reload();
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__sb.clearProgress());
    await page.click('.attention-item [data-action="remind-invoice"]');
    await page.waitForTimeout(200);
    await page.click('[data-action="confirm-remind"]');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__sb.clearProgress());
    if (after.done !== before.done + 1) throw new Error(`done ${before.done}→${after.done}`);
    if (!(after.pct > before.pct)) throw new Error('pct did not increase');
    const off = await page.getAttribute('.ring-fg', 'stroke-dashoffset');
    return `done ${before.done}→${after.done}, pct ${(before.pct*100).toFixed(0)}%→${(after.pct*100).toFixed(0)}%, offset ${off}`;
  });

  // ---------- temporal landmark ----------
  await check('temporal landmark banner adapts to date', async () => {
    const txt = await page.textContent('.landmark .lm-text');
    const lm = await page.evaluate(() => window.__sb.landmark());
    if (!txt || txt.length < 20) throw new Error('banner empty');
    if (!lm.ico) throw new Error('no icon');
    return txt.replace(/\s+/g, ' ').trim().slice(0, 58) + '…';
  });

  // ---------- implementation intentions ----------
  await check('schedule flow commits a when-then', async () => {
    const before = await page.evaluate(() => window.__sb.state.scheduled.length);
    await page.click('.attention-item [data-action="schedule-item"]');
    await page.waitForTimeout(220);
    const opts = await page.locator('.trigger-opt').count();
    if (opts < 3) throw new Error('expected trigger options, got ' + opts);
    await page.locator('.trigger-opt').nth(1).click();
    await page.waitForTimeout(120);
    const sel = await page.locator('.trigger-opt.sel').count();
    if (sel !== 1) throw new Error('selection not exclusive: ' + sel);
    await page.click('[data-action="confirm-schedule"]');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__sb.state.scheduled.length);
    if (after !== before + 1) throw new Error('not committed');
    const shown = await page.locator('.sched-item').count();
    if (!shown) throw new Error('scheduled panel not rendered');
    const trig = await page.textContent('.sched-when');
    return `${opts} triggers, committed "${trig}", panel shows ${shown}`;
  });

  await check('scheduled item can be executed', async () => {
    const before = await page.evaluate(() => window.__sb.state.scheduled.length);
    if (!before) throw new Error('nothing scheduled to run');
    await page.click('[data-action="do-scheduled"]');
    await page.waitForTimeout(300);
    const modal = await page.locator('.modal').count();
    if (modal) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    const after = await page.evaluate(() => window.__sb.state.scheduled.length);
    if (after !== before - 1) throw new Error(`queue ${before}→${after}`);
    return `executed, scheduled ${before}→${after}` + (modal ? ' (opened target action)' : '');
  });

  await check('scheduled item can be dropped', async () => {
    await page.click('.attention-item [data-action="schedule-item"]');
    await page.waitForTimeout(200);
    await page.click('[data-action="confirm-schedule"]');
    await page.waitForTimeout(250);
    const before = await page.evaluate(() => window.__sb.state.scheduled.length);
    await page.click('[data-action="drop-scheduled"]');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => window.__sb.state.scheduled.length);
    if (after !== before - 1) throw new Error('not dropped');
    return `scheduled ${before}→${after}`;
  });

  // ---------- peak-end: cleared state ----------
  // The queue is now server-fetched (state.queue / state.progress), not
  // derived from state.invoices/messages — simulate "everything cleared" by
  // setting those directly, the same fields render() actually reads.
  await check('cleared state renders when queue empties', async () => {
    await page.evaluate(() => {
      const s = window.__sb.state;
      s.queue = [];
      s.messages.forEach(m => { m.status = 'done'; m.unread = false; });
      s.progress = { done: 6, total: 6, remaining: 0, pct: 1 };
    });
    await page.click('[data-action="nav"][data-page="settings"]');
    await page.waitForTimeout(120);
    await page.click('[data-action="nav"][data-page="overview"]');
    await page.waitForTimeout(300);
    const hero = await page.locator('.cleared-hero').count();
    if (!hero) throw new Error('no cleared hero');
    const tally = await page.locator('.cleared-tally .ct').count();
    if (tally !== 3) throw new Error('expected 3 tally stats, got ' + tally);
    const items = await page.locator('.attention-item').count();
    if (items) throw new Error('attention items still present');
    await page.screenshot({ path: '/home/claude/shot-cleared.png' });
    return 'hero + ' + tally + ' tally stats, queue empty';
  });

  await page.reload();
  await page.waitForTimeout(400);

  // ---------- command palette ----------
  await check('palette opens via Cmd+K', async () => {
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(250);
    let open = await page.locator('.cmdk').count();
    if (!open) { await page.keyboard.press('Control+k'); await page.waitForTimeout(250); open = await page.locator('.cmdk').count(); }
    if (!open) throw new Error('palette did not open');
    const items = await page.locator('.cmdk-item').count();
    return items + ' default commands';
  });

  await check('palette filters as you type', async () => {
    await page.fill('#cmdkInput', 'invoice');
    await page.waitForTimeout(250);
    const items = await page.locator('.cmdk-item').count();
    if (!items) throw new Error('no matches for "invoice"');
    const first = await page.textContent('.cmdk-item .ci-label');
    return items + ' hits, top = "' + first.trim() + '"';
  });

  await check('palette arrow keys move selection', async () => {
    const before = await page.evaluate(() => window.__sb.state.cmdk.idx);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => window.__sb.state.cmdk.idx);
    if (after !== before + 1) throw new Error(`idx ${before}→${after}`);
    const on = await page.locator('.cmdk-item.on').count();
    if (on !== 1) throw new Error('highlight not unique: ' + on);
    return `idx ${before}→${after}, one highlighted`;
  });

  await check('palette Enter runs the command', async () => {
    await page.fill('#cmdkInput', 'Payments');
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    const open = await page.locator('.cmdk').count();
    if (open) throw new Error('palette stayed open');
    const h1 = await page.textContent('.page-head h1');
    if (h1.trim() !== 'Payments') throw new Error('landed on ' + h1);
    return 'navigated to ' + h1.trim();
  });

  await check('palette closes on Escape', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const open = await page.locator('.cmdk').count();
    if (open) throw new Error('still open');
    return 'closed';
  });

  await check('palette empty state', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(250);
    await page.fill('#cmdkInput', 'qqqzzzxx');
    await page.waitForTimeout(250);
    const empty = await page.locator('.cmdk-empty').count();
    if (!empty) throw new Error('no empty state');
    await page.keyboard.press('Escape');
    return 'shown';
  });

  // ---------- keyboard shortcuts ----------
  await check('G-prefix navigation works for all 5 pages', async () => {
    const map = { o: 'Overview', i: 'Inbox', p: 'Payments', c: 'Contacts', s: 'Settings' };
    for (const [key, title] of Object.entries(map)) {
      await page.keyboard.press('g');
      await page.waitForTimeout(80);
      await page.keyboard.press(key);
      await page.waitForTimeout(220);
      const h1 = (await page.textContent('.page-head h1')).trim();
      if (h1 !== title) throw new Error(`g+${key} → "${h1}", expected "${title}"`);
    }
    return 'g+o/i/p/c/s all land correctly';
  });

  await check('N opens log activity', async () => {
    await page.keyboard.press('n');
    await page.waitForTimeout(250);
    const modal = await page.locator('.modal').count();
    if (!modal) throw new Error('modal did not open');
    const title = await page.textContent('.modal-head h3');
    await page.keyboard.press('Escape');
    return 'opened "' + title.trim() + '"';
  });

  await check('/ focuses search', async () => {
    await page.keyboard.press('/');
    await page.waitForTimeout(200);
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    if (focused !== 'search') throw new Error('focus is on ' + focused);
    await page.evaluate(() => document.activeElement.blur());
    return 'search focused';
  });

  await check('? opens shortcut reference', async () => {
    await page.keyboard.press('?');
    await page.waitForTimeout(250);
    const title = await page.textContent('.modal-head h3');
    const rows = await page.locator('.modal .kbd').count();
    if (rows < 5) throw new Error('only ' + rows + ' shortcuts listed');
    await page.keyboard.press('Escape');
    return rows + ' shortcuts listed';
  });

  await check('shortcuts do not fire while typing', async () => {
    await page.click('[data-action="nav"][data-page="overview"]');
    await page.waitForTimeout(200);
    await page.click('#qc-name');
    await page.type('#qc-name', 'gnip');
    await page.waitForTimeout(200);
    const val = await page.inputValue('#qc-name');
    const h1 = (await page.textContent('.page-head h1')).trim();
    const modal = await page.locator('.modal').count();
    if (val !== 'gnip') throw new Error('input got "' + val + '"');
    if (h1 !== 'Overview') throw new Error('navigated away to ' + h1);
    if (modal) throw new Error('a modal opened while typing');
    return 'typed "gnip" safely — no nav, no modal';
  });

  // ---------- 15. final screenshots ----------
  await page.reload();
  await page.waitForTimeout(400);
  for (const p of ['overview','inbox','payments','contacts','settings']) {
    await page.click(`[data-action="nav"][data-page="${p}"]`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/home/claude/shot-${p}.png`, fullPage: true });
  }

  await browser.close();

  console.log('\n================ SWITCHBOARD TEST REPORT ================\n');
  console.log('PASSED: ' + results.pass.length + '   FAILED: ' + results.fail.length + '   CONSOLE ERRORS: ' + results.consoleErrors.length + '\n');
  results.pass.forEach(p => console.log('  PASS  ' + p));
  if (results.fail.length) { console.log(''); results.fail.forEach(f => console.log('  FAIL  ' + f)); }
  if (results.consoleErrors.length) { console.log('\n  Console errors:'); results.consoleErrors.forEach(e => console.log('    ! ' + e)); }
  console.log('\n=========================================================\n');
  process.exit(results.fail.length || results.consoleErrors.length ? 1 : 0);
})();
