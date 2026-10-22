# Changelog

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
