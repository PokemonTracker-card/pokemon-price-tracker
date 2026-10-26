'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANG = { en: '🇺🇸 EN', ja: '🇯🇵 JP', 'zh-tw': '繁中', 'zh-cn': '简中' };
const LANGNAME = { en: 'English', ja: 'Japanese', 'zh-tw': 'Chinese (Traditional)', 'zh-cn': 'Chinese (Simplified)' };
const fmt = (v, cur = 'USD') => v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
const S = { pokemon: [], current: null, cards: [], lang: 'all', shown: 48, user: null, chart: null, scale: 'logarithmic', status: null };

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }

// ---------- price helpers ----------
const bestVariant = c => {
  if (c.source === 'tcgdex') return null;
  const ps = c.prices.filter(p => p.market != null);
  if (ps.length) return ps.reduce((a, b) => b.market > a.market ? b : a);
  const ms = c.prices.filter(p => p.mid != null);
  return ms.length ? ms.reduce((a, b) => b.mid > a.mid ? b : a) : null;
};
const cardPrice = c => { if (c.source === 'tcgdex') return c.cardmarket?.current ?? null; if (c.source === 'cardprice') return c.cp?.sortPrice ?? null; const v = bestVariant(c); return v ? (v.market ?? v.mid) : null; };
const cardCur = () => 'USD'; // everything is shown in USD; Cardmarket (EUR) prices are converted server-side at the daily ECB rate
const fxNote = cm => `converted from EUR at 1 EUR = $${(cm?.eurRate || S.status?.fx?.eurUsd || 0).toFixed(4)}`;
const priceLabel = c => { if (c.source === 'tcgdex') return 'Cardmarket trend · converted from EUR'; if (c.source === 'cardprice') return `raw · ${(c.cp?.latestSource || 'CardPrice').replace(' (via CardPrice)', ' via CardPrice')} · thin data`; const v = bestVariant(c); return v ? (v.market != null ? `market · ${v.sub}` : `asking only (listing mid, no recent sale) · ${v.sub}`) : ''; };
const evBadge = c => c.event ? `<span class="badge ev ${c.event.kind}">${c.event.kind === 'prize' ? '🏆 ' : '🎟 '}${esc(c.event.label)}</span>` : '';
const noTcgPrice = c => c.source === 'tcgcsv' && !c.prices.some(p => p.market != null || p.mid != null);
const hasMarket = c => c.source === 'tcgcsv' && c.prices.some(p => p.market != null);
const packPrice = p => p ? (p.market ?? p.mid ?? null) : null;

// ---------- status ----------
async function loadStatus() {
  try {
    const s = S.status = await api('/api/status');
    if (!s.ready) { $('#fresh').textContent = `Building price index… ${s.progress.done}/${s.progress.total} sets`; setTimeout(loadStatus, 2000); return; }
    const d = new Date(s.pricesUpdated);
    $('#fresh').innerHTML = `<span class="dot"></span>Prices updated ${esc(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))} · ${s.cards.toLocaleString()} cards · ${s.sets} sets`;
  } catch { $('#fresh').textContent = 'Price server unavailable'; }
}

// ---------- autocomplete ----------
let acIdx = -1, acItems = [];
function renderAC() {
  const q = $('#q').value.trim().toLowerCase();
  const ac = $('#ac');
  if (!q) { ac.hidden = true; return; }
  const n = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  acItems = S.pokemon.filter(p => p.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(n))
    .sort((a, b) => (b.name.toLowerCase().startsWith(n)) - (a.name.toLowerCase().startsWith(n)) || a.id - b.id).slice(0, 8);
  if (/^\d+$/.test(q)) acItems = S.pokemon.filter(p => String(p.id).startsWith(q)).slice(0, 8);
  acIdx = acItems.length ? 0 : -1;
  ac.innerHTML = acItems.map((p, i) => `<li role="option" data-i="${i}" class="${i === acIdx ? 'on' : ''}"><img src="${esc(p.sprite)}" alt="" loading="lazy"><span>${esc(p.name)}</span><span class="num">#${String(p.id).padStart(4, '0')}</span></li>`).join('') || `<li class="muted">No Pokémon named “${esc(q)}”</li>`;
  ac.hidden = false;
}
$('#q').addEventListener('input', renderAC);
$('#q').addEventListener('keydown', e => {
  const lis = [...$('#ac').querySelectorAll('li[data-i]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!lis.length) return; acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length; lis.forEach((l, i) => l.classList.toggle('on', i === acIdx)); lis[acIdx].scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { e.preventDefault(); if (acItems[acIdx]) choose(acItems[acIdx]); }
  else if (e.key === 'Escape') $('#ac').hidden = true;
});
$('#ac').addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(acItems[+li.dataset.i]); } });
$('#q').addEventListener('blur', () => setTimeout(() => $('#ac').hidden = true, 120));

function renderChips() {
  const favs = (S.user?.favorites || []).map(n => S.pokemon.find(p => p.name === n)).filter(Boolean);
  const pop = ['Charizard', 'Pikachu', 'Umbreon', 'Mewtwo', 'Gengar', 'Rayquaza', 'Lugia', 'Eevee'].map(n => S.pokemon.find(p => p.name === n)).filter(Boolean).filter(p => !favs.includes(p));
  $('#chips').innerHTML = favs.map(p => `<button class="chip fav" data-n="${esc(p.name)}"><img src="${esc(p.sprite)}" alt="">★ ${esc(p.name)}</button>`).join('') +
    pop.map(p => `<button class="chip" data-n="${esc(p.name)}"><img src="${esc(p.sprite)}" alt="">${esc(p.name)}</button>`).join('');
}
$('#chips').addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (b) choose(S.pokemon.find(p => p.name === b.dataset.n)); });
$('#langs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.lang = b.dataset.l; [...$('#langs').children].forEach(x => x.classList.toggle('on', x === b));
  if (S.current) choose(S.current, true);
});

// ---------- search ----------
async function choose(p, keepUrl) {
  if (!p) return;
  S.current = p; $('#q').value = p.name; $('#ac').hidden = true; $('#empty').hidden = true; $('#results').hidden = false;
  if (!keepUrl) history.replaceState(null, '', `?pokemon=${encodeURIComponent(p.name)}${S.lang !== 'all' ? '&lang=' + S.lang : ''}`);
  $('#pkSprite').src = p.sprite; $('#pkName').textContent = p.name; $('#pkMeta').textContent = `Pokédex #${String(p.id).padStart(4, '0')} · loading cards…`;
  $('#grid').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#stats').innerHTML = ''; $('#notes').textContent = ''; updateFav();
  const langs = S.lang === 'all' ? 'en,ja,zh-tw,zh-cn' : S.lang;
  try {
    const r = await api(`/api/search?name=${encodeURIComponent(p.name)}&langs=${langs}`);
    if (S.current !== p) return;
    S.cards = r.cards; S.shown = 48;
    const notes = [...r.notes];
    const zhSel = S.lang === 'all' || S.lang.startsWith('zh');
    if (zhSel && r.cards.some(c => c.source === 'tcgdex')) notes.push('Chinese cards: prices are Cardmarket trend prices from TCGdex, converted from EUR to USD at the daily ECB rate (Cardmarket may not separate Chinese printings from other languages), there is no booster pack price source, and no pull-rate data.');
    if (S.lang === 'ja' || S.lang === 'all') notes.push('Japanese cards use TCGplayer USD prices; pull rates are only published for English sets.');
    $('#notes').innerHTML = notes.map(esc).join('<br>');
    const counts = Object.entries(r.cards.reduce((a, c) => (a[c.lang] = (a[c.lang] || 0) + 1, a), {})).map(([l, n]) => `${n} ${LANGNAME[l]}`).join(' · ');
    $('#pkMeta').textContent = `Pokédex #${String(p.id).padStart(4, '0')} · ${r.cards.length} cards found${counts ? ' (' + counts + ')' : ''}`;
    renderStats(); renderChart(); renderGrid();
  } catch (e) {
    $('#grid').innerHTML = `<div class="notes">${esc(e.message)}</div>`;
    if (e.status === 503) setTimeout(() => choose(p, true), 3000);
  }
}

