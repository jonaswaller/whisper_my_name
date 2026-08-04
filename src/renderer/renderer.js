/**
 * HUD. Plain JS on purpose — no framework, no build step for this file.
 *
 * Buttons and hotkeys take the SAME path: both call api.fire(action), which the
 * main process handles identically. The button face carries its hotkey number
 * so the UI teaches the keys while he uses it.
 */

let config = null;
let lastSnapshot = null;
/** label -> accelerator, from the main process. */
let hotkeys = {};

/**
 * Show just the number, matching the numpad key it maps to.
 *
 * The product runs on Windows against numpad 1-9, so the UI always reads 1-9.
 * Modifier chords are a dev-machine detail and are stripped from the display.
 */
function keyLabel(accel) {
  if (!accel) return '·';
  const last = String(accel).split('+').pop() ?? '';
  return last.replace(/^num/i, '') || '·';
}

const keyFor = (label) => keyLabel(hotkeys[label]);

const $ = (sel, root = document) => root.querySelector(sel);

/** "just now" / "2m ago" — what matters is how fresh a trade is, not the clock. */
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
/** Signed money with an explicit +, for P&L where direction is the point. */
const signedMoney = (n) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const fmt = (n, dp = 2) => (n === null || n === undefined ? '–' : Number(n).toFixed(dp));

