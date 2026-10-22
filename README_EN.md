# AutoDL GPU Availability Monitor

[简体中文](README.md) · [Privacy Policy](PRIVACY.md) · [Changelog](CHANGELOG.md)

An open-source Chromium extension that monitors rented AutoDL instances and alerts you when a stopped instance shows **GPU available** (`GPU充足`).

This is an independent community project, not an official AutoDL product. By default it only alerts you and never starts an instance. Auto-start is an optional, opt-in switch that is off by default and incurs real AutoDL charges once enabled.

## Why this exists

I rent AutoDL instances often. The annoying part is not slow training — it is that the instance is already rented but cannot boot because the host machine's GPUs are all taken.

AutoDL shows a green `GPU充足` row once a GPU frees up. The problem: nobody can sit there refreshing the page.

So the extension watched the page for me and alerted me when a GPU appeared. **That turned out not to be enough.** By the time I saw the alert, walked back to the computer, and clicked Start, the GPU had usually been taken by someone else — the race is measured in minutes, so "alert only" was effectively doing nothing.

Two things were added in response:

1. **Auto-start** — click Start the moment a GPU frees up, so the card is secured before anyone else takes it. The trade-off is that billing begins immediately.
2. **Shut down after 5 minutes without confirmation** — after an automatic start you get 5 minutes to click "I'm back". Clicking means you are at the computer, so it keeps running; not clicking means nobody is there and the instance is burning money unattended, so it is shut down.

A third piece came from the same experience: with the browser in the background the only remaining cue was sound, and with sound off I had no idea anything had happened. Hence the **system-level alert window**, which is raised to the foreground even while the browser is minimised.

## Features

- Monitor multiple rented instances by name or instance ID
- In-page banner, audible alarm, and system notification
- **System-level alert window**: raised to the foreground even while the browser is minimised or covered, and dismissed only with a button
- One-shot or repeating alarm with a configurable interval
- In-page status panel with recent checks and logs
- Per-row matching to prevent status leakage from adjacent instances
- Recognition diagnostics that can be copied into an issue report
- Optional auto-start: clicks the instance row's **Start** button for you when a GPU frees up (off by default, incurs real charges)
- Optional timeout shutdown: if nobody confirms within 5 minutes of an automatic start, the instance is shut down so it cannot keep billing while you are away
- No AutoDL password, cookie, or access-token storage
- Supports Chrome, Edge, Arc, and other Chromium browsers

## Three alert channels

A system notification alone is not reliable: if the OS notification toggle is off (many "optimiser" scripts turn it off) or Focus Assist is on, calling the toast API still succeeds but the system **silently drops** the toast — you are left with sound only, and if sound is muted you learn nothing.

So every important alert goes through three channels at once:

| Channel | Behaviour |
| --- | --- |
| In-page panel | Visible only on the AutoDL page; good while you are looking at the browser |
| System notification | Leaves a trace in the notification centre, but can be blocked by OS settings |
| **System-level alert window** | An extension-owned OS window raised to the front on creation, visible while the browser is in the background, dismissed only by a button |

The alert window needs no installer, no native messaging host and no registry change — the extension creates it with `chrome.windows.create`. It has three shapes:

- **GPU available** (green): `静音` / `知道了` / `打开 AutoDL`
- **Auto-started and now billing** (red): live 5-minute countdown with a progress bar, primary button `我已回来，继续使用`
- **Auto-shutdown result** (blue on success, red on failure): on failure the primary button becomes `打开 AutoDL 手动关机`

`Enter` activates the primary button, `Esc` closes the window.

**One honest limitation**: a browser extension cannot make a window permanently stay on top. `alwaysOnTop` is a ChromeOS-only property; Chrome and Edge on Windows/macOS silently ignore it (verified on a real install). The actual behaviour is therefore: the window grabs focus and comes to the front when created, then the taskbar button flashes every 30 seconds until you dismiss it — it will not interrupt your typing, but you will not miss it. Pinning a window physically above every other program would require a native helper binary, which this extension deliberately does not ship.

By default it opens whenever **you cannot see the in-page panel**. The check is: a browser window is focused **and** its active tab is an AutoDL instance page — only then is the panel considered visible. So minimising the browser, switching to another application, or merely switching to another tab all trigger the window.

