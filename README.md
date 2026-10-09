# CS2 现役职业选手全球分布

一个可交互的 CS2 现役职业选手分布可视化：3D 地球 / 2D 世界地图双视图，
可以按战队、选手 ID、国家名搜索，也可以直接点地图上的国家查看该地区全部现役选手。

**当前数据：99 支战队 · 485 名现役选手 · 48 个国家和地区**（来源：HLTV.org 世界排名前 100；
其中 473 人有头像、115 人共 777 条冠军记录）

---

## 一、怎么跑起来

只有一个前置要求：**装了 Node.js**（本机是 v24.16.0，18 以上都行）。

双击目录里的 **`启动.bat`**，或者在终端里：

```bash
node scripts/serve.mjs
```

服务器起来后**会自动帮你打开浏览器**，地址是 **http://127.0.0.1:5173/**
（如果 5173 被别的程序占了，会自动换到 5174、5175…… 以终端里打印的地址为准）。

> ⚠️ **不要直接双击 `index.html`。** 那样是以 `file://` 打开的，浏览器会因为
> 同源策略拒绝加载 ES 模块、也读不到 `data/*.json`，你只会看到一个空壳页面。
> 必须先启动本地服务器（`启动.bat` 或 `node scripts/serve.mjs`）。
> 如果你不小心这么打开了，页面现在会弹出一个红色的错误遮罩告诉你原因。

> 这一步不需要 `npm install`：前端依赖已经预先放进 `public/vendor/`，
> 服务器 `scripts/serve.mjs` 用的是 Node 自带的 `node:http`，零第三方依赖。

改完 `src/` 下的源码只要刷新页面就生效（没有构建步骤）。
如果改动没反应，按 **Ctrl+F5** 强制刷新，绕开浏览器缓存。

---

## 二、怎么用

| 操作 | 效果 |
| --- | --- |
| 右上角「3D 地球 / 2D 地图」 | 切换两种视图，选择会被记住 |
| 鼠标拖动 / 滚轮 | 3D 下旋转地球、缩放；2D 下平移地图、以光标为中心缩放（1×–10×） |
| 2D 下双击 | 在 1× 和 2.6× 之间来回切换 |
| 点击某个国家或气泡 | 右侧列出该地区的全部现役选手（按战队分组），并列出驻在该地区的战队；地图会平滑飞到那个国家 |
| 点击右侧战队名 | 展开该队完整阵容 |
| 点击任意一名选手 | 打开选手卡片：大头像、国籍、现役战队，以及**冠军荣誉**列表（每条可点进 HLTV 赛事页）。列表里带 🏆N 角标的就是拿过 N 个冠军的人 |
| 顶部搜索框 | 输 `Vitality` / `ZywOo` / `丹麦` / `TYLOO` 都能命中，回车选第一条，↑↓ 可以在候选之间移动 |
| 左侧排行榜 | 国家和地区按选手数排序，点击即定位 |
| `Esc` | 先收起搜索候选，再取消当前选中 |

**颜色与气泡怎么读**（左侧面板的图例是同一套函数现算的，不会和地图对不上）：

- **颜色**是连续色标，不是分档。位置按 `√(人数 / 最多)` 取，然后在一组六色
  色标上插值 —— 所以「多」和「少」之间是平滑过渡的，不会出现差 1 个人就
  换一个颜色、差 20 个人反而同色。
  - 用平方根而不是对数：选手数分布是长尾，取对数会把头部压扁，而
    「俄罗斯 83 人、巴西 43 人」恰恰是这张图最该说清楚的一件事。
  - 深色底图上「越多越深」行不通（国家一暗就沉进海面里了），所以改成
    **越多越浓、越亮**：1 人是很淡的暗蓝，83 人是饱和的金黄，视觉重量单调递增。
- **气泡大小** = `2.5 + 15 × √(人数 / 最多)`，面积**近似**正比于人数（有个常数项，
  所以人少的国家会比严格比例显得略大一点，不然 1 人的气泡会小到看不见）。
  图例里给了 1 / 10 / 83 三个参照圆，可以直接拿去和地图上的气泡比大小。
- 没有数据的国家/地区是半透明的灰蓝，不参与色标。
- 色标只有一处定义（`src/util.js` 的 `RAMP`），2D 的 SVG 填充和 3D 的球面贴图
  都调 `colorFor()`，图例也是。