/** Build the three buy rows for a side. Inputs are live-editable. */
function buildRows(side) {
  const host = $(`#side-${side} .rows`);
  host.innerHTML = '';
  // Each side has its own three tiers — editing A must not touch B.
  (config?.tiers?.[side] ?? []).forEach((tier, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="key">${escapeHtml(keyFor(`buy${side}${i + 1}`))}</div>
      <button class="buy" data-side="${side}" data-tier="${i}">
        <div class="lbl">${tier.label}</div>
        BUY $${tier.notional} · ${tier.slippageCents}c
      </button>
      <input class="size" type="number" min="1" step="1" value="${tier.notional}" data-tier="${i}" data-side="${side}" title="order size in dollars for this side only" />
      <input class="slip" type="number" min="0" max="99" step="1" value="${tier.slippageCents}" data-tier="${i}" data-side="${side}" title="slippage tolerance in cents for this side only" />
      <div class="cap" data-tier="${i}">–</div>`;
    host.appendChild(row);
  });

  // Buttons dispatch the same action ids the hotkeys do, so the two paths
  // cannot drift apart.
  host.querySelectorAll('.buy').forEach((btn) =>
    btn.addEventListener('click', () =>
      api.runAction(`buy${btn.dataset.side}${Number(btn.dataset.tier) + 1}`),
    ),
  );
  host.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', pushConfig);
    // Don't let a focused field swallow keys meant for trading.
    input.addEventListener('keydown', (e) => e.stopPropagation());
  });
}

/**
 * Send an edited size/slippage back to the agent, which re-signs at the new size.
 *
 * Reads the element that actually changed. Tiers are shared across both sides,
 * so each side renders its own inputs — always reading side A's would silently
 * discard any edit made on side B.
 */
async function pushConfig(event) {
  if (!config) return;
  const input = event.target;
  const index = Number(input.dataset.tier);
  const side = input.dataset.side;
  const field = input.classList.contains('size') ? 'notional' : 'slippageCents';

  // Only the edited side's tier changes; the other side is copied untouched.
  const tiers = {
    A: config.tiers.A.map((t) => ({ ...t })),
    B: config.tiers.B.map((t) => ({ ...t })),
  };
  tiers[side][index] = { ...tiers[side][index], [field]: Number(input.value) };
  const res = await api.updateConfig({ ...config, tiers });
  if (!res.ok) {
    log('error', res.error);
    return;
  }
  config = res.config;
  ['A', 'B'].forEach(buildRows);
}

function renderSide(side, view) {
  const root = $(`#side-${side}`);
  $('h2', root).textContent = view.name;
  $('.bid', root).textContent = fmt(view.bid);
  $('.ask', root).textContent = fmt(view.ask);
  $('.sz', root).textContent =
    view.bid === null ? '' : `${Math.round(view.bidSize)} x ${Math.round(view.askSize)}`;

  // What this side is worth right now, what it cost, and the difference —
  // "value" is what he'd get selling into the bid this instant.
  const pos = $('.pos', root);
  if (view.shares > 0) {
    const value = view.bid === null ? null : view.shares * view.bid;
    const cost = view.shares * view.avgPrice;
    const pnl = value === null ? null : value - cost;
    const pct = pnl === null || cost === 0 ? null : (pnl / cost) * 100;
    pos.innerHTML =
      `<div class="posline"><b>${view.shares}</b> shares @ ${fmt(view.avgPrice, 3)} avg` +
      `<span class="posval">${value === null ? '' : `worth ${money(value)}`}</span></div>` +
      (pnl === null
        ? ''
        : `<div class="posline"><span class="dimlab">cost ${money(cost)}</span>` +
          `<span class="pnl ${pnl >= 0 ? 'up' : 'down'}">${signedMoney(pnl)}` +
          `${pct === null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`}</span></div>`);
  } else {
    pos.innerHTML = '<div class="posline"><span class="dimlab">no position</span></div>';
  }

  view.tiers.forEach((tier, i) => {
    const btn = $(`.buy[data-side="${side}"][data-tier="${i}"]`, root);
    const cap = $(`.cap[data-tier="${i}"]`, root);
    if (!btn) return;
    btn.classList.toggle('veto', Boolean(tier.unfillable));
    btn.title = tier.unfillable
      ? 'ask is above this cap — the order would kill'
      : tier.warning ?? '';
    cap.innerHTML = tier.maxPrice === null
      ? '–'
      : `cap ${fmt(tier.maxPrice)}<br><span class="ready ${tier.ready ? 'on' : ''}">${tier.ready ? 'loaded' : '…'}</span>`;
  });
}

function renderLog(entries) {
  const host = $('#log');
  const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 20;
  host.innerHTML = entries
    .map((e) => {
      const t = new Date(e.at).toTimeString().slice(0, 8);
      return `<div class="${e.level}">${t}  ${escapeHtml(e.text)}</div>`;
    })
    .join('');
  if (atBottom) host.scrollTop = host.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/**
 * Latency and outcome of the last action.
 *
 * Every action stamps this, including ones blocked before any network call, and
 * the age is always shown — otherwise a number from ten minutes ago reads as if
 * it were the press he just made.
 */
function renderPing(a) {
  const el = $('#ping');
  if (!a) {
    el.textContent = 'no actions yet';
    el.className = '';
    return;
  }
  const age = ago(a.at);
  if (a.outcome === 'sent') {
    el.innerHTML = `<b>${a.label}</b> · ${a.ms}ms · ${age}` +
      (a.detail ? ` <span class="pct">(${escapeHtml(a.detail)})</span>` : '');
    el.className = a.ms > 1500 ? 'down' : 'up';
  } else if (a.outcome === 'dry') {
    el.innerHTML = `<b>${a.label}</b> · dry run, not sent · ${age}`;
    el.className = 'warnc';
  } else {
    el.innerHTML = `<b>${a.label}</b> · blocked${a.detail ? `: ${escapeHtml(a.detail)}` : ''} · ${age}`;
    el.className = 'down';
  }
}

/** Resting orders — money committed on the book that he must be able to see. */
function renderOrders(orders, maxResting) {
  $('#ocount').textContent = orders.length;
  const host = $('#olist');
  if (orders.length === 0) {
    host.innerHTML = '<div class="none">nothing resting</div>';
    return;
  }
  host.innerHTML = orders
    .map(
      (o) => `<div class="orow">
        <span>${escapeHtml(o.sideLabel)} <span style="color:var(--dim)">${o.side}</span></span>
        <span class="px">${fmt(o.price, 3)}</span>
        <span class="rem">${o.remaining} of ${o.size} sh</span>
        <button data-cancel="${escapeHtml(o.orderId)}">cancel</button>
      </div>`,
    )
    .join('');
  host.querySelectorAll('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => api.cancelOrder(b.dataset.cancel)),
  );
}

/**
 * Name the actual price on the button rather than "max".
 *
 * It's 0.999 on a 0.001-tick market and 0.99 on a 0.01 one, and the venue can
 * change a market's tick while it's open — so this is read from the live book
 * every render instead of being written into the HTML.
 */
function renderMaxPrice(maxResting) {
  document.querySelectorAll('.max-px').forEach((el) => {
    el.textContent = maxResting ?? '–';
  });
  document.querySelectorAll('.sell-max').forEach((b) => {
    b.title = maxResting
      ? `highest price this market allows (tick ${maxResting === 0.999 ? '0.001' : '0.01'}) — rests until filled or cancelled`
      : 'arm a market first';
  });
  document
    .querySelectorAll('.limit-px')
    .forEach((i) => (i.placeholder = maxResting ? `max ${maxResting}` : 'price'));
}

/**
 * A limit sell always offers the ENTIRE position, minus anything already
 * resting. Saying so on screen stops him wondering whether it sells part.
 */
function renderSellBlock(side, view, openOrders) {
  const root = $(`#side-${side}`);
  const resting = (openOrders ?? [])
    .filter((o) => o.tokenId === view.tokenId && o.side === 'SELL')
    .reduce((sum, o) => sum + o.remaining, 0);
  const available = Number((view.shares - resting).toFixed(2));

  const qty = $('.all-qty', root);
  if (view.shares <= 0) {
    qty.textContent = 'nothing — no position';
  } else if (available <= 0) {
    qty.textContent = `nothing — all ${view.shares} already resting`;
  } else {
    qty.textContent = `all ${available} shares`;
  }

  $('.ask-px', root).textContent = view.ask === null ? '–' : fmt(view.ask, 3);

  // Grey the whole block out when there is nothing it could sell.
  const disabled = available <= 0;
  ['.sell-limit', '.sell-ask', '.sell-max'].forEach((sel) => {
    const b = $(sel, root);
    if (b) b.disabled = disabled;
  });
  $('.standing', root).style.opacity = disabled ? '0.5' : '1';
  $('.sell', root).disabled = view.shares <= 0;
}

function render(snap) {
  lastSnapshot = snap;
  renderOrders(snap.openOrders ?? [], snap.maxRestingPrice);
  renderMaxPrice(snap.maxRestingPrice);
  renderPing(snap.lastAction);
  $('#market').textContent = snap.armed
    ? `${snap.marketQuestion}`
    : 'nothing armed — paste a match URL';
  $('#l-book').classList.toggle('on', snap.bookLive);
  $('#l-fills').classList.toggle('on', snap.fillsLive);
  $('#l-warm').classList.toggle('on', snap.warmth.warm);
  $('#warm-ms').textContent = snap.warmth.warm
    ? `${Math.round(snap.warmth.medianMs)}ms`
    : 'conn';

  const dry = $('#dry');
  dry.textContent = snap.dryRun ? 'DRY RUN' : 'LIVE';
  dry.classList.toggle('live', !snap.dryRun);

  renderInventory(snap.inventory ?? []);
  renderWatch(snap.watched ?? [], snap.watchStatus);
  if (snap.watchStatus?.wallet && document.activeElement !== $('#watch-addr')) {
    $('#watch-addr').value = snap.watchStatus.wallet;
  }
  renderSide('A', snap.A);
  renderSide('B', snap.B);
  renderSellBlock('A', snap.A, snap.openOrders);
  renderSellBlock('B', snap.B, snap.openOrders);
  renderLog(snap.recent);
}

function log(level, text) {
  const host = $('#log');
  const div = document.createElement('div');
  div.className = level;
  div.textContent = `${new Date().toTimeString().slice(0, 8)}  ${text}`;
  host.appendChild(div);
  host.scrollTop = host.scrollHeight;
}

// --- hotkey binder -----------------------------------------------------------

let actionSpecs = [];
let bindings = {};
let capturingFor = null;

/**
 * Turn a KeyboardEvent into an Electron accelerator.
 *
 * Uses `event.code` (physical key) rather than `event.key`, so a numpad press
 * is recognised as Numpad1 whether Num Lock is on or off — with Num Lock off,
 * `key` would read "End" and bind the wrong thing.
 */
function toAccelerator(e) {
  const code = e.code || '';
  const numpad = {
    NumpadDivide: 'numdiv',
    NumpadMultiply: 'nummult',
    NumpadSubtract: 'numsub',
    NumpadAdd: 'numadd',
    NumpadDecimal: 'numdec',
    NumpadEnter: 'numenter',
  };

  let base = null;
  if (/^Numpad[0-9]$/.test(code)) base = 'num' + code.slice(6);
  else if (numpad[code]) base = numpad[code];
  else if (/^Digit[0-9]$/.test(code)) base = code.slice(5);
  else if (/^Key[A-Z]$/.test(code)) base = code.slice(3);
  else if (/^F\d{1,2}$/.test(code)) base = code;
  else if (code === 'Space') base = 'Space';
  else if (code === 'Enter') base = 'Return';
  else if (code === 'Tab') base = 'Tab';
  else if (['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon',
            'Quote', 'Comma', 'Period', 'Slash', 'Backquote'].includes(code)) {
    base = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
             Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
             Backquote: '`' }[code];
  }
  if (!base) return null; // a bare modifier, or something unbindable

  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Command');
  return [...mods, base].join('+');
}

function renderBinder() {
  const host = $('#blist');
  const groups = [...new Set(actionSpecs.map((a) => a.group))];
  host.innerHTML = groups
    .map((g) => {
      const rows = actionSpecs
        .filter((a) => a.group === g)
        .map((a) => {
          const accel = bindings[a.id];
          const label = accel ? keyLabel(accel) : 'unbound';
          return `<div class="brow">
            <span><span class="nm">${escapeHtml(a.label)}</span>${a.hint ? ` <span class="hint">${escapeHtml(a.hint)}</span>` : ''}</span>
            <button class="bkey ${accel ? '' : 'unbound'}" data-bind="${a.id}">${escapeHtml(label)}</button>
            <button class="bclear" data-clear="${a.id}">unbind</button>
          </div>`;
        })
        .join('');
      return `<div class="bgroup">${escapeHtml(g)}</div>${rows}`;
    })
    .join('');

  host.querySelectorAll('[data-bind]').forEach((b) =>
    b.addEventListener('click', () => startCapture(b.dataset.bind, b)),
  );
  host.querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await api.setBinding(b.dataset.clear, null);
      if (res.ok) {
        bindings = res.bindings;
        renderBinder();
      }
    }),
  );
}

