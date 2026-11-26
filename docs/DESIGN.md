# 半身像工坊 · 设计基线

记录日期：2026-11-26。以下当前行为直接对照根目录 `index.html`；基线来源源码 SHA-256 为 `409acac39c73a415f755bce9a63dd4fbef2292edf07c4a6dc8c039dd520e4b2c`。后续目标已批准，尚未实现的行为不作为当前保证。

## 当前职责

单 HTML 包含样式、Engine IIFE 与 UI IIFE。Engine 无 DOM 依赖，已有 CommonJS 导出，`render(state, override)` 返回自包含 SVG。UI 持有状态，负责输入校验、控件与缩略图、下载和分享。没有后端、外部运行时依赖或本地草稿持久化。

`render` 复制 `slots`，只在副本应用可选 `override.slot` / `override.value`，`override.viewBox` 可覆盖裁切。它读取参数与颜色，不应修改输入。锁定与配色预设索引是 UI 元数据，不参与绘图。Engine 自身不负责校验任意外部状态，URL 恢复由 UI 归一化后交给引擎。

## 当前 11 层顺序

SVG 先输出背景底色矩形，再按以下顺序连接层函数返回的片段；空层仍占一个调用位置。后面的片段覆盖前面的片段。

| 顺序 | 函数 | 内容 |
| --- | --- | --- |
| 1 | `bgLayer` | 背景纹样 |
| 2 | `neck` | 脖子底块与侧线 |
| 3 | `bodyBack` | 衣服底形 |
| 4 | `hairBack` | 后侧头发 |
| 5 | `face` | 脸与下颌 |
| 6 | `hairMain` | 主发型与刘海 |
| 7 | `eyes` | 眼睛或眼镜 |
| 8 | `mouth` | 嘴巴 |
| 9 | `bodyFront` | 衣服识别线 |
| 10 | `extra` | 配饰 |
| 11 | `topper` | 头顶搭档 |

页面帮助目前与此顺序不一致，修说明属于后续切片，不据帮助文案重排图形。自检在测试 VM 中给实际层函数加标记，核对调用及最终 SVG 中的顺序，去掉标记后还应与原始渲染完全一致。

## 当前配置

| 字段 | 类型与默认值 | 作用 |
| --- | --- | --- |
| `seed` | 字符串，`studio-01` | 部件抽签、随机参数和配色；也影响发型轮廓细节 |
| `slots` | 下表 7 个字符串字段 | 离散部件选择 |
| `locks` | 对象，默认 `{}` | 槽位键、`params`、`colors` 为真时保留对应输入 |
| `params` | 6 个数字字段 | 连续形状参数，见下表 |
| `colors` | 6 个 `#rrggbb` 字符串 | `ink` 描边、`skin` 肤色、`hair` 发色、`cloth` 衣色、`accent` 点缀、`bg` 背景 |
| `palette` | 默认 `0`，自定义 / 恢复可为 `null` | UI 配色预设选中索引；恢复时根据颜色重新匹配 |
| `view` | `half`（默认）、`bust`、`head` | 裁切，不改变绘制公式 |

| 槽位 | 默认 | 当前选项 |
| --- | --- | --- |
| `bg` | `plain` | `plain`, `circle`, `dots`, `grid`, `rays`, `blob` |
| `body` | `hoodie` | `hoodie`, `crew`, `tee`, `jacket`, `turtleneck`, `overalls` |
| `hair` | `cloud` | `cloud`, `curly`, `bob`, `long`, `short`, `bun`, `pigtails`, `buzz`, `bald` |
| `eyes` | `round` | `round`, `square`, `dots`, `closed`, `shades`, `monocle`, `wink` |
| `mouth` | `smile` | `none`, `smile`, `flat`, `open`, `cat`, `smirk` |
| `extra` | `none` | `none`, `headphones`, `earrings`, `scarf`, `badge`, `freckles` |
| `topper` | `cat` | `none`, `cat`, `calico`, `dog`, `bird`, `plant`, `cap`, `bow` |

共 48 选项；离散组合乘积 653184。全局 `LABELS` 当前有 `dots` 与 `cat` 重名覆盖，显示问题仍待修复。

