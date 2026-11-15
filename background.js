'use strict';

// ───── Helpers ─────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getState() {
  const r = await chrome.storage.session.get('divarExporter');
  return r.divarExporter || { phase: 'idle' };
}

async function saveState(updates) {
  const cur = await getState();
  const next = { ...cur, ...updates };
  await chrome.storage.session.set({ divarExporter: next });
  // Broadcast to popup (best-effort)
  chrome.runtime.sendMessage({ type: 'stateUpdate', state: next }).catch(() => {});
  return next;
}

// ───── Tab management ─────
let targetTabId = null;

async function ensureDivarTab() {
  // Look for existing Divar tab
  const tabs = await chrome.tabs.query({ url: 'https://divar.ir/*' });
  if (tabs.length > 0) {
    targetTabId = tabs[0].id;
    return tabs[0];
  }
  const tab = await chrome.tabs.create({ url: 'https://divar.ir/my-divar/my-posts', active: true });
  targetTabId = tab.id;
  return tab;
}

async function navigateTab(url) {
  await chrome.tabs.update(targetTabId, { url, active: true });
}

// Wait for a tab to fully load
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Don't reject — just proceed after timeout
    }, timeoutMs);

    function listener(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Inject a function into the target tab and return its result
async function inject(fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: fn,
    args,
  });
  return results[0]?.result;
}

// ───── Main message handler ─────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startExport') {
    startExport().catch(console.error);
    sendResponse({ ok: true });
  } else if (msg.action === 'stopExport') {
    saveState({ phase: 'idle' });
    sendResponse({ ok: true });
  } else if (msg.action === 'getState') {
    getState().then(sendResponse);
    return true; // async
  }
  return true;
});

// ───── Export flow ─────
async function startExport() {
  await saveState({ phase: 'opening', ads: [], currentIndex: 0, results: [] });

  const tab = await ensureDivarTab();
  targetTabId = tab.id;

  // Navigate to the my-posts page
  await navigateTab('https://divar.ir/my-divar/my-posts');
  await waitForTabLoad(targetTabId);
  await sleep(3000); // let React render

  await saveState({ phase: 'collecting' });

  // ── Step 1: Collect all ads ──
  const ads = await inject(collectAdsOnPage);

  if (!ads || ads.length === 0) {
    await saveState({ phase: 'error', error: 'آگهی یافت نشد. لطفاً مطمئن شوید که وارد حساب خود شده‌اید.' });
    return;
  }

  let state = await saveState({ ads, currentIndex: 0, results: [], phase: 'processing' });

  // ── Step 2: Process each ad ──
  for (let i = 0; i < ads.length; i++) {
    const st = await getState();
    if (st.phase === 'idle') return; // stopped by user

    const ad = ads[i];
    state = await saveState({ currentIndex: i, currentAdTitle: ad.title, phase: 'processing' });

    let stats = {};

    // If we have a direct URL for this ad, navigate to it
    if (ad.url) {
      await navigateTab(ad.url);
      await waitForTabLoad(targetTabId);
      await sleep(3000);

      // Try to find and click "عملکرد آگهی" on the ad's page
      const clicked = await inject(clickPerfButton);
      if (clicked) {
        await sleep(2500);
        stats = await inject(extractStatsFromPage);
      }

      // Some ads expose the section only inside /my-divar — go back and try via card
      if (!stats || Object.keys(stats).length === 0) {
        // Navigate back to list and use the card-based approach
        await navigateTab('https://divar.ir/my-divar/my-posts');
        await waitForTabLoad(targetTabId);
        await sleep(3000);
        stats = await inject(clickCardPerfAndExtract, [i]) || {};
      }
    } else {
      // No URL — use the card-index approach on the list page
      stats = await inject(clickCardPerfAndExtract, [i]) || {};
    }

    state = await saveState({
      results: [...(state.results || []), { title: ad.title, ...stats }],
      phase: 'processing',
    });
  }

  // ── Step 3: Generate & download CSV ──
  const finalState = await getState();
  await saveState({ phase: 'done' });
  await inject(downloadCSV, [finalState.results || []]);
}