/**
 * Capture the next keypress for this action.
 *
 * Global hotkeys are suspended first — otherwise pressing numpad 1 to REBIND it
 * would also fire a live buy order.
 */
function startCapture(actionId, button) {
  if (capturingFor) return;
  capturingFor = actionId;
  api.suspendHotkeys(true);
  button.classList.add('capturing');
  button.textContent = 'press a key…';

  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') return finish(null, true);
    if (e.key === 'Delete' || e.key === 'Backspace') return finish(null, false);

    const accel = toAccelerator(e);
    if (!accel) return; // modifier held on its own — keep waiting
    finish(accel, false);
  };

  async function finish(accel, cancelled) {
    window.removeEventListener('keydown', onKey, true);
    button.classList.remove('capturing');
    capturingFor = null;
    api.suspendHotkeys(false);

    if (!cancelled) {
      const res = await api.setBinding(actionId, accel);
      if (res.ok) {
        bindings = res.bindings;
      } else {
        // e.g. a bare letter, which would fire while typing anywhere.
        log('warn', res.error ?? 'could not bind');
        alert(res.error ?? 'could not bind');
      }
    }
    renderBinder();
  }

  window.addEventListener('keydown', onKey, true);
}

$('#keys').addEventListener('click', async () => {
  const panel = $('#binder');
  const opening = !panel.classList.contains('on');
  panel.classList.toggle('on', opening);
  if (opening) {
    const { actions, bindings: b } = await api.listActions();
    actionSpecs = actions;
    bindings = b;
    renderBinder();
  }
});
$('#binder-close').addEventListener('click', () => $('#binder').classList.remove('on'));