3D 视图空闲约 4.5 秒后会缓慢自转；拖动时画面只在需要时重绘（按需渲染），
所以静止时几乎不占 GPU。

如果显卡/驱动不支持 WebGL，3D 视图会**自动降级到 2D**，并且「3D 地球」按钮会变灰
（鼠标悬停有说明）。

---

## 三、数据是怎么来的

### 当前数据源：HLTV（已抓好，可直接用）

```
data/hltv.json                   # 抓取原始结果（世界排名前 100 → 有现役阵容的队伍）
data/players.json                # 选手头像与冠军荣誉（由 scrape:players 补）
public/data/dataset.json         # 前端实际读的数据（构建产物）
public/data/countries-110m.json  # 世界底图（GeoJSON，含中国标准口径与九段线）
public/avatars/<数字id>.webp      # 选手头像，120×120，约 4 KB 一张
```

重新抓取（会**弹出一个浏览器窗口**）：

```bash
npm run scrape:hltv -- --limit 100   # 抓 HLTV 世界排名前 100 队（默认只抓前 30）
npm run scrape:players               # 补每个选手的头像 + 冠军荣誉（可中断，重跑自动续）
npm run dataset:hltv                 # 加工成前端数据
npm run test                         # 冒烟测试：验证 数据 → 地图 这条链路
```

`--limit 100` 大约 30–35 分钟，`scrape:players` 再 30 分钟左右，都建议放着跑。

> **为什么是 100 而不是 50**：排名页一页就列出 250 支队。早先只抓前 50，
> 结果澳洲的 FlyQuest（第 75）怎么搜都搜不到 —— 数据集里根本没抓它。
> 用 `--limit 100` 就覆盖到了。

#### 选手头像与冠军荣誉

这两样由 `scripts/scrape-players.mjs` 单独补（在 `scrape:hltv` 之后跑）。
过程中踩到的坑比想象的深，都写在脚本头部注释里，这里只记结论：

- **头像图片也在 Cloudflare 后面**：`img-cdn.hltv.org` 对普通 fetch 返回 403；
  在 hltv.org 页面里 `fetch()` 也会因缺 CORS 头报 `TypeError: Failed to fetch`。
  唯一走得通的是 **CDP 的 `Network.getResponseBody`** —— 先让页面把图加载出来，
  再按 `requestId` 取原始字节，这是浏览器自己的网络栈，不受 CORS 约束。
- **CDN 的 `s=` 签名绑定 `w=` 参数**：把 `w=400` 改成 `w=120` 直接 403，要不到小图。
  原图 400×417 约 88 KB，500 人就是 40+ MB，不能直接入库。
  解法是把原图当 **data: URL** 塞回页面（data URL 同源，**不会污染 canvas**），
  用 canvas 缩到 120×120 再 `toDataURL('image/webp', 0.88)` —— 约 4 KB 一张，
  透明背景也保得住。500 人合计约 2 MB。
  ⚠ 直接用 CDN 地址画 canvas 会因跨域污染画布，`toDataURL` 抛 `SecurityError`。
- **不逐个 `Page.navigate`**：停在 hltv.org 上用**同源 fetch** 把选手页 HTML 拉下来，
  在页面里 `DOMParser` 解析出需要的那点字段再传回 Node，省掉整页渲染的开销。
- **"冠军"的判据**：只认 `.trophySection a.trophy[href^="/events/"]`。
  同一排里的 MVP 次数、`#N best player in YY`、Player/AWPer of the Year、
  `Winner of ESL Grand Slam`（href 是 `/news/`）、`Faceit winner of: FPL` 全部剔除。
  实测 ZywOo 页面上 44 个奖杯块里只有 28 个是真正的赛事冠军。
- **去重要按 `href` 而不是赛事名**：HLTV 的 `title` 大多带年份（"IEM Katowice 2025"），
  但偶尔不带。年年都办的比赛按名字去重会把 IEM Katowice 2021/2024/2025 压成一条，
  冠军数直接少算。每个 `/events/<id>` 才是一次独立的夺冠。
