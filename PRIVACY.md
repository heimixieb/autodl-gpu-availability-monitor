# 隐私政策 / Privacy Policy

生效日期：2026-10-22

AutoDL GPU Availability Monitor 在用户浏览器本地运行。

- 扩展读取 AutoDL 容器实例页面中已经展示给用户的实例名称、实例 ID、运行状态和“GPU充足”文本，用于本地匹配和提醒。
- 监控目标和提醒设置保存在 Chromium 扩展的 `storage.sync` 中；浏览器可能按照用户自身的同步设置，将这些配置同步到其浏览器账户。
- 最近一次诊断结果保存在 `storage.local` 中。
- 扩展不会读取或保存 AutoDL 密码、Cookie、Authorization 令牌或付款信息。
- 自动开机（可选、默认关闭）只在 AutoDL 页面上点击该实例行中已有的「开机」按钮，不读取、不保存、不上传任何登录凭证或额外数据。
- 自动开机后的 5 分钟确认倒计时、确认状态和「通知 ID → 实例名」映射保存在 `storage.local` 中，只用于本地计时和点击系统通知时定位实例；超时自动关机同样只是点击页面上已有的「关机」按钮。
- 扩展不会向作者、分析平台、广告服务或其他第三方服务器发送任何数据。
- 扩展不包含遥测、分析 SDK、广告或远程加载的可执行代码。

系统通知由浏览器和操作系统负责显示。AutoDL 页面请求由用户当前登录的 AutoDL 页面本身发起。

---

AutoDL GPU Availability Monitor runs locally in the user's browser. It reads visible instance names, IDs, runtime states, and the `GPU充足` label solely for local matching and alerts. Preferences may be synchronized by the browser through `storage.sync`; recent diagnostics stay in `storage.local`.

The extension does not read or store AutoDL passwords, cookies, authorization tokens, or payment information. The optional auto-start feature (off by default) only clicks the existing `开机` button on the AutoDL page; it reads, stores, and transmits no credentials or additional data. The 5-minute confirmation deadline, its state, and the notification-to-instance mapping are kept in `storage.local` purely for local timing and to route a notification click back to the right instance; the timeout shutdown likewise only clicks the existing `关机` button. It sends no data to the authors, analytics providers, advertisers, or other third-party servers, and contains no telemetry, advertising, or remotely hosted executable code.
