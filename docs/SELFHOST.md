# 半身像工坊 · 自建静态部署指南

本指南面向自行托管半身像工坊的团队或个人。构建结果是纯静态目录 `dist-selfhost/`，无后端、无需安装 npm 依赖，可直接从 Git 仓库或**无 Git 源码包**构建并部署到任意静态托管服务（Nginx、Caddy、Apache、GitHub Pages、Cloudflare Pages、Vercel、Netlify、对象存储等）。

> 官方站点（<https://avatar.conteman.com/>）继续使用独立的 `dist/` 与 `npm run build` / `npm run verify:ci` 发布流程（见 [docs/RELEASING.md](RELEASING.md)），根目录 `index.html` 保持默认品牌不变。社交分享卡（OG/Twitter）、CLI/API/MCP 接口与后端不在当前自建范围内。

## 前置要求

- Node.js 26（仅使用内置模块，无需执行 `npm install`，也不依赖 Git）。
- 若使用源码压缩包（无 `.git`），包内至少需保留：`index.html`、`site.config.json`、`assets/`（默认图标 `assets/mark.svg` 与 `assets/favicon-32.png`，以及你的自定义品牌图标文件）、`scripts/build-selfhost.mjs`、`scripts/verify-selfhost.mjs`（本地预览还需 `scripts/preview-dist.mjs`）。

## 首次换品牌（3 步）

### 第 1 步：放好自己的 Logo 和 favicon

把品牌图片放到仓库内非保留目录（推荐新建 `brand/` 或放在 `assets/`），例如：

- `brand/logo.svg`（推荐 1:1 正方形 SVG 或 PNG，页头按 `32×32` 显示）
- `brand/favicon-32.png` 或 `brand/favicon.ico`

限制与安全约束：

- 必须是仓库内的相对本地路径（使用 `/`），不允许 `http(s)://`、`data:`、绝对路径、`..` 穿越或符号链接。
- 禁止引用母版目录 `rounds/` 或仓库内部目录（`docs/`、`scripts/`、`tests/`、`deploy/`、`dist/`、`dist-selfhost/`、`.git/` 等）。
- Logo 支持 `.svg`、`.png`、`.webp`、`.jpg`、`.jpeg`；favicon 支持 `.svg`、`.png`、`.ico`、`.webp`（单个文件不超过 2 MiB）。
- SVG 必须自包含，不允许 `<script>`、`onload=`、`<foreignObject>`、`<image>`、`<use>`、`xlink:href`、`@import` 或外部 `url(...)`。

### 第 2 步：修改 `site.config.json`

仓库自带默认品牌配置 [site.config.json](../site.config.json) 和自定义示例 [site.config.example.json](../site.config.example.json)。编辑 `site.config.json`（全部 5 个顶层字段必填，不支持多余字段）：

```json
{
  "siteName": "你的站名",
  "title": "你的站名 · 头像工坊",
  "description": "面向团队与社区的纯静态半身头像生成器，支持导出 SVG 或 PNG。",
  "logo": "brand/logo.svg",
  "favicon": {
    "svg": "brand/logo.svg",
    "png": "brand/favicon-32.png"
  }
}
```

| 字段 | 作用 | 格式与限制 |
| --- | --- | --- |
| `siteName` | 页头 `<h1>` 站名 | 非空单行字符串，≤ 80 字 |
| `title` | 浏览器标签页 `<title>` | 非空单行字符串，≤ 120 字 |
| `description` | `<meta name="description">` 页面描述 | 非空单行字符串，≤ 300 字 |
| `logo` | 页头 32px 标志图 | 相对本地路径（`.svg` / `.png` / `.webp` / `.jpg` / `.jpeg`） |
| `favicon` | 浏览器标签页图标 | 单个相对路径字符串（`.svg` / `.png` / `.ico` / `.webp`），或含 `svg` / `png` / `ico` 至少一项的对象 |

只准备了一张图标时，`favicon` 可直接写成字符串，例如 `"favicon": "brand/favicon.ico"` 或与 `logo` 指向同一路径（构建会自动去重）。

### 第 3 步：构建、校验与本地预览

在项目根目录执行（也可把 `npm run ...` 换成对应的 `node scripts/...` 直接运行）：

```sh
# 1. 按 site.config.json 构建独立静态目录 dist-selfhost/
npm run build:selfhost

# 2. 校验配置、资产、白名单、页面引用与产物漂移
npm run verify:selfhost

# 3. 启动本地预览（默认 http://127.0.0.1:8788）
npm run preview:selfhost
```

使用自定义配置文件或输出目录（例如试跑示例配置）：

```sh
node scripts/build-selfhost.mjs --config site.config.example.json --out dist-selfhost
node scripts/verify-selfhost.mjs --config site.config.example.json --out dist-selfhost
node scripts/preview-dist.mjs --dist dist-selfhost --port 8788
```

预览确认页头站名、浏览器标题、Logo 与 favicon 显示正常，以及随机、导出 SVG/PNG 和 `/?s=...` 分享链接工作正常后再上传。

## 上传哪些文件

**只上传 `dist-selfhost/` 目录中的内容**（目录根就是站点根）。每次构建都会清空旧产物，严格按白名单仅生成以下文件：

```text
dist-selfhost/
├── index.html          # 已注入站名、标题、描述与图标引用的单页入口
└── assets/
    ├── logo.<ext>      # 页头 Logo（若 favicon 与 logo 同源则自动复用此文件）
    └── favicon.<ext>   # 浏览器图标（仅当与 logo 不同源文件时单独生成）
```

**不要上传**以下内容：

- 仓库根目录整体、`site.config.json`、`site.config.example.json`
- `docs/`、`rounds/`、`tests/`、`scripts/`、`deploy/`、`dist/`、`node_modules/`、`.git/`、`.github/`
- `package.json`、`cloudflare.config.ts` 等配置或研发文件

静态托管配置建议：

- 默认入口设为 `index.html`，保留查询参数 `/?s=...` 即可正常分享；不需要后端，也不需要把未知路径回退到 `index.html`（未知路径直接返回 `404`）。
- 图标全部使用相对路径 `assets/...`，同时兼容根域名（`https://example.com/`）与子路径（`https://example.com/avatar/`）。
- 建议为 `index.html` 配置 `Cache-Control: public, max-age=0, must-revalidate`，为 `assets/*` 配置较短缓存或在更换图标后刷新缓存。

## 常见报错排查

- **缺件（`Missing asset file` / `Missing site config file`）**：核对 `site.config.json` 中的路径是否存在且拼写一致。
- **无效字段（`Invalid site config`）**：检查是否漏填必填项、拼错字段名、含换行符、使用了外部 URL / `rounds/` 路径，或 SVG 含不安全标签 / 图片头损坏。
- **产物漂移（`Artifact drift`）**：修改 `site.config.json`、源图标或 `index.html` 后未重新构建，或手工改过 `dist-selfhost/`；重新执行 `npm run build:selfhost && npm run verify:selfhost` 即可。
- **多余文件（`Unexpected files in self-host output`）**：`dist-selfhost/` 被放入了白名单外的文件；重新运行 `npm run build:selfhost` 会自动清理重建。
- **输出目录受拒（`Refusing ...`）**：`--out` 仅允许项目内非受保护目录（如默认 `dist-selfhost`、`out/site`）或项目外名为 `dist-selfhost` / `dist-selfhost-*` 的目录，且禁止经由符号链接（含符号链接祖先）指向受保护目录、越过项目边界，或与配置引用的品牌素材目录重叠。