| 参数 | 默认 | UI / URL 恢复范围 | UI 步长 |
| --- | --- | --- | --- |
| `volume` 蓬松度 | 1.00 | 0.72–1.34 | 0.01 |
| `wave` 卷曲度 | 0.50 | 0–1 | 0.01 |
| `length` 发梢长度 | 0.35 | 0–1 | 0.01 |
| `fringe` 刘海斜分 | 0.35 | -1–1 | 0.01 |
| `faceW` 脸宽 | 1.00 | 0.84–1.20 | 0.01 |
| `shoulders` 肩宽 | 1.00 | 0.84–1.20 | 0.01 |

默认颜色依次为 `ink: #141414`、`skin: #ffffff`、`hair: #a9322b`、`cloth: #a9322b`、`accent: #141414`、`bg: #ffffff`。已有 6 套预设：砖红、靛蓝、抹茶、莓果、海盐、炭灰。

`half`、`bust`、`head` 的 viewBox 分别为 `0 0 600 600`、`60 60 480 480`、`140 60 320 340`。SVG 尺寸属性始终 600×600；PNG 通过 SVG Blob → Image → Canvas 导出 1024×1024。

## 当前分享与恢复格式

分享序列化整个 UI 状态（含 `locks` 与 `palette`）：`JSON.stringify(state)` → UTF-8 字节 → base64 → 将 `+`、`/` 替换为 `-`、`_` 并去掉尾部 `=` → `encodeURIComponent` → 查询参数 `s`。目前没有格式版本字段。点击分享才替换当前 URL 并尝试复制链接，编辑时不自动更新 URL。

读取时取首个 `s` 参数。无 `s` 用默认形象；空值、编码值超过 8000 字符、URI / base64 / UTF-8 / JSON 解码失败，或配置对象结构不合法时，回默认并提示。顶层及可选的 `slots`、`params`、`colors`、`locks` 必须是非数组对象；空对象可以补齐默认值。未知字段忽略。读取兼容标准 base64 的字符与补齐 padding。

- `seed` 去 C0 控制字符并 trim，截取前 160 个 JavaScript 字符串码元；空值保留默认。
- `slots` 仅接受对应白名单，缺失或不合法字段用默认。
- `params` 仅接受有限数字，按范围限幅并取两位小数。
- `colors` 仅接受六位十六进制颜色，转小写；缺失 / 非法值用默认。
- `view` 仅接受三个已知值。锁仅接受严格 `true`，其余不保留；`palette` 根据最终颜色重新计算，不信任传入索引。

复制 JSON 按钮仅导出 `seed`、`slots`、`params`、`colors`、`view`，与分享载荷并不相同；当前没有 JSON 导入入口。没有分享参数时不会恢复此前未分享的编辑。

## 当前随机与已知限制

随机按钮生成新 seed；手动提交 seed 也调用 `randomize`。未锁槽位由 `fromSeed` 抽签；参数锁和颜色锁分别控制随机化。即使全锁定，seed 仍会变化，主发型会用新 seed 绘制细节，因此当前不能保证全锁定后 SVG 不变。手动操作可改变锁定部件；锁的作用域是随机流程。

手动编辑后缩略图及配色选中态可能滞后，手机编辑与预览分离，基础可访问性和剪贴板 / 导出失败路径仍有缺口。复现与浏览器证据见 [实现评估](implementation-review-2026-11-26.md)，不把这些目标计作基线测试已修复。

## 已批准、后续实现

所有者于 2026-11-26 批准 [六个开发切片](development-plan.md)。切片 1 建立维护与回归基线，后续依序接入 Logo、修复锁定和同步、实现草稿及版本化分享、改善手机与可访问性、准备 Workers 首发。

全锁定随机应保持同一 SVG；部件锁保留外观所需输入，参数与颜色分别遵守自身锁。抽签与绘图 seed 在状态层区分，具体字段及 seed 输入框行为在切片 3 明确。恢复目标是合法分享优先、无分享才读草稿、非法分享保留默认回退、首次读分享不立即覆盖草稿、存储失败仍可编辑和导出、兼容现有无版本链接。这些目前均未完成。

明显手机布局先交本地草稿供所有者验收；正式发布需可评审产物与预览，再经所有者验收。`0.1.0` 是首发计划，尚未发布；不在基线阶段增加部署配置或服务端。
