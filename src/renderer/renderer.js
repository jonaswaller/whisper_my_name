/**
 * HUD. Plain JS on purpose — no framework, no build step for this file.
 *
 * Buttons and hotkeys take the SAME path: both call api.fire(action), which the
 * main process handles identically. The button face carries its hotkey number
 * so the UI teaches the keys while he uses it.
 */

const KEYS = { A: ['1', '2', '3'], B: ['4', '5', '6'] };
let config = null;
let lastSnapshot = null;

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n, dp = 2) => (n === null || n === undefined ? '–' : Number(n).toFixed(dp));

/** Build the three buy rows for a side. Inputs are live-editable. */
function buildRows(side) {
  const host = $(`#side-${side} .rows`);
  host.innerHTML = '';
  (config?.tiers ?? []).forEach((tier, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="key">${KEYS[side][i]}</div>
      <button class="buy" data-side="${side}" data-tier="${i}">
        <div class="lbl">${tier.label}</div>
        BUY $${tier.notional} · ${tier.slippageCents}c
      </button>
      <input class="size" type="number" min="1" step="1" value="${tier.notional}" data-tier="${i}" title="order size in dollars" />
      <input class="slip" type="number" min="0" max="99" step="1" value="${tier.slippageCents}" data-tier="${i}" title="slippage tolerance in cents" />
      <div class="cap" data-tier="${i}">–</div>`;
    host.appendChild(row);
  });

  host.querySelectorAll('.buy').forEach((btn) =>
    btn.addEventListener('click', () =>
      api.fire({ kind: 'buy', side: btn.dataset.side, tier: Number(btn.dataset.tier) }),
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
  const field = input.classList.contains('size') ? 'notional' : 'slippageCents';

  const tiers = config.tiers.map((tier, i) =>
    i === index ? { ...tier, [field]: Number(input.value) } : { ...tier },
  );
  const res = await api.updateConfig({ ...config, tiers });
  if (!res.ok) {
    log('error', res.error);
    return;
  }
  config = res.config;
  // Re-render both sides so the edit shows on whichever one wasn't touched.
  ['A', 'B'].forEach(buildRows);
}

function renderSide(side, view) {
  const root = $(`#side-${side}`);
  $('h2', root).textContent = view.name;
  $('.bid', root).textContent = fmt(view.bid);
  $('.ask', root).textContent = fmt(view.ask);
  $('.sz', root).textContent =
    view.bid === null ? '' : `${Math.round(view.bidSize)} x ${Math.round(view.askSize)}`;

  const pos = $('.pos', root);
  if (view.shares > 0) {
    const sign = view.unrealizedPnl >= 0 ? '+' : '';
    pos.innerHTML = `<b>${view.shares}</b> sh @ ${fmt(view.avgPrice)} &nbsp; ${sign}$${fmt(view.unrealizedPnl)}`;
  } else {
    pos.textContent = 'flat';
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

function render(snap) {
  lastSnapshot = snap;
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

  renderSide('A', snap.A);
  renderSide('B', snap.B);
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

['A', 'B'].forEach((side) =>
  $(`#side-${side} .sell`).addEventListener('click', () => api.fire({ kind: 'sell', side })),
);

api.onReady((info) => {
  config = info.config;
  ['A', 'B'].forEach(buildRows);
  log('info', `wallet ${info.wallet.slice(0, 10)}… (type ${info.walletType})`);
  if (info.config.lastEventUrl) $('#url').value = info.config.lastEventUrl;
});
api.onSnapshot(render);
api.onFatal((msg) => log('error', msg));
api.onHotkeyWarning((msg) => log('warn', msg));
api.onPressed((action) => {
  const sel =
    action.kind === 'sell'
      ? `#side-${action.side} .sell`
      : `.buy[data-side="${action.side}"][data-tier="${action.tier}"]`;
  const el = $(sel);
  if (el) {
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }
});
