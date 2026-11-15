'use strict';

// Divar Exporter Content Script - Universal Version (v2.1.0)
// Supports both Personal and Business/Store Divar accounts

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startExport') {
    runExportProgressively((progress) => {
      chrome.runtime.sendMessage({ type: 'progressUpdate', ...progress }).catch(() => {});
    })
      .then((results) => {
        sendResponse({ ok: true, count: results.length });
      })
      .catch((err) => {
        console.error('Divar Exporter Error:', err);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true; // Keep channel open for async response
  }
});

async function runExportProgressively(onProgress) {
  onProgress({ phase: 'collecting', message: 'در حال دریافت لیست آگهی‌ها از دیوار...', current: 0, total: 0 });

  let allPosts = [];
  let lastItemIdentifier = '';
  let hasNext = true;
  let pageCount = 0;

  // 1. Fetch all pages of posts (handles both personal and business)
  while (hasNext && pageCount < 30) {
    pageCount++;
    const res = await fetch('https://api.divar.ir/v8/my-posts/w/list-v2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*'
      },
      credentials: 'include',
      body: JSON.stringify({
        specification: { tab_identifier: '', last_item_identifier: lastItemIdentifier },
        request_data: { business_type: 'ALL' }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('list-v2 response status:', res.status, errText);
      throw new Error(`خطا در ارتباط با دیوار (${res.status}). لطفاً مطمئن شوید در دیوار لاگین هستید.`);
    }

    const data = await res.json();
    const widgets = data.page?.widget_list || [];

    for (const w of widgets) {
      if (w.widget_type === 'CONTENT_CONTAINER') {
        const subWidgets = w.data?.widgets || [];
        const postRow = subWidgets.find((sw) => sw.widget_type === 'POST_ROW');
        
        // Find any row related to stats / insights / performance
        const selectorRow = subWidgets.find((sw) =>
          sw.widget_type === 'SELECTOR_ROW' &&
          (
            sw.data?.title?.includes('آمار') ||
            sw.data?.title?.includes('عملکرد') ||
            sw.data?.action?.payload?.manage_insights ||
            sw.data?.action?.type === 'OPEN_THE_WALL_PAGE'
          )
        );

        if (postRow) {
          // Resolve post token from all possible locations
          let postToken = selectorRow?.data?.action?.payload?.manage_insights?.post_token ||
                          selectorRow?.data?.action?.payload?.post_token ||
                          postRow.data?.action?.payload?.post_token ||
                          postRow.data?.action?.payload?.token;

          // Fallback 1: Extract 8-char post token from 14-char manage_token (e.g. gaIFry_1z1R6vN -> gaIFry_1)
          if (!postToken && postRow.data?.action?.payload?.manage_token) {
            postToken = postRow.data.action.payload.manage_token.slice(0, 8);
          }

          // Fallback 2: Extract post token from widget UID (e.g. my-posts-post-section-gaIFry_1-container)
          if (!postToken && w.uid) {
            const m = w.uid.match(/post-section-([a-zA-Z0-9_\-]+)-container/);
            if (m) postToken = m[1];
          }

          const brandToken = selectorRow?.data?.action?.payload?.manage_insights?.brand_token || '';

          allPosts.push({
            title: postRow.data?.title || '',
            price: postRow.data?.middle_description_text || '',
            date: postRow.data?.bottom_description_text || '',
            status: postRow.data?.label || '',
            manageToken: postRow.data?.action?.payload?.manage_token || '',
            brandToken: brandToken,
            postToken: postToken || ''
          });
        }
      }
    }

    const scrollResp = data.page?.infinite_scroll_response;
    if (scrollResp && scrollResp.has_next && scrollResp.last_item_identifier) {
      lastItemIdentifier = scrollResp.last_item_identifier;
    } else {
      hasNext = false;
    }
  }

  if (allPosts.length === 0) {
    throw new Error('هیچ آگهی فعالی در حساب کاربری یافت نشد.');
  }

  onProgress({
    phase: 'extracting',
    message: `تعداد ${allPosts.length} آگهی یافت شد. در حال استخراج آمار و عملکرد...`,
    current: 0,
    total: allPosts.length
  });

  // Helper to extract value by fuzzy matching title
  function findStatValue(stats, keyword) {
    for (const [key, val] of Object.entries(stats)) {
      if (key.includes(keyword)) return val;
    }
    return '-';
  }

  // 2. Fetch stats for each post with universal fallback logic
  async function fetchStats(post) {
    if (!post.postToken) {
      console.warn('No postToken found for post:', post.title);
      return { ...post, impressions: '-', views: '-', calls: '-', bookmarks: '-', rank: '-' };
    }

    // Try multiple endpoint structures (Business brand, Personal, or generic)
    const endpointsToTry = [];
    if (post.brandToken) {
      endpointsToTry.push({
        url: `https://api.divar.ir/v8/post-stats/insight/detail/${post.brandToken}/${post.postToken}`,
        body: {
          request_data: {
            token: post.postToken,
            brand_token: post.brandToken,
            business_ref: post.brandToken
          }
        }
      });
    }

    // Personal / Standard Divar account endpoint
    endpointsToTry.push({
      url: `https://api.divar.ir/v8/post-stats/insight/detail/personal/${post.postToken}`,
      body: { request_data: { token: post.postToken } }
    });

    // Fallback underscore endpoint
    endpointsToTry.push({
      url: `https://api.divar.ir/v8/post-stats/insight/detail/_/${post.postToken}`,
      body: { request_data: { token: post.postToken } }
    });

    for (const ep of endpointsToTry) {
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json-divar-filled'
          },
          credentials: 'include',
          body: JSON.stringify(ep.body)
        });

        if (!res.ok) {
          continue;
        }

        const data = await res.json();
        const widgets = data.page?.widget_list || [];
        const stats = {};
        for (const w of widgets) {
          if (w.widget_type === 'SCORE_ROW') {
            stats[w.data?.title || ''] = w.data?.descriptive_score || '';
          }
        }

        if (Object.keys(stats).length > 0) {
          return {
            ...post,
            impressions: findStatValue(stats, 'نمایش'),
            views: findStatValue(stats, 'بازدید'),
            calls: findStatValue(stats, 'تماس'),
            bookmarks: findStatValue(stats, 'نشان'),
            rank: findStatValue(stats, 'جایگاه')
          };
        }
      } catch (err) {
        console.warn('Error fetching endpoint:', ep.url, err);
      }
    }

    // If all fail, return '-'
    return { ...post, impressions: '-', views: '-', calls: '-', bookmarks: '-', rank: '-' };
  }

  const results = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const batchSize = 4;

  for (let i = 0; i < allPosts.length; i += batchSize) {
    const chunk = allPosts.slice(i, i + batchSize);
    const chunkResults = await Promise.all(chunk.map((p) => fetchStats(p)));
    results.push(...chunkResults);

    onProgress({
      phase: 'extracting',
      message: `در حال دریافت آمار (${results.length} از ${allPosts.length})...`,
      current: results.length,
      total: allPosts.length,
      currentTitle: chunk[chunk.length - 1]?.title
    });

    await delay(120);
  }

  // 3. Export to CSV/Excel with UTF-8 BOM
  downloadCSV(results);

  onProgress({
    phase: 'done',
    message: `✅ استخراج ${results.length} آگهی با موفقیت انجام شد و فایل اکسل دانلود گردید!`,
    current: results.length,
    total: results.length
  });

  return results;
}

function downloadCSV(results) {
  const headers = ['ردیف', 'عنوان آگهی', 'کل نمایش‌ها', 'کل بازدیدها', 'کل تماس‌ها', 'کل نشان‌کردن‌ها', 'جایگاه در شهر و دسته‌بندی', 'قیمت', 'وضعیت', 'تاریخ و شهر'];
  const rows = results.map((r, idx) => [
    idx + 1,
    `"${(r.title || '').replace(/"/g, '""')}"`,
    `"${r.impressions || '-'}"`,
    `"${r.views || '-'}"`,
    `"${r.calls || '-'}"`,
    `"${r.bookmarks || '-'}"`,
    `"${(r.rank || '-').replace(/"/g, '""')}"`,
    `"${(r.price || '').replace(/"/g, '""')}"`,
    `"${(r.status || '').replace(/"/g, '""')}"`,
    `"${(r.date || '').replace(/"/g, '""')}"`
  ].join(','));

  const csvContent = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const today = new Date().toISOString().slice(0, 10);
  a.download = `divar-amar-agahi-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}
