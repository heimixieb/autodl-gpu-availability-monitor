(() => {
  'use strict';

  const defaults = { enabled: true, targets: [], refreshSeconds: 60, alarmMode: 'continuous', alarmSeconds: 15, alarmSound: 'classic', alarmMuted: false, autoStart: false };
  // 自动开机：点击后等 20 秒再校验接口状态，最多尝试 3 次（两次点击间隔 >= 20 秒）。
  const AUTO_START_MAX_ATTEMPTS = 3;
  const AUTO_START_VERIFY_DELAY = 20000;
  const CONFIRM_LABELS = new Set(['确认', '确定', '立即开机', '确认开机', '开始开机']);
  // 自动开机成功后的人工确认窗口：5 分钟内没点「我已回来」就自动点「关机」，
  // 避免人不在、实例空跑按分钟计费（用户 2026-10-22 明确要求）。
  const AUTO_CONFIRM_WINDOW = 5 * 60 * 1000;
  // 自动关机：按钮找不到或实例仍在运行时，间隔 15 秒再试，最多 3 次；
  // 关机弹窗在 1.2s / 3s 各找一次确认按钮。
  const AUTO_STOP_MAX_ATTEMPTS = 3;
  const AUTO_STOP_VERIFY_DELAY = 15000;
  const STOP_CONFIRM_LABELS = new Set(['确认', '确定', '立即关机', '确认关机', '开始关机', '关机']);
  // 关机成功/在途的状态。注意不能用黑名单：shutdown_by_* 也是「已经不在跑」。
  const STOPPED_STATUSES = new Set(['stopping', 'shutdown', 'shutdown_by_running_error', 'shutdown_by_starting_error']);
  let config = { ...defaults };
  let lastSignature = '';
  let alarmTimer = null;
  let reminderTimer = null;
  let reminderPaused = false;
  let reloadTimer = null;
  let scanTimer = null;
  let scanInFlight = false;
  let latestRows = [];
  let logs = [];
  let apiRows = [];
  let apiError = '';
  let apiFetchedAt = 0;
  const autoState = new Map();
  const verifyInFlight = new Set();
  let autoWindowSignature = '';
  let lastAutoResult = '';
  // 自动开机成功后的人工确认状态机：pending → confirmed / stopping → stopped / failed。
  // 必须持久化到 storage.local：开机后 GPU 不再「充足」，页面会按刷新间隔自动 reload，
  // 内存里的倒计时会被冲掉，只有存盘才能跨刷新继续计时并按时关机。
  const confirmState = new Map();
  const verifyStopInFlight = new Set();
  let lastConfirmResult = '';

  const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
  const stamp = () => new Date().toLocaleTimeString();
  const addLog = (text) => { logs = [`${stamp()} ${text}`, ...logs].slice(0, 20); renderPanel(); };

  // 扩展被重载/更新后，旧页面里这份脚本持有的 chrome.* 通道会立刻作废，
  // 之后每次调用都抛 "Extension context invalidated"。这里统一兜住：
  // 一旦发现通道已失效就静默停掉所有定时器，等用户刷新页面换成新脚本，
  // 避免在扩展错误页里每 2.5 秒堆一条 unhandled rejection。
  let contextAlive = true;

  function stopAllTimers() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
    if (reminderTimer) clearTimeout(reminderTimer);
    reminderTimer = null;
    if (alarmTimer) clearInterval(alarmTimer);
    alarmTimer = null;
  }

  function isContextInvalid(error) {
    return /Extension context invalidated|message port closed|Receiving end does not exist/i.test(String(error?.message || error || ''));
  }

  function onContextLost() {
    if (!contextAlive) return;
    contextAlive = false;
    stopAllTimers();
    const panel = document.getElementById('agm-panel');
    if (panel) {
      panel.classList.add('agm-dead');
      const head = panel.querySelector('.agm-head span');
      if (head) head.textContent = 'AutoDL GPU Monitor（扩展已更新，请刷新页面）';
      // 内联样式兜底：不依赖 content.css 是否已加载、也不怕页面样式覆盖
      const body = panel.querySelector('.agm-body');
      if (body) body.style.display = 'none';
    }
    console.info('[AutoDL GPU Monitor] 扩展已更新，本页脚本已停止，请刷新页面。');
  }

  // 包一层：失败不抛、不产生 unhandled rejection；通道失效则整体停机。
  function safeSend(message) {
    if (!contextAlive) return Promise.resolve(undefined);
    try {
      // 注意：这里必须直接调用 chrome.runtime.sendMessage，不能递归回 safeSend
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') {
        return result.catch((error) => {
          if (isContextInvalid(error)) onContextLost();
          return undefined;
        });
      }
      return Promise.resolve(result);
    } catch (error) {
      if (isContextInvalid(error)) onContextLost();
      return Promise.resolve(undefined);
    }
  }

  function safeStorageSet(value) {
    if (!contextAlive) return;
    try {
      const result = chrome.storage.local.set(value);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_error) { /* 通道已失效，忽略 */ }
  }

  function countStatuses(text) {
    return (String(text || '').match(/已关机|运行中|开机中|关机中/g) || []).length;
  }

  function leafElementsContaining(target) {
    return [...document.querySelectorAll('body *')].filter((node) =>
      node.children.length === 0 && normalize(node.textContent).includes(normalize(target))
    );
  }

  function findInstanceRow(target) {
    for (const leaf of leafElementsContaining(target)) {
      let node = leaf;
      while (node && node !== document.body) {
        const raw = node.innerText || '';
        const statuses = countStatuses(raw);
        if (normalize(raw).includes(normalize(target)) && statuses === 1 && raw.includes('查看详情')) return node;
        if (statuses > 1) break;
        node = node.parentElement;
      }
    }
    return null;
  }

  const statusText = (status) => ({
    shutdown: '已关机', running: '运行中', starting: '开机中',
    stopping: '关机中', shutdown_by_starting_error: '已关机',
    shutdown_by_running_error: '已关机'
  })[status] || status || '状态未知';

  function findApiInstance(target) {
    const wanted = normalize(target);
    return apiRows.find((row) => normalize(row.name) === wanted || normalize(row.uuid) === wanted) || null;
  }

  function assessApiInstance(instance) {
    const mode = instance.start_mode === 'non_gpu' ? '无卡模式' : '';
    const status = statusText(instance.status);
    const canCheck = instance.status === 'shutdown' || (instance.status === 'running' && instance.start_mode === 'non_gpu');
    const idle = Number(instance.gpu_idle_num);
    const required = Number(instance.req_gpu_amount);
    const hasGpuNumbers = Number.isFinite(idle) && Number.isFinite(required) && required > 0;

    if (!canCheck) {
      return { available: false, availability: 'inactive', status: [status, mode].filter(Boolean).join(' / '), source: '实例接口' };
    }
    if (!hasGpuNumbers) {
      return { available: false, availability: 'unknown', status: [status, mode, 'GPU 状态未知'].filter(Boolean).join(' / '), source: '实例接口' };
    }

    const available = idle >= required;
    return {
      available,
      availability: available ? 'available' : 'unavailable',
      status: [status, mode, `GPU 空闲 ${idle}/${Number(instance.gpu_all_num) || '?'}`, `需要 ${required} 卡`].filter(Boolean).join(' / '),
      source: '实例接口'
    };
  }

  async function refreshApiRows(force = false) {
    const maxAge = Math.max(5, Number(config.refreshSeconds) || 60) * 1000;
    if (!force && apiFetchedAt && Date.now() - apiFetchedAt < maxAge) return;
    const response = await safeSend({ type: 'FETCH_AUTODL_INSTANCES' });
    apiFetchedAt = Date.now();
    if (response?.ok) {
      apiRows = Array.isArray(response.rows) ? response.rows : [];
      apiError = '';
    } else {
      apiRows = [];
      apiError = response?.error || '实例接口暂时不可用';
    }
  }

  async function diagnose(forceApi = false) {
    await refreshApiRows(forceApi);
    const results = [];
    for (const target of config.targets) {
      const instance = findApiInstance(target);
      const row = findInstanceRow(target);
      if (instance) {
        const assessment = assessApiInstance(instance);
        results.push({
          target, found: true, ...assessment,
          instanceStatus: instance.status || '',
          preview: `${target} / ${assessment.status}`
        });
      } else if (!row) {
        results.push({
          target, found: false, available: false, availability: 'unknown',
          status: apiError ? `未识别到实例（${apiError}）` : '未识别到实例',
          source: apiError ? '页面兜底' : '实例接口'
        });
      } else {
        const raw = row.innerText || '';
        const noGpuMode = normalize(raw).includes(normalize('无卡模式'));
        const hasAvailableText = normalize(raw).includes(normalize('GPU充足'));
        results.push({
          target, found: true, available: hasAvailableText,
          availability: hasAvailableText ? 'available' : noGpuMode ? 'unknown' : 'unavailable',
          status: `${(raw.match(/已关机|运行中|开机中|关机中/) || ['状态未知'])[0]}${noGpuMode ? ' / 无卡模式 / GPU 状态未知' : ''}`,
          instanceStatus: '',
          source: '页面兜底',
          preview: raw.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 7).join(' / ')
        });
      }
    }
    latestRows = results;
    safeStorageSet({ latestDiagnostic: results, lastCheckedAt: Date.now() });
    return results;
  }

  // ---------- 自动开机 ----------
  // 只在「页面显示 GPU充足 + 实例接口状态为 shutdown」时，点该实例行的「开机」按钮。
  // 点击后由后续 scan 在 20 秒后回查接口状态，最多 3 次；同一可用窗口内成功/失败都不再重复点击。

  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    if (node.closest('[hidden],[aria-hidden="true"]')) return false;
    let style = null;
    try { style = window.getComputedStyle(node); } catch (_error) { style = null; }
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
    return true;
  }

  function clickableAncestor(node) {
    return node.closest('button,a,[role="button"],.ant-btn,.el-button,input[type="button"]') || node;
  }

  function findStartButton(target) {
    const row = findInstanceRow(target);
    if (!row) return { button: null, reason: '未定位到实例行' };
    const candidates = [...row.querySelectorAll('*')].filter((node) =>
      node.children.length === 0
      && normalize(node.textContent) === '开机'
      && !node.closest('#agm-panel')
    );
    if (candidates.length === 0) return { button: null, reason: '实例行内没有「开机」按钮' };
    const visible = candidates.filter(isVisible);
    if (visible.length === 0) return { button: null, reason: '「开机」按钮当前不可见（可能已开机或在开机中）' };
    return { button: clickableAncestor(visible[0]), reason: '' };
  }

  // 自动关机用的定位逻辑与开机对称：只点实例行里文本恰好等于「关机」的最内层可见元素。
  // 文本必须精确相等，否则「无卡模式关机」「关机中」这类文案会被误点。
  function findStopButton(target) {
    const row = findInstanceRow(target);
    if (!row) return { button: null, reason: '未定位到实例行' };
    const candidates = [...row.querySelectorAll('*')].filter((node) =>
      node.children.length === 0
      && normalize(node.textContent) === '关机'
      && !node.closest('#agm-panel')
    );
    if (candidates.length === 0) return { button: null, reason: '实例行内没有「关机」按钮' };
    const visible = candidates.filter(isVisible);
    if (visible.length === 0) return { button: null, reason: '「关机」按钮当前不可见（可能已关机或在关机中）' };
    return { button: clickableAncestor(visible[0]), reason: '' };
  }

  const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],.ant-modal,.ant-modal-content,.el-dialog,.el-message-box,[class*="modal"],[class*="dialog"]';

  // 真实 AutoDL 的两个弹窗（2026-10-22 用户截图确认）：
  //   开机：「确认开机吗？实例将按 ¥0.88/时整点扣费」+ 取消 / 确定
  //   关机：「确认关机吗？实例: xxx 按量计费的实例关机后GPU将会释放，
  //          再次开机时可能面临空闲GPU不足无法开机，是否继续关机？」+ 取消 / 确定
  // 关键：关机弹窗正文里也含「开机」二字。若只按「文本含开机」找弹窗，
  // 开机流程可能误点用户手动打开的关机弹窗 → 把实例关掉。所以两个方向都要
  // 用「必须匹配自己的标题 + 必须不匹配对方的标题」双条件。
  const START_DIALOG_RE = /确认开机|是否开机|立即开机|开始开机/;
  const STOP_DIALOG_RE = /确认关机|是否关机|继续关机|关机后/;

  function findDialogButton(labels, ownRe, otherRe) {
    // 只在**真实弹窗内**找确认按钮。绝不能退化成 document.body：
    // 那样会把整页文本当成弹窗文本，既可能误点页面上的其他「确定」，也会因为页面本身
    // 含「无卡模式」字样而永远跳过，两个方向都是错的。
    for (const dialog of document.querySelectorAll(DIALOG_SELECTOR)) {
      if (!isVisible(dialog)) continue;
      const text = dialog.innerText || dialog.textContent || '';
      if (!ownRe.test(text)) continue;
      if (otherRe.test(text)) continue;
      // 「无卡模式开机/关机」按无卡计费，不是用户要的，必须跳过
      if (text.includes('无卡')) continue;
      for (const node of dialog.querySelectorAll('button,[role="button"],.ant-btn,.el-button,a')) {
        if (!labels.has(normalize(node.textContent))) continue;
        if (!isVisible(node)) continue;
        return node;
      }
    }
    return null;
  }

  function findConfirmButton() {
    return findDialogButton(CONFIRM_LABELS, START_DIALOG_RE, STOP_DIALOG_RE);
  }

  function findStopConfirmButton() {
    return findDialogButton(STOP_CONFIRM_LABELS, STOP_DIALOG_RE, START_DIALOG_RE);
  }

  function recordAutoStart(target, status, message, extra = {}) {
    autoState.set(target, { ...(autoState.get(target) || {}), ...extra, status, message, at: Date.now() });
    lastAutoResult = `${target}：${message}`;
    safeStorageSet({ lastAutoStartResult: lastAutoResult });
  }

  // ---------- 自动开机后的人工确认 + 超时自动关机 ----------
  // verifyAutoStart 确认开机成功（starting/running）后开一个 5 分钟窗口：
  //   - 用户点面板按钮或系统通知按钮 → confirmed，不再关机；
  //   - 超时未确认 → 自动点实例行的「关机」按钮、确认关机弹窗，再用实例接口回查状态。
  // 状态必须持久化：开机后 GPU 不再「充足」，页面会按刷新间隔 reload，内存倒计时会被冲掉。
  const CONFIRM_STORAGE_KEY = 'autoConfirm';
  const CONFIRM_KEEP_MS = 30 * 60 * 1000;

  function confirmRemainingText(state) {
    const seconds = Math.ceil(Math.max(0, (state.deadline || 0) - Date.now()) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  async function loadConfirmState() {
    try {
      const stored = await chrome.storage.local.get(CONFIRM_STORAGE_KEY);
      const saved = stored?.[CONFIRM_STORAGE_KEY];
      if (!saved || typeof saved !== 'object') return;
      for (const [target, state] of Object.entries(saved)) {
        if (!state || !state.status) continue;
        // 太旧的记录（例如几天前浏览器没开）直接丢掉，避免页面一打开就误关机
        if (Date.now() - (state.updatedAt || 0) > CONFIRM_KEEP_MS) continue;
        confirmState.set(target, state);
      }
    } catch (_error) { /* 读不到就当作没有待确认记录 */ }
  }

  function saveConfirmState() {
    const payload = {};
    for (const [target, state] of confirmState) payload[target] = state;
    safeStorageSet({ [CONFIRM_STORAGE_KEY]: payload });
  }

  function recordConfirm(target, status, message, extra = {}) {
    const previous = confirmState.get(target) || {};
    confirmState.set(target, { ...previous, ...extra, status, message, updatedAt: Date.now() });
    // 只把「关机结果」写进 storage.local 供 popup 展示，pending 不写，避免显示成已关机
    if (status === 'stopped' || status === 'failed') {
      lastConfirmResult = `${target}：${message}`;
      safeStorageSet({ lastAutoStopResult: lastConfirmResult });
    }
    saveConfirmState();
  }

  function beginConfirmWindow(target) {
    const now = Date.now();
    recordConfirm(target, 'pending', `${AUTO_CONFIRM_WINDOW / 60000} 分钟内点「我已回来」确认，否则自动关机`, {
      startedAt: now, deadline: now + AUTO_CONFIRM_WINDOW, attempts: 0, lastClickAt: 0, lastTryAt: 0
    });
    addLog(`自动开机成功：${target} 已开始计费，请在 ${AUTO_CONFIRM_WINDOW / 60000} 分钟内点「我已回来」确认，超时自动关机`);
  }

  function confirmPending(target, source) {
    const state = confirmState.get(target);
    if (!state || state.status !== 'pending') return false;
    recordConfirm(target, 'confirmed', `已确认继续使用（${source}）`, { confirmedAt: Date.now() });
    addLog(`已确认继续使用 ${target}（${source}），不会再自动关机`);
    safeSend({ type: 'AUTO_START_CONFIRMED', target });
    renderPanel();
    return true;
  }

  function hasActiveConfirm() {
    for (const state of confirmState.values()) {
      if (state.status === 'pending' || state.status === 'stopping') return true;
    }
    return false;
  }

  async function checkConfirmWindows() {
    const now = Date.now();
    for (const [target, state] of [...confirmState]) {
      if (state.status === 'pending' && now >= (state.deadline || 0)) {
        if (now - (state.lastTryAt || 0) < AUTO_STOP_VERIFY_DELAY) continue;
        await startAutoStop(target);
      } else if (state.status === 'stopping' && now - (state.lastClickAt || 0) >= AUTO_STOP_VERIFY_DELAY) {
        await verifyAutoStop(target);
      }
    }
  }

  async function startAutoStop(target) {
    const state = confirmState.get(target) || {};
    const attempts = Number(state.attempts) || 0;
    if (attempts >= AUTO_STOP_MAX_ATTEMPTS) {
      const message = `已尝试 ${AUTO_STOP_MAX_ATTEMPTS} 次自动关机仍未成功，请手动关机`;
      recordConfirm(target, 'failed', message);
      addLog(`自动关机失败：${target} - ${message}`);
      safeSend({ type: 'AUTO_STOP_RESULT', ok: false, target, message });
      renderPanel();
      return;
    }
    // 先刷新接口：实例可能已经被用户手动关掉，别再去点「关机」。
    // 但接口不可用时**仍要按页面状态去点**：关机是省钱的保底动作，页面上的「关机」
    // 按钮本身就是可信状态（已关机的实例行只有「开机」按钮，点不到关机）。
    await refreshApiRows(true);
    const instance = findApiInstance(target);
    if (instance && STOPPED_STATUSES.has(instance.status)) {
      recordConfirm(target, 'stopped', `已关机（状态 ${statusText(instance.status)}），无需再点关机`, { attempts });
      addLog(`自动关机：${target} 已经是 ${statusText(instance.status)} 状态`);
      safeSend({ type: 'AUTO_STOP_RESULT', ok: true, target, message: `已关机（状态 ${statusText(instance.status)}）` });
      renderPanel();
      return;
    }
    if (apiError || !instance) {
      addLog(`自动关机：接口暂不可用（${apiError || '未返回该实例'}），改为按页面「关机」按钮操作`);
    }
    const nextAttempts = attempts + 1;
    const { button, reason } = findStopButton(target);
    if (!button) {
      recordConfirm(target, 'pending', `等待「关机」按钮（${reason}），第 ${nextAttempts} 次尝试`, {
        attempts: nextAttempts, lastTryAt: Date.now()
      });
      addLog(`自动关机：${target} 暂未找到关机按钮 - ${reason}，${AUTO_STOP_VERIFY_DELAY / 1000} 秒后重试`);
      renderPanel();
      return;
    }
    recordConfirm(target, 'stopping', `已点击「关机」（第 ${nextAttempts} 次），等待 ${AUTO_STOP_VERIFY_DELAY / 1000} 秒校验`, {
      attempts: nextAttempts, lastClickAt: Date.now(), lastTryAt: Date.now()
    });
    addLog(`自动关机：已点击 ${target} 的「关机」按钮（第 ${nextAttempts} 次）`);
    try { button.click(); } catch (error) {
      const message = `点击关机失败：${error?.message || error}`;
      recordConfirm(target, 'failed', message, { attempts: nextAttempts });
      addLog(`自动关机失败：${target} - ${message}`);
      safeSend({ type: 'AUTO_STOP_RESULT', ok: false, target, message });
      renderPanel();
      return;
    }
    // 关机弹窗可能延迟出现，1.2 秒和 3 秒各找一次；确认过一次就不再重复点
    let confirmed = false;
    for (const delay of [1200, 3000]) {
      setTimeout(() => {
        if (confirmed) return;
        if (confirmState.get(target)?.status !== 'stopping') return;
        const confirm = findStopConfirmButton();
        if (!confirm) return;
        confirmed = true;
        try { confirm.click(); addLog(`自动关机：已确认 ${target} 的关机弹窗`); } catch (_error) { /* 弹窗可能已消失 */ }
      }, delay);
    }
    renderPanel();
  }

  async function verifyAutoStop(target) {
    if (verifyStopInFlight.has(target)) return;
    verifyStopInFlight.add(target);
    try {
      await refreshApiRows(true);
      const instance = findApiInstance(target);
      const status = instance?.status || '';
      const state = confirmState.get(target) || {};

      if (instance && STOPPED_STATUSES.has(status)) {
        const message = `未在 ${AUTO_CONFIRM_WINDOW / 60000} 分钟内确认，已自动关机（状态 ${statusText(status)}）`;
        recordConfirm(target, 'stopped', message, { stoppedAt: Date.now() });
        addLog(`自动关机成功：${target} 状态 ${statusText(status)}`);
        safeSend({ type: 'AUTO_STOP_RESULT', ok: true, target, message });
        disableAutoStartAfterStop(target);
        renderPanel();
        return;
      }

      if (apiError || !instance) {
        const message = apiError ? `无法确认关机结果（${apiError}），请手动检查` : '接口未返回该实例，请手动确认是否已关机';
        recordConfirm(target, 'failed', message);
        addLog(`自动关机：${target} - ${message}`);
        safeSend({ type: 'AUTO_STOP_RESULT', ok: false, target, message });
        renderPanel();
        return;
      }

      if ((state.attempts || 0) < AUTO_STOP_MAX_ATTEMPTS) {
        addLog(`自动关机：${target} 仍是 ${statusText(status)}，准备第 ${(state.attempts || 0) + 1} 次尝试`);
        await startAutoStop(target);
      } else {
        const message = `已尝试 ${AUTO_STOP_MAX_ATTEMPTS} 次仍为 ${statusText(status)}，请手动关机`;
        recordConfirm(target, 'failed', message);
        addLog(`自动关机失败：${target} - ${message}`);
        safeSend({ type: 'AUTO_STOP_RESULT', ok: false, target, message });
      }
      renderPanel();
    } finally {
      verifyStopInFlight.delete(target);
    }
  }

  // 关机后必须停掉「自动开机」，否则用户不在时会出现
  // 「抢到卡 → 5 分钟没确认 → 关机 → GPU 又空出 → 再抢」的无限循环，反复产生计费。
  function disableAutoStartAfterStop(target) {
    if (!config.autoStart) return;
    config = { ...config, autoStart: false };
    addLog(`已自动关闭「GPU 空出后自动开机」开关（${target} 无人确认），需要时请手动重新开启`);
    try {
      const result = chrome.storage.sync.set({ config });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_error) { /* 通道已失效，忽略 */ }
  }

  // 页面级总次数上限：防止「点开机 → 变 starting → 又退回 shutdown → 窗口重置 → 再点」
  // 这种循环无限重试。计数带时间窗并持久化到 storage.local，刷新页面不会重置预算。
  const AUTO_START_CLICK_LIMIT = 10;
  const AUTO_START_CLICK_WINDOW = 30 * 60 * 1000;
  // 只有这两个状态才算真的开机了。黑名单写法会把 shutdown_by_starting_error
  // （开机失败退回关机）和 stopping 误判成成功，导致「已自动开机」的假通知。
  const STARTED_STATUSES = new Set(['starting', 'running']);
  let autoClickCount = 0;
  let autoClickWindowStart = 0;
  let limitNotified = false;

  async function loadClickBudget() {
    try {
      const stored = await chrome.storage.local.get('autoStartClicks');
      const saved = stored?.autoStartClicks;
      if (saved && Date.now() - (saved.windowStart || 0) < AUTO_START_CLICK_WINDOW) {
        autoClickCount = Number(saved.count) || 0;
        autoClickWindowStart = Number(saved.windowStart) || 0;
        limitNotified = Boolean(saved.notified);
      } else {
        autoClickCount = 0;
        autoClickWindowStart = Date.now();
        limitNotified = false;
      }
    } catch (_error) { autoClickCount = 0; autoClickWindowStart = Date.now(); }
  }

  function saveClickBudget() {
    safeStorageSet({ autoStartClicks: { count: autoClickCount, windowStart: autoClickWindowStart, notified: limitNotified } });
  }

  function overClickLimit() {
    if (Date.now() - autoClickWindowStart >= AUTO_START_CLICK_WINDOW) {
      autoClickCount = 0;
      autoClickWindowStart = Date.now();
      limitNotified = false;
      saveClickBudget();
    }
    return autoClickCount >= AUTO_START_CLICK_LIMIT;
  }

  // 点击「开机」并尝试确认弹窗。注意：这里是程序化 DOM 点击（element.click()），
  // 不需要页面在前台，不移动鼠标，也不会抢走窗口焦点。
  function clickStart(target, attempt) {
    if (overClickLimit()) {
      const message = `最近 ${AUTO_START_CLICK_WINDOW / 60000} 分钟内已自动尝试 ${AUTO_START_CLICK_LIMIT} 次，为避免反复重试已停止，请手动开机`;
      recordAutoStart(target, 'failed', message, { attempts: attempt });
      addLog(`自动开机：${message}`);
      // 超限通知只发一次，否则每轮窗口翻转都会再弹一条常驻通知；标记随预算一起持久化
      if (!limitNotified) {
        limitNotified = true;
        saveClickBudget();
        safeSend({ type: 'AUTO_START_RESULT', ok: false, target, message });
      }
      renderPanel();
      return;
    }
    const { button, reason } = findStartButton(target);
    if (!button) {
      recordAutoStart(target, 'failed', reason, { attempts: attempt });
      addLog(`自动开机失败：${target} - ${reason}`);
      safeSend({ type: 'AUTO_START_RESULT', ok: false, target, message: reason });
      renderPanel();
      return;
    }
    autoClickCount += 1;
    saveClickBudget();
    const now = Date.now();
    recordAutoStart(target, 'starting', `第 ${attempt} 次点击开机，等待 ${AUTO_START_VERIFY_DELAY / 1000} 秒校验`, { attempts: attempt, lastClickAt: now, verifyAt: now + AUTO_START_VERIFY_DELAY });
    addLog(`自动开机：已点击 ${target} 的「开机」按钮（第 ${attempt} 次）`);
    try { button.click(); } catch (error) {
      recordAutoStart(target, 'failed', `点击失败：${error?.message || error}`, { attempts: attempt });
      renderPanel();
      return;
    }
    // 开机确认弹窗可能延迟出现，1.2 秒和 3 秒各找一次；确认过一次就不再重复点，
    // 否则弹窗关闭动画期间可能被点两次。
    let confirmed = false;
    for (const delay of [1200, 3000]) {
      setTimeout(() => {
        if (confirmed) return;
        if (autoState.get(target)?.status !== 'starting') return;
        const confirm = findConfirmButton();
        if (!confirm) return;
        confirmed = true;
        try { confirm.click(); addLog(`自动开机：已确认 ${target} 的开机弹窗`); } catch (_error) { /* 弹窗可能已消失 */ }
      }, delay);
    }
    renderPanel();
  }

  // 校验由下一次 scan 触发（而不是 sleep），这样即使标签页在后台被浏览器降频也只会变慢，不会卡死。
  async function verifyAutoStart(target) {
    if (verifyInFlight.has(target)) return;
    verifyInFlight.add(target);
    try {
      await refreshApiRows(true);
      const instance = findApiInstance(target);
      const status = instance?.status || '';
      const state = autoState.get(target) || {};

      if (STARTED_STATUSES.has(status)) {
        recordAutoStart(target, 'success', `已开机（状态 ${statusText(status)}）`, { attempts: state.attempts || 1 });
        addLog(`自动开机成功：${target} 状态 ${statusText(status)}`);
        // 开机成功即开始计费：开一个 5 分钟人工确认窗口，超时自动关机
        beginConfirmWindow(target);
        safeSend({ type: 'AUTO_START_RESULT', ok: true, target, message: `已开机（状态 ${statusText(status)}）` });
        renderPanel();
        return;
      }

      // 接口不可用 / 实例读不到时，无法判断是否开机成功。此时不要再点，避免盲目重复点击。
      if (apiError || !instance) {
        const message = apiError ? `无法确认开机结果（${apiError}），已暂停自动重试` : '接口未返回该实例，已暂停自动重试';
        recordAutoStart(target, 'failed', message, { attempts: state.attempts || 1 });
        addLog(`自动开机：${target} - ${message}`);
        safeSend({ type: 'AUTO_START_RESULT', ok: false, target, message });
        renderPanel();
        return;
      }

      if ((state.attempts || 1) < AUTO_START_MAX_ATTEMPTS) {
        addLog(`自动开机：${target} 仍是关机状态（${statusText(status)}），准备第 ${(state.attempts || 1) + 1} 次尝试`);
        clickStart(target, (state.attempts || 1) + 1);
      } else {
        const message = `已尝试 ${AUTO_START_MAX_ATTEMPTS} 次仍为关机状态，请手动开机`;
        recordAutoStart(target, 'failed', message, { attempts: state.attempts || 1 });
        addLog(`自动开机失败：${target} - ${message}`);
        safeSend({ type: 'AUTO_START_RESULT', ok: false, target, message });
      }
      renderPanel();
    } finally {
      verifyInFlight.delete(target);
    }
  }

  function maybeAutoStart(availableRows) {
    const signature = availableRows.map((row) => row.target).sort().join('|');
    if (signature !== autoWindowSignature) {
      autoWindowSignature = signature;
      autoState.clear();
    }
    if (!config.autoStart) return;
    for (const row of availableRows) {
      // 有未完成的人工确认 / 自动关机流程时，不要对同一实例再次开机
      if (confirmState.has(row.target)) {
        const confirmStatus = confirmState.get(row.target)?.status;
        if (confirmStatus === 'pending' || confirmStatus === 'stopping') continue;
      }
      const state = autoState.get(row.target);
      if (state?.status === 'success' || state?.status === 'failed') continue; // 本窗口内已处理
      if (state?.status === 'starting') {
        if (Date.now() - (state.lastClickAt || 0) >= AUTO_START_VERIFY_DELAY) verifyAutoStart(row.target);
        continue;
      }
      if (row.instanceStatus !== 'shutdown') continue; // 只给「已关机」的实例开机
      clickStart(row.target, 1);
    }
  }

  function probeStartButtons() {
    if (config.targets.length === 0) { addLog('查开机按钮：尚未设置监控实例'); return; }
    for (const target of config.targets) {
      const { button, reason } = findStartButton(target);
      addLog(button ? `查开机按钮：${target} 找到「开机」（${button.tagName.toLowerCase()}）` : `查开机按钮：${target} 未找到 - ${reason}`);
    }
  }

  function playTone() {
    safeSend({ type: 'PLAY_ALARM', sound: config.alarmSound });
  }

  function stopAlarm() {
    if (alarmTimer) clearInterval(alarmTimer);
    alarmTimer = null;
  }

  function cancelReminder() {
    if (reminderTimer) clearTimeout(reminderTimer);
    reminderTimer = null;
    reminderPaused = false;
  }

  function scheduleReminder(signature, seconds) {
    stopAlarm();
    cancelReminder();
    reminderPaused = true;
    const delay = Math.max(5, Number(seconds) || config.refreshSeconds) * 1000;
    reminderTimer = setTimeout(async () => {
      reminderTimer = null;
      reminderPaused = false;
      const current = (await diagnose(true)).filter((row) => row.available).map((row) => row.target).sort().join('|');
      if (!current || current !== signature) return;
      const available = latestRows.filter((row) => row.available);
      startAlarm(signature);
      safeSend({
        type: 'GPU_AVAILABLE', signature,
        names: available.map((row) => row.target),
        summary: available.map((row) => row.preview).join('\n')
      });
      addLog(`到达刷新间隔，GPU 仍然充足，再次提醒${config.alarmMuted ? '（静音）' : ''}`);
    }, delay);
  }

  function startAlarm(signature) {
    if (config.alarmMuted || reminderPaused || !signature) return;
    stopAlarm(); playTone();
    if (config.alarmMode === 'continuous') alarmTimer = setInterval(playTone, Math.max(5, config.alarmSeconds) * 1000);
  }

  function scheduleReload() {
    // 有待确认 / 正在自动关机的实例时不要刷新页面：倒计时虽然已持久化，
    // 但页面刷新会让「我已回来」按钮消失一瞬，用户正要点的时候体验很差。
    if (hasActiveConfirm()) return;
    if (!config.enabled || reloadTimer) return;
    const base = Math.max(30, config.refreshSeconds) * 1000;
    const jitter = Math.round(base * (Math.random() * .2 - .1));
    reloadTimer = setTimeout(() => location.reload(), base + jitter);
  }

  async function scan() {
    if (!contextAlive) return; // 扩展已重载，本页脚本已停机，等刷新
    if (scanInFlight) return;
    if (!config.enabled) {
      // 监控被暂停也要继续跑「确认/自动关机」倒计时：实例已经在计费，
      // 不能因为用户顺手关掉监控就一直烧钱。
      if (hasActiveConfirm()) { await checkConfirmWindows(); }
      renderPanel();
      return;
    }
    scanInFlight = true;
    try {
      if (config.targets.length === 0) {
        // 监控目标被清空时仍要处理已经开始的「确认/自动关机」倒计时
        await checkConfirmWindows();
        renderPanel();
        return;
      }
      const rows = await diagnose();
      const available = rows.filter((x) => x.available);
      const signature = available.map((x) => x.target).sort().join('|');

      await checkConfirmWindows();
      maybeAutoStart(available);

      if (signature) {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = null;
        if (signature !== lastSignature) {
          startAlarm(signature);
          // 系统通知和本轮第一次响铃均由扩展后台处理，避免网页自动播放限制。
          safeSend({
            type: 'GPU_AVAILABLE', signature,
            names: available.map((x) => x.target),
            summary: available.map((x) => x.preview).join('\n')
          });
          addLog(`发现 GPU 充足：${available.map((x) => x.target).join('、')}`);
        }
      } else {
        stopAlarm(); cancelReminder();
        if (lastSignature) {
          safeSend({ type: 'GPU_UNAVAILABLE', signature: lastSignature });
          addLog('GPU 已不再充足，下一次释放将重新提醒');
        }
        scheduleReload();
      }
      lastSignature = signature; renderPanel();
    } finally {
      scanInFlight = false;
    }
  }

  // 实例名来自用户输入，写进 HTML 属性前必须转义，否则带引号的名字会破坏面板结构
  const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function confirmSummary(state) {
    switch (state?.status) {
      case 'pending': return `剩余 ${confirmRemainingText(state)} 未确认将自动关机`;
      case 'confirmed': return '已确认，继续使用';
      case 'stopping': return '正在自动关机…';
      case 'stopped': return state.message || '已自动关机';
      case 'failed': return state.message || '自动关机失败，请手动处理';
      default: return state?.message || state?.status || '未知';
    }
  }

  function renderPanel() {
    let panel = document.getElementById('agm-panel');
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'agm-panel';
      panel.innerHTML = '<div class="agm-head"><span>AutoDL GPU Monitor</span><span class="agm-toggle">−</span></div><div class="agm-body"></div>';
      panel.querySelector('.agm-head').onclick = () => { panel.classList.toggle('agm-collapsed'); panel.querySelector('.agm-toggle').textContent = panel.classList.contains('agm-collapsed') ? '+' : '−'; };
      // 确认按钮用事件委托挂在 .agm-body 上（只挂一次）：面板每 2.5 秒重渲染 innerHTML，
      // 如果给按钮本身挂 onclick，用户点下去的瞬间元素可能已被替换，点击就丢了。
      panel.querySelector('.agm-body').addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-agm-confirm]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        confirmPending(button.dataset.agmConfirm, '面板');
      });
      document.body.appendChild(panel);
    }
    const found = latestRows.filter((x) => x.found).length;
    const available = latestRows.filter((x) => x.available).map((x) => x.target);
    const unknown = latestRows.filter((x) => x.availability === 'unknown').map((x) => x.target);
    const health = !config.enabled ? ['已暂停', 'agm-warn'] : config.targets.length === 0 ? ['尚未设置实例', 'agm-warn'] : found < config.targets.length ? [`识别异常 ${found}/${config.targets.length}`, 'agm-bad'] : ['运行正常', 'agm-ok'];
    const autoOn = Boolean(config.autoStart);
    const autoResults = config.targets
      .map((t) => [t, autoState.get(t)])
      .filter(([, s]) => s)
      .map(([t, s]) => `${t}：${s.message}`);
    const autoText = autoResults.length ? autoResults.join('；') : (lastAutoResult || '尚未触发');
    const confirmRows = [...confirmState.entries()].map(([target, state]) => `${target}：${confirmSummary(state)}`);
    const confirmText = confirmRows.length ? confirmRows.join('；') : (lastConfirmResult || '未触发');
    const confirmWarn = [...confirmState.values()].some((state) => state.status === 'pending' || state.status === 'stopping' || state.status === 'failed');
    const pendingTargets = [...confirmState.entries()].filter(([, state]) => state.status === 'pending').map(([target]) => target);
    panel.querySelector('.agm-body').innerHTML = `
      <div class="agm-row"><span>状态</span><span class="agm-value ${health[1]}">${health[0]}</span></div>
      <div class="agm-row"><span>监控目标</span><span class="agm-value">${config.targets.join('、') || '无'}</span></div>
      <div class="agm-row"><span>GPU 充足</span><span class="agm-value agm-ok">${available.join('、') || '无'}</span></div>
      <div class="agm-row"><span>状态未知</span><span class="agm-value ${unknown.length ? 'agm-warn' : ''}">${unknown.join('、') || '无'}</span></div>
      <div class="agm-row"><span>自动开机</span><span class="agm-value ${autoOn ? 'agm-ok' : ''}">${autoOn ? '已开启' : '已关闭'}</span></div>
      <div class="agm-row"><span>开机结果</span><span class="agm-value ${autoOn ? '' : 'agm-muted'}">${autoOn ? autoText : '未开启'}</span></div>
      <div class="agm-row"><span>开机确认</span><span class="agm-value ${confirmWarn ? 'agm-warn' : 'agm-muted'}">${confirmText}</span></div>
      <div class="agm-row"><span>最近检查</span><span class="agm-value">${stamp()}</span></div>
      <div class="agm-row"><span>提醒</span><span class="agm-value">${config.alarmMode === 'continuous' ? `每 ${config.alarmSeconds} 秒响铃` : '仅响一次'} · ${({classic:'经典提示',double:'双响',digital:'数字警报',gentle:'柔和提示',urgent:'急促提醒'})[config.alarmSound] || '经典提示'}</span></div>
      <label class="agm-check"><input type="checkbox" data-agm="auto" ${autoOn ? 'checked' : ''}> GPU 空出后自动开机（会产生费用）</label>
      ${pendingTargets.length ? `<div class="agm-confirm">${pendingTargets.map((target) => `<button type="button" data-agm-confirm="${escapeAttr(target)}">我已回来：${escapeAttr(target)}（取消自动关机）</button>`).join('')}</div>` : ''}
      <div class="agm-actions"><button data-agm="scan">立即检测</button><button data-agm="test">测试响铃</button><button data-agm="probe">查开机按钮</button><button data-agm="diagnose">复制诊断</button></div>
      <div class="agm-log">${logs.join('\n') || '等待检测…'}</div>`;
    panel.querySelector('[data-agm="scan"]').onclick = () => { apiFetchedAt = 0; scan(); };
    panel.querySelector('[data-agm="test"]').onclick = playTone;
    panel.querySelector('[data-agm="probe"]').onclick = probeStartButtons;
    panel.querySelector('[data-agm="auto"]').onchange = async (event) => {
      const next = { ...config, autoStart: event.target.checked };
      addLog(event.target.checked ? '已开启自动开机：GPU 空出后会自动点「开机」，会产生费用' : '已关闭自动开机');
      try { await chrome.storage.sync.set({ config: next }); } catch (error) {
        if (isContextInvalid(error)) onContextLost();
        else addLog(`保存设置失败：${error?.message || error}`);
      }
    };
    panel.querySelector('[data-agm="diagnose"]').onclick = async () => {
      const report = JSON.stringify({
        url: location.href, time: new Date().toISOString(), targets: config.targets, rows: latestRows,
        autoStart: config.autoStart, autoState: [...autoState.entries()], confirmState: [...confirmState.entries()]
      }, null, 2);
      await navigator.clipboard.writeText(report); addLog('诊断信息已复制');
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SCAN') { scan(); sendResponse({ ok: true }); }
    if (message?.type === 'TEST_SOUND') { playTone(); sendResponse({ ok: true }); }
    if (message?.type === 'SCHEDULE_ALERT_REMINDER') {
      scheduleReminder(message.signature || lastSignature, message.seconds);
      sendResponse({ ok: true });
    }
    if (message?.type === 'CONFIRM_AUTO_START') {
      // 系统通知里的「我已回来」按钮点击后由 background 转发到这里
      const targets = message.target ? [message.target] : [...confirmState.keys()];
      let confirmed = false;
      for (const target of targets) confirmed = confirmPending(target, '系统通知') || confirmed;
      sendResponse({ ok: confirmed });
    }
    if (message?.type === 'SET_ALARM_MUTED') {
      config.alarmMuted = Boolean(message.muted);
      if (config.alarmMuted) stopAlarm();
      else if (lastSignature && !reminderPaused) startAlarm(lastSignature);
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.config) return;
    const wasMuted = config.alarmMuted;
    const wasAutoStart = config.autoStart;
    config = { ...defaults, ...changes.config.newValue };
    stopAlarm();
    if (wasMuted && !config.alarmMuted && lastSignature && !reminderPaused) startAlarm(lastSignature);
    // 刚打开自动开机时，清掉上一轮的失败/成功标记，让它对当前可用窗口重新生效
    if (!wasAutoStart && config.autoStart) autoState.clear();
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
    scan();
  });

  chrome.storage.sync.get({ config: defaults }, async ({ config: saved }) => {
    config = { ...defaults, ...saved };
    // 点击预算跨刷新持久化，避免「刷新页面就重置重试额度」形成长期循环
    await loadClickBudget();
    // 开机确认倒计时同样跨刷新恢复（开机后页面会按刷新间隔 reload）
    await loadConfirmState();
    renderPanel(); scan();
    scanTimer = setInterval(scan, 2500);
  });
})();
