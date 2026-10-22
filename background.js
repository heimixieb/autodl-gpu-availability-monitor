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

// ---------- 系统级置顶提醒窗口 ----------
// chrome.notifications 的 toast 依赖 Windows/macOS 的系统通知开关。一旦系统通知被关掉
// （或者开着专注助手），提醒就只剩声音；浏览器在后台时用户根本看不到任何东西。
// 所以关键提醒再额外弹一个独立的提醒窗口：它不属于任何标签页，浏览器最小化/被别的程序
// 盖住时也会弹到桌面最前面，而且必须点一下按钮才消失，不会像 toast 那样自己滑走。
// 注意「最前面」的实现方式：创建时 focused:true 抢一次焦点 + 每 30 秒 drawAttention 闪任务栏。
// 不是 alwaysOnTop —— 那个属性在 Windows/macOS 上会被浏览器静默忽略（已真机验证）。
const ALERT_WINDOW_PATH = 'alert.html';
const ALERT_WINDOW_ID_KEY = 'systemAlertWindowId';
const ALERT_PAYLOAD_KEY = 'systemAlertPayload';
const ALERT_WINDOW_WIDTH = 430;
const ALERT_WINDOW_HEIGHT = 300;

let alertWindowId = null;
let alertPayload = null;

async function alertWindowMode() {
  try {
    const stored = await chrome.storage.sync.get({ config: {} });
    const mode = stored.config?.alertWindow;
    return mode === 'always' || mode === 'never' ? mode : 'auto';
  } catch (_error) { return 'auto'; }
}

async function loadAlertWindowState() {
  try {
    const stored = await chrome.storage.local.get([ALERT_WINDOW_ID_KEY, ALERT_PAYLOAD_KEY]);
    if (alertWindowId == null) alertWindowId = stored?.[ALERT_WINDOW_ID_KEY] ?? null;
    if (!alertPayload) alertPayload = stored?.[ALERT_PAYLOAD_KEY] ?? null;
  } catch (_error) { /* 读不到就当作没有 */ }
}

async function rememberAlertWindow(id) {
  alertWindowId = id;
  try { await chrome.storage.local.set({ [ALERT_WINDOW_ID_KEY]: id }); } catch (_error) { /* 忽略 */ }
}

async function alertWindowAlive() {
  if (alertWindowId == null) return false;
  try {
    await chrome.windows.get(alertWindowId);
    return true;
  } catch (_error) {
    alertWindowId = null;
    try { await chrome.storage.local.remove(ALERT_WINDOW_ID_KEY); } catch (_ignore) { /* 忽略 */ }
    return false;
  }
}

// 只看普通窗口：置顶提醒窗口本身是 popup 类型，不能算「浏览器在前台」，
// 否则窗口一弹出来就会把自己当成「用户正在看浏览器」，后续提醒就不再弹了。
async function browserWindowFocused() {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return windows.some((item) => item.focused);
  } catch (_error) { return true; }
}

const AUTODL_INSTANCE_URL_RE = /^https:\/\/(www\.|console\.)?autodl\.com\/console\/instance/;

// 「用户此刻能不能看见页面内面板」。
// 注意不能只用 browserWindowFocused()：面板只画在 AutoDL 实例页上。
// 用户明明开着浏览器、但停在别的标签页（比如正在看文档）时，面板根本不可见，
// 这时候如果因为「浏览器在前台」就不弹系统级窗口，就退回成只能听声音了 ——
// 正是用户反馈要解决的问题。所以必须同时满足：
//   1. 有普通窗口在前台；
//   2. 该前台窗口的当前标签页就是 AutoDL 实例页。
async function alertVisibleToUser() {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const focused = windows.find((item) => item.focused);
    if (!focused) return false;
    const activeTab = (focused.tabs || []).find((tab) => tab.active);
    return Boolean(activeTab && AUTODL_INSTANCE_URL_RE.test(activeTab.url || ''));
  } catch (_error) {
    // 拿不到标签页信息时保守处理：当作看不见，宁可多弹一次也不漏
    return false;
  }
}