// A limit-price hotkey has no price of its own — main asks for whatever is
// currently typed into that side's box.
api.onRequestLimitPrice(async (side) => {
  const px = $(`#side-${side} .limit-px`);
  const price = Number(px?.value);
  if (!price) {
    log('warn', `no price typed for ${side} — type one in the box first`);
    return;
  }
  const res = await api.sellLimit(side, price);
  if (!res.ok) log('error', res.error);
  else px.value = '';
});

// --- wiring ------------------------------------------------------------------

$('#arm').addEventListener('click', async () => {
  const url = $('#url').value.trim();
  if (!url) return;
  log('info', 'arming…');
  const res = await api.arm(url);
  if (!res.ok) {
    log('error', res.error);
    return;
  }
  const pick = $('#market-pick');
  pick.innerHTML = res.markets
    .map((m) => `<option value="${m.slug}" ${m.slug === res.armed ? 'selected' : ''}>${escapeHtml(m.question)}</option>`)
    .join('');
  pick.style.display = '';
});

$('#market-pick').addEventListener('change', async (e) => {
  const url = $('#url').value.trim();
  if (url) await api.arm(url, e.target.value);
});

$('#dry').addEventListener('click', async () => {
  if (!config) return;
  const goingLive = config.dryRun;
  if (goingLive && !confirm('Switch to LIVE? Hotkeys will place real orders.')) return;
  const res = await api.updateConfig({ ...config, dryRun: !config.dryRun });
  if (res.ok) config = res.config;
});

