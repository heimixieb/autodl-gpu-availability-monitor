# Changelog

## [1.5.0] - 2026-10-22

### Added

- **System-level alert window.** Alerts are no longer limited to a toast plus the in-page panel. A dedicated extension window (`alert.html`) is opened as a real OS window with `type: 'popup'` + `focused: true`, so it is raised to the foreground even when the browser is minimised or behind other applications. It has to be dismissed with a button — it does not slide away on its own the way a toast does.
- While the window is open, a 30-second alarm keeps calling `chrome.windows.update({ drawAttention: true })`, so the taskbar button keeps flashing until the alert is dismissed. This does not steal focus, so it cannot interrupt typing.
- The window is reused rather than stacked: a repeat of the same alert updates the open window (and only flashes the taskbar) instead of opening another one.
- Three alert shapes: **GPU available** (green, mute / dismiss / open AutoDL), **auto-started and now billing** (red, live 5-minute countdown with a progress bar, `我已回来，继续使用` as the primary button), and **auto-shutdown result** (blue on success, red with a "shut down manually" button on failure).
- New popup setting `系统级弹窗` with three modes: `浏览器在后台时弹出` (default), `每次提醒都弹出`, `只发系统通知，不弹窗`.
- `Enter` confirms the primary button and `Esc` dismisses the window.
- New message routes: `GET_SYSTEM_ALERT`, `ALERT_WINDOW_ACTION`, `TEST_SYSTEM_ALERT`, `GET_BACKGROUND_INFO`.
- `AUTO_START_RESULT` now carries `deadline` and `windowMs` so the alert window can render the same countdown as the in-page panel.
- The popup detects a stale service worker: unpacked extensions keep running the previously loaded `background.js` until the extension is reloaded, while `popup.html` / `popup.js` are re-read from disk on every open. That mismatch made the test button appear to do nothing. The popup now performs a version handshake on open, shows a warning when the background is outdated, and offers a one-click **立即重新加载扩展** button (`chrome.runtime.reload()`).

### Fixed

- The popup's test button sent `TEST_GLOBAL_ALERT`, which only plays the sound and shows the in-page card — so pressing **测试系统级提醒** never produced the system-level window. It now sends `TEST_SYSTEM_ALERT`.
- The alert window was skipped whenever any browser window was focused, even when the active tab was not an AutoDL page. The in-page panel only exists on the AutoDL instance page, so a user reading another tab was left with sound only. The check is now `alertVisibleToUser()`: a focused normal window **and** an active AutoDL instance tab are both required, otherwise the window is shown.
- The auto-start alert icon used `⏻` (U+23FB), which has no glyph in Chinese system fonts and rendered as a tofu box. It is now `¥`.
- The alert window sized itself from `card.scrollHeight`, which returns the viewport height while the card is `height: 100%`, and it did not subtract the window frame — the bottom buttons were clipped. It now measures the real content height and accounts for the frame.

### Changed

- The popup's test button is now `测试系统级提醒`; it forces the window open even when the browser is focused, so the feature can be verified on the spot.
- Closing the GPU alert from the alert window also clears the in-page alert, and vice versa.

### Notes

- The alert window is produced by the extension itself and needs no installer, native messaging host or registry change. The Windows toast path is unchanged and still used in parallel, so a machine with system notifications switched off still gets a visible alert.
- `chrome.windows` needs no extra manifest permission; the permission list is unchanged.
- `alwaysOnTop` is a ChromeOS-only property; Chrome and Edge on Windows/macOS silently ignore it (verified on a real Edge 155 install — the created window reports `alwaysOnTop: false`). The window is therefore raised once on creation and kept discoverable through taskbar flashing rather than pinned permanently above other windows.

## [1.4.0] - 2026-10-22

### Added

- 5-minute confirmation window after an automatic start: once the instance reports `starting` / `running`, the panel shows a **我已回来：<instance>（取消自动关机）** button with a live countdown, and the success notification gains a **我已回来，继续使用** button. Confirming in either place cancels the automatic shutdown.
- Automatic shutdown on timeout: if nobody confirms within 5 minutes, the extension clicks that instance row's **关机** button, confirms the shutdown dialog, then re-checks the instance API (up to 3 attempts, 15 seconds apart) so an instance nobody is using stops billing.
- Notifications `AutoDL：已自动关机` / `AutoDL：自动关机失败`.
- A successful timeout shutdown turns the auto-start switch off, so `GPU available → start → nobody back → shut down → GPU available again` cannot loop and keep charging.
- The 5-minute deadline is persisted in `storage.local`, so a page reload inside the window keeps counting down instead of restarting.

### Changed

- The auto-start success notification now requires interaction and carries a confirmation button.
- Page auto-refresh is paused while a confirmation window is open, so the confirm button cannot vanish under the user's cursor.

### Safety

- Dialog matching now requires the dialog's own wording (`确认开机…` for start, `确认关机` / `是否关机` / `继续关机` / `关机后` for shutdown) and rejects the opposite wording. This matters because the real shutdown dialog text also contains the word `开机`, which could make the start flow click a shutdown dialog.
- Both matchers were re-verified against the real AutoDL dialogs (start: `确认开机吗？实例将按 ¥0.88/时整点扣费`; shutdown: `确认关机吗？…是否继续关机？`), each confirmed via the `确定` button.
- `无卡模式` dialogs remain skipped in both directions.
- If the instance API is unavailable at shutdown time the extension still clicks the page's `关机` button (the page is the source of truth for that button), but reports failure when it cannot verify the result, and never retries indefinitely.
- Confirmation records older than 30 minutes are discarded on page load, so a stale record cannot shut an instance down days later.

## [1.3.0] - 2026-10-22

### Added

- Optional auto-start: when a monitored instance is shut down and shows `GPU充足`, the extension clicks that row's **Start** button and tries to confirm the start dialog (off by default; enabling it incurs real AutoDL charges)
- Auto-start toggle in both the extension popup and the in-page status panel
- `查开机按钮` probe in the status panel that only reports whether a Start button can be located, without clicking it
- System notifications for auto-start success (`AutoDL：已自动开机`) and failure (`AutoDL：自动开机失败`, after 3 unsuccessful attempts)
- Background fallback check every 30 seconds via `alarms`, so a throttled background tab cannot stall detection; the AutoDL tab is also marked as not auto-discardable

### Changed

- Added the `alarms` permission

### Safety

- Success is only reported for `starting` / `running`; failure states such as `shutdown_by_starting_error` no longer produce a false “already started” notification
- No retry clicks are made when the instance API is unavailable or the instance is missing from the response
- Clicking is capped at 10 attempts per 30 minutes, persisted across page reloads, so a start/stop loop cannot retry indefinitely
- The cap notice is sent only once instead of on every retry window
- The start dialog is confirmed at most once

## [1.0.1] - 2026-09-14

### Fixed

- Move alarm playback from the AutoDL page to an extension offscreen document, avoiding Chromium autoplay-policy errors after automatic refreshes
- Use a fully resolved extension URL for the notification icon and handle notification creation failures

## [1.0.0] - 2026-09-14

### Added

- Multi-instance monitoring by name or instance ID
- Configurable refresh and audible-alert intervals
- One-shot and repeating alerts
- Chromium system notifications
- In-page status and log panel
- Per-instance diagnostics and copyable reports
- Automatic alarm reset after an unavailable → available cycle
- Chrome, Edge, and Arc support