async function saveAlertPayload(payload) {
  alertPayload = payload;
  try { await chrome.storage.local.set({ [ALERT_PAYLOAD_KEY]: payload }); } catch (_error) { /* 忽略 */ }
}

async function pushAlertPayload(payload) {
  if (!await alertWindowAlive()) return false;
  // 注意：chrome.tabs.sendMessage 的第一个参数是 tabId，不是 windowId。
  // 置顶窗口是 popup 类型，里面有一个扩展页面 tab，得先把它查出来再发，
  // 否则会把消息发给 id 恰好相同的无关标签页。
  try {
    const tabs = await chrome.tabs.query({ windowId: alertWindowId });
    const tabId = tabs.find((tab) => tab.id != null)?.id;
    if (tabId != null) {
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_SYSTEM_ALERT', payload });
      return true;
    }
  } catch (_error) { /* 退回广播 */ }
  try {
    await chrome.runtime.sendMessage({ type: 'SHOW_SYSTEM_ALERT', payload });
    return true;
  } catch (_error) { return false; }
}

async function alertWindowBounds() {
  const width = ALERT_WINDOW_WIDTH;
  try {
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (last && Number.isFinite(last.left) && Number.isFinite(last.top)) {
      return {
        width,
        left: Math.max(0, last.left + last.width - width - 28),
        top: Math.max(0, last.top + last.height - ALERT_WINDOW_HEIGHT - 72)
      };
    }
  } catch (_error) { /* 拿不到就交给浏览器自己摆 */ }
  return { width };
}

async function createAlertWindow(payload) {
  try {
    const bounds = await alertWindowBounds();
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(ALERT_WINDOW_PATH),
      type: 'popup',
      focused: true,
      width: bounds.width,
      height: ALERT_WINDOW_HEIGHT,
      ...(bounds.left == null ? {} : { left: bounds.left, top: bounds.top })
    });
    await rememberAlertWindow(win.id);
    // alwaysOnTop 只在 ChromeOS 上生效，Windows/macOS 的 Chrome/Edge 会静默忽略（不报错）。
    // 真机实测确认过：这里传了也拿不到置顶。所以窗口真正的「弹到最前」靠的是
    // create 时的 focused:true + 后续 raiseAlertWindow 的 focused:true，
    // 而不是这个属性。保留它只为 ChromeOS 上的用户。
    try {
      await chrome.windows.update(win.id, { alwaysOnTop: true, focused: true, drawAttention: true });
    } catch (_error) { /* 平台不支持置顶，忽略 */ }
    return true;
  } catch (error) {
    console.warn('Unable to open the system alert window:', error);
    return false;
  } finally {
    syncAttentionAlarm();
  }
}

async function raiseAlertWindow() {
  if (!await alertWindowAlive()) return false;
  try {
    // alwaysOnTop 一起传只是为了 ChromeOS；Windows/macOS 上它被忽略，
    // 真正起作用的是 focused:true 和 drawAttention:true。
    await chrome.windows.update(alertWindowId, { focused: true, alwaysOnTop: true, drawAttention: true });
    return true;
  } catch (_error) { return false; }
}

async function flashAlertWindow() {
  if (!await alertWindowAlive()) return false;
  try {
    await chrome.windows.update(alertWindowId, { drawAttention: true });
    return true;
  } catch (_error) { return false; }
}

// 窗口还开着就每隔一段时间闪一次任务栏，直到用户点掉它。
// drawAttention 只闪任务栏、不抢焦点，所以不会打断用户正在做的事；
// 这是「浏览器在后台也一定能注意到」的兜底手段，不依赖任何系统权限。
const ALERT_ATTENTION_ALARM = 'autodl-alert-attention';

