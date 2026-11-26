import { defineConfig } from "cf/config";

/**
 * Cloudflare Workers Static Assets 0.1.0 正式发布配置（供 `cf deploy ./dist` 读取）。
 *
 * - 纯静态应用，无 Worker 服务端入口（entrypoint）与后端绑定。
 * - `notFoundHandling: "none"`：未知路径与缺失资产返回真实 404，不用 SPA 回退掩盖缺失文件。
 * - `htmlHandling: "auto-trailing-slash"`：保留 Workers Static Assets 默认规则，查询分享参数 `?s=...` 正常工作。
 * - 2026-11-27 经所有者正式授权启用自定义域名 `avatar.conteman.com`（Worker `avatar-studio`，保持 `workersDev: false`），
 *   与 `deploy/release.json`（`stage: "release"`）保持一致；正式部署与公开地址复测按 `docs/RELEASING.md` 执行。
 */
export default defineConfig({
  worker: {
    name: "avatar-studio",
    compatibilityDate: "2026-11-26",
    workersDev: false,
    domains: ["avatar.conteman.com"],
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
    },
  },
});
