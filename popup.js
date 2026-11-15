'use strict';

const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusBox = document.getElementById('statusBox');
const adTitle   = document.getElementById('adTitle');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');

let isRunning = false;

function updateUI(msg, phase, current = 0, total = 0, currentTitle = '') {
  statusBox.textContent = msg;
  statusBox.className = 'status-box' +
    (phase === 'done' ? ' done' :
     phase === 'error' ? ' error' :
     phase === 'extracting' || phase === 'collecting' ? ' running' : '');

  adTitle.textContent = currentTitle ? `آگهی: ${currentTitle}` : '';

  if (total > 0) {
    progressWrap.style.display = 'block';
    const pct = Math.round((current / total) * 100);
    progressFill.style.width = pct + '%';
    progressLabel.textContent = `${current} از ${total} (${pct}%)`;
  } else if (phase === 'collecting') {
    progressWrap.style.display = 'block';
    progressFill.style.width = '30%';
    progressLabel.textContent = 'در حال ارتباط با دیوار...';
  } else if (phase === 'done') {
    progressWrap.style.display = 'block';
    progressFill.style.width = '100%';
    progressLabel.textContent = `تکمیل شد (${total} آگهی)`;
  } else {
    progressWrap.style.display = 'none';
  }

  if (phase === 'done' || phase === 'error') {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// Receive progress updates from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'progressUpdate') {
    updateUI(message.message, message.phase, message.current, message.total, message.currentTitle);
  }
});

startBtn.addEventListener('click', async () => {
  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  updateUI('در حال بررسی تب دیوار...', 'collecting', 0, 0);

  // 1. Find or open divar tab
  const tabs = await chrome.tabs.query({ url: 'https://divar.ir/*' });
  let activeTab = tabs.find(t => t.url && t.url.includes('divar.ir'));

  if (!activeTab) {
    updateUI('در حال باز کردن صفحه دیوار...', 'collecting', 0, 0);
    activeTab = await chrome.tabs.create({ url: 'https://divar.ir/my-divar/my-posts', active: true });
    // Wait for tab to load
    await new Promise(r => setTimeout(r, 4000));
  } else {
    // Focus tab
    await chrome.tabs.update(activeTab.id, { active: true });
  }

  // Ensure content script is ready
  updateUI('در حال ارسال دستور استخراج به صفحه...', 'collecting', 0, 0);

  chrome.tabs.sendMessage(activeTab.id, { action: 'startExport' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script might need injection if tab was open before extension install
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content.js']
      }, () => {
        if (chrome.runtime.lastError) {
          updateUI('خطا در اتصال به صفحه دیوار: لطفاً صفحه دیوار را رفرش کنید.', 'error');
          return;
        }
        // Retry sending
        setTimeout(() => {
          chrome.tabs.sendMessage(activeTab.id, { action: 'startExport' }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              updateUI(resp?.error || 'خطا در اجرای استخراج. لطفاً وارد حساب دیوار باشید.', 'error');
            }
          });
        }, 500);
      });
      return;
    }

    if (!response || !response.ok) {
      updateUI(response?.error || 'خطایی در استخراج رخ داد.', 'error');
    }
  });
});

stopBtn.addEventListener('click', () => {
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateUI('عملیات توسط کاربر متوقف شد.', 'idle');
});