The popup's `系统级弹窗` setting switches this to "every alert" or "notification only". The `测试系统级提醒` button forces the window open so you can verify it on the spot.

**If `测试系统级提醒` appears to do nothing**, the browser is still running an older background script. Editing an unpacked extension's files does not reload its service worker — `popup.html` / `popup.js` are re-read from disk on every open, but `background.js` keeps running the previously loaded code until the extension is reloaded. The popup therefore performs a version handshake on open and, on mismatch, shows a red box with a one-click **立即重新加载扩展** button.

## Auto-start (optional)

If you would rather not get up at 3 a.m. to click Start, you can let the extension click it for you. The switch is off by default; turning it on will really boot the instance, and billing really starts.

Enable it in either place:

- Open the extension popup and tick **GPU 空出后自动开机（会产生费用）**;
- Or tick the same option in the status panel at the bottom-right of the AutoDL page.

Both of these must hold before it acts:

- The instance is currently **shut down**;
- Its row shows `GPU充足`, meaning idle GPUs are actually available.

The extension then clicks the **Start** button inside that instance's row and tries to confirm the dialog that follows. After clicking it keeps watching and retries up to 3 times; if the instance is still shut down after 3 attempts, it sends the system notification `AutoDL：自动开机失败` and asks you to start it manually.

### Confirm within 5 minutes, or it shuts down again

Once the automatic start succeeds (the API reports `starting` or `running`), you get **5 minutes** to confirm you are back:

- The status panel at the bottom-right of the AutoDL page shows a red **我已回来：<instance>（取消自动关机）** button with a live countdown;
- The `AutoDL：已自动开机` system notification also carries a **我已回来，继续使用** button;
- The always-on-top window shows the same countdown with `我已回来，继续使用` as its primary button;
- Confirming in any of the three places cancels the automatic shutdown.

**If nobody confirms within 5 minutes**, the extension clicks that instance row's **关机** button, confirms the shutdown dialog, then re-checks the instance API (up to 3 attempts, 15 seconds apart). On success it sends `AutoDL：已自动关机` and **turns the auto-start switch off** — otherwise `GPU available → start → nobody back → shut down → GPU available again` would loop and keep charging you. Re-enable the switch when you need it.

The deadline is stored in `storage.local`, so a page reload does not restart the countdown. The AutoDL tab, however, **must stay open** — without it the extension cannot click `关机` for you.

Worth knowing:

- **You pay for it**: once the instance boots, AutoDL bills you under its own rules. The timeout shutdown is a safety net for "nobody came back", not a replacement for watching your bill. Check your billing mode and balance first.
- The tab does not need to be in the foreground. The extension does not move the mouse; the always-on-top alert window does grab focus once, deliberately — otherwise you might not notice it.
- The AutoDL tab **must stay open** — it must not be closed or discarded. The extension marks that tab as not auto-discardable and adds an `alarms`-based check every 30 seconds so a background tab's throttled timers cannot stall detection.
- If you only want the alert and no charges, leave the switch off; behaviour is exactly as before.
- Page auto-refresh is paused while the confirmation window is open, so the button cannot disappear under your cursor.

## Install

1. Download and extract the ZIP from GitHub Releases.
2. Open `chrome://extensions`, `edge://extensions`, or `arc://extensions`.
3. Enable Developer mode.
4. Select **Load unpacked** and choose the extracted directory.
5. Open and refresh the AutoDL container-instances page.
6. Open the extension popup, enter instance names or IDs, and save.

## How it works

The extension reads the visible state of the signed-in AutoDL instance page. When a monitored row changes to `GPU充足`, it alerts you. The tab must remain open so the extension can periodically refresh it.

## Permissions

- `storage`: saves monitoring preferences
- `notifications`: shows a system notification
- AutoDL host access: reads visible instance status and renders the status panel

No analytics, advertising, remote code, or account credentials are collected. Auto-start only clicks the existing **Start** button on the AutoDL page; it reads and transmits no credentials. See [PRIVACY.md](PRIVACY.md).

## Development

No build step is required. Run `npm run check` and `npm run package`.

## License

[MIT](LICENSE)
