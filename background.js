let activeAlert = null;

async function fetchAutoDLInstances(tabId) {
  if (!tabId) return { ok: false, error: '无法确定 AutoDL 页面' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        try {
          const token = window.localStorage.getItem('token');
          if (!token) return { ok: false, error: '未检测到 AutoDL 登录状态' };

          let user = {};
          let appVersion = '0.0.0';
          try { user = JSON.parse(window.localStorage.getItem('user') || '{}'); } catch (_error) { /* use main account */ }
          try { appVersion = JSON.parse(window.localStorage.getItem('app_version') || '{}').version || appVersion; } catch (_error) { /* optional */ }

          const endpoint = user.sub_name ? '/api/v1/sub_user/instance' : '/api/v1/instance';
          const response = await window.fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Authorization: token,
              AppVersion: appVersion
            },
            body: JSON.stringify({
              page_index: 1,
              page_size: 1000,
              status: [],
              charge_type: [],
              name: '',
              sub_name: user.sub_name || ''
            })
          });
          const payload = await response.json();
          if (!response.ok || payload?.code !== 'Success') {
            return { ok: false, error: payload?.msg || `接口请求失败 (${response.status})` };
          }

          const data = payload?.data;
          const list = Array.isArray(data) ? data
            : Array.isArray(data?.list) ? data.list
              : Array.isArray(data?.result) ? data.result
                : [];
          return {
            ok: true,
            rows: list.map((row) => ({
              name: row?.name || '',
              uuid: row?.uuid || row?.instance_uuid || '',
              status: row?.status || '',
              start_mode: row?.start_mode || '',
              req_gpu_amount: row?.req_gpu_amount,
              gpu_idle_num: row?.gpu_idle_num,
              gpu_all_num: row?.gpu_all_num,
              machine_id: row?.machine_id || '',
              charge_type: row?.charge_type || ''
            }))
          };
        } catch (error) {
          return { ok: false, error: error?.message || '无法读取实例数据' };
        }
      }
    });
    return results?.[0]?.result || { ok: false, error: '未收到实例数据' };
  } catch (error) {
    return { ok: false, error: error?.message || '无法访问 AutoDL 页面' };
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play the user-configured GPU availability alarm.'
    });
  }
  return true;
}

async function playAlarm(sound) {
  try {
    if (await ensureOffscreenDocument()) {
      let selected = sound;
      if (!selected) {
        const stored = await chrome.storage.sync.get({ config: { alarmSound: 'classic' } });
        selected = stored.config?.alarmSound || 'classic';
      }
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAY_TONE', sound: selected });
    }
  } catch (error) { console.warn('Unable to play the GPU alarm:', error); }
}

async function createNotification(summary) {
  try {
    await chrome.notifications.create(`autodl-${Date.now()}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'AutoDL：GPU 已充足', message: summary || '监控实例已有可用 GPU',
      priority: 2, requireInteraction: true
    });
  } catch (error) { console.warn('Unable to create the GPU notification:', error); }
}

async function createAutoStartNotification(ok, target, message, tabId) {
  const id = `autodl-autostart-${Date.now()}`;
  try {
    await chrome.notifications.create(id, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: ok ? 'AutoDL：已自动开机' : 'AutoDL：自动开机失败',
      // 成功通知必须让用户能一键确认：5 分钟内不点就自动关机，避免无人空跑计费
      message: ok
        ? `${target || '监控实例'}：${message || '实例已开始开机'}。请在 5 分钟内点「我已回来，继续使用」确认，否则自动关机。`
        : `${target || '监控实例'}：${message || '请手动开机'}`,
      priority: 2, requireInteraction: true,
      ...(ok ? { buttons: [{ title: '我已回来，继续使用' }] } : {})
    });
    if (ok && target) await saveAutoStartNotif(target, id, tabId);
    return id;
  } catch (error) {
    console.warn('Unable to create the auto-start notification:', error);
    return null;
  }
}

async function createAutoStopNotification(ok, target, message) {
  try {
    await chrome.notifications.create(`autodl-autostop-${Date.now()}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: ok ? 'AutoDL：已自动关机' : 'AutoDL：自动关机失败',
      message: `${target || '监控实例'}：${message || (ok ? '实例已自动关机' : '请手动关机')}`,
      priority: 2, requireInteraction: !ok
    });
  } catch (error) { console.warn('Unable to create the auto-stop notification:', error); }
}

// 「已自动开机」通知需要能被点击确认，所以要把 notificationId → target/tabId 存起来。
// 存在 storage.local 而不是内存：MV3 service worker 随时可能被回收重启。
const AUTO_START_NOTIF_KEY = 'autoStartNotifs';

async function saveAutoStartNotif(target, id, tabId) {
  const stored = await chrome.storage.local.get(AUTO_START_NOTIF_KEY);
  const map = { ...(stored?.[AUTO_START_NOTIF_KEY] || {}) };
  map[target] = { id, tabId: tabId || null, at: Date.now() };
  await chrome.storage.local.set({ [AUTO_START_NOTIF_KEY]: map });
}

