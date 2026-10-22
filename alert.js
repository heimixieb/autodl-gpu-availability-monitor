/* 置顶提醒窗口的前端逻辑。
 *
 * 这个页面由 background.js 用 chrome.windows.create({ type: 'popup', focused: true }) 打开，
 * 是一个独立的 OS 窗口：浏览器被最小化或盖在别的程序后面时，它依然会弹到屏幕最前面。
 *
 * 注意 alwaysOnTop 只在 ChromeOS 上生效，Windows/macOS 会被静默忽略（已真机验证），
 * 所以这里不能指望 CSS 或窗口属性做「永远压在最上层」。真正的持续可见性靠：
 *   1. 创建时 focused:true —— 立刻弹到前台；
 *   2. background 每 30 秒 drawAttention —— 任务栏一直闪到你点掉为止。
 *
 * 数据来源有两个：
 *   1. 加载时向 background 要一次当前 payload（GET_SYSTEM_ALERT）；
 *   2. 之后由 background 主动推 SHOW_SYSTEM_ALERT 更新内容。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const el = {
    badge: $('badge'),
    title: $('title'),
    subtitle: $('subtitle'),
    message: $('message'),
    countdown: $('countdown'),
    countdownValue: $('countdownValue'),
    countdownHint: $('countdownHint'),
    bar: $('bar'),
    actions: $('actions'),
    close: $('close')
  };

  let payload = null;
  let ticker = null;

  function setText(node, value, hideWhenEmpty) {
    const text = value == null ? '' : String(value);
    node.textContent = text;
    if (hideWhenEmpty) node.hidden = !text;
  }

  function renderCountdown() {
    if (!payload || !payload.deadline) {
      el.countdown.hidden = true;
      if (ticker) { clearInterval(ticker); ticker = null; }
      return;
    }
    el.countdown.hidden = false;
    const total = Math.max(1, Number(payload.windowMs) || 0);
    const update = () => {
      const left = Math.max(0, payload.deadline - Date.now());
      const seconds = Math.ceil(left / 1000);
      const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      el.countdownValue.textContent = left > 0 ? text : '正在自动关机…';
      el.countdown.classList.toggle('done', left <= 0);
      const ratio = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
      el.bar.style.width = `${(ratio * 100).toFixed(2)}%`;
      if (left <= 0 && ticker) { clearInterval(ticker); ticker = null; }
    };
    update();
    if (ticker) clearInterval(ticker);
    ticker = setInterval(update, 500);
  }

  function renderButtons() {
    el.actions.textContent = '';
    const buttons = Array.isArray(payload?.buttons) ? payload.buttons : [];
    for (const spec of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = spec.label || '关闭';
      if (spec.primary) {
        button.className = 'primary';
        button.dataset.accent = payload.accent || 'green';
      }
      button.addEventListener('click', () => dispatch(spec.action));
      el.actions.appendChild(button);
    }
  }

  function dispatch(action) {
    if (!payload) return;
    chrome.runtime.sendMessage({ type: 'ALERT_WINDOW_ACTION', action, key: payload.key, kind: payload.kind });
    if (action === 'close') window.close();
  }

  function render(next) {
    if (!next || typeof next !== 'object') return;
    payload = next;
    card.dataset.accent = payload.accent || 'green';
    document.title = payload.title || 'AutoDL 提醒';
    setText(el.badge, payload.badge || '✓', false);
    setText(el.title, payload.title || 'AutoDL 提醒', false);
    setText(el.subtitle, payload.subtitle, true);
    setText(el.message, payload.message, false);
    setText(el.countdownHint, payload.countdownHint, true);
    renderButtons();
    renderCountdown();
    fitWindow();
  }

  // 内容高度会随文字长度变化，算完再把窗口收成刚好的大小，避免出现大片空白。
  //
  // 这里有两个坑（都是真机截图发现的）：
  //   1. 不能用 card.scrollHeight —— .card 是 height:100%，scrollHeight 返回的是当前视口高度，
  //      等于用旧高度算新高度，永远缩不到内容的真实大小，按钮底部会被裁掉。
  //      必须临时把 min-height 归零，让卡片按内容撑开，再量 getBoundingClientRect。
  //   2. chrome.windows.update 的 height 是「外框高度」，比视口多一个标题栏/边框，
  //      不扣掉的话每次都会矮一点点，底部按钮依旧被切。
  let fitTimer = null;
  function fitWindow() {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(async () => {
      try {
        const previousMin = card.style.minHeight;
        card.style.minHeight = '0';
        const contentHeight = Math.ceil(card.getBoundingClientRect().height);
        card.style.minHeight = previousMin;

        const frame = Math.max(0, Math.round(window.outerHeight - window.innerHeight));
        const target = Math.min(620, Math.max(140, contentHeight + frame + 2));
        const current = await chrome.windows.getCurrent();
        if (current && Math.abs((current.height || 0) - target) > 4) {
          await chrome.windows.update(current.id, { height: target });
        }
      } catch (_error) { /* 窗口正在关闭 */ }
    }, 30);
  }

  el.close.addEventListener('click', () => dispatch('close'));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); dispatch('close'); }
    if (event.key === 'Enter' && !event.isComposing) {
      const primary = el.actions.querySelector('button.primary');
      if (primary) { event.preventDefault(); primary.click(); }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SHOW_SYSTEM_ALERT') render(message.payload);
  });

  chrome.runtime.sendMessage({ type: 'GET_SYSTEM_ALERT' }, (response) => {
    if (chrome.runtime.lastError) return;
    render(response?.payload);
  });
})();
