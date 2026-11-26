# 更新记录

## 0.1.0（2026-11-27 +08:00）

- 已于 `2026-11-27 06:35 +08:00` 经 Cloudflare Workers Static Assets 正式上线，公开入口 <https://avatar.conteman.com/>（Worker `avatar-studio`，部署源码 `main` SHA `97fe0c9577403f4913fbad9db4ac840b0b3ce5b1`，Version `11e3a3c8-f04f-443b-83c4-42cf5e32210b`，Deployment `d2aa156d-e7ca-4e0d-8c6a-9b6f9cc92864`，100% 流量），并于 `2026-11-27 06:39–06:40 +08:00` 完成公开地址核心流程验收（详见 `docs/RELEASING.md`）。

### 工程与发布配置

- 2026-11-27 经所有者正式授权，完成 `0.1.0` 发布配置：在 `cloudflare.config.ts` 启用自定义域名 `avatar.conteman.com`（Worker `avatar-studio`，保持 `workersDev: false`），将 `deploy/release.json` 切换为 `stage: "release"` 与 `allowedDomains: ["avatar.conteman.com"]`，并同步 `package.json` / `package-lock.json` 版本为 `0.1.0`。
- 增加显式白名单 `dist/` 打包脚本、`deploy/release.json` 阶段与域名清单、候选/正式双模式校验、清单驱动 PR CI 门禁（`verify:ci`）、本地静态预览服务与 `tests/dist.test.cjs` 回归用例（应用源码 `index.html` 无功能变更）。
- 增加 `cloudflare.config.ts`（Workers Static Assets 纯静态配置，`notFoundHandling: "none"`、`workersDev: false`）、`deploy/_headers`、锁定 `cf@1.0.0-rc.1`、PR CI 打包/dry-run 门禁与 `docs/RELEASING.md` 发布及紧急撤下指南。

### 页面

- 窄屏（`<= 720px`）改为紧凑 144px 粘性预览停靠在页头下方，滚动编辑部件、参数和配色时可实时查看头像变化，并提升按钮与滑块触控区域；桌面端保留双栏布局。
- 补齐基础可访问性：滑块绑定可见标签并同步 `aria-valuetext` / `aria-describedby`，裁切、部件、配色预设和锁定按钮暴露 `aria-pressed` 与上下文标签，操作提示增加 `role="status"` 与 `aria-live="polite"`，并补充 `:focus-visible` 焦点轮廓与减少动态偏好支持。
- 复制未写入剪贴板时提示失败。异步写入被拒绝或同步抛错时改为页面内复制；临时文本框会移除，焦点回到原处。
- PNG 使用点击当时的头像和文件名。画布、绘制或图片生成失败时说明原因，并只释放这一次的临时链接。
- 再次复制分享时，新的分享参数位于查询串，锚点留在后面；地址栏已有的其他参数保留。
- 编辑并成功保存草稿后，地址栏会去掉旧的分享参数，直接刷新恢复刚才的编辑。保存失败或只复制、下载时，不改地址栏。
- 刷新恢复本地草稿。合法分享优先；非法或无法识别的分享回到默认形象并提示，不改读草稿。
- 分享和草稿使用格式版本 1。没有版本号的旧链接保持原来的图形。打开分享不会立刻覆盖草稿，开始编辑后才保存。
- 本地存储损坏、不可用或空间不足时仍可编辑、分享和下载，并提示未能保存。
- 页头加入既定「疏」标志的 32px 派生符号，名称仍用活字「半身像工坊」。
- 补充站点 description、theme-color，以及 SVG 与 32px PNG 图标。
- 整体随机与输入种子遵守相同锁定规则；全部锁定后保持同一 SVG，手动更换部件仍有效。
- 发型随机细节独立保存为 `drawingSeed`，分享与复制配置包含该字段，兼容旧分享。
- 参数、配色和部件编辑统一刷新主图、缩略图及选中态；自定义配色按实际颜色匹配预设。
- 修正背景圆点、猫嘴的显示名，以及层序和确定性说明。
