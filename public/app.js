'use strict';

/* =========================================================================
   OpsDesk front end.
   No build step, no framework, no dependencies. Everything the client sees —
   colours, wording, which tabs exist — is driven by /api/config, which is
   driven by the environment variables on that client's Railway service.
   ========================================================================= */

const State = { cfg: null, route: 'dashboard', search: '', cache: {} };

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function money(cents) {
  const c = State.cfg || {};
  try {
    return new Intl.NumberFormat(c.currencyLocale || 'en-US', {
      style: 'currency', currency: c.currency || 'USD',
    }).format((cents || 0) / 100);
  } catch { return `${((cents || 0) / 100).toFixed(2)}`; }
}

function dateShort(v) {
  if (!v) return '—';
  const d = new Date(String(v).length <= 10 ? `${v}T12:00:00` : String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(State.cfg?.currencyLocale || 'en-US',
    { day: 'numeric', month: 'short', year: 'numeric' });
}

function relTime(v) {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return dateShort(v);
}

function toast(message, isError = false) {
  const node = el('div', { class: `toast${isError ? ' err' : ''}` }, message);
  $('#toast-root').append(node);
  setTimeout(() => node.remove(), 3800);
}

const L = (key) => State.cfg?.labels?.[key] || key;

/* ---------- modal ---------- */
function modal({ title, body, footer, wide }) {
  const root = $('#modal-root');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const box = el('div', { class: 'modal', style: wide ? 'width:min(96vw,900px)' : '' },
    el('div', { class: 'modal-head' },
      el('h2', {}, title),
      el('button', { class: 'ghost small', onclick: close }, 'Close')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('div', { class: 'modal-foot' }, footer) : null
  );
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, box);
  root.innerHTML = '';
  root.append(backdrop);
  const firstInput = box.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
  return close;
}

function field(label, input) { return el('div', { class: 'field' }, el('label', {}, label), input); }
function input(name, opts = {}) {
  return el('input', { name, type: opts.type || 'text', value: opts.value ?? '', placeholder: opts.placeholder || '', step: opts.step });
}
function select(name, options, value) {
  return el('select', { name }, ...options.map((o) =>
    el('option', { value: o, selected: o === value ? true : null }, o)));
}
function textarea(name, value = '') { return el('textarea', { name }, value); }
function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

/* ---------- shell ---------- */
async function boot() {
  State.cfg = await api('/config');
  const c = State.cfg;

  document.title = c.companyName;
  const root = document.documentElement;
  root.style.setProperty('--primary', c.brand.primary);
  root.style.setProperty('--accent', c.brand.accent);
  root.style.setProperty('--danger', c.brand.danger);
  root.style.setProperty('--radius', c.brand.radius);
  root.style.setProperty('--font', c.brand.font);
  const theme = c.brand.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : c.brand.theme;
  root.setAttribute('data-theme', theme);

  if (c.faviconEmoji) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${c.faviconEmoji}</text></svg>`;
    document.head.append(el('link', { rel: 'icon', href: `data:image/svg+xml,${encodeURIComponent(svg)}` }));
  }

  $('#brand-name').textContent = c.companyName;
  $('#brand-tag').textContent = c.companyTagline;
  if (c.logoUrl) { const img = $('#brand-logo'); img.src = c.logoUrl; img.hidden = false; }

  if (!c.isProduction) {
    const b = $('#env-banner');
    b.hidden = false;
    b.textContent = `${c.deployEnv} — test data, not the live site`;
  }

  buildNav();
  $('#global-search').addEventListener('input', (e) => {
    State.search = e.target.value.trim();
    render();
  });
  window.addEventListener('hashchange', render);
  await render();
  setInterval(refreshBadge, 120000);
}

function buildNav() {
  const c = State.cfg;
  const items = [['dashboard', 'Dashboard']];
  if (c.modules.intakes) items.push(['intakes', c.labels.intakePlural]);
  if (c.modules.jobs) items.push(['jobs', c.labels.jobPlural]);
  if (c.modules.invoices) items.push(['invoices', c.labels.invoicePlural]);
  if (c.modules.contacts) items.push(['contacts', c.labels.contactPlural]);
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [key, label] of items) {
    nav.append(el('a', { href: `#/${key}`, 'data-route': key }, label));
  }
}

async function refreshBadge() {
  try {
    const s = await api('/dashboard/summary');
    const link = document.querySelector('nav a[data-route="dashboard"]');
    if (!link) return;
    link.querySelector('.pip')?.remove();
    if (s.followup_count > 0) link.append(el('span', { class: 'pip' }, String(s.followup_count)));
  } catch { /* badge is cosmetic */ }
}

