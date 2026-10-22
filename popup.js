const defaults = { enabled: true, targets: [], refreshSeconds: 60, alarmMode: 'continuous', alarmSeconds: 15, alarmSound: 'classic', alarmMuted: false, autoStart: false, alertWindow: 'auto' };
const $ = (id) => document.getElementById(id);
let savedMuted = false;

chrome.storage.sync.get({ config: defaults }, ({ config }) => {
  const value = { ...defaults, ...config };
  savedMuted = value.alarmMuted;
  $('enabled').checked = value.enabled; $('targets').value = value.targets.join(', ');
  $('autostart').checked = Boolean(value.autoStart);
  $('refresh').value = value.refreshSeconds; $('mode').value = value.alarmMode; $('alarm').value = value.alarmSeconds; $('sound').value = value.alarmSound;
  $('alertWindow').value = ['auto', 'always', 'never'].includes(value.alertWindow) ? value.alertWindow : 'auto';
});

chrome.storage.local.get(['latestDiagnostic', 'lastCheckedAt', 'lastAutoStartResult', 'lastAutoStopResult'], ({ latestDiagnostic = [], lastCheckedAt, lastAutoStartResult, lastAutoStopResult }) => {
  $('diagnostic').textContent = latestDiagnostic.length
    ? latestDiagnostic.map((x) => `${x.found ? (x.available ? '✅' : x.availability === 'unknown' ? '⚠️' : '○') : '⚠️'} ${x.target}：${x.status}${x.source ? `（${x.source}）` : ''}`).join('\n')
    : '尚无诊断结果。请打开 AutoDL 容器实例页面。';
  if (lastAutoStartResult) $('diagnostic').textContent += `\n自动开机：${lastAutoStartResult}`;
  if (lastAutoStopResult) $('diagnostic').textContent += `\n自动关机：${lastAutoStopResult}`;
  if (lastCheckedAt) $('diagnostic').textContent += `\n检查时间：${new Date(lastCheckedAt).toLocaleTimeString()}`;
});

// ---------- 后台脚本版本自检 ----------
// unpacked 扩展改了磁盘文件不会自动生效：popup.html / popup.js 每次打开都重新读盘，
// 但 service worker 要手动在扩展管理页点「重新加载」才会换代码。
// 结果就是「界面是新的、后台还是旧的」，点按钮毫无反应又看不出原因。
// 所以这里主动握一次手，把不匹配明明白白显示出来，并给一个一键重载按钮。
let backgroundReady = false;
let backgroundInfo = null;

function renderStaleWarning() {
  const box = $('staleWarning');
  const text = $('staleText');
  if (!box || !text) return;
  if (backgroundReady) { box.hidden = true; return; }
  box.hidden = false;
  text.textContent = backgroundInfo
    ? `后台脚本还是旧版本（${backgroundInfo.version}），系统级弹窗用不了。点右边的按钮重载一次即可。`
    : '后台脚本还没加载新功能（扩展刚更新过、还没重载）。点右边的按钮重载一次即可。';
}

function probeBackground() {
  let settled = false;
  let timer = null;
  const done = (info) => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    backgroundInfo = info;
    backgroundReady = Boolean(info?.features?.includes('systemAlert'));
    renderStaleWarning();
  };
  try {
    chrome.runtime.sendMessage({ type: 'GET_BACKGROUND_INFO' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) { done(null); return; }
      done(response);
    });
  } catch (_error) { done(null); return; }
  // 旧版后台收到不认识的消息不会回 sendResponse，等 800ms 就当作旧版处理
  timer = setTimeout(() => done(null), 800);
}

probeBackground();

// 一键重载扩展：chrome.runtime.reload() 会让 service worker 重新从磁盘加载代码。
// 这是「改了文件但浏览器还在跑旧代码」这个坑的根治办法，比让用户自己去找按钮可靠。
const reloadButton = $('reloadExt');
if (reloadButton) {
  reloadButton.onclick = () => {
    reloadButton.disabled = true;
    reloadButton.textContent = '正在重载…';
    try { chrome.runtime.reload(); } catch (_error) { reloadButton.textContent = '重载失败，请手动操作'; }
  };
}

$('mode').onchange = () => { $('alarm').disabled = $('mode').value !== 'continuous'; };
$('save').onclick = () => {
  const config = {
    enabled: $('enabled').checked,
    targets: $('targets').value.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean),
    autoStart: $('autostart').checked,
    refreshSeconds: Math.max(30, Number($('refresh').value) || 60),
    alarmMode: $('mode').value,
    alarmSeconds: Math.max(5, Number($('alarm').value) || 15),
    alarmSound: $('sound').value,
    alarmMuted: savedMuted,
    alertWindow: $('alertWindow').value
  };
  chrome.storage.sync.set({ config }, () => window.close());
};

// 测试按钮必须发 TEST_SYSTEM_ALERT（会强制弹系统级窗口）。
// 之前这里发的是 TEST_GLOBAL_ALERT，那个分支只播声音 + 页面内面板，
// 所以用户点了「测试系统级提醒」却只看到浏览器里的小卡片 —— 是消息类型写错了。
$('test').onclick = () => {
  chrome.runtime.sendMessage({ type: 'TEST_SYSTEM_ALERT' }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      backgroundReady = false;
      backgroundInfo = null;
      renderStaleWarning();
    }
  });
};
$('preview').onclick = () => chrome.runtime.sendMessage({ type: 'PLAY_ALARM', sound: $('sound').value });