async function takeAutoStartNotif(target) {
  const stored = await chrome.storage.local.get(AUTO_START_NOTIF_KEY);
  const map = { ...(stored?.[AUTO_START_NOTIF_KEY] || {}) };
  const entry = map[target] || null;
  if (entry) { delete map[target]; await chrome.storage.local.set({ [AUTO_START_NOTIF_KEY]: map }); }
  return entry;
}

async function clearAutoStartNotification(target) {
  if (!target) return;
  const entry = await takeAutoStartNotif(target);
  if (entry?.id) {
    try { await chrome.notifications.clear(entry.id); } catch (_error) { /* 已关闭 */ }
  }
}

async function sendToAutoDLTabs(message, preferredTabId) {
  const ids = [];
  if (preferredTabId) ids.push(preferredTabId);
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && /^https:\/\/(www\.|console\.)?autodl\.com\/console\/instance/.test(tab.url || '') && !ids.includes(tab.id)) ids.push(tab.id);
    }
  } catch (_error) { /* 保持只发 preferredTabId */ }
  // 逐个发、第一个返回 ok 就停：确认只需要送达一次，不必广播给所有 AutoDL 标签页
  for (const tabId of ids) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, message);
      if (result?.ok) return true;
    } catch (_error) { /* 页面没开或内容脚本已停机，试下一个 */ }
  }
  return false;
}

async function confirmFromNotification(notificationId) {
  const stored = await chrome.storage.local.get(AUTO_START_NOTIF_KEY);
  const map = stored?.[AUTO_START_NOTIF_KEY] || {};
  const target = Object.keys(map).find((key) => map[key]?.id === notificationId);
  if (!target) return false;
  const entry = await takeAutoStartNotif(target);
  const delivered = await sendToAutoDLTabs({ type: 'CONFIRM_AUTO_START', target }, entry?.tabId);
  try { await chrome.notifications.clear(notificationId); } catch (_error) { /* 已关闭 */ }
  if (!delivered) {
    try {
      await chrome.notifications.create(`autodl-confirm-missed-${Date.now()}`, {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'AutoDL：确认未送达', message: '没找到 AutoDL 实例页面。请打开该页面，在右下角面板点「我已回来」，否则 5 分钟后会自动关机。',
        priority: 2
      });
    } catch (_error) { /* 忽略 */ }
  }
  return delivered;
}

// 后台标签页可能被浏览器的「内存节省」丢弃，丢弃后内容脚本就停了，监控会静默失效。
// 对 AutoDL 实例页关掉自动丢弃，页面本身仍可在后台运行，不会抢占焦点。
async function keepTabAlive(tabId) {
  if (!tabId) return;
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (_error) { /* 标签页已关闭 */ }
}

function isInjectableUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

async function ensureGlobalAlertInjected(tab) {
  if (!tab?.id || !isInjectableUrl(tab.url)) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['global-alert.js'] });
    return true;
  } catch (error) {
    console.debug('Unable to inject the global alert into this page:', tab.url, error);
    return false;
  }
}

async function showAlertInTab(tab, alert) {
  if (!await ensureGlobalAlertInjected(tab)) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_GLOBAL_ALERT', alert }); } catch (_error) { /* page changed */ }
}

async function showAlertInCurrentTab(alert) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]) await showAlertInTab(tabs[0], alert);
}

async function broadcastAlert(alert) {
  activeAlert = alert;
  await chrome.storage.local.set({ activeAlert: alert });
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter((tab) => isInjectableUrl(tab.url)).map((tab) => showAlertInTab(tab, alert)));
}

async function updateAlert(patch) {
  if (!activeAlert) return;
  activeAlert = { ...activeAlert, ...patch };
  await chrome.storage.local.set({ activeAlert });
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter((tab) => isInjectableUrl(tab.url)).map((tab) => showAlertInTab(tab, activeAlert)));
}

async function clearAlert() {
  activeAlert = null;
  await chrome.storage.local.remove('activeAlert');
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => tab.id
    ? chrome.tabs.sendMessage(tab.id, { type: 'HIDE_GLOBAL_ALERT' })
    : Promise.resolve()));
}

async function focusAutoDL() {
  const windows = await chrome.windows.getAll({ populate: true });
  for (const window of windows) {
    const tab = window.tabs?.find((item) => /^https:\/\/(www\.|console\.)?autodl\.com\/console\/instance/.test(item.url || ''));
    if (!tab) continue;
    await chrome.windows.update(window.id, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    return;
  }
}

// 后台标签页的 setInterval 会被浏览器降频到约每分钟一次。
// 用 alarms 定期给 AutoDL 页面发一次 SCAN，把检测节奏拉回来（不影响前台页面，也不抢焦点）。
const SCAN_ALARM = 'autodl-scan';

async function ensureScanAlarm() {
  try {
    const existing = await chrome.alarms.get(SCAN_ALARM);
    if (!existing) await chrome.alarms.create(SCAN_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  } catch (error) { console.debug('Unable to schedule the scan alarm:', error); }
}

async function scanAutoDLTabs() {
  const stored = await chrome.storage.sync.get({ config: { enabled: true } });
  if (stored.config?.enabled === false) return;
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((tab) => tab.id && /^https:\/\/(www\.|console\.)?autodl\.com\/console\/instance/.test(tab.url || ''));
  await Promise.allSettled(targets.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'SCAN' })));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM) scanAutoDLTabs().catch((error) => console.debug('Scan alarm failed:', error));
});