async function syncAttentionAlarm() {
  const alive = await alertWindowAlive();
  try {
    if (alive) {
      const existing = await chrome.alarms.get(ALERT_ATTENTION_ALARM);
      if (!existing) await chrome.alarms.create(ALERT_ATTENTION_ALARM, { periodInMinutes: 0.5 });
    } else {
      await chrome.alarms.clear(ALERT_ATTENTION_ALARM);
    }
  } catch (_error) { /* 闹钟不可用时忽略，窗口本身仍然可见 */ }
}

/**
 * 展示一条系统级提醒。
 * - alertWindow 配置为 never：完全不弹窗口（只保留 toast 和页面内提示）。
 * - 用户此刻能看见 AutoDL 页面面板：不弹（面板已经能看见），除非 force。
 * - 其余情况（浏览器在后台 / 停在别的标签页 / 窗口已打开）：弹出来并抢一次焦点，确保用户真的看见。
 */
async function presentSystemAlert(payload, options = {}) {
  const mode = await alertWindowMode();
  if (mode === 'never') return false;
  const previous = alertPayload;
  await saveAlertPayload(payload);

  const alive = await alertWindowAlive();
  if (alive) {
    await pushAlertPayload(payload);
    // 同一条提醒重复刷新时只闪任务栏，不反复抢焦点，避免打断用户打字
    const isRepeat = previous && previous.key === payload.key;
    if (isRepeat && !options.force) await flashAlertWindow();
    else await raiseAlertWindow();
    return true;
  }

  const visible = await alertVisibleToUser();
  if (visible && mode !== 'always' && !options.force) return false;
  return createAlertWindow(payload);
}

async function closeSystemAlert(kind) {
  if (kind && alertPayload && alertPayload.kind !== kind) return false;
  await saveAlertPayload(null);
  if (await alertWindowAlive()) {
    try { await chrome.windows.remove(alertWindowId); } catch (_error) { /* 已关闭 */ }
  }
  alertWindowId = null;
  try { await chrome.storage.local.remove(ALERT_WINDOW_ID_KEY); } catch (_error) { /* 忽略 */ }
  await syncAttentionAlarm();
  return true;
}

function gpuAlertPayload(summary, names, muted) {
  return {
    kind: 'gpu', key: 'gpu', accent: 'green', badge: '✓',
    title: 'GPU 已经空出来了',
    subtitle: names?.length ? names.join('、') : '',
    message: summary || '监控实例已有可用 GPU，回 AutoDL 页面就能开机。',
    buttons: [
      { action: 'mute', label: muted ? '恢复声音' : '静音' },
      { action: 'close', label: '知道了' },
      { action: 'open', label: '打开 AutoDL', primary: true }
    ]
  };
}

function autoStartAlertPayload(target, message, deadline, windowMs) {
  const minutes = Math.max(1, Math.round((Number(windowMs) || 5 * 60 * 1000) / 60000));
  return {
    // badge 用 ¥ 而不是电源符号 ⏻(U+23FB)：后者在中文字体里没有字形，
    // 真机上会渲染成一个方块。¥ 既能表达「正在计费」，所有字体也都有。
    kind: 'autostart', key: `autostart:${target}`, target, accent: 'red', badge: '¥',
    title: '实例已自动开机，开始计费',
    subtitle: target || '',
    message: `${message || '实例已开始开机'}。如果不点「我已回来，继续使用」，${minutes} 分钟后会自动关机。`,
    deadline: Number(deadline) || null,
    windowMs: Number(windowMs) || 5 * 60 * 1000,
    countdownHint: '未确认将自动关机',
    buttons: [
      { action: 'open', label: '打开 AutoDL' },
      { action: 'confirm', label: '我已回来，继续使用', primary: true }
    ]
  };
}