async function render() {
  const route = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  State.route = route;
  document.querySelectorAll('nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === route));

  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const renderers = { dashboard: viewDashboard, contacts: viewContacts, intakes: viewIntakes, jobs: viewJobs, invoices: viewInvoices };
    await (renderers[route] || viewDashboard)(view);
    refreshBadge();
  } catch (err) {
    view.innerHTML = '';
    view.append(el('div', { class: 'empty' }, el('strong', {}, 'Could not load this page'), err.message));
  }
}

/* =========================================================================
   Dashboard — follow-up queue first, because that is the product.
   ========================================================================= */
async function viewDashboard(view) {
  const [summary, followups, trend] = await Promise.all([
    api('/dashboard/summary'), api('/dashboard/followups'), api('/dashboard/trend'),
  ]);
  view.innerHTML = '';

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', {}, 'Dashboard'),
      el('div', { class: 'sub' }, `${State.cfg.companyName} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`))));

  view.append(el('div', { class: 'kpis' },
    kpi('Outstanding', money(summary.outstanding_cents), `${L('invoicePlural')} awaiting payment`),
    kpi('Overdue', money(summary.overdue_cents), `${summary.overdue_count} past due`, summary.overdue_cents > 0 ? 'alert' : ''),
    kpi('Collected this month', money(summary.collected_this_month_cents), `${money(summary.billed_this_month_cents)} billed`, 'good'),
    kpi('Open pipeline', money(summary.pipeline_cents), `${summary.open_intakes} open ${L('intakePlural').toLowerCase()}`),
    kpi('Needs attention', String(summary.followup_count), `${summary.followup_high} urgent`, summary.followup_high > 0 ? 'alert' : '')));

  /* --- follow-up queue --- */
  const list = el('div', { class: 'followups' });
  if (!followups.length) {
    list.append(el('div', { class: 'empty' },
      el('strong', {}, 'Nothing is slipping'),
      'Every enquiry, job and invoice has been touched inside its window.'));
  } else {
    for (const f of followups) list.append(followUpRow(f));
  }
  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Needs following up'),
      el('span', { class: 'muted', style: 'font-size:.82rem' },
        `${followups.length} item${followups.length === 1 ? '' : 's'}`)),
    list));

  /* --- 6 month trend --- */
  const max = Math.max(1, ...trend.flatMap((t) => [t.billed_cents, t.collected_cents]));
  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Billed vs collected'),
      el('div', { class: 'legend' },
        el('span', {}, el('i', { style: 'background:color-mix(in srgb,var(--primary) 55%,transparent)' }), 'Billed'),
        el('span', {}, el('i', { style: 'background:var(--accent)' }), 'Collected'))),
    el('div', { class: 'card-body' },
      el('div', { class: 'chart' }, ...trend.map((t) =>
        el('div', { class: 'col' },
          el('div', { class: 'bars' },
            el('div', { class: 'bar billed', style: `height:${(t.billed_cents / max) * 100}%`, title: `Billed ${money(t.billed_cents)}` }),
            el('div', { class: 'bar collected', style: `height:${(t.collected_cents / max) * 100}%`, title: `Collected ${money(t.collected_cents)}` })),
          el('div', { class: 'lbl' }, new Date(`${t.month}-02`).toLocaleDateString(undefined, { month: 'short' }))))))));
}

function kpi(label, value, foot, cls = '') {
  return el('div', { class: `kpi ${cls}` },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, value),
    el('div', { class: 'foot' }, foot));
}

function followUpRow(f) {
  const openIt = () => {
    if (f.entity === 'invoice') openInvoice(f.id);
    else if (f.entity === 'intake') openIntake(f.id);
    else if (f.entity === 'job') openJob(f.id);
  };
  return el('div', { class: `fu ${f.severity}` },
    el('div', { class: 'sev' }),
    el('div', { class: 'fu-main row-link', onclick: openIt },
      el('div', { class: 'fu-title' }, f.title),
      el('div', { class: 'fu-detail' }, f.detail),
      f.contact ? el('div', { class: 'fu-who' },
        f.contact.name,
        f.contact.phone ? el('span', { class: 'muted' }, ` · ${f.contact.phone}`) : null) : null),
    el('div', { class: 'fu-right' },
      f.value_cents ? el('div', { class: 'fu-amount' }, money(f.value_cents)) : null,
      el('button', { class: 'small', onclick: openIt }, f.action)));
}