// ═══════════════════════════════════════════════════════
// Functions injected INTO the page (must be self-contained)
// ═══════════════════════════════════════════════════════

/** Collect all ad cards from /my-divar/my-posts */
function collectAdsOnPage() {
  const ads = [];
  const seen = new Set();

  function findTitle(root) {
    const sel = '[class*="title" i], [class*="Title"], h1, h2, h3, h4, strong, b, p';
    const el = root.querySelector(sel);
    return el ? el.textContent.trim().replace(/\s+/g, ' ').substring(0, 120) : '';
  }

  // Try to find ad post cards
  const cards = [...document.querySelectorAll(
    '[class*="post-card" i], [class*="PostCard"], [class*="my-post" i], ' +
    '[class*="MyPost"], [class*="ad-card" i], [class*="AdCard"], article, ' +
    '[class*="post-item" i], [class*="PostItem"]'
  )];

  for (const card of cards) {
    const link = card.querySelector('a[href*="/v/"], a[href*="my-divar/post"]');
    const title = findTitle(card) || (link ? link.textContent.trim() : '');
    if (!title || seen.has(title)) continue;
    seen.add(title);
    ads.push({ title, url: link ? link.href : null });
  }

  // Fallback: grab all /v/ links
  if (ads.length === 0) {
    const links = [...document.querySelectorAll('a[href*="/v/"]')];
    for (const a of links) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const title = a.textContent.trim().substring(0, 120) || a.href;
      ads.push({ title, url: a.href });
    }
  }

  return ads;
}

/** Try to find and click "عملکرد آگهی" on current page */
function clickPerfButton() {
  const keywords = ['عملکرد آگهی', 'عملکرد', 'آمار آگهی', 'آمار'];
  const candidates = [...document.querySelectorAll(
    'button, a, [role="tab"], [role="button"], li, span, div'
  )];
  for (const kw of keywords) {
    const el = candidates.find(e =>
      e.textContent.trim() === kw ||
      (e.textContent.trim().includes(kw) && e.textContent.trim().length < 30)
    );
    if (el) { el.click(); return true; }
  }
  return false;
}

/** On the my-posts list page: click the performance button of card #index and extract */
function clickCardPerfAndExtract(index) {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function extractStats() {
    const LABELS = ['بازدید', 'تماس', 'ذخیره', 'چت', 'نشان‌گذاری', 'کلیک', 'نمایش', 'مشاهده'];
    const stats = {};
    // Scan all leaf text nodes for label/value pairs
    const leaves = [...document.querySelectorAll('*')].filter(e =>
      e.children.length === 0 && e.textContent.trim().length > 0 && e.textContent.trim().length < 60
    );
    for (const el of leaves) {
      const t = el.textContent.trim();
      for (const lbl of LABELS) {
        if (t === lbl) {
          const parent = el.parentElement;
          if (!parent) continue;
          for (const sib of [...parent.children]) {
            if (sib === el) continue;
            const n = sib.textContent.trim().replace(/[,،]/g, '');
            if (/^\d+$/.test(n)) { stats[lbl] = stats[lbl] || n; break; }
          }
          if (!stats[lbl] && parent.parentElement) {
            for (const uncle of [...parent.parentElement.children]) {
              if (uncle === parent) continue;
              const n = uncle.textContent.trim().replace(/[,،]/g, '');
              if (/^\d+$/.test(n)) { stats[lbl] = stats[lbl] || n; break; }
            }
          }
        }
      }
    }
    // Also try stat containers
    for (const el of document.querySelectorAll(
      '[class*="stat" i], [class*="insight" i], [class*="analytics" i], [class*="performance" i]'
    )) {
      const text = el.textContent;
      for (const lbl of LABELS) {
        if (text.includes(lbl)) {
          const m = text.match(/[\d,،]+/);
          if (m && !stats[lbl]) stats[lbl] = m[0].replace(/[,،]/g, '');
        }
      }
    }
    return stats;
  }

  return new Promise(async (resolve) => {
    const cards = [...document.querySelectorAll(
      '[class*="post-card" i], [class*="PostCard"], [class*="my-post" i], ' +
      '[class*="MyPost"], [class*="ad-card" i], article, [class*="post-item" i]'
    )];

    const card = cards[index];
    if (!card) return resolve({});

    const keywords = ['عملکرد آگهی', 'عملکرد', 'آمار آگهی'];
    const candidates = [...card.querySelectorAll('button, a, [role="tab"], [role="button"], span')];
    let btn = null;
    for (const kw of keywords) {
      btn = candidates.find(e => e.textContent.trim().includes(kw));
      if (btn) break;
    }
    if (!btn) return resolve({});

    const urlBefore = location.href;
    btn.click();
    await sleep(3000);

    if (location.href !== urlBefore) {
      // Navigated — the background will re-inject extractStatsFromPage
      return resolve(null); // Signal to background to handle on new page
    }

    // Panel/modal opened inline
    const stats = extractStats();
    // Try to close the panel
    const closeEl = document.querySelector(
      '[class*="close" i], [aria-label*="بستن"], button[aria-label*="close" i], [data-testid*="close"]'
    );
    if (closeEl) closeEl.click();

    resolve(stats);
  });
}