function autoStopAlertPayload(ok, target, message) {
  return {
    kind: 'autostop', key: `autostop:${target}`, target,
    accent: ok ? 'blue' : 'red', badge: ok ? '✓' : '!',
    title: ok ? '已自动关机，停止计费' : '自动关机失败',
    subtitle: target || '',
    message: message || (ok ? '实例已自动关机。' : '请手动到 AutoDL 关机，否则会继续计费。'),
    buttons: ok
      ? [{ action: 'close', label: '知道了', primary: true }]
      : [{ action: 'close', label: '知道了' }, { action: 'open', label: '打开 AutoDL 手动关机', primary: true }]
  };
}

async function toggleAlarmMuted() {
  const stored = await chrome.storage.sync.get({ config: {} });
  const config = { ...stored.config, alarmMuted: !Boolean(stored.config?.alarmMuted) };
  await chrome.storage.sync.set({ config });
  return Boolean(config.alarmMuted);
}

async function handleAlertWindowAction(action, kind) {
  if (action === 'open') {
    await focusAutoDL();
    await closeSystemAlert();
    return;
  }
  if (action === 'close') {
    await closeSystemAlert();
    return;
  }
  if (action === 'mute') {
    const muted = await toggleAlarmMuted();
    if (activeAlert) await updateAlert({ muted });
    if (alertPayload?.kind === 'gpu') {
      await presentSystemAlert(gpuAlertPayload(alertPayload.message, activeAlert?.names, muted));
    }
    return;
  }
  if (action === 'confirm') {
    const target = alertPayload?.target;
    if (!target) { await closeSystemAlert(); return; }
    const delivered = await sendToAutoDLTabs({ type: 'CONFIRM_AUTO_START', target });
    if (delivered) {
      await clearAutoStartNotification(target);
      await closeSystemAlert('autostart');
      return;
    }
    // 没送达就把窗口内容换成明确指引，别让用户以为已经确认过了
    await presentSystemAlert({
      ...alertPayload,
      accent: 'amber', badge: '!',
      title: '确认未送达',
      message: '没找到 AutoDL 实例页面，无法确认。请打开该页面后在右下角面板点「我已回来」，否则到时间仍会自动关机。',
      buttons: [
        { action: 'close', label: '知道了' },
        { action: 'open', label: '打开 AutoDL', primary: true }
      ]
    }, { force: true });
  }
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
  if (alarm.name === ALERT_ATTENTION_ALARM) {
    // 窗口还开着就继续闪任务栏，提醒用户这件事没处理完
    alertWindowAlive()
      .then((alive) => (alive ? flashAlertWindow() : syncAttentionAlarm()))
      .catch((error) => console.debug('Alert attention failed:', error));
  }
});

chrome.runtime.onInstalled.addListener(() => { ensureScanAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureScanAlarm(); });
ensureScanAlarm();
loadAlertWindowState().catch((error) => console.debug('Unable to restore the alert window state:', error));