function renderStats() {
  const usd = S.cards.filter(hasMarket);
  const prices = usd.map(cardPrice).sort((a, b) => a - b);
  const top = usd.slice().sort((a, b) => cardPrice(b) - cardPrice(a))[0];
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const packs = new Map(); S.cards.forEach(c => { if (c.pack && packPrice(c.pack) != null) packs.set(c.pack.id, c.pack); });
  const cheapest = [...packs.values()].sort((a, b) => packPrice(a) - packPrice(b))[0];
  const pulls = S.cards.filter(c => c.pull?.known && c.pull.specificOneIn).sort((a, b) => b.pull.specificOneIn - a.pull.specificOneIn)[0];
  $('#stats').innerHTML = [
    ['Most valuable', top ? fmt(cardPrice(top)) : '—', top ? `${top.name} · ${top.set.name}` : 'No priced cards'],
    ['Median card', fmt(median), `${prices.length} printings with a TCGplayer market price`],
    ['Cheapest pack', cheapest ? fmt(packPrice(cheapest)) : '—', cheapest ? cheapest.name : 'No pack prices'],
    ['Hardest pull', pulls ? `1 in ${pulls.pull.specificOneIn.toLocaleString()}` : '—', pulls ? `${pulls.name} · ${pulls.set.name}` : 'No pull-rate data for these sets'],
  ].map(([k, v, d]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="d" title="${esc(d)}">${esc(d)}</div></div>`).join('');
}

function renderChart() {
  const top = S.cards.filter(hasMarket).sort((a, b) => cardPrice(b) - cardPrice(a)).slice(0, 15);
  const labels = top.map(c => `${c.name.replace(/\s-\s.*$/, '')} ${c.number ? '#' + c.number.split('/')[0] : ''} · ${c.set.abbr || c.set.name}${c.lang === 'ja' ? ' (JP)' : ''}`);
  if (S.chart) S.chart.destroy();
  S.chart = new Chart($('#mainChart'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Card — TCGplayer market price', data: top.map(cardPrice), backgroundColor: 'rgba(250,204,21,.85)', borderRadius: 6, maxBarThickness: 40 },
      { label: 'Booster pack from that set — market price', data: top.map(c => packPrice(c.pack)), backgroundColor: 'rgba(96,165,250,.75)', borderRadius: 6, maxBarThickness: 40 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => { if (els[0]) openCard(top[els[0].index]); },
      scales: {
        x: { ticks: { color: '#8b93ab', maxRotation: 60, minRotation: 35, font: { size: 11 } }, grid: { display: false } },
        y: { type: S.scale, ticks: { color: '#8b93ab', callback: v => (S.scale === 'logarithmic' && ![1, 10, 100, 1000, 10000, 100000].includes(v)) ? '' : fmt(v) }, grid: { color: '#1f2435' } },
      },
      plugins: {
        legend: { labels: { color: '#e7eaf3' } },
        tooltip: { callbacks: {
          title: items => top[items[0].dataIndex].name + ' — ' + top[items[0].dataIndex].set.name,
          label: it => `${it.dataset.label}: ${it.raw == null ? 'no price' : fmt(it.raw)}`,
          afterBody: items => { const c = top[items[0].dataIndex]; return c.pack ? [`Pack: ${c.pack.name}`] : ['No single booster pack for this set']; },
        } },
      },
    },
  });
}
$('#scaleSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.scale = b.dataset.s; [...$('#scaleSeg').children].forEach(x => x.classList.toggle('on', x === b)); renderChart(); });

function filtered() {
  const f = $('#filter').value.trim().toLowerCase();
  let list = S.cards.filter(c => !f || `${c.name} ${c.set.name} ${c.rarity || ''} ${c.number || ''}`.toLowerCase().includes(f));
  if ($('#pricedOnly').checked) list = list.filter(c => cardPrice(c) != null);
  const date = c => c.set.released ? Date.parse(c.set.released) : 0;
  const sorts = {
    price: (a, b) => (cardPrice(b) ?? -1) - (cardPrice(a) ?? -1), // most expensive first, unpriced last
    priceAsc: (a, b) => (cardPrice(a) ?? 1e12) - (cardPrice(b) ?? 1e12),
    newest: (a, b) => date(b) - date(a), oldest: (a, b) => (date(a) || 1e15) - (date(b) || 1e15),
    pull: (a, b) => (b.pull?.specificOneIn || 0) - (a.pull?.specificOneIn || 0),
  };
  return list.sort(sorts[$('#sort').value]);
}
function cardTile(c, idx) {
    const pr = cardPrice(c), cur = cardCur(c);
    const pp = packPrice(c.pack);
    return `<article class="c" data-i="${idx}">
      <div class="img">${c.img ? `<img src="${esc(c.img)}" alt="${esc(c.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'noimg',textContent:'No image'}))">` : '<span class="noimg">No image</span>'}
        <span class="badge">${LANG[c.lang]}</span>${c.edition === '1st' ? '<span class="badge ed1">1st Ed</span>' : ''}${c.kind === 'trainer' ? '<span class="badge t">Trainer/Energy</span>' : ''}${evBadge(c)}${c.rarity && c.rarity !== 'None' ? `<span class="badge r">${esc(c.rarity)}</span>` : ''}</div>
      <div class="body">
        <div class="name">${esc(c.name)}</div>${c.editionLabel ? `<div class="edl ${c.edition === '1st' ? 'first' : ''}">${esc(c.editionLabel)}</div>` : ''}
        <div class="set">${esc(c.set.name)}${c.number ? ' · #' + esc(c.number) : ''}</div>
        ${pr != null ? `<div class="price">${fmt(pr, cur)}<small>${esc(priceLabel(c))}</small></div>` : c.source === 'cardprice' ? `<div class="price na">${c.cp?.suspicious ? 'No reliable raw price' : 'No sales data'}<small>${c.event?.curated ? 'not on TCGplayer · open for graded values &amp; links' : ''}</small></div>` : c.event ? '<div class="price na">No TCGplayer price<small>open for sale history, CardPrice data &amp; links</small></div>' : '<div class="price na">No current price</div>'}
        <div class="pull">${c.pull?.known ? `🎲 ${esc(c.pull.tier)}: 1 in ${c.pull.tierOneIn} packs${c.pull.specificOneIn ? ` · this card ≈1 in ${c.pull.specificOneIn.toLocaleString()}` : ''}` : '<span class="muted">🎲 Pull rate unknown</span>'}</div>
        <div class="packrow">${c.pack ? `${c.pack.img ? `<img src="${esc(c.pack.img)}" alt="" loading="lazy">` : ''}<span>Pack: <b>${pp != null ? fmt(pp) : 'no recent sales'}</b><br><span class="muted">${esc(c.pack.name.length > 38 ? c.pack.name.slice(0, 36) + '…' : c.pack.name)}</span></span>` : `<span class="muted">${esc(c.packNote || 'No pack price')}</span>`}</div>
      </div></article>`;
}
function renderGrid() {
  const list = filtered();
  const slice = list.slice(0, S.shown);
  $('#grid').innerHTML = slice.map(c => cardTile(c, S.cards.indexOf(c))).join('') || '<div class="muted">No cards match.</div>';
  $('#moreBtn').hidden = list.length <= S.shown;
  $('#moreBtn').textContent = `Show more (${list.length - S.shown} left)`;
}
['input', 'change'].forEach(ev => { $('#filter').addEventListener(ev, () => { S.shown = 48; renderGrid(); }); });
$('#sort').addEventListener('change', renderGrid); $('#pricedOnly').addEventListener('change', renderGrid);
$('#moreBtn').addEventListener('click', () => { S.shown += 48; renderGrid(); });
$('#grid').addEventListener('click', e => { const a = e.target.closest('.c'); if (a) openCard(S.cards[+a.dataset.i]); });

// ---------- card detail ----------
let miniCharts = [];
function openModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal(m) { m.hidden = true; if (![...document.querySelectorAll('.modal')].some(x => !x.hidden)) document.body.style.overflow = ''; }
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) closeModal(m); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => !m.hidden && closeModal(m)); });

function alertForm(kind, c, variants) {
  if (!S.user) return `<div class="muted small">Log in to set a price alert. <a href="#" data-login>Log in</a></div>`;
  const sym = '$';
  if (kind === 'card' && (c.source === 'cardprice' || noTcgPrice(c))) {
    // Prize/trophy cards (and cards TCGplayer has no price for) alert on CardPrice's raw price or a graded value.
    const cpId = c.source === 'cardprice' ? c.cpId : `tcg-${c.id}`;
    return `<form class="alertform" data-kind="card" data-src="cardprice" data-id="${esc(cpId)}" data-lang="${esc(c.lang)}">
    <select name="field" title="Which price"><option value="raw">Raw (ungraded) price</option><option value="psa10">PSA 10</option><option value="grade9">Grade 9</option><option value="grade8">Grade 8</option><option value="cgc10">CGC 10</option></select>
    <select name="mode" title="Alert type"><option value="percent" selected>Below % of 30-day avg</option><option value="target">At/below fixed price</option></select>
    <span class="pm"><input name="percent" type="number" min="1" max="99" step="1" value="75" required aria-label="Percent of average"><span class="muted small">% of avg</span></span>
    <span class="tm" hidden><input name="target" type="number" min="0.01" step="0.01" placeholder="${sym} target" aria-label="Target price"></span>
    <button class="btn sm" type="submit">🔔 Set alert</button>
    <div class="aq muted small">Loading CardPrice price…</div><div class="muted small">Source: CardPrice (thin data). Graded alerts use a fixed target — there's no graded history to average.</div></form>`;
  }
  return `<form class="alertform" data-kind="${kind}" data-id="${esc(kind === 'pack' ? c.pack.id : (c.source === 'tcgdex' ? c.tcgdexId : c.id))}" data-src="${esc(c.source || 'tcgcsv')}" data-lang="${esc(c.lang)}">
    ${variants && variants.length > 1 ? `<select name="sub">${variants.map(v => `<option>${esc(v)}</option>`).join('')}</select>` : ''}
    <select name="mode" title="Alert type"><option value="percent" selected>Below % of 30-day avg</option><option value="target">At/below fixed price</option></select>
    <span class="pm"><input name="percent" type="number" min="1" max="99" step="1" value="75" required aria-label="Percent of average"><span class="muted small">% of avg</span></span>
    <span class="tm" hidden><input name="target" type="number" min="0.01" step="0.01" placeholder="${sym} target" aria-label="Target price"></span>
    <button class="btn sm" type="submit">🔔 Set alert</button>
    <div class="aq muted small">Loading 30-day average…</div></form>`;
}
// Fetch current price + average and show the trigger price for the alert form.
async function refreshQuote(f) {
  if (f.field && f.field.value !== 'raw' && f.mode.value === 'percent') f.mode.value = 'target';
  const isPct = f.mode.value === 'percent';
  f.querySelector('.pm').hidden = !isPct; f.querySelector('.tm').hidden = isPct;
  f.percent.required = isPct; f.target.required = !isPct;
  const q = new URLSearchParams({ kind: f.dataset.kind, percent: f.percent.value || 75 });
  if (f.dataset.src === 'tcgdex' && f.dataset.kind === 'card') { q.set('source', 'tcgdex'); q.set('tcgdexId', f.dataset.id); q.set('lang', f.dataset.lang); }
  else if (f.dataset.src === 'cardprice') { q.set('source', 'cardprice'); q.set('cpId', f.dataset.id); q.set('field', f.field.value); if (+f.target.value > 0) q.set('target', f.target.value); }
  else { q.set('productId', f.dataset.id); if (f.sub) q.set('subType', f.sub.value); }
  const box = f.querySelector('.aq'); const seq = (f._seq = (f._seq || 0) + 1);
  try {
    const r = await api(`/api/alerts/quote?${q}`); if (seq !== f._seq) return;
    const cur = r.currency;
    const avg = r.average != null ? `30-day avg <b>${fmt(r.average, cur)}</b> <span title="${esc(r.averageBasis)}">(${esc(r.averageBasis)})</span>` : `No average yet (${esc(r.averageBasis)})`;
    const trig = isPct ? (r.triggerPrice != null ? ` · alert when below <b>${fmt(r.triggerPrice, cur)}</b> (${esc(f.percent.value || 75)}% of avg)` : ' · can\u2019t compute a trigger until an average exists')
      : (+f.target.value > 0 ? ` · alert at or below <b>${fmt(+f.target.value, cur)}</b>` : '');
    if (f.dataset.src === 'cardprice' && r.current == null) { box.innerHTML = `No CardPrice ${esc(r.fieldLabel || 'price')} for this card right now — an alert will wait until one appears.${!isPct && +f.target.value > 0 ? ` Alert at or below <b>${fmt(+f.target.value, cur)}</b>.` : ''}`; return; }
    box.innerHTML = `Now <b>${fmt(r.current, cur)}</b>${r.percentOfAverage != null ? ` (${r.percentOfAverage}% of avg)` : ''} · ${avg}${trig}`;
  } catch (e) { if (seq === f._seq) box.textContent = `Couldn't load the average: ${e.message}`; }
}
function initAlertForms() { document.querySelectorAll('#cardBody .alertform').forEach(refreshQuote); }
async function openCard(c) {
  miniCharts.forEach(ch => ch.destroy()); miniCharts = [];
  const cur = cardCur(c);
  const variants = c.prices.map(p => p.sub);
  const isCP = c.source === 'cardprice';
  const priceRows = isCP ? '' : c.source === 'tcgdex'
    ? (c.cardmarket ? `<tr><td>Cardmarket</td><td>${fmt(c.cardmarket.trend)}</td><td>${fmt(c.cardmarket.low)}</td><td>${fmt(c.cardmarket.avg)}</td><td>—</td></tr>` : '<tr><td colspan="5" class="muted">No price data</td></tr>')
    : c.prices.map(p => `<tr><td>${esc(p.sub)}</td><td><b>${fmt(p.market)}</b></td><td>${fmt(p.low)}</td><td>${fmt(p.mid)}</td><td>${fmt(p.high)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No listings</td></tr>';
  const pp = packPrice(c.pack);
  $('#cardBody').innerHTML = `<div class="detail">
    <div>${c.img ? `<img class="big" src="${esc(c.img.replace('_200w', '_in_1000x1000'))}" onerror="this.onerror=null;this.src='${esc(c.img)}'" alt="${esc(c.name)}">` : ''}</div>
    <div>
      <h2>${esc(c.name)}${c.edition === '1st' ? ' <span class="badge ed1 inl">1st Ed</span>' : ''}</h2>
      ${c.editionLabel ? `<div class="edl big ${c.edition === '1st' ? 'first' : ''}">${esc(c.editionLabel)} printing</div>` : ''}
      ${(c.otherEditions || []).map(o => `<div class="muted small">Other printing of this card: <b>${esc(o.label)}</b> — ${o.price != null ? fmt(o.price) : 'no price'} (listed separately)</div>`).join('')}
      <div class="kv"><span>Set</span><span>${esc(c.set.name)}</span><span>Number</span><span>${esc(c.number || '—')}</span><span>Rarity</span><span>${esc(c.rarity || '—')}</span><span>Language</span><span>${LANGNAME[c.lang]}</span>${c.set.released ? `<span>Released</span><span>${new Date(c.set.released).toLocaleDateString()}</span>` : ''}</div>
      ${c.event ? `<div class="evnote">${evBadge(c).replace('class="badge', 'class="badge inl')} ${esc(c.event.note || (c.event.kind === 'prize' ? 'Tournament/contest prize card — very few copies exist and sales are rare.' : 'Event / staff / championship promo — distributed at events, so sales can be infrequent.'))}</div>` : ''}
      <div class="box"><h4>Sales data${c.event || isCP ? ' · thin market' : ''}</h4><div id="salesArea" class="muted small">Loading sale history…</div></div>
      ${isCP ? `<div class="box"><h4>Current price (CardPrice, USD)</h4>
        <div>${c.cp?.latest != null && !c.cp.suspicious ? `<span class="price" style="font-size:20px">${fmt(c.cp.latest)}</span> <span class="muted small">raw/ungraded · ${esc(c.cp.latestSource || 'CardPrice')}</span>` : c.cp?.suspicious ? `<b>No reliable raw price</b> <span class="muted small">— CardPrice lists ${fmt(c.cp.latest)} ungraded, under 1% of this card's graded values, so it's treated as a bad record.</span>` : '<b>No sales data</b> <span class="muted small">— no raw price recorded for this card.</span>'}</div>
        <div class="muted small">Not listed on TCGplayer. ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">CardPrice ↗</a> · ` : ''}<a href="${esc(c.links.ebay)}" target="_blank" rel="noopener">eBay sold ↗</a> · <a href="${esc(c.links.pricecharting)}" target="_blank" rel="noopener">PriceCharting ↗</a> · <a href="${esc(c.links.psa)}" target="_blank" rel="noopener">PSA ↗</a></div>
        ${alertForm('card', c, [])}</div>` : `
      <div class="box"><h4>Current prices ${c.source === 'tcgdex' ? '(Cardmarket via TCGdex, USD converted from EUR)' : '(TCGplayer, USD)'}</h4>
        <table class="t"><thead><tr><th>${c.source === 'tcgdex' ? 'Source' : 'Variant'}</th><th>${c.source === 'tcgdex' ? 'Trend' : 'Market'}</th><th>Low</th><th>${c.source === 'tcgdex' ? 'Avg' : 'Mid'}</th><th>High</th></tr></thead><tbody>${priceRows}</tbody></table>
        <div class="muted small">${c.source === 'tcgdex' ? `Prices ${fxNote(c.cardmarket)} (ECB daily reference rate). Updated ${c.cardmarket?.updated ? new Date(c.cardmarket.updated).toLocaleString() : '—'}.` : `“Market” is TCGplayer's recent-sales market price; low/mid/high are current listings. Updated ${new Date(S.status?.pricesUpdated).toLocaleString()}.`}
        ${c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">View on ${c.source === 'tcgdex' ? 'Cardmarket' : 'TCGplayer'} ↗</a>` : ''}</div>
        ${alertForm('card', c, variants)}
      </div>`}
      <div class="box"><h4>Graded prices (PSA · BGS · CGC · SGC)</h4><div id="gradedArea" class="muted small">Loading graded prices…</div></div>
      <div class="box"><h4>Booster pack it came from</h4>
        ${c.pack ? `<div class="row" style="align-items:center">${c.pack.img ? `<img src="${esc(c.pack.img)}" style="width:54px;border-radius:6px" alt="">` : ''}<div class="grow"><b>${esc(c.pack.name)}</b><br><span class="price" style="font-size:18px">${pp != null ? fmt(pp) : 'No recent sales'}</span> <span class="muted small">${c.pack.market != null ? 'TCGplayer market' : c.pack.mid != null ? 'listing mid' : ''}${c.pack.fromParent ? ` · pack of parent set “${esc(c.pack.fromParent)}”` : ''}</span><br><a href="${esc(c.pack.url)}" target="_blank" rel="noopener">View pack on TCGplayer ↗</a></div></div>
          ${pp != null && cardPrice(c) != null && cur === 'USD' ? `<div class="muted small" style="margin-top:6px">This card is worth ≈ ${Math.max(0, cardPrice(c) / pp).toFixed(cardPrice(c) / pp < 10 ? 1 : 0)} packs.</div>` : ''}
          ${alertForm('pack', c)}` : `<div class="muted">${esc(c.packNote)}</div>`}
      </div>
      <div class="box"><h4>Pull rate</h4>
        ${c.pull?.known ? `<div><b>${esc(c.pull.tier)}</b>: about <b>1 in ${c.pull.tierOneIn} packs</b> contains one.</div>
          ${c.pull.specificOneIn ? `<div>This exact card: ≈ <b>1 in ${c.pull.specificOneIn.toLocaleString()} packs</b> <span class="muted small">(${c.pull.cardsInTier} ${esc(c.pull.tier)} cards in the set, assuming each is equally likely)</span></div>` : ''}
          ${pp != null && c.pull.specificOneIn ? `<div class="muted small">Expected cost to pull it from packs ≈ ${fmt(pp * c.pull.specificOneIn)} vs. ${fmt(cardPrice(c))} to buy the single.</div>` : ''}
          <div class="muted small">Source: <a href="${esc(c.pull.sourceUrl)}" target="_blank" rel="noopener">${esc(c.pull.source)}</a>, as of ${esc(c.pull.asOf)}.</div>`
          : `<div class="muted">Unknown — ${esc(c.pull?.reason || 'no data')}.</div>`}
      </div>
      ${isCP ? '' : `<div class="box"><h4>Price trend</h4><div id="trendArea" class="muted small">Loading Cardmarket averages…</div></div>`}
    </div></div>`;
  openModal('#cardModal'); initAlertForms();
  loadGraded(c); loadSales(c);
  if (isCP) return;
  // Trend: Cardmarket 30/7/1-day averages + our own recorded daily TCGplayer snapshots
  const area = $('#trendArea');
  let cm = null;
  if (c.source === 'tcgdex') cm = c.cardmarket ? { found: true, ...c.cardmarket, unit: 'USD' } : { found: false, reason: 'No Cardmarket data' };
  else { try { cm = await api(`/api/trend?productId=${c.id}&dexId=${(c.dexId !== undefined ? c.dexId : S.current?.id) || ''}`); } catch (e) { cm = { found: false, reason: e.message }; } }
  const hist = (c.history || []).filter(h => h.points.length);
  const days = new Set(hist.flatMap(h => h.points.map(p => p.d)));
  let html = '';
  if (cm.found) html += `<div class="minichart"><canvas id="cmChart"></canvas></div><div class="muted small">Cardmarket average sale price over the last 30 days, 7 days and 1 day, plus Cardmarket's trend price (USD, ${esc(fxNote(cm))}). Updated ${cm.updated ? esc(new Date(cm.updated).toLocaleString()) : '—'}${cm.url ? ` · <a href="${esc(cm.url)}" target="_blank" rel="noopener">Cardmarket ↗</a>` : ''}.</div>`;
  else html += `<div class="muted small">Cardmarket averages: unavailable — ${esc(cm.reason)}.</div>`;
  if (cm.found && c.edition) html += `<div class="muted small">⚠️ Cardmarket doesn't split this card by edition, so this chart mixes 1st Edition/Shadowless/Unlimited sales. The TCGplayer history below is edition-specific.</div>`;
  if (c.source === 'tcgcsv') html += days.size >= 2
    ? `<div class="minichart" style="margin-top:12px"><canvas id="histChart"></canvas></div><div class="muted small">Daily TCGplayer market price recorded by this site (${days.size} days).</div>`
    : `<div class="muted small" style="margin-top:10px">Daily TCGplayer price history: this site started recording on ${esc([...(S.status?.historyDays || [])][0] || 'today')} — a line chart appears here once there are 2+ days of snapshots (TCGplayer doesn't publish history).</div>`;
  area.innerHTML = html;
  const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e7eaf3' } } }, scales: { x: { ticks: { color: '#8b93ab' }, grid: { color: '#1f2435' } }, y: { ticks: { color: '#8b93ab' }, grid: { color: '#1f2435' } } } };
  if (cm.found) {
    const pts = [['30-day avg', cm.avg30], ['7-day avg', cm.avg7], ['1-day avg', cm.avg1], ['Trend', cm.trend]];
    const ds = [{ label: 'Cardmarket (normal)', data: pts.map(p => p[1] || null), borderColor: '#facc15', backgroundColor: 'rgba(250,204,21,.15)', fill: true, tension: .3, spanGaps: true }];
    if (cm.holo && (cm.holo.avg30 || cm.holo.trend)) ds.push({ label: 'Cardmarket (holo/reverse)', data: [cm.holo.avg30, cm.holo.avg7, cm.holo.avg1, cm.holo.trend].map(v => v || null), borderColor: '#60a5fa', tension: .3, spanGaps: true });
    base.scales.y.ticks.callback = v => fmt(v);
    miniCharts.push(new Chart($('#cmChart'), { type: 'line', data: { labels: pts.map(p => p[0]), datasets: ds }, options: base }));
  }
  if (c.source === 'tcgcsv' && days.size >= 2) {
    const labels = [...days].sort();
    const colors = ['#22c55e', '#f97316', '#a78bfa', '#f472b6'];
    miniCharts.push(new Chart($('#histChart'), { type: 'line', data: { labels, datasets: hist.map((h, i) => ({ label: h.sub, data: labels.map(d => h.points.find(p => p.d === d)?.m ?? null), borderColor: colors[i % 4], tension: .25, spanGaps: true })) },
      options: { ...base, scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: '#8b93ab', callback: v => fmt(v) } } } } }));
  }
}
// ---------- sales data / thin-market info (CardPrice) ----------
const dshort = d => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
function manualLinks(c) {
  if (c.links) return `<a href="${esc(c.links.ebay)}" target="_blank" rel="noopener">eBay sold ↗</a> · <a href="${esc(c.links.pricecharting)}" target="_blank" rel="noopener">PriceCharting ↗</a> · <a href="${esc(c.links.psa)}" target="_blank" rel="noopener">PSA ↗</a>`;
  const q = String(c.name || '').replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return `<a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener">eBay sold ↗</a> · <a href="${esc(c.event?.pricecharting || `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q)}`)}" target="_blank" rel="noopener">PriceCharting ↗</a> · <a href="https://www.psacard.com/pop/search?q=${encodeURIComponent(q)}" target="_blank" rel="noopener">PSA ↗</a>`;
}
async function loadSales(c) {
  const area = $('#salesArea'); if (!area) return;
  if (c.source === 'tcgdex') { area.innerHTML = 'Sale counts aren\u2019t available for Chinese-language cards (Cardmarket averages are in the trend box below).'; return; }
  let r;
  try { r = await api(c.source === 'cardprice' ? `/api/cpinfo?cardId=${encodeURIComponent(c.cpId)}` : `/api/cpinfo?productId=${c.id}`); } catch (e) { r = { found: false, reason: e.message }; }
  if (!document.body.contains(area)) return;
  area.classList.remove('muted');
  const rs = r.reportedSales || c.event?.reportedSales;
  const reported = rs?.length ? `<div class="reported"><b>Reported record sales</b> <span class="muted small">— cited one-off public sales, not part of the tracked price data above</span>
    <table class="t"><tbody>${rs.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.grade)}</td><td><b>${fmt(x.price)}</b></td><td class="small">${esc(x.venue)} · <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)} ↗</a></td></tr>`).join('')}</tbody></table></div>` : '';
  if (!r.found) { area.innerHTML = `<div><b>No sales data</b> — ${esc(r.reason || 'no record')}</div><div class="small" style="margin-top:6px">Check by hand: ${manualLinks(c)}</div>${reported}`; return; }
  const s = r.sales || { count7d: 0, count30d: 0, count90d: 0, few: true };
  const few = s.count90d < (r.thinThreshold || 5);
  const tcgAsk = c.source === 'tcgcsv' && !hasMarket(c) && c.prices.some(p => p.mid != null);
  const latestLine = r.latest != null && !r.suspicious
    ? `CardPrice latest raw price: <b>${fmt(r.latest)}</b> <span class="muted">(${esc(r.latestSource)}${r.tcgListed && !s.count90d ? ' — no sale in 90 days, so this is likely an old sale or an asking price' : ''})</span>`
    : r.suspicious ? `CardPrice lists ${fmt(r.latest)} ungraded — under 1% of the graded values, ignored as a bad record.` : 'No raw price recorded on CardPrice.';
  area.innerHTML = `<div class="salesrow"><span class="pill ${few ? 'few' : 'ok'}">${!s.count90d ? '⚠️ No recorded sales' : few ? '⚠️ Few sales' : '✓ Regular sales'}</span>
      <span><b>${s.count90d}</b> sale${s.count90d === 1 ? '' : 's'} in 90 days · ${s.count30d} in 30 · ${s.count7d} in 7</span></div>
    <div class="small">Last sale: ${s.last ? `<b>${dshort(s.last.date)}</b> — ${fmt(s.last.price)}${s.last.condition ? ` (${esc(s.last.condition)}${s.last.variant && s.last.variant !== 'Normal' ? ', ' + esc(s.last.variant) : ''})` : ''}` : '<b>none recorded</b>'}${s.avg90d != null ? ` · 90-day avg ${fmt(s.avg90d)}` : ''}</div>
    ${s.recent?.length > 1 ? `<div class="small muted">Recent: ${s.recent.map(x => `${dshort(x.date)} ${fmt(x.price)}${x.condition ? ' ' + esc(x.condition.replace(/(\w)\w+ ?/g, '$1')) : ''}`).join(' · ')}</div>` : ''}
    <div class="small" style="margin-top:4px">${latestLine}</div>
    ${tcgAsk ? '<div class="small">⚠️ The TCGplayer price shown is <b>asking-only</b> (listing mid) — no recent completed sale backs it.</div>' : ''}
    <div class="muted small" style="margin-top:4px">${r.tcgListed ? 'Sale counts are TCGplayer completed sales tracked by CardPrice.' : 'Not sold on TCGplayer — CardPrice tracks no individual sales for it; its values come from PriceCharting.'} “Few sales” = fewer than ${r.thinThreshold || 5} in 90 days. Source: <a href="${esc(r.url)}" target="_blank" rel="noopener">CardPrice ↗</a> · check by hand: ${manualLinks(c)}</div>
    ${r.history?.length >= 2 && !r.suspicious ? `<div class="minichart" style="margin-top:10px"><canvas id="cpChart"></canvas></div><div class="muted small">CardPrice raw price history (${r.history.length} days, ${esc(r.history[0].d)} → ${esc(r.history[r.history.length - 1].d)}). Thin data: flat stretches mean no new sale.</div>` : ''}
    ${reported}`;
  if (r.history?.length >= 2 && !r.suspicious && window.Chart) {
    const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e7eaf3' } } }, scales: { x: { ticks: { color: '#8b93ab' }, grid: { color: '#1f2435' } }, y: { ticks: { color: '#8b93ab', callback: v => fmt(v) }, grid: { color: '#1f2435' } } } };
    miniCharts.push(new Chart($('#cpChart'), { type: 'line', data: { labels: r.history.map(p => p.d), datasets: [{ label: 'CardPrice raw (USD)', data: r.history.map(p => p.m), borderColor: '#f59e0b', tension: .2, stepped: true }] }, options: opts }));
  }
}
// ---------- graded prices (CardPrice) ----------
function gradedLinks(c) {
  const base = String(c.name || '').replace(/\s-\s.*$/, '');
  const num = String(c.number || '').split('/')[0];
  const ed = c.edition === '1st' ? '1st Edition ' : /shadowless/i.test(c.editionLabel || '') ? 'Shadowless ' : '';
  const q = `${ed}${base} ${num}`.trim();
  const setName = c.source === 'tcgdex' ? '' : ' ' + (c.set?.name || '');
  return `<a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent('PSA ' + q + setName)}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener">eBay sold graded listings ↗</a> · <a href="https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q + setName)}" target="_blank" rel="noopener">PriceCharting ↗</a>`;
}
async function loadGraded(c) {
  const area = $('#gradedArea'); if (!area) return;
  if (c.source === 'tcgdex') {
    area.classList.remove('muted');
    area.innerHTML = `<div><b>Not available</b> — no free graded-price source covers Chinese-language cards (CardPrice tracks English &amp; Japanese TCGplayer products only).</div><div class="small" style="margin-top:6px">Check by hand: ${gradedLinks(c)}</div>`;
    return;
  }
  let g;
  const sub = c.edition ? c.prices[0]?.sub : null;
  try { g = await api(c.source === 'cardprice' ? `/api/graded?cardId=${encodeURIComponent(c.cpId)}` : `/api/graded?productId=${c.id}${sub ? `&subType=${encodeURIComponent(sub)}` : ''}`); } catch (e) { g = { available: false, reason: e.message }; }
  if (!document.body.contains(area)) return;
  area.classList.remove('muted');
  const pop = (g.population || []).filter(p => p.total);
  const popHtml = pop.length ? `<div class="small" style="margin-top:6px">${pop.map(p => {
      const gem = p.total ? Math.round(p.gem / p.total * 100) : 0, n9 = Array.isArray(p.dist) ? p.dist[8] : null;
      return `<div><b>${esc(String(p.company).toUpperCase())} population${p.printing ? ` (${esc(p.printing)})` : ''}:</b> ${p.total.toLocaleString()} graded · 10s: ${p.gem.toLocaleString()} (${gem}%)${n9 != null ? ` · 9s: ${n9.toLocaleString()}` : ''} <span class="muted">as of ${esc(p.updated || '—')}</span></div>`;
    }).join('')}</div>` : '';
  if (!g.available) {
    area.innerHTML = `<div><b>Not available</b> — ${esc(g.reason || 'no graded data')}${g.hint ? ' ' + esc(g.hint) : ''}</div>${popHtml}<div class="small" style="margin-top:6px">Check by hand: ${gradedLinks(c)}${g.source?.url ? ` · <a href="${esc(g.source.url)}" target="_blank" rel="noopener">CardPrice ↗</a>` : ''}</div>`;
    return;
  }
  const raw = cardPrice(c);
  const cols = g.printings;
  const keys = []; cols.forEach(p => p.grades.forEach(x => { if (!keys.some(k => k.key === x.key)) keys.push(x); }));
  const head = `<tr><th>Grade</th>${cols.map(p => `<th>${esc(cols.length > 1 ? (p.printing || 'Unlimited') : 'Price')}</th>`).join('')}</tr>`;
  const rows = keys.map(k => `<tr class="${k.key === 'psa10' ? 'hl' : ''}"><td>${esc(k.label)}${k.company || k.key === 'ungraded' ? '' : ' <span class="muted small">any grader</span>'}</td>${cols.map(p => { const x = p.grades.find(x => x.key === k.key), v = x?.price; const tag = x?.estimated ? ' <span class="est" title="Derived by CardPrice from another grade — not a recorded sale">est.</span>' : x?.suspect ? ' <span class="est bad" title="Under 1% of the graded values — probably a bad record">suspect</span>' : ''; return `<td>${k.key === 'psa10' ? `<b>${fmt(v)}</b>` : fmt(v)}${tag}</td>`; }).join('')}</tr>`).join('');
  const psa10 = cols[0].grades.find(x => x.key === 'psa10')?.price;
  const edBanner = g.edition === '1st' ? (g.editionMatched
      ? `<div class="small" style="margin-bottom:6px"><span class="badge ed1 inl">1st Ed</span> CardPrice's <b>1st Edition</b> graded sales for this card.</div>`
      : `<div class="note" style="margin-bottom:6px">⚠️ ${esc(g.note || 'CardPrice does not separate 1st Edition for this card.')}</div>`) : '';
  area.innerHTML = `${edBanner}<table class="t gt"><thead>${head}</thead><tbody>${rows}</tbody></table>
    ${(() => { const u0 = cols[0].grades.find(x => x.key === 'ungraded'); const ung = u0?.suspect ? null : u0?.price; const b = ung || raw; return psa10 && b ? `<div class="small" style="margin-top:4px">PSA 10 ≈ <b>${(psa10 / b).toFixed(1)}×</b> ${ung ? 'the ungraded sale price (same source)' : `the raw TCGplayer ${hasMarket(c) ? 'market' : 'listing mid'} price`}.</div>` : ''; })()}
    ${popHtml}
    ${c.event || c.source === 'cardprice' ? '<div class="small" style="margin-top:4px">⚠️ Prize/event cards: these values often rest on one or two sales (or a PriceCharting estimate), not a liquid market.</div>' : ''}
    <div class="muted small" style="margin-top:6px">${g.note && g.editionMatched !== false ? esc(g.note) + ' ' : ''}Grades 7–9.5 are the going rate for that grade from any grading company (mostly PSA); the “10” rows are company-specific. USD, updated ${esc(cols[0].date || '—')}. Source: <a href="${esc(g.source.url)}" target="_blank" rel="noopener">CardPrice ↗</a> · also see ${gradedLinks(c)}</div>`;
}
$('#cardBody').addEventListener('click', e => { if (e.target.closest('[data-login]')) { e.preventDefault(); showAuth('login'); } });
$('#cardBody').addEventListener('change', e => { const f = e.target.closest('.alertform'); if (f) refreshQuote(f); });
$('#cardBody').addEventListener('input', e => { const f = e.target.closest('.alertform'); if (f && (e.target.name === 'percent' || e.target.name === 'target')) { clearTimeout(f._t); f._t = setTimeout(() => refreshQuote(f), 250); } });
$('#cardBody').addEventListener('submit', async e => {
  const f = e.target.closest('.alertform'); if (!f) return; e.preventDefault();
  const body = { kind: f.dataset.kind, mode: f.mode.value, subType: f.sub?.value };
  if (body.mode === 'percent') body.percent = +f.percent.value; else body.target = +f.target.value;
  if (f.dataset.src === 'tcgdex' && f.dataset.kind === 'card') Object.assign(body, { source: 'tcgdex', tcgdexId: f.dataset.id, lang: f.dataset.lang });
  else if (f.dataset.src === 'cardprice') Object.assign(body, { source: 'cardprice', cpId: f.dataset.id, field: f.field.value });
  else body.productId = +f.dataset.id;
  try {
    const r = await api('/api/alerts', { method: 'POST', body: JSON.stringify(body) }); const a = r.alert || {};
    const rule = a.mode === 'percent' ? (a.triggerPrice != null ? ` (below ${fmt(a.triggerPrice, a.currency)} = ${a.percent}% of avg)` : ` (below ${a.percent}% of avg once an average exists)`) : '';
    toast((S.user.email ? `Alert saved${rule} — we'll email ${S.user.email}` : `Alert saved${rule} — add an alert email in your profile`)); loadAlerts();
  }
  catch (err) { toast(err.message); }
});