chrome.runtime.onInstalled.addListener(() => { ensureScanAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureScanAlarm(); });
ensureScanAlarm();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (sender.tab?.id) keepTabAlive(sender.tab.id);
    if (message?.type === 'FETCH_AUTODL_INSTANCES') {
      sendResponse(await fetchAutoDLInstances(sender.tab?.id));
      return;
    }
    if (message?.type === 'AUTO_START_RESULT') {
      await createAutoStartNotification(Boolean(message.ok), message.target, message.message, sender.tab?.id);
      return;
    }
    if (message?.type === 'AUTO_START_CONFIRMED') {
      // 用户在页面面板点了「我已回来」，清掉那条待确认的系统通知
      await clearAutoStartNotification(message.target);
      return;
    }
    if (message?.type === 'AUTO_STOP_RESULT') {
      // 已经自动关机了，那条「请在 5 分钟内确认」的通知就失效了，一并清掉，
      // 否则用户之后点它只会得到一次无意义的确认失败。
      await clearAutoStartNotification(message.target);
      await createAutoStopNotification(Boolean(message.ok), message.target, message.message);
      return;
    }
    if (message?.type === 'GPU_AVAILABLE') {
      const stored = await chrome.storage.sync.get({ config: { alarmMuted: false } });
      const alert = { signature: message.signature, names: message.names || [], summary: message.summary || '', sourceTabId: sender.tab?.id || null, muted: Boolean(stored.config?.alarmMuted) };
      await Promise.all([createNotification(alert.summary), broadcastAlert(alert)]);
    }
    if (message?.type === 'PLAY_ALARM') await playAlarm(message.sound);
    if (message?.type === 'GET_ACTIVE_ALERT') {
      if (!activeAlert) activeAlert = (await chrome.storage.local.get('activeAlert')).activeAlert || null;
      sendResponse({ alert: activeAlert });
    }
    if (message?.type === 'TOGGLE_GLOBAL_MUTE') {
      if (!activeAlert) return;
      const stored = await chrome.storage.sync.get({ config: {} });
      const config = { ...stored.config, alarmMuted: !Boolean(stored.config?.alarmMuted) };
      await chrome.storage.sync.set({ config });
      await updateAlert({ muted: config.alarmMuted });
    }
    if (message?.type === 'CLOSE_GLOBAL_ALERT') {
      const stored = await chrome.storage.sync.get({ config: { refreshSeconds: 60 } });
      const seconds = Math.max(5, Number(stored.config?.refreshSeconds) || 60);
      if (activeAlert?.sourceTabId) {
        try {
          await chrome.tabs.sendMessage(activeAlert.sourceTabId, {
            type: 'SCHEDULE_ALERT_REMINDER', signature: activeAlert.signature, seconds
          });
        } catch (_error) { /* tab closed */ }
      }
      await clearAlert();
    }
    if (message?.type === 'OPEN_AUTODL') await focusAutoDL();
    if (message?.type === 'GPU_UNAVAILABLE') await clearAlert();
    if (message?.type === 'TEST_GLOBAL_ALERT') {
      const stored = await chrome.storage.sync.get({ config: { alarmSound: 'classic' } });
      const alert = { signature: `test-${Date.now()}`, names: ['全局提醒测试成功'], summary: '这是一条测试提醒。', sourceTabId: null, muted: Boolean(stored.config?.alarmMuted) };
      await broadcastAlert(alert);
      if (!alert.muted) await playAlarm(stored.config?.alarmSound);
    }
  })().catch((error) => console.warn('Background action failed:', error));
  return true;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!activeAlert) activeAlert = (await chrome.storage.local.get('activeAlert')).activeAlert || null;
  if (!activeAlert) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await showAlertInTab(tab, activeAlert);
  } catch (_error) { /* restricted page */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!activeAlert) activeAlert = (await chrome.storage.local.get('activeAlert')).activeAlert || null;
  if (activeAlert && tab.active) await showAlertInTab(tab, activeAlert);
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    // 「已自动开机」通知：点通知本身也算确认（用户选定的交互方式）
    if (await confirmFromNotification(notificationId)) { await focusAutoDL(); return; }
  } catch (error) { console.debug('Unable to confirm from the notification:', error); }
  await focusAutoDL();
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (buttonIndex !== 0) return;
  try {
    await confirmFromNotification(notificationId);
    await focusAutoDL();
  } catch (error) { console.debug('Unable to confirm from the notification button:', error); }
});