['A', 'B'].forEach((side) => {
  const root = $(`#side-${side}`);
  $('.sell', root).addEventListener('click', () => api.runAction(`sell${side}`));
  $('.sell-ask', root).addEventListener('click', () => api.runAction(`sellAsk${side}`));
  $('.sell-max', root).addEventListener('click', () => api.runAction(`sellMax${side}`));

  const px = $('.limit-px', root);
  $('.sell-limit', root).addEventListener('click', () => api.runAction(`sellLimit${side}`));

  // The numpad is bound to buy hotkeys and fires even while this window has
  // focus, so typing a price with it would place orders. Suspend while focused.
  px.addEventListener('focus', () => api.suspendHotkeys(true));
  px.addEventListener('blur', () => api.suspendHotkeys(false));
  px.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') $('.sell-limit', root).click();
  });
});

$('#cancel-all').addEventListener('click', async () => {
  const n = lastSnapshot?.openOrders?.length ?? 0;
  if (n === 0) return;
  if (confirm(`Cancel all ${n} resting order(s)?`)) await api.runAction('cancelAll');
});

api.onReady((info) => {
  config = info.config;
  ['A', 'B'].forEach(buildRows);
  log('info', `wallet ${info.wallet.slice(0, 10)}… (type ${info.walletType})`);
  if (info.config.lastEventUrl) $('#url').value = info.config.lastEventUrl;
});
api.onSnapshot(render);
api.onFatal((msg) => log('error', msg));
api.onHotkeyWarning((msg) => log('warn', msg));
api.onHotkeysSuspended((suspended) => {
  $('#paused').classList.toggle('on', Boolean(suspended));
});

/**
 * Stamp every control with its currently configured key.
 *
 * Every action is bindable, so a button that doesn't show its key is a button
 * whose key you have to remember — which is exactly how a working hotkey ends
 * up looking broken.
 */
function paintKeys() {
  ['A', 'B'].forEach((side) => {
    const root = $(`#side-${side}`);
    const set = (sel, actionId) => {
      const k = $(`${sel} .k`, root);
      if (k) k.textContent = keyFor(actionId);
    };
    set('.sell', `sell${side}`);
    set('.sell-ask', `sellAsk${side}`);
    set('.sell-max', `sellMax${side}`);
    set('.sell-limit', `sellLimit${side}`);
  });
  const ca = $('#cancel-all .k');
  if (ca) ca.textContent = keyFor('cancelAll');
  if (config) ['A', 'B'].forEach(buildRows); // buy rows carry their own keys
}

api.onHotkeys((list) => {
  hotkeys = Object.fromEntries((list ?? []).map((h) => [h.label, h.accelerator]));
  paintKeys();

  const failed = (list ?? []).filter((h) => !h.ok);
  if (failed.length) {
    log('warn', `could not bind: ${failed.map((f) => `${f.label} (${f.accelerator})`).join(', ')}`);
  }
});
// `pressed` carries an action id; flash whichever control owns it.
const FLASH_SELECTOR = {
  sellA: '#side-A .sell', sellB: '#side-B .sell',
  sellAskA: '#side-A .sell-ask', sellAskB: '#side-B .sell-ask',
  sellMaxA: '#side-A .sell-max', sellMaxB: '#side-B .sell-max',
  sellLimitA: '#side-A .sell-limit', sellLimitB: '#side-B .sell-limit',
  cancelAll: '#cancel-all',
};
api.onPressed((id) => {
  const buy = /^buy([AB])([123])$/.exec(id);
  const sel = buy ? `.buy[data-side="${buy[1]}"][data-tier="${Number(buy[2]) - 1}"]` : FLASH_SELECTOR[id];
  const el = sel ? $(sel) : null;
  if (el) {
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }
});