- **少数选手没有头像**：485 人里有 12 人拿不到（HLTV 上就没有可用的大图，
  或 CDN 请求失败）。这些人在页面上会退化成首字母圆片，不是 bug。

#### 为什么抓 HLTV 必须开窗口（踩过的坑）

HLTV 前面挂着 Cloudflare 的托管挑战，直接请求只会拿到 403 和一个
`<title>Just a moment...</title>` 页面。要过它必须满足两个条件，缺一不可：

1. **必须有窗口**。无头模式下浏览器原生 UA 是 `HeadlessChrome/154.0.0.0`，
   Cloudflare 一眼识破，会一直卡在 `Just a moment...`。
2. **绝对不要伪造 UA**。脚本里曾经传过 `--user-agent=<硬编码串>`，结果是
   `navigator.userAgent` 说有头、`navigator.userAgentData` 却说无头（无头下它是
   `undefined`），两个指纹互相矛盾，挑战永远过不去。同理，
   `--hide-scrollbars`、`--disable-background-networking` 这类"自动化常用开关"
   也会被指纹识别，已从 `scripts/lib/browser.mjs` 里去掉。

实测对照：**覆写 UA → 卡 90 秒超时；不覆写 + 有窗口 → 约 38 秒自动通过。**

HLTV 的页面结构偶尔会变。如果脚本报"没解析出选手"，它会把页面原始 HTML
存到 `data/raw/hltv-sample.html`，照着改脚本里的 `EXTRACT_TEAM` 选择器即可。

> HLTV 的数据请只用于个人学习研究，不要再分发。

### 备选数据源：Liquipedia（全球覆盖面更广）

```bash
npm run scrape                   # 抓 Liquipedia（约 75 秒，串行限速 2.1 秒/请求）
npm run dataset:liquipedia       # 用它重建前端数据
npm run test
```

Liquipedia 这条线覆盖**全球 820 个队伍页**，能挖出 101 支有现役阵容的战队、
470 名选手、54 个地区 —— 广度比 HLTV 的排名榜大得多，但时效性和"现役职业"的
权威性不如 HLTV。两条线产出的 `data/*.json` 结构完全一致，前端不用改，
切换只影响 `public/data/dataset.json` 的来源。

Liquipedia 内容按 **CC-BY-SA 3.0** 授权。限速与 User-Agent 都写在
`scripts/scrape-liquipedia.mjs` 顶部，请勿调低限速。

> 页面右下角会自动显示当前数据集的来源与授权（读的是 dataset.json 的
> `meta.source` / `meta.license`），所以换源后不用改前端文案。

---

### 底图

`public/data/countries-110m.json` 由 `scripts/build-basemap.mjs` 生成，采用**中国标准地图口径**
（含台湾、藏南与南海诸岛九段线），不是直接从 world-atlas 拷来的：

```bash
npm run basemap     # 重新生成底图（会联网拉 DataV GeoAtlas，缓存到 .tmp-geo/）
```

脚本自带绕向、面积与跨 ±180° 的自检，跑通时会打印各国面积（中国约 9,526,309 km²）供比对。
实现细节与踩过的坑都写在 `scripts/build-basemap.mjs` 的头部注释里。

> `npm run dataset` **不会**覆盖底图；文件不存在时会提示你先跑 `npm run basemap`。

---

## 四、目录结构

