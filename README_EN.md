# AutoDL GPU Availability Monitor

[简体中文](README.md) · [Privacy Policy](PRIVACY.md) · [Changelog](CHANGELOG.md)

An open-source Chromium extension that monitors rented AutoDL instances and alerts you when a stopped instance shows **GPU available** (`GPU充足`).

This is an independent community project, not an official AutoDL product. By default it only alerts you and never starts an instance. Auto-start is an optional, opt-in switch that is off by default and incurs real AutoDL charges once enabled.

## Features

- Monitor multiple rented instances by name or instance ID
- In-page banner, audible alarm, and system notification
- One-shot or repeating alarm with a configurable interval
- In-page status panel with recent checks and logs
- Per-row matching to prevent status leakage from adjacent instances
- Recognition diagnostics that can be copied into an issue report
- Optional auto-start: clicks the instance row's **Start** button for you when a GPU frees up (off by default, incurs real charges)
- Optional timeout shutdown: if nobody confirms within 5 minutes of an automatic start, the instance is shut down so it cannot keep billing while you are away
- No AutoDL password, cookie, or access-token storage
- Supports Chrome, Edge, Arc, and other Chromium browsers

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
- Confirming in either place cancels the automatic shutdown.

**If nobody confirms within 5 minutes**, the extension clicks that instance row's **关机** button, confirms the shutdown dialog, then re-checks the instance API (up to 3 attempts, 15 seconds apart). On success it sends `AutoDL：已自动关机` and **turns the auto-start switch off** — otherwise `GPU available → start → nobody back → shut down → GPU available again` would loop and keep charging you. Re-enable the switch when you need it.

The deadline is stored in `storage.local`, so a page reload does not restart the countdown. The AutoDL tab, however, **must stay open** — without it the extension cannot click `关机` for you.

Worth knowing:

- **You pay for it**: once the instance boots, AutoDL bills you under its own rules. The timeout shutdown is a safety net for "nobody came back", not a replacement for watching your bill. Check your billing mode and balance first.
- The tab does not need to be in the foreground. The extension does not move the mouse or steal window focus, so you can keep working.
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