/* =========================================================================
   Customers
   ========================================================================= */
async function viewContacts(view) {
  const rows = await api(`/contacts?q=${encodeURIComponent(State.search)}`);
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, L('contactPlural')),
      el('div', { class: 'sub' }, `${rows.length} on file`)),
    el('button', { onclick: () => editContact() }, `New ${L('contact').toLowerCase()}`)));

  if (!rows.length) {
    view.append(emptyCard(`No ${L('contactPlural').toLowerCase()} yet`, 'Add the first one to get going.'));
    return;
  }

  view.append(el('div', { class: 'card' }, el('div', { class: 'table-wrap' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'Company'), el('th', {}, 'Phone'),
        el('th', {}, 'Email'), el('th', {}, 'Tags'), el('th', {}, ''))),
      el('tbody', {}, ...rows.map((r) =>
        el('tr', { class: 'row-link', onclick: () => openContact(r.id) },
          el('td', {}, el('strong', {}, r.name)),
          el('td', {}, r.company || '—'),
          el('td', {}, r.phone || '—'),
          el('td', {}, r.email || '—'),
          el('td', {}, r.tags ? el('span', { class: 'pill' }, r.tags) : '—'),
          el('td', { class: 'num' },
            el('button', {
              class: 'ghost small',
              onclick: (e) => { e.stopPropagation(); editContact(r); },
            }, 'Edit')))))))));
}