```
index.html                  页面骨架 + import map（依赖映射）
启动.bat                    Windows 一键启动
src/
  main.js                   应用入口：状态、搜索、详情面板、视图切换
  globe3d.js                three.js 地球：程序化生成球体贴图、Sprite 气泡、解析解拾取
  globe2d.js                D3 自然地球投影的 2D 地图（事件委托 + 自实现缩放平移）
  util.js                   国旗 emoji、颜色刻度、经纬度 ↔ 三维坐标
  style.css                 深色主题样式
scripts/
  serve.mjs                 零依赖静态服务器（替代 vite dev）
  vendor.mjs                把 node_modules 里的 ESM 入口复制到 public/vendor/
  scrape-hltv.mjs           HLTV 抓取器（当前数据源，会弹窗口过 Cloudflare）
  scrape-players.mjs        补每个选手的头像 + 冠军荣誉（头像走 CDP 取字节，见「三」）
  scrape-liquipedia.mjs     Liquipedia 抓取器（备选数据源）
  build-dataset.mjs         抓取结果 → dataset.json
  build-basemap.mjs         世界底图 → countries-110m.json（含中国标准地图口径修正）
  smoke-test.mjs            不开浏览器的链路自检
  lib/browser.mjs           起一个可远程调试的 Chrome
  lib/cdp.mjs               极简 CDP 客户端（Node 自带 WebSocket）
  lib/countries.mjs         国名 → ISO 两字母码
  dev/                      开发用检查（check:imports / check:boot / check:3d / check:e2e）
public/
  data/                     dataset.json + 底图 countries-110m.json
  avatars/                  选手头像，120×120 WebP，约 4 KB 一张
  vendor/                   预先放好的前端依赖（three / d3-geo / d3-array / internmap；
                            topojson-client 现在只有构建脚本用，前端不再加载）
data/
  hltv.json                 当前默认数据源的抓取原始结果
  players.json              选手头像文件名与冠军荣誉列表
  liquipedia.json           备选数据源的抓取原始结果
  countries.raw.json        国家元数据缓存（world-countries）
```

### 为什么不用 Vite

本来是用 Vite 的，但在受限制的环境里 `vite build` 会抛
`[commonjs--resolver] spawn EPERM`（Vite 内部会 `exec('net use')`，
而沙箱禁止用管道 stdio 起子进程）。于是改成 **import map + 零依赖静态服务器**：
`index.html` 里声明裸模块名到 `/vendor/...` 的映射，浏览器原生 ESM 直接加载。
好处是没有任何构建步骤，改完源码刷新页面就生效。

要重新生成 `public/vendor/`（比如升级了依赖）：

```bash
npm install --ignore-scripts
npm run vendor
```

`--ignore-scripts` 是必须的，否则 postinstall 会因为同样的沙箱限制失败。

---

## 五、自检

```bash
npm run test
```

会验证：结构自洽（战队阵容人数合计 = 选手总数）、国家码能和世界地图的
GeoJSON 要素对上、每个国家的气泡坐标确实落在本国境内、
搜索能命中战队/选手/国家、**地图口径**（藏南/台湾/钓鱼岛属于中国，且布尔减没有
误伤邻国），以及前端模块解析（相对 import 是否存在、
裸模块名是否都在 import map 里、`public/vendor/` 是否齐备）。
当前 **32 项全部通过**。

`scripts/dev/` 下还有四个开发用检查，前三个**不用开浏览器**：

```bash
npm run check:imports   # 扫 src/ + public/vendor/ 共 138 个 js，确认模块图自洽
npm run check:boot      # 用 linkedom 造一个假 DOM，把 src/main.js 真跑一遍，抓运行时报错
npm run check:3d        # 用一个假 WebGLRenderer 把 src/globe3d.js 真跑一遍，验证拾取链路
npm run check:e2e       # 真的拉起 Chrome，量真实布局 + 截图（需要 Node 之外的权限，见下）
```

`check:boot` 和 `check:3d` 需要一次性装个 linkedom（故意不写进 `package.json`）：

```bash
npm install linkedom --no-save --ignore-scripts
```

**没装也不会报错**——这两项会打印一行「跳过」并正常退出，因为它们只是开发期辅助，
真正必需的是 `npm test`（32 项）。

它会打印启动后各视图的元素数量、点击左侧首行和搜索的结果，以及任何未捕获异常。
`check:3d` 还会遍历假渲染器收到的场景，报告气泡/星空/贴图是否真的建出来，
并在一块 117 点的网格上模拟点击，确认点到的地方能解析成正确的国家。

### 为什么还需要 check:e2e

前三个检查用的是**假 DOM**，它把 `getBoundingClientRect()` 写死成 900×620 ——
所以**任何 CSS 层面的塌陷它都发现不了**。曾经就发生过：`.crash { display: grid }`
盖过了浏览器对 `hidden` 属性的默认样式，导致一个空白的报错遮罩铺满全屏挡住整张地图，
而三个无浏览器检查全部是绿的。`check:e2e` 就是为了堵这个洞：

```bash
npm run check:e2e -- http://127.0.0.1:5180/
```

它会真启动 Chrome（走 CDP over TCP，不用命名管道），然后：