// ---------- auth ----------
let authMode = 'login';
function showAuth(mode) {
  authMode = mode; $('#authErr').textContent = '';
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === mode));
  document.querySelectorAll('#authForm .su').forEach(l => l.hidden = mode !== 'signup');
  $('#authForm').invite.required = mode === 'signup';
  $('#authForm').password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
  openModal('#authModal');
}
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showAuth(b.dataset.t); });
$('#authBtn').addEventListener('click', () => S.user ? openAlerts() : showAuth('login'));
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  const body = { username: f.username.value, password: f.password.value };
  if (authMode === 'signup') Object.assign(body, { email: f.email.value, invite: f.invite.value });
  try { const r = await api(`/api/${authMode}`, { method: 'POST', body: JSON.stringify(body) }); setUser(r.user); closeModal($('#authModal')); f.reset(); toast(`Welcome, ${r.user.username}!`); if (S.current && !$('#cardModal').hidden) closeModal($('#cardModal')); }
  catch (err) { $('#authErr').textContent = err.message; }
});
function setUser(u) {
  S.user = u;
  $('#authBtn').textContent = u ? `👤 ${u.username}` : 'Log in';
  if (u?.restored && !setUser.warned) { setUser.warned = true; setTimeout(() => toast('Your account was restored from your sign-in — set a password again via Sign up (same username) so you can log in on other devices.'), 800); }
  $('#alertsBtn').hidden = !u;
  renderChips(); updateFav(); if (u) loadAlerts();
}
function updateFav() {
  const b = $('#favBtn'); b.hidden = !S.user || !S.current;
  if (!b.hidden) { const on = S.user.favorites.includes(S.current.name); b.textContent = on ? '★' : '☆'; b.title = on ? 'Remove favorite' : 'Save as favorite'; }
}
$('#favBtn').addEventListener('click', async () => {
  const on = !S.user.favorites.includes(S.current.name);
  const r = await api('/api/favorites', { method: 'POST', body: JSON.stringify({ pokemon: S.current.name, on }) });
  S.user = r.user; updateFav(); renderChips(); toast(on ? `${S.current.name} added to favorites` : 'Removed from favorites');
});