async function openContact(id) {
  const c = await api(`/contacts/${id}`);
  modal({
    title: c.name,
    wide: true,
    body: el('div', {},
      el('p', { class: 'muted' },
        [c.company, c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details on file'),
      c.address ? el('p', { class: 'muted' }, c.address) : null,
      c.notes ? el('div', { class: 'card' }, el('div', { class: 'card-body' }, c.notes)) : null,
      miniList(`${L('intakePlural')}`, c.intakes, (i) =>
        `${i.subject} — ${i.stage} (${relTime(i.created_at)})`),
      miniList(`${L('jobPlural')}`, c.jobs, (j) => `${j.title} — ${j.stage}`),
      miniList(`${L('invoicePlural')}`, c.invoices, (i) => `${i.number} — ${i.status}`)),
    footer: el('button', { class: 'ghost', onclick: () => editContact(c) }, 'Edit'),
  });
}

function miniList(title, rows, fmt) {
  return el('div', { class: 'card', style: 'margin-top:1rem' },
    el('div', { class: 'card-head' }, el('h2', {}, title)),
    el('div', { class: 'card-body' },
      rows.length
        ? el('ul', { class: 'timeline' }, ...rows.map((r) => el('li', {}, fmt(r))))
        : el('span', { class: 'muted' }, 'None yet')));
}

function editContact(existing) {
  const form = el('form', {},
    field('Name', input('name', { value: existing?.name })),
    el('div', { class: 'grid-2' },
      field('Company', input('company', { value: existing?.company })),
      field('Tags', input('tags', { value: existing?.tags, placeholder: 'vip, wholesale' }))),
    el('div', { class: 'grid-2' },
      field('Phone', input('phone', { value: existing?.phone })),
      field('Email', input('email', { type: 'email', value: existing?.email }))),
    field('Address', input('address', { value: existing?.address })),
    field('Notes', textarea('notes', existing?.notes || '')));

  const close = modal({
    title: existing ? `Edit ${existing.name}` : `New ${L('contact').toLowerCase()}`,
    body: form,
    footer: [
      existing ? el('button', {
        class: 'ghost', onclick: async () => {
          if (!confirm('Delete this record permanently?')) return;
          await api(`/contacts/${existing.id}`, { method: 'DELETE' });
          close(); toast('Deleted'); render();
        },
      }, 'Delete') : null,
      el('button', {
        onclick: async () => {
          const body = formValues(form);
          if (!body.name.trim()) return toast('A name is required', true);
          try {
            if (existing) await api(`/contacts/${existing.id}`, { method: 'PUT', body });
            else await api('/contacts', { method: 'POST', body });
            close(); toast('Saved'); render();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Save'),
    ],
  });
}

/* =========================================================================
   Enquiries / intakes
   ========================================================================= */
async function viewIntakes(view) {
  const rows = await api(`/intakes?q=${encodeURIComponent(State.search)}`);
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, L('intakePlural')),
      el('div', { class: 'sub' }, 'Every call, email and walk-in — logged the moment it lands')),
    el('button', { onclick: () => editIntake() }, `Log ${L('intake').toLowerCase()}`)));

  const board = el('div', { class: 'board' });
  for (const stage of State.cfg.intakeStages) {
    const items = rows.filter((r) => r.stage === stage);
    const col = el('div', { class: 'board-col' },
      el('h3', {}, stage, el('span', {}, String(items.length))));
    for (const i of items) {
      col.append(el('div', { class: 'board-card', onclick: () => openIntake(i.id) },
        el('div', { class: 't' }, i.subject),
        el('div', { class: 'm' }, i.contact?.name || 'No customer linked'),
        el('div', { class: 'm' },
          `${i.channel || '—'} · ${relTime(i.last_activity_at || i.created_at)}`),
        Number(i.value_cents) ? el('div', { class: 'm mono' }, money(i.value_cents)) : null));
    }
    if (!items.length) col.append(el('div', { class: 'm muted', style: 'padding:.5rem' }, '—'));
    board.append(col);
  }
  view.append(board);
}

async function openIntake(id) {
  const i = await api(`/intakes/${id}`);
  const noteBox = textarea('body', '');
  const close = modal({
    title: i.subject,
    wide: true,
    body: el('div', {},
      el('p', { class: 'muted' },
        `${i.stage} · ${i.channel || 'Unknown channel'} · logged ${relTime(i.created_at)}`),
      i.contact ? el('p', {}, el('strong', {}, i.contact.name),
        i.contact.phone ? ` · ${i.contact.phone}` : '',
        i.contact.email ? ` · ${i.contact.email}` : '') : null,
      i.details ? el('p', {}, i.details) : null,
      Number(i.value_cents) ? el('p', {}, el('strong', {}, money(i.value_cents)), ' estimated value') : null,
      i.next_action ? el('p', { class: 'muted' }, `Next: ${i.next_action}${i.next_action_at ? ` (${dateShort(i.next_action_at)})` : ''}`) : null,
      el('div', { class: 'card', style: 'margin-top:1rem' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Log a follow-up')),
        el('div', { class: 'card-body' },
          field('What happened?', noteBox),
          el('button', {
            onclick: async () => {
              await api(`/intakes/${id}/touch`, { method: 'POST', body: { body: noteBox.value || 'Followed up' } });
              close(); toast('Follow-up logged'); render();
            },
          }, 'Log it & reset the clock'))),
      el('div', { class: 'card', style: 'margin-top:1rem' },
        el('div', { class: 'card-head' }, el('h2', {}, 'History')),
        el('div', { class: 'card-body' },
          i.activity.length
            ? el('ul', { class: 'timeline' }, ...i.activity.map((a) =>
              el('li', {}, el('div', {}, a.body || a.kind),
                el('div', { class: 'when' }, `${a.kind} · ${relTime(a.created_at)}`))))
            : el('span', { class: 'muted' }, 'Nothing logged yet')))),
    footer: [
      State.cfg.modules.jobs ? el('button', {
        class: 'ghost',
        onclick: () => { close(); editJob({ contact_id: i.contact_id, intake_id: i.id, title: i.subject, value: (i.value_cents || 0) / 100 }); },
      }, `Convert to ${L('job').toLowerCase()}`) : null,
      el('button', { class: 'ghost', onclick: () => { close(); editIntake(i); } }, 'Edit'),
    ],
  });
}

async function editIntake(existing) {
  const contacts = State.cfg.modules.contacts ? await api('/contacts') : [];
  const contactSelect = el('select', { name: 'contact_id' },
    el('option', { value: '' }, '— none / new below —'),
    ...contacts.map((c) => el('option', {
      value: c.id, selected: String(c.id) === String(existing?.contact_id) ? true : null,
    }, c.company ? `${c.name} (${c.company})` : c.name)));

  const form = el('form', {},
    field('Subject', input('subject', { value: existing?.subject, placeholder: 'Quote for 3 rings, resize' })),
    el('div', { class: 'grid-2' },
      field(L('contact'), contactSelect),
      field('Channel', select('channel', State.cfg.intakeChannels, existing?.channel))),
    !existing ? el('div', { class: 'grid-3' },
      field('…or new name', input('contact_name')),
      field('Phone', input('contact_phone')),
      field('Email', input('contact_email', { type: 'email' }))) : null,
    field('Details', textarea('details', existing?.details || '')),
    el('div', { class: 'grid-3' },
      field('Stage', select('stage', State.cfg.intakeStages, existing?.stage)),
      field('Est. value', input('value', { type: 'number', step: '0.01', value: existing ? (existing.value_cents || 0) / 100 : '' })),
      field('Owner', input('owner', { value: existing?.owner }))),
    el('div', { class: 'grid-2' },
      field('Next action', input('next_action', { value: existing?.next_action, placeholder: 'Call back with pricing' })),
      field('Follow up on', input('next_action_at', { type: 'date', value: (existing?.next_action_at || '').slice(0, 10) }))));

  const close = modal({
    title: existing ? 'Edit' : `Log ${L('intake').toLowerCase()}`,
    body: form,
    footer: [
      existing ? el('button', {
        class: 'ghost', onclick: async () => {
          if (!confirm('Delete this record?')) return;
          await api(`/intakes/${existing.id}`, { method: 'DELETE' });
          close(); toast('Deleted'); render();
        },
      }, 'Delete') : null,
      el('button', {
        onclick: async () => {
          const body = formValues(form);
          if (!body.subject?.trim()) return toast('A subject is required', true);
          try {
            if (existing) await api(`/intakes/${existing.id}`, { method: 'PUT', body });
            else await api('/intakes', { method: 'POST', body });
            close(); toast('Saved'); render();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Save'),
    ],
  });
}

/* =========================================================================
   Jobs
   ========================================================================= */
async function viewJobs(view) {
  const rows = await api(`/jobs?q=${encodeURIComponent(State.search)}`);
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, L('jobPlural')),
      el('div', { class: 'sub' }, 'Work in flight, and what it is worth')),
    el('button', { onclick: () => editJob() }, `New ${L('job').toLowerCase()}`)));

  const board = el('div', { class: 'board' });
  for (const stage of State.cfg.jobStages) {
    const items = rows.filter((r) => r.stage === stage);
    const col = el('div', { class: 'board-col' }, el('h3', {}, stage, el('span', {}, String(items.length))));
    for (const j of items) {
      const uninvoiced = j.stage === 'Complete' && !j.invoices.length;
      col.append(el('div', { class: 'board-card', onclick: () => openJob(j.id) },
        el('div', { class: 't' }, j.title),
        el('div', { class: 'm' }, j.contact?.name || 'No customer linked'),
        j.due_date ? el('div', { class: 'm' }, `Due ${dateShort(j.due_date)}`) : null,
        Number(j.value_cents) ? el('div', { class: 'm mono' }, money(j.value_cents)) : null,
        uninvoiced ? el('span', { class: 'pill red' }, 'Not invoiced') : null));
    }
    if (!items.length) col.append(el('div', { class: 'm muted', style: 'padding:.5rem' }, '—'));
    board.append(col);
  }
  view.append(board);
}

async function openJob(id) {
  const j = await api(`/jobs/${id}`);
  const noteBox = textarea('body', '');
  const close = modal({
    title: j.title,
    wide: true,
    body: el('div', {},
      el('p', { class: 'muted' },
        `${j.stage}${j.due_date ? ` · due ${dateShort(j.due_date)}` : ''} · last touched ${relTime(j.last_activity_at)}`),
      j.contact ? el('p', {}, el('strong', {}, j.contact.name), j.contact.phone ? ` · ${j.contact.phone}` : '') : null,
      j.description ? el('p', {}, j.description) : null,
      Number(j.value_cents) ? el('p', {}, el('strong', {}, money(j.value_cents))) : null,
      j.invoices.length
        ? el('p', {}, `Invoiced: ${j.invoices.map((i) => `${i.number} (${i.status})`).join(', ')}`)
        : el('p', { class: 'muted' }, 'Not yet invoiced'),
      el('div', { class: 'card', style: 'margin-top:1rem' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Log progress')),
        el('div', { class: 'card-body' },
          field('Update', noteBox),
          el('button', {
            onclick: async () => {
              await api(`/jobs/${id}/touch`, { method: 'POST', body: { body: noteBox.value || 'Progress logged' } });
              close(); toast('Logged'); render();
            },
          }, 'Log it'))),
      el('div', { class: 'card', style: 'margin-top:1rem' },
        el('div', { class: 'card-head' }, el('h2', {}, 'History')),
        el('div', { class: 'card-body' },
          j.activity.length
            ? el('ul', { class: 'timeline' }, ...j.activity.map((a) =>
              el('li', {}, el('div', {}, a.body || a.kind), el('div', { class: 'when' }, relTime(a.created_at)))))
            : el('span', { class: 'muted' }, 'Nothing logged yet')))),
    footer: [
      State.cfg.modules.invoices && !j.invoices.length ? el('button', {
        onclick: async () => {
          try {
            const inv = await api('/invoices', {
              method: 'POST',
              body: { contact_id: j.contact_id, job_id: j.id },
            });
            close(); toast(`Created ${inv.number}`); location.hash = '#/invoices';
            openInvoice(inv.id);
          } catch (e) { toast(e.message, true); }
        },
      }, `Raise ${L('invoice').toLowerCase()}`) : null,
      el('button', { class: 'ghost', onclick: () => { close(); editJob(j); } }, 'Edit'),
    ],
  });
}

async function editJob(prefill) {
  const existing = prefill?.id ? prefill : null;
  const contacts = State.cfg.modules.contacts ? await api('/contacts') : [];
  const contactSelect = el('select', { name: 'contact_id' },
    el('option', { value: '' }, '— none —'),
    ...contacts.map((c) => el('option', {
      value: c.id,
      selected: String(c.id) === String(prefill?.contact_id ?? existing?.contact_id) ? true : null,
    }, c.company ? `${c.name} (${c.company})` : c.name)));

  const form = el('form', {},
    field('Title', input('title', { value: prefill?.title ?? existing?.title })),
    el('div', { class: 'grid-2' },
      field(L('contact'), contactSelect),
      field('Reference', input('reference', { value: existing?.reference }))),
    field('Description', textarea('description', existing?.description || '')),
    el('div', { class: 'grid-3' },
      field('Stage', select('stage', State.cfg.jobStages, existing?.stage)),
      field('Value', input('value', {
        type: 'number', step: '0.01',
        value: prefill?.value ?? (existing ? (existing.value_cents || 0) / 100 : ''),
      })),
      field('Due date', input('due_date', { type: 'date', value: existing?.due_date || '' }))),
    field('Owner', input('owner', { value: existing?.owner })));
  if (prefill?.intake_id) form.append(el('input', { type: 'hidden', name: 'intake_id', value: prefill.intake_id }));

  const close = modal({
    title: existing ? 'Edit' : `New ${L('job').toLowerCase()}`,
    body: form,
    footer: [
      existing ? el('button', {
        class: 'ghost', onclick: async () => {
          if (!confirm('Delete this record?')) return;
          await api(`/jobs/${existing.id}`, { method: 'DELETE' });
          close(); toast('Deleted'); render();
        },
      }, 'Delete') : null,
      el('button', {
        onclick: async () => {
          const body = formValues(form);
          if (!body.title?.trim()) return toast('A title is required', true);
          try {
            if (existing) await api(`/jobs/${existing.id}`, { method: 'PUT', body });
            else await api('/jobs', { method: 'POST', body });
            close(); toast('Saved'); render();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Save'),
    ],
  });
}

/* =========================================================================
   Invoices
   ========================================================================= */
const STATUS_CLASS = { Draft: '', Sent: 'blue', Partial: 'amber', Paid: 'green', Void: '' };

async function viewInvoices(view) {
  const rows = await api(`/invoices?q=${encodeURIComponent(State.search)}`);
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, L('invoicePlural')),
      el('div', { class: 'sub' }, `${rows.length} on record`)),
    el('button', { onclick: () => newInvoice() }, `New ${L('invoice').toLowerCase()}`)));

  if (!rows.length) {
    view.append(emptyCard(`No ${L('invoicePlural').toLowerCase()} yet`, 'Raise the first one when work is done.'));
    return;
  }

  view.append(el('div', { class: 'card' }, el('div', { class: 'table-wrap' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Number'), el('th', {}, L('contact')), el('th', {}, 'Issued'),
        el('th', {}, 'Due'), el('th', {}, 'Status'),
        el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, 'Balance'))),
      el('tbody', {}, ...rows.map((r) => {
        const overdue = ['Sent', 'Partial'].includes(r.status) && r.due_date &&
          new Date(`${r.due_date}T23:59:59`) < new Date();
        return el('tr', { class: 'row-link', onclick: () => openInvoice(r.id) },
          el('td', {}, el('strong', {}, r.number)),
          el('td', {}, r.contact?.name || '—'),
          el('td', {}, dateShort(r.issue_date)),
          el('td', {}, overdue
            ? el('span', { class: 'pill red' }, dateShort(r.due_date))
            : dateShort(r.due_date)),
          el('td', {}, el('span', { class: `pill ${STATUS_CLASS[r.status] || ''}` }, r.status)),
          el('td', { class: 'num' }, money(r.totals.total)),
          el('td', { class: 'num' }, r.totals.balance > 0 ? money(r.totals.balance) : '—'));
      }))))));
}

async function newInvoice() {
  const contacts = State.cfg.modules.contacts ? await api('/contacts') : [];
  const jobs = State.cfg.modules.jobs ? await api('/jobs') : [];
  const form = el('form', {},
    field(L('contact'), el('select', { name: 'contact_id' },
      el('option', { value: '' }, '— none —'),
      ...contacts.map((c) => el('option', { value: c.id }, c.company ? `${c.name} (${c.company})` : c.name)))),
    jobs.length ? field(`Link a ${L('job').toLowerCase()} (optional)`,
      el('select', { name: 'job_id' },
        el('option', { value: '' }, '— none —'),
        ...jobs.filter((j) => !j.invoices.length).map((j) => el('option', { value: j.id }, j.title)))) : null,
    el('div', { class: 'grid-2' },
      field('Issue date', input('issue_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })),
      field(`${State.cfg.taxLabel} rate %`, input('tax_rate', { type: 'number', step: '0.001', value: State.cfg.defaultTaxRate }))));

  const close = modal({
    title: `New ${L('invoice').toLowerCase()}`,
    body: form,
    footer: el('button', {
      onclick: async () => {
        try {
          const inv = await api('/invoices', { method: 'POST', body: formValues(form) });
          close(); toast(`Created ${inv.number}`); openInvoice(inv.id);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Create'),
  });
}

async function openInvoice(id) {
  const inv = await api(`/invoices/${id}`);
  const cfg = State.cfg;

  /* --- editable line items --- */
  const items = inv.items.length
    ? inv.items.map((i) => ({ description: i.description, qty: Number(i.qty), unit_price: Number(i.unit_cents) / 100 }))
    : [{ description: '', qty: 1, unit_price: 0 }];

  const tbody = el('tbody');
  const totalsBox = el('div', { class: 'totals' });

  function recalc() {
    const subtotal = items.reduce((s, i) => s + Math.round((Number(i.qty) || 0) * (Number(i.unit_price) || 0) * 100), 0);
    const discount = Number(inv.discount_cents || 0);
    const taxable = Math.max(0, subtotal - discount);
    const tax = Math.round((taxable * Number(inv.tax_rate_bp || 0)) / 10000);
    const total = taxable + tax;
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount_cents), 0);
    totalsBox.innerHTML = '';
    // Native append stringifies null, so filter before handing it the list.
    const lines = [
      el('div', {}, el('span', {}, 'Subtotal'), el('span', { class: 'mono' }, money(subtotal))),
      discount ? el('div', {}, el('span', {}, 'Discount'), el('span', { class: 'mono' }, `−${money(discount)}`)) : null,
      Number(inv.tax_rate_bp) ? el('div', {},
        el('span', {}, `${cfg.taxLabel} (${(inv.tax_rate_bp / 100).toFixed(2)}%)`),
        el('span', { class: 'mono' }, money(tax))) : null,
      el('div', { class: 'grand' }, el('span', {}, 'Total'), el('span', { class: 'mono' }, money(total))),
      paid ? el('div', {}, el('span', {}, 'Paid'), el('span', { class: 'mono' }, `−${money(paid)}`)) : null,
      el('div', { class: 'grand' }, el('span', {}, 'Balance'), el('span', { class: 'mono' }, money(total - paid))),
    ].filter(Boolean);
    totalsBox.append(...lines);
  }

  function drawItems() {
    tbody.innerHTML = '';
    items.forEach((item, idx) => {
      const desc = el('input', { value: item.description, placeholder: 'Description' });
      const qty = el('input', { type: 'number', step: '0.001', value: item.qty });
      const unit = el('input', { type: 'number', step: '0.01', value: item.unit_price });
      desc.addEventListener('input', () => { item.description = desc.value; });
      qty.addEventListener('input', () => { item.qty = qty.value; recalc(); });
      unit.addEventListener('input', () => { item.unit_price = unit.value; recalc(); });
      tbody.append(el('tr', {},
        el('td', {}, desc),
        el('td', { style: 'width:90px' }, qty),
        el('td', { style: 'width:120px' }, unit),
        el('td', { style: 'width:40px' }, el('button', {
          class: 'ghost small',
          onclick: () => { items.splice(idx, 1); if (!items.length) items.push({ description: '', qty: 1, unit_price: 0 }); drawItems(); recalc(); },
        }, '×'))));
    });
  }
  drawItems();
  recalc();

  const editable = inv.status === 'Draft';

  const body = el('div', {},
    el('p', { class: 'muted' },
      `${inv.status} · issued ${dateShort(inv.issue_date)} · due ${dateShort(inv.due_date)}`),
    inv.contact ? el('p', {}, el('strong', {}, inv.contact.name),
      inv.contact.company ? ` · ${inv.contact.company}` : '') : null,

    el('div', { class: 'card', style: 'margin-top:1rem' },
      el('div', { class: 'card-head' },
        el('h2', {}, 'Lines'),
        editable ? el('button', {
          class: 'ghost small',
          onclick: () => { items.push({ description: '', qty: 1, unit_price: 0 }); drawItems(); recalc(); },
        }, 'Add line') : null),
      el('div', { class: 'card-body' },
        editable
          ? el('div', { class: 'table-wrap' }, el('table', { class: 'items-table' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Description'), el('th', {}, 'Qty'), el('th', {}, 'Unit'), el('th', {}, ''))),
            tbody))
          : el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Description'), el('th', { class: 'num' }, 'Qty'),
              el('th', { class: 'num' }, 'Unit'), el('th', { class: 'num' }, 'Amount'))),
            el('tbody', {}, ...inv.items.map((i) => el('tr', {},
              el('td', {}, i.description),
              el('td', { class: 'num' }, Number(i.qty)),
              el('td', { class: 'num' }, money(i.unit_cents)),
              el('td', { class: 'num' }, money(Math.round(Number(i.qty) * Number(i.unit_cents))))))))),
        totalsBox)),

    el('div', { class: 'card', style: 'margin-top:1rem' },
      el('div', { class: 'card-head' }, el('h2', {}, L('paymentPlural'))),
      el('div', { class: 'card-body' },
        inv.payments.length
          ? el('ul', { class: 'timeline' }, ...inv.payments.map((p) =>
            el('li', {},
              el('div', {}, `${money(p.amount_cents)} · ${p.method || '—'}${p.reference ? ` · ${p.reference}` : ''}`),
              el('div', { class: 'when' }, dateShort(p.paid_on)))))
          : el('span', { class: 'muted' }, 'Nothing recorded yet'),
        inv.status !== 'Void' && inv.totals.balance > 0
          ? el('div', { style: 'margin-top:1rem' }, el('button', {
            class: 'ghost',
            onclick: () => recordPayment(inv),
          }, `Record ${L('payment').toLowerCase()}`))
          : null)));

  const close = modal({
    title: inv.number,
    wide: true,
    body,
    footer: [
      editable ? el('button', {
        class: 'ghost',
        onclick: async () => {
          try {
            await api(`/invoices/${id}`, { method: 'PUT', body: { items } });
            toast('Saved'); close(); openInvoice(id);
          } catch (e) { toast(e.message, true); }
        },
      }, 'Save lines') : null,
      inv.status === 'Draft' ? el('button', {
        onclick: async () => {
          await api(`/invoices/${id}`, { method: 'PUT', body: { items } });
          await api(`/invoices/${id}/send`, { method: 'POST' });
          close(); toast('Marked as sent'); render();
        },
      }, 'Mark as sent') : null,
      inv.status !== 'Void' && inv.status !== 'Draft' ? el('button', {
        class: 'ghost',
        onclick: async () => {
          if (!confirm('Void this invoice?')) return;
          await api(`/invoices/${id}/void`, { method: 'POST' });
          close(); toast('Voided'); render();
        },
      }, 'Void') : null,
    ],
  });
}

function recordPayment(inv) {
  const form = el('form', {},
    el('div', { class: 'grid-2' },
      field('Amount', input('amount', { type: 'number', step: '0.01', value: (inv.totals.balance / 100).toFixed(2) })),
      field('Method', select('method', State.cfg.paymentMethods))),
    el('div', { class: 'grid-2' },
      field('Paid on', input('paid_on', { type: 'date', value: new Date().toISOString().slice(0, 10) })),
      field('Reference', input('reference', { placeholder: 'Cheque no., txn id' }))));

  const close = modal({
    title: `Record ${L('payment').toLowerCase()} — ${inv.number}`,
    body: form,
    footer: el('button', {
      onclick: async () => {
        try {
          await api(`/invoices/${inv.id}/payments`, { method: 'POST', body: formValues(form) });
          close(); toast('Payment recorded'); render();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Save'),
  });
}

function emptyCard(title, sub) {
  return el('div', { class: 'card' },
    el('div', { class: 'empty' }, el('strong', {}, title), sub));
}

boot().catch((err) => {
  document.body.innerHTML = `<div style="padding:3rem;font-family:sans-serif">
    <h1>Could not start</h1><p>${err.message}</p></div>`;
});