- 收集页面里所有 `console.*` 与未捕获异常；
- 量真实布局：`#viewport` 尺寸、canvas 尺寸、SVG 的 path/气泡/标签数量、遮罩是否可见；
- 依次切到 2D、点开一个国家，各截一张图到 `.tmp-shots/`。

注意两点：它会**每次重建 `.tmp-profile/e2e`**（视图模式存在 `localStorage` 里，
不重建的话你会截到上一轮的视图）；另外它需要能真正启动浏览器进程，
在受限沙箱里要给足权限，普通终端直接跑即可。

---

## 六、已知取舍

- **战队驻在地**靠的是数据源给的 `location` 字段（Liquipedia 取队伍页；HLTV 取队伍页
  的国旗），不是每个选手的出生地；选手国籍则来自阵容表里的国旗。两者是不同维度，
  右侧面板分成了两组展示。
  ⚠ HLTV 对国际纵队（Vitality、MOUZ、FaZe 等）给出的是 **"Europe"** 这种赛区名而不是
  国家名，所以这些队伍不会在地图上落到某个国家 —— 但**国家维度的统计和气泡完全不受影响**，
  因为它是按每个选手的国旗算的（`scripts/build-dataset.mjs`）。
- **科索沃（xk）** 在世界地图数据里没有对应国土（world-atlas 110m 里没有），
  只会显示气泡、不会被填色，元数据在 `scripts/build-dataset.mjs` 的 `MANUAL` 表里手工补的。
- **110m 地图精度**有限，以色列这类细长国家的边界被简化过，
  所以构建时会自动把气泡吸附到国土几何内部（`snapInside`）。

---

## 七、遇到问题怎么办

页面右下角不会再"默默空白"：任何致命错误都会弹出一个红色遮罩，
写明「发生了什么 / 可能的原因 / 怎么解决」，并有一个「复制详情」按钮方便反馈。

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面只有空壳，顶部写「正在构建地球…」 | 直接双击了 `index.html`（`file://`）。**现在页面会自己说清楚**：`index.html` 底部有一段普通内联脚本（不是 module），检测到 `file://` 就把「打开方式不对 + 正确做法」整页写出来。用 `启动.bat` 重开即可。 |
| 页面卡在「正在构建地球…」，15 秒后弹出「页面没能启动」 | 走的是 HTTP 但脚本没加载到（`src/main.js` 返回 404、服务器起错目录等）。内联脚本里有个 15 秒看门狗（靠 `window.__CS2_BOOTED__` 判断模块有没有跑起来），以及 `src/main.js` 标签上的 `onerror`。按提示检查地址、404、然后 `Ctrl+F5`。 |
| 弹窗里的按钮点了没反应 | 正常情况不会发生；只有「内联兜底脚本」弹出的遮罩会这样，因为绑定事件的 `main.js` 没跑起来 —— 所以那段脚本会自己把「重新加载」接上 `location.reload()`，并把「复制错误信息」改成「关闭提示」。 |
| 提示 `HTTP 404` / `HTTP 500` | 服务器没跑在项目根目录，或者 `public/data/` 被删了。重新跑 `npm run dataset`。 |
| 画面卡顿 | 早年版本用了 `backdrop-filter` 模糊压在 WebGL 画布上，每帧都要重新合成；现已全部去掉。另外 3D 拾取从"对 1.2 万个三角面求交"改成了纯数学解析解。如果还卡，检查系统是否在跑省电模式/集显降频。 |
| 3D 视图一片黑 | 显卡不支持 WebGL。会自动切到 2D 并把 3D 按钮置灰。也可以在浏览器地址栏进 `chrome://gpu` 查看。 |
| 改了源码没生效 | `Ctrl+F5` 强制刷新（服务器虽然发了 `no-cache`，但浏览器仍可能复用内存缓存）。 |
| 端口 5173 被占用 | 服务器会自动 +1；**以终端里打印的地址为准**，别照抄 5173。 |
| 整张地图被一个空白「页面出错了」遮罩盖住 | 已修（2026-10）。`.crash` 的 `display: grid` 会盖过浏览器对 `hidden` 属性的默认样式，现在 `src/style.css` 顶部有 `[hidden] { display: none !important }` 兜底。**这类纯 CSS 的坑只有 `npm run check:e2e` 能发现。** |
| 详情标题或搜索里出现 `[object Object]` | 已修（2026-10）。`world-countries` 的 `name` 字段是 `{ common, official, native }` 对象而不是字符串，构建数据集时现在取 `name.common`；前端另有 `enName()` 兼容两种形态。 |
| 选手头像显示成首字母圆片 | 这是**有意的降级**，不是破图：说明该选手没有头像数据。跑一次 `npm run scrape:players` 再 `npm run dataset:hltv` 即可。 |
| 选手卡片里「暂无冠军记录」 | 两种情况：要么确实没抓过（同上），要么这名选手真的没拿过冠军。HLTV 上的 MVP 次数、`#N best player`、年度最佳、ESL Grand Slam、FPL 都不算冠军，会被主动滤掉。 |
| 抓取脚本卡在 `Just a moment...` | Cloudflare 又拦住了。确认**没有加 `--headless`**、也没有手动传 `--user-agent`（详见「三 → 为什么抓 HLTV 必须开窗口」）。 |