// The body sets user-select:none so dragging across the trading controls does
// not select text; the log opts back in, and this copies the whole buffer.
$('#copy-log').addEventListener('click', async () => {
  const text = (lastSnapshot?.recent ?? [])
    .map((e) => `${new Date(e.at).toTimeString().slice(0, 8)}  [${e.level}] ${e.text}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text || '(log empty)');
    const b = $('#copy-log');
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = 'Copy'), 1200);
  } catch {
    log('warn', 'clipboard blocked — select the text and use Cmd/Ctrl+C');
  }
});

// --- tabs, inventory, watch --------------------------------------------------

let unseenWatched = 0;

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    ['trade', 'inventory', 'watch'].forEach((v) => {
      $(`#view-${v}`).style.display = v === t.dataset.tab ? '' : 'none';
    });
    if (t.dataset.tab === 'watch') {
      unseenWatched = 0;
      $('#watch-badge').textContent = '';
      $('#watch-badge').classList.remove('hot');
    }
  }),
);

/** Everything the account holds, not just the armed market. */
function renderInventory(inv) {
  $('#inv-count').textContent = inv.length;
  const total = inv.reduce((s, p) => s + p.pnl, 0);
  const value = inv.reduce((s, p) => s + p.shares * (p.curPrice || 0), 0);
  $('#inv-total').innerHTML = inv.length
    ? `total value <b>${money(value)}</b> &nbsp; P&amp;L <span class="${total >= 0 ? 'up' : 'down'}">${signedMoney(total)}</span>`
    : '';

  const host = $('#invlist');
  if (!inv.length) {
    host.innerHTML = '<div class="none">nothing held</div>';
    return;
  }
  host.innerHTML =
    `<div class="irow ihead">
       <span>position</span><span class="num">shares</span><span class="num">avg → now</span>
       <span class="num">cost</span><span class="num">value</span><span class="num">P&amp;L</span>
     </div>` +
    inv
      .map((p) => {
        const value = p.shares * (p.curPrice || 0);
        const cost = p.shares * p.avgPrice;
        const pct = cost === 0 ? 0 : (p.pnl / cost) * 100;
        return `<div class="irow">
        <span><b>${escapeHtml(p.outcome)}</b><br><span class="wmkt">${escapeHtml(p.title)}</span></span>
        <span class="num">${p.shares}</span>
        <span class="num">${fmt(p.avgPrice, 3)} → ${fmt(p.curPrice, 3)}</span>
        <span class="num dimlab">${money(cost)}</span>
        <span class="num">${money(value)}</span>
        <span class="num ${p.pnl >= 0 ? 'up' : 'down'}">${signedMoney(p.pnl)}<br>
          <span class="pct">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span></span>
      </div>`;
      })
      .join('');
}

/** Another trader's fills — side, size, team, and the price they got. */
function renderWatch(trades, status) {
  const s = $('#watch-status');
  if (status) {
    const age = status.lastPollAt ? Math.round((Date.now() - status.lastPollAt) / 1000) : null;
    s.textContent = status.error
      ? `error: ${status.error}`
      : age === null
        ? 'starting…'
        : `updated ${age}s ago`;
  }
  const host = $('#watchlist');
  if (!trades?.length) {
    host.innerHTML = '<div class="none">no trades seen yet</div>';
    return;
  }
  host.innerHTML = trades
    .map(
      (t) => `<div class="wrow ${t.isArmedMarket ? 'mine' : ''}">
        <span class="wtime">${ago(t.at)}<br><span class="pct">${clock(t.at)}</span></span>
        <span class="wside ${t.side}">${t.side}</span>
        <span>${escapeHtml(t.outcome)} <span class="wmkt">${escapeHtml(t.title)}</span></span>
        <span class="num">${t.size} sh</span>
        <span class="num">@ ${fmt(t.price, 3)}</span>
        <span class="num">$${fmt(t.usdc)}</span>
      </div>`,
    )
    .join('');
}

$('#watch-addr').addEventListener('change', async (e) => {
  const addr = e.target.value.trim();
  if (addr && !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    log('error', 'that is not a 40-character wallet address');
    return;
  }
  await api.setWatchWallet(addr);
});
$('#watch-addr').addEventListener('focus', () => api.suspendHotkeys(true));
$('#watch-addr').addEventListener('blur', () => api.suspendHotkeys(false));
$('#watch-addr').addEventListener('keydown', (e) => e.stopPropagation());

// Alert even when the Watch tab isn't showing.
api.onWatchedTrade((t) => {
  if (!$('#view-watch').style.display) return; // already looking at it
  unseenWatched += 1;
  const badge = $('#watch-badge');
  badge.textContent = unseenWatched;
  badge.classList.add('hot');
});