// 用户自己关掉置顶窗口时同步清掉记录，下次提醒才会重新弹
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== alertWindowId) return;
  alertWindowId = null;
  alertPayload = null;
  chrome.storage.local.remove([ALERT_WINDOW_ID_KEY, ALERT_PAYLOAD_KEY]).catch(() => { /* 忽略 */ });
  syncAttentionAlarm().catch(() => { /* 忽略 */ });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (sender.tab?.id) keepTabAlive(sender.tab.id);
    if (message?.type === 'FETCH_AUTODL_INSTANCES') {
      sendResponse(await fetchAutoDLInstances(sender.tab?.id));
      return;
    }
    if (message?.type === 'AUTO_START_RESULT') {
      await createAutoStartNotification(Boolean(message.ok), message.target, message.message, sender.tab?.id);
      // 开机成功意味着已经开始计费：除了 toast，再弹一个置顶窗口，浏览器在后台也不会漏看
      if (message.ok) {
        await presentSystemAlert(autoStartAlertPayload(
          message.target, message.message, message.deadline, message.windowMs
        ));
      }
      return;
    }
    if (message?.type === 'AUTO_START_CONFIRMED') {
      // 用户在页面面板点了「我已回来」，清掉那条待确认的系统通知和置顶窗口
      await clearAutoStartNotification(message.target);
      await closeSystemAlert('autostart');
      return;
    }
    if (message?.type === 'AUTO_STOP_RESULT') {
      // 已经自动关机了，那条「请在 5 分钟内确认」的通知就失效了，一并清掉，
      // 否则用户之后点它只会得到一次无意义的确认失败。
      await clearAutoStartNotification(message.target);
      await createAutoStopNotification(Boolean(message.ok), message.target, message.message);
      await presentSystemAlert(autoStopAlertPayload(Boolean(message.ok), message.target, message.message));
      return;
    }
    if (message?.type === 'GPU_AVAILABLE') {
      const stored = await chrome.storage.sync.get({ config: { alarmMuted: false } });
      const alert = { signature: message.signature, names: message.names || [], summary: message.summary || '', sourceTabId: sender.tab?.id || null, muted: Boolean(stored.config?.alarmMuted) };
      await Promise.all([createNotification(alert.summary), broadcastAlert(alert)]);
      await presentSystemAlert(gpuAlertPayload(alert.summary, alert.names, alert.muted));
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
      // 置顶窗口上的按钮文案要跟着变，否则「静音」按了没反应
      if (alertPayload?.kind === 'gpu') {
        await presentSystemAlert(gpuAlertPayload(alertPayload.message, activeAlert.names, config.alarmMuted));
      }
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
      await closeSystemAlert('gpu');
    }
    if (message?.type === 'OPEN_AUTODL') await focusAutoDL();
    if (message?.type === 'GPU_UNAVAILABLE') { await clearAlert(); await closeSystemAlert('gpu'); }
    if (message?.type === 'TEST_GLOBAL_ALERT') {
      const stored = await chrome.storage.sync.get({ config: { alarmSound: 'classic' } });
      const alert = { signature: `test-${Date.now()}`, names: ['全局提醒测试成功'], summary: '这是一条测试提醒。', sourceTabId: null, muted: Boolean(stored.config?.alarmMuted) };
      await broadcastAlert(alert);
      if (!alert.muted) await playAlarm(stored.config?.alarmSound);
      // force：即使浏览器在前台也弹一次，方便用户确认「系统级弹窗」到底长什么样
      await presentSystemAlert(
        gpuAlertPayload('这是一条测试提醒，能弹出这个窗口就说明系统级提醒可用。', alert.names, alert.muted),
        { force: true }
      );
    }
    if (message?.type === 'TEST_SYSTEM_ALERT') {
      const opened = await presentSystemAlert(
        gpuAlertPayload('这是一条测试提醒，能弹出这个窗口就说明系统级提醒可用。', ['系统级提醒自检'], false),
        { force: true }
      );
      sendResponse({ ok: true, opened });
      return;
    }
    // 版本握手：popup 用它判断「浏览器里跑的后台脚本」是不是磁盘上这一份。
    // unpacked 扩展改了文件不会自动生效，service worker 要手动 reload 才会换代码，
    // 而 popup.html / popup.js 是每次打开都从磁盘读的 —— 于是会出现
    // 「界面是新的、后台还是旧的」，用户点了按钮毫无反应又不知道原因。
    if (message?.type === 'GET_BACKGROUND_INFO') {
      sendResponse({
        ok: true,
        version: chrome.runtime.getManifest().version,
        features: ['systemAlert', 'alertAttention', 'autoConfirm', 'autoStop']
      });
      return;
    }
    if (message?.type === 'GET_SYSTEM_ALERT') {
      await loadAlertWindowState();
      sendResponse({ payload: alertPayload });
      return;
    }
    if (message?.type === 'ALERT_WINDOW_ACTION') {
      await handleAlertWindowAction(message.action, message.kind);
      sendResponse({ ok: true });
      return;
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