// ---------- alerts / profile ----------
async function loadAlerts() {
  try {
    const r = await api('/api/alerts'); S.alerts = r.alerts;
    $('#alertCount').textContent = r.alerts.length;
    $('#alertList').innerHTML = r.alerts.map(a => `<div class="al">${a.img ? `<img src="${esc(a.img)}" alt="">` : '<img alt="">'}
      <div class="grow"><div class="t">${esc(a.name)}${a.subType ? ` <span class="muted small">(${esc(a.subType)})</span>` : ''}</div>
      <div class="muted small">${esc(a.set)} · ${LANGNAME[a.language] || esc(a.language)} · ${a.kind === 'sealed' ? 'sealed' + (a.sealedType ? ' · ' + esc(a.sealedType) : '') : a.kind}</div>
      <div class="small">Now <b class="${a.triggered ? 'hit' : ''}">${fmt(a.current, a.currency)}</b>${a.mode === 'percent'
        ? ` · avg ${fmt(a.average, a.currency)} · alert below <b>${fmt(a.triggerPrice, a.currency)}</b> (${a.percent}% of avg)`
        : ` · target ${fmt(a.target, a.currency)}${a.average != null ? ` · avg ${fmt(a.average, a.currency)}` : ''}`}${a.notified ? ' · <span class="hit">alert sent</span>' : ''}</div>
      <div class="muted small" title="${esc(a.averageBasis || '')}">Average: ${esc(a.averageBasis || '—')}${a.percentOfAverage != null ? ` · now ${a.percentOfAverage}% of avg` : ''}</div></div>
      ${a.url ? `<a class="btn ghost sm" href="${esc(a.url)}" target="_blank" rel="noopener">↗</a>` : ''}<button class="btn ghost sm" data-del="${esc(a.id)}">Remove</button></div>`).join('') || '<div class="muted">No alerts yet — open any card, pack or sealed product and set an alert (default: below 75% of its 30-day average).</div>';
  } catch {}
}
function openAlerts() { $('#profileForm').email.value = S.user.email || ''; $('#profileMsg').textContent = ''; loadAlerts(); openModal('#alertsModal'); }
$('#alertsBtn').addEventListener('click', openAlerts);
$('#alertList').addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (!b) return; await api(`/api/alerts?id=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); loadAlerts(); });
$('#profileForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { const r = await api('/api/me', { method: 'POST', body: JSON.stringify({ email: e.target.email.value }) }); S.user = r.user; $('#profileMsg').textContent = 'Saved.'; }
  catch (err) { $('#profileMsg').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); setUser(null); closeModal($('#alertsModal')); toast('Logged out'); });

// ---------- find a specific card ----------
const FS = { langs: 'en,ja,zh-tw,zh-cn', cards: [], seq: 0, timer: null };
async function findCards(zh = FS.zh) {
  FS.zh = zh;
  const q = $('#fq').value.trim(); const seq = ++FS.seq;
  if (q.length < (/[\u3400-\u9fff]/.test(q) ? 1 : 2)) { FS.cards = []; $('#fGrid').innerHTML = ''; $('#fNotes').innerHTML = ''; $('#fCount').textContent = ''; return; }
  const wantZh = zh && FS.langs.includes('zh');
  $('#fCount').textContent = wantZh ? 'Searching (including Chinese cards)…' : 'Searching…';
  try {
    const r = await api(`/api/cardsearch?q=${encodeURIComponent(q)}&langs=${FS.langs}${wantZh ? '&zh=1' : ''}&sort=${$('#fSort').value}`);
    if (seq !== FS.seq) return;
    FS.cards = r.cards;
    $('#fGrid').innerHTML = r.cards.map((c, i) => cardTile(c, i)).join('') || `<div class="muted">No cards match “${esc(q)}”. Try fewer words, the set name, or the card number (e.g. 199 or 215/203).</div>`;
    $('#fNotes').innerHTML = (r.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join('');
    const tcg = r.cards.filter(c => c.source === 'tcgcsv').length, zhn = r.cards.length - tcg;
    const hasEnJa = FS.langs.includes('en') || FS.langs.includes('ja');
    $('#fCount').textContent = [hasEnJa ? `${r.total.toLocaleString()} English/Japanese match${r.total === 1 ? '' : 'es'}${r.total > tcg ? ` (showing top ${tcg})` : ''}` : '', zhn ? `${zhn} Chinese` : '', !wantZh && FS.langs.includes('zh') ? 'press Enter to include Chinese cards' : ''].filter(Boolean).join(' · ');
  } catch (e) { if (seq === FS.seq) { $('#fCount').textContent = ''; $('#fGrid').innerHTML = `<div class="muted">${esc(e.message)}</div>`; } }
}
$('#fq').addEventListener('input', () => { clearTimeout(FS.timer); FS.timer = setTimeout(() => findCards(false), 250); });
$('#fq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(FS.timer); findCards(true); } });
$('#fBtn').addEventListener('click', () => { clearTimeout(FS.timer); findCards(true); });
$('#fLangs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...$('#fLangs').children].forEach(x => x.classList.toggle('on', x === b)); FS.langs = b.dataset.l; findCards(FS.langs.startsWith('zh')); });
$('#fSort').addEventListener('change', () => findCards());
$('#fGrid').addEventListener('click', e => { const a = e.target.closest('.c'); if (a) openCard(FS.cards[+a.dataset.i]); });
document.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => { $('#fq').value = b.dataset.example; findCards(false); }));

// ---------- sealed products ----------
const SS = { langs: 'en,ja', type: '', items: [], shown: 48, chart: null, scale: 'logarithmic', sets: [], loaded: false, seq: 0 };
const TYPE_ICON = { 'Booster Box': '📦', 'Elite Trainer Box': '🎁', 'Booster Bundle': '🧺', 'Booster Pack': '🎴', 'Collection / Box': '🗃️', Tin: '🥫', Blister: '🧷', Deck: '🃏', Display: '🏪', Case: '🚚' };
const TYPE_COLOR = { 'Booster Box': '#facc15', 'Elite Trainer Box': '#f97316', 'Booster Bundle': '#22c55e', 'Booster Pack': '#60a5fa', 'Collection / Box': '#a78bfa', Tin: '#94a3b8', Blister: '#f472b6', Deck: '#2dd4bf', Display: '#fb7185', Case: '#64748b' };
const sPrice = x => { const m = x.prices.find(p => p.market != null); if (m) return m.market; const d = x.prices.find(p => p.mid != null); return d ? d.mid : null; };
const sHasMarket = x => x.prices.some(p => p.market != null);
function setMode(m) {
  [...$('#modes').children].forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#cardsView').hidden = m !== 'cards'; $('#sealedView').hidden = m !== 'sealed'; $('#findView').hidden = m !== 'find';
  if (m === 'find') setTimeout(() => $('#fq').focus(), 0);
  if (m === 'sealed') {
    $('#sPokeWrap').hidden = !S.current; if (S.current) $('#sPokeName').textContent = S.current.name; else $('#sPoke').checked = false;
    if (!SS.loaded) { SS.loaded = true; loadSets(); }
    loadSealed();
  }
  const h = m === 'sealed' ? '#sealed' : m === 'find' ? '#find' : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}
$('#modes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); });
$('#toSealed').addEventListener('click', () => { $('#sPoke').checked = true; $('#sSet').value = ''; setMode('sealed'); window.scrollTo({ top: 0 }); });
async function loadSets() {
  const langs = SS.langs === 'zh' ? 'zh-tw' : SS.langs;
  try {
    const r = await api(`/api/sealed/sets?langs=${langs}`); SS.sets = r.sets;
    const cur = $('#sSet').value;
    $('#sSet').innerHTML = '<option value="">All sets</option>' + r.sets.map(g => `<option value="${g.cat}:${g.groupId}">${esc(g.name)}${g.lang === 'ja' ? ' (JP)' : ''} — ${g.count}</option>`).join('');
    if ([...$('#sSet').options].some(o => o.value === cur)) $('#sSet').value = cur;
  } catch {}
}
function renderTypes(types) {
  if ($('#sTypes').children.length) return;
  $('#sTypes').innerHTML = `<button data-t="" class="on">All types</button>` + types.map(t => `<button data-t="${esc(t)}">${TYPE_ICON[t] || ''} ${esc(t)}</button>`).join('');
}
$('#sTypes').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; SS.type = b.dataset.t; [...$('#sTypes').children].forEach(x => x.classList.toggle('on', x === b)); if (SS.type === 'Case') $('#sNoCases').checked = false; loadSealed(); });
$('#sLangs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; SS.langs = b.dataset.l; [...$('#sLangs').children].forEach(x => x.classList.toggle('on', x === b)); $('#sSet').value = ''; loadSets(); loadSealed(); });
let sqT; $('#sq').addEventListener('input', () => { clearTimeout(sqT); sqT = setTimeout(loadSealed, 250); });
['#sSet', '#sPoke', '#sNoCases'].forEach(id => $(id).addEventListener('change', loadSealed));
$('#sSort').addEventListener('change', renderSealedGrid); $('#sPriced').addEventListener('change', () => { SS.shown = 48; renderSealedAll(); });
$('#sMore').addEventListener('click', () => { SS.shown += 48; renderSealedGrid(); });
$('#sScaleSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; SS.scale = b.dataset.s; [...$('#sScaleSeg').children].forEach(x => x.classList.toggle('on', x === b)); renderSealedChart(); });

async function loadSealed() {
  const seq = ++SS.seq;
  if (SS.langs === 'zh') {
    SS.items = []; $('#sNotes').textContent = 'Chinese sealed products: there is no free, key-less price source for them — TCGplayer/TCGCSV only list English and Japanese products, and TCGdex (our Chinese card source) has no sealed products. Nothing is shown rather than guessing.';
    $('#sStats').innerHTML = ''; $('#sCount').textContent = ''; renderSealedAll(); return;
  }
  const qs = new URLSearchParams({ langs: SS.langs });
  if ($('#sq').value.trim()) qs.set('q', $('#sq').value.trim());
  if (SS.type) qs.set('type', SS.type);
  if ($('#sNoCases').checked && SS.type !== 'Case') qs.set('exclude', 'Case');
  const set = $('#sSet').value; if (set) { const [cat, gid] = set.split(':'); qs.set('cat', cat); qs.set('groupId', gid); }
  if ($('#sPoke').checked && S.current) qs.set('pokemon', S.current.name);
  $('#sGrid').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const r = await api(`/api/sealed?${qs}`); if (seq !== SS.seq) return;
    renderTypes(r.types); SS.items = r.items; SS.total = r.total; SS.shown = 48;
    const notes = [];
    if (r.total > r.items.length) notes.push(`Showing the ${r.items.length} highest-priced of ${r.total.toLocaleString()} matching products — search or pick a set to narrow it down.`);
    if (SS.langs.includes('ja')) notes.push('Japanese sealed coverage is limited to what TCGplayer lists (mostly booster boxes, packs and decks).');
    $('#sNotes').textContent = notes.join(' ');
    renderSealedAll();
  } catch (e) { $('#sGrid').innerHTML = `<div class="notes">${esc(e.message)}</div>`; if (e.status === 503) setTimeout(loadSealed, 3000); }
}
function sealedFiltered() {
  let l = SS.items.slice(); if ($('#sPriced').checked) l = l.filter(x => sPrice(x) != null);
  const d = x => x.set.released ? Date.parse(x.set.released) : 0;
  const sorts = { price: (a, b) => (sPrice(b) ?? -1) - (sPrice(a) ?? -1), priceAsc: (a, b) => (sPrice(a) ?? 1e12) - (sPrice(b) ?? 1e12), newest: (a, b) => d(b) - d(a), oldest: (a, b) => (d(a) || 1e15) - (d(b) || 1e15) };
  return l.sort(sorts[$('#sSort').value]);
}
function renderSealedAll() { renderSealedStats(); renderSealedChart(); renderSealedGrid(); }
function renderSealedStats() {
  if (SS.langs === 'zh') return;
  const priced = SS.items.filter(sHasMarket);
  const cheapest = t => priced.filter(x => x.type === t).sort((a, b) => sPrice(a) - sPrice(b))[0];
  const top = priced.slice().sort((a, b) => sPrice(b) - sPrice(a))[0];
  const bb = cheapest('Booster Box'), etb = cheapest('Elite Trainer Box');
  $('#sStats').innerHTML = [
    ['Products', (SS.total ?? 0).toLocaleString(), `${priced.length} shown with a market price`],
    ['Most expensive', top ? fmt(sPrice(top)) : '—', top ? `${top.name}` : '—'],
    ['Cheapest booster box', bb ? fmt(sPrice(bb)) : '—', bb ? bb.name : 'None in this view'],
    ['Cheapest ETB', etb ? fmt(sPrice(etb)) : '—', etb ? etb.name : 'None in this view'],
  ].map(([k, v, d]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="d" title="${esc(d)}">${esc(d)}</div></div>`).join('');
}
function renderSealedChart() {
  const top = SS.items.filter(sHasMarket).sort((a, b) => sPrice(b) - sPrice(a)).slice(0, 20);
  $('#sChartTitle').textContent = $('#sSet').value ? `Sealed products in ${$('#sSet').selectedOptions[0].textContent.replace(/ — \d+$/, '')}` : 'Highest-priced sealed products in this view';
  $('#sChartSub').textContent = `Current TCGplayer market price (USD), colored by product type. Prices updated ${S.status ? new Date(S.status.pricesUpdated).toLocaleString() : ''}. Click a bar for details & history.`;
  if (SS.chart) SS.chart.destroy();
  SS.chart = new Chart($('#sChart'), {
    type: 'bar',
    data: { labels: top.map(x => (x.name.length > 42 ? x.name.slice(0, 40) + '…' : x.name) + (x.lang === 'ja' ? ' (JP)' : '')), datasets: [{ label: 'TCGplayer market price', data: top.map(sPrice), backgroundColor: top.map(x => TYPE_COLOR[x.type] || '#94a3b8'), borderRadius: 6, maxBarThickness: 56 }] },
    options: {
      responsive: true, maintainAspectRatio: false, onClick: (e, els) => { if (els[0]) openSealed(top[els[0].index]); },
      scales: { x: { ticks: { color: '#8b93ab', maxRotation: 60, minRotation: 35, font: { size: 11 } }, grid: { display: false } },
        y: { type: SS.scale, ticks: { color: '#8b93ab', callback: v => (SS.scale === 'logarithmic' && ![1, 10, 100, 1000, 10000, 100000].includes(v)) ? '' : fmt(v) }, grid: { color: '#1f2435' } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => top[it[0].dataIndex].name, label: it => `${top[it.dataIndex].type}: ${fmt(it.raw)}`, afterLabel: it => top[it.dataIndex].set.name } } },
    },
  });
}
function renderSealedGrid() {
  const list = sealedFiltered(); const slice = list.slice(0, SS.shown);
  $('#sCount').textContent = SS.langs === 'zh' ? '' : `${list.length} products`;
  $('#sGrid').innerHTML = slice.map(x => { const pr = sPrice(x); const v = x.prices.find(p => p.market != null) || x.prices.find(p => p.mid != null);
    return `<article class="c" data-sid="${x.id}"><div class="img sealed">${x.img ? `<img src="${esc(x.img)}" alt="${esc(x.name)}" loading="lazy">` : '<span class="noimg">No image</span>'}
      <span class="badge">${LANG[x.lang]}</span><span class="badge r typebadge">${TYPE_ICON[x.type] || ''} ${esc(x.type)}</span></div>
      <div class="body"><div class="name">${esc(x.name)}</div><div class="set">${esc(x.set.name)}${x.set.released ? ' · ' + new Date(x.set.released).getFullYear() : ''}</div>
      ${pr != null ? `<div class="price">${fmt(pr)}<small>${v.market != null ? 'market' : 'listing mid'}</small></div>` : '<div class="price na">No current price</div>'}</div></article>`; }).join('') || `<div class="muted">${SS.langs === 'zh' ? '' : 'No sealed products match.'}</div>`;
  $('#sMore').hidden = list.length <= SS.shown; $('#sMore').textContent = `Show more (${list.length - SS.shown} left)`;
}
$('#sGrid').addEventListener('click', e => { const a = e.target.closest('[data-sid]'); if (a) openSealed(SS.items.find(x => x.id === +a.dataset.sid)); });
function openSealed(x) {
  miniCharts.forEach(ch => ch.destroy()); miniCharts = [];
  const hist = (x.history || []).filter(h => h.points.length); const days = new Set(hist.flatMap(h => h.points.map(p => p.d)));
  const sx = { ...x, source: 'tcgcsv' };
  const rows = x.prices.map(p => `<tr><td>${esc(p.sub)}</td><td><b>${fmt(p.market)}</b></td><td>${fmt(p.low)}</td><td>${fmt(p.mid)}</td><td>${fmt(p.high)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No listings on TCGplayer right now</td></tr>';
  $('#cardBody').innerHTML = `<div class="detail"><div>${x.img ? `<img class="big" style="box-shadow:none" src="${esc(x.img.replace('_200w', '_in_1000x1000'))}" onerror="this.onerror=null;this.src='${esc(x.img)}'" alt="">` : ''}</div><div>
    <h2>${esc(x.name)}</h2>
    <div class="kv"><span>Type</span><span>${TYPE_ICON[x.type] || ''} ${esc(x.type)}</span><span>Set</span><span>${esc(x.set.name)}</span><span>Language</span><span>${LANGNAME[x.lang]}</span>${x.set.released ? `<span>Released</span><span>${new Date(x.set.released).toLocaleDateString()}</span>` : ''}</div>
    <div class="box"><h4>Current prices (TCGplayer, USD)</h4><table class="t"><thead><tr><th>Variant</th><th>Market</th><th>Low</th><th>Mid</th><th>High</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted small">“Market” is TCGplayer's recent-sales market price; low/mid/high are current listings. Updated ${S.status ? esc(new Date(S.status.pricesUpdated).toLocaleString()) : ''}. <a href="${esc(x.url)}" target="_blank" rel="noopener">View on TCGplayer ↗</a></div>
      ${alertForm('sealed', sx, x.prices.map(p => p.sub))}</div>
    <div class="box"><h4>Price history</h4>${days.size >= 2 ? '<div class="minichart"><canvas id="histChart"></canvas></div><div class="muted small">Daily TCGplayer market price recorded by this site.</div>'
      : `<div class="muted small">TCGplayer doesn't publish price history and the TCGCSV archive is offline, so this site records its own daily snapshot (since ${esc((S.status?.historyDays || [])[0] || 'today')}). A line chart appears here once 2+ days are recorded.</div>`}</div>
  </div></div>`;
  openModal('#cardModal'); initAlertForms();
  if (days.size >= 2) { const labels = [...days].sort(); const colors = ['#facc15', '#60a5fa', '#22c55e'];
    miniCharts.push(new Chart($('#histChart'), { type: 'line', data: { labels, datasets: hist.map((h, i) => ({ label: h.sub, data: labels.map(d => h.points.find(p => p.d === d)?.m ?? null), borderColor: colors[i % 3], tension: .25, spanGaps: true })) },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e7eaf3' } } }, scales: { x: { ticks: { color: '#8b93ab' } }, y: { ticks: { color: '#8b93ab', callback: v => fmt(v) }, grid: { color: '#1f2435' } } } } })); }
}

// ---------- boot ----------
(async () => {
  loadStatus();
  const [pk, me] = await Promise.all([api('/api/pokemon').catch(() => []), api('/api/me').catch(() => ({ user: null }))]);
  S.pokemon = pk; setUser(me.user); renderChips();
  const params = new URLSearchParams(location.search);
  const l = params.get('lang'); if (l) { const b = $(`#langs [data-l="${l}"]`); if (b) b.click(); }
  const n = params.get('pokemon'); if (n) await choose(S.pokemon.find(p => p.name.toLowerCase() === n.toLowerCase()));
  if (location.hash === '#sealed') setMode('sealed');
  else if (location.hash === '#find') setMode('find');
})();