> **一条教训**：`.crash` 那个坑之所以能活下来，是因为三个无浏览器检查全绿。
> 假 DOM 把 `getBoundingClientRect()` 写死、也没有真实 CSS 级联，
> 所以「元素存在、代码没报错」≠「用户看得见」。改完样式务必跑一次 `npm run check:e2e`。

还有一个容易被忽略的坑：**同时开着多个服务器实例**。
如果之前有一个旧的 `node scripts/serve.mjs` 没关掉，它可能占着 5173 并在提供旧副本，
而新开的服务器退到了 5174 —— 你就会以为"改动没生效"。
排查：`netstat -ano | findstr :517`，然后 `taskkill /PID <pid> /F`。

---

## 八、数据来源与使用声明

这个仓库里带着抓好的数据（`data/hltv.json`、`data/dataset.json`、`data/liquipedia.json`），
所以 clone 下来就能直接跑，不用先抓一遍。但请先读完这一节。

### HLTV（当前默认数据源）

- 抓的是 HLTV.org 的公开页面：世界排名页 + 各战队页面的现役阵容 + 各选手页面的
  头像与冠军荣誉。
- **仅供个人学习与研究使用，请勿再分发、勿用于商业用途。** 这条声明同时写在
  `data/hltv.json` 的 `license` 字段里，页面上也会照原样展示。
- `public/avatars/` 里的选手头像下载自 `img-cdn.hltv.org`，版权归 HLTV.org 与
  摄影师所有，同样**只在本仓库内作演示用途**。不想要这些图可以整个目录删掉，
  前端会自动退化成首字母圆片。
- `scripts/scrape-hltv.mjs` 默认串行执行、每次请求间隔 2.6 秒。请不要把它调快，
  也不要高频重复抓取。
- 本项目与 HLTV.org 没有任何隶属关系。若你是权利方并希望删除相关内容，开个 issue 即可。

### Liquipedia（备选数据源）

- 内容来自 [Liquipedia](https://liquipedia.net/counterstrike)，采用
  [CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 许可。
  再分发是被允许的，但**必须署名，并以相同方式共享**。
- 页面上已标注「数据来源：Liquipedia (CC-BY-SA 3.0)」，修改或再分发时请一并保留。

### 第三方资源

- `public/vendor/` 下的 `three.js`、`d3-geo`、`d3-array`、`internmap`
  由 `npm run vendor` 从 npm 拷进仓库，各自遵循其原始许可（MIT / ISC / BSD）。
  `topojson-client` 现在只在构建底图时使用（`scripts/build-basemap.mjs`），
  前端运行时不加载它，但它仍留在 `package.json` 里。
- `public/data/countries-110m.json` 的**国界**来自
  [world-atlas](https://github.com/topojson/world-atlas)（ISC，Natural Earth 110m）；
  **中国疆域与南海诸岛九段线**来自阿里云
  [DataV GeoAtlas](https://geo.datav.aliyun.com/)（中国标准地图口径）。
  两者由 `scripts/build-basemap.mjs` 合并，详见「三、数据是怎么来的 → 底图」。
- 国名中英对照取自 [world-countries](https://github.com/mledoze/countries)（ODbL）。