/** Extract performance stats from whatever is currently visible on the page */
function extractStatsFromPage() {
  const LABELS = ['بازدید', 'تماس', 'ذخیره', 'چت', 'نشان‌گذاری', 'کلیک', 'نمایش', 'مشاهده'];
  const stats = {};

  // 1. Stat container approach
  const containers = [...document.querySelectorAll(
    '[class*="stat" i], [class*="insight" i], [class*="analytics" i], ' +
    '[class*="performance" i], [class*="chart" i], [class*="metric" i]'
  )];
  for (const c of containers) {
    const t = c.textContent;
    for (const lbl of LABELS) {
      if (t.includes(lbl)) {
        const m = t.match(/[\d,،]+/);
        if (m && !stats[lbl]) stats[lbl] = m[0].replace(/[,،]/g, '');
      }
    }
  }

  // 2. Leaf node label → sibling number
  if (Object.keys(stats).length === 0) {
    const leaves = [...document.querySelectorAll('*')].filter(e =>
      e.children.length === 0 && e.textContent.trim().length < 60
    );
    for (const el of leaves) {
      const t = el.textContent.trim();
      for (const lbl of LABELS) {
        if (t === lbl) {
          const parent = el.parentElement;
          if (!parent) continue;
          for (const sib of [...parent.children]) {
            if (sib === el) continue;
            const n = sib.textContent.trim().replace(/[,،]/g, '');
            if (/^\d+$/.test(n)) { stats[lbl] = stats[lbl] || n; break; }
          }
          if (!stats[lbl] && parent.parentElement) {
            for (const uncle of [...parent.parentElement.children]) {
              if (uncle === parent) continue;
              const n = uncle.textContent.trim().replace(/[,،]/g, '');
              if (/^\d+$/.test(n)) { stats[lbl] = stats[lbl] || n; break; }
            }
          }
        }
      }
    }
  }

  // 3. Table rows
  if (Object.keys(stats).length === 0) {
    for (const row of document.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll('td, th')];
      if (cells.length < 2) continue;
      for (const lbl of LABELS) {
        if (cells[0].textContent.trim().includes(lbl)) {
          const n = cells[1].textContent.trim().replace(/[,،]/g, '');
          if (/^\d+$/.test(n)) stats[lbl] = n;
        }
      }
    }
  }

  return stats;
}

/** Generate CSV and download it in-page */
function downloadCSV(results) {
  const LABELS = ['بازدید', 'تماس', 'ذخیره', 'چت', 'نشان‌گذاری', 'کلیک', 'نمایش', 'مشاهده'];
  const allKeys = new Set();
  for (const r of results) Object.keys(r).forEach(k => allKeys.add(k));

  const cols = ['title', ...LABELS.filter(l => allKeys.has(l)),
    ...[...allKeys].filter(k => k !== 'title' && !LABELS.includes(k))];
  const headers = cols.map(c => c === 'title' ? 'عنوان آگهی' : c);

  const rows = results.map(r =>
    cols.map(c => `"${String(r[c] || '').replace(/"/g, '""')}"`).join(',')
  );

  const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `divar-آمار-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
}
