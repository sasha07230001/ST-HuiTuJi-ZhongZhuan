# 绘图姬·中转站

> 在「剧情正文 → ComfyUI」中间加一道**中转站**:正文先交给一个 OpenAI 兼容的模型,
> 让它编译成 ComfyUI 能直接吃进 CLIP 的英文提示词,再送进工作流出图。

SillyTavern 扩展,与 [ST-HuiTuJi-2(绘图🐔二号)](https://github.com/sasha07230001/ST-HuiTuJi-2)
同级,但它**只管一件事**:

```
ST-HuiTuJi-2 里那些「提取提示词 → 塞进 ComfyUI 的 CLIPTextEncode」
                                   ▲
                                   │  ← 这里插进来
                    绘图姬·中转站(本扩展)
```

二号把正文直接丢进工作流、提词靠 ComfyUI 里的节点;本扩展把「正文 → 提示词」这一步
**搬到酒馆侧**,用你自己填的 url + key 调模型完成,只把结果写进 CLIP 文本节点。

---

## 它到底做了什么

```
楼层正文 ──清洗──► 中转站模型 ──英文 tag──► 合并画风/负面 ──► CLIPTextEncode ──► ComfyUI ──► 楼层卡片
   ▲                    ▲                    ▲                                      │
   └─ 自动/AI 楼 ────────┘                    └─ 恒定画风词、恒定负面词              └─ 排队/进度/取消
```

1. **取正文**:当前楼层的 AI 剧情正文(剥 HTML/Markdown、去上一轮卡片、超长保尾部)。
2. **中转站编译**:一次补全请求,模型把中文剧情压成一行英文 danbooru tag。
   请求**经 SillyTavern 服务端转发**(`/api/backends/chat-completions/generate`),
   所以没有 CORS 问题,key 也不会暴露给页面上的其它脚本。
3. **验收**:空回复、以中文为主、过长,都判失败并按设置重试。
4. **写进 CLIP**:两种工作流都支持——
   - 有 `%prompt%` 占位符 → 直接替换;
   - 没有占位符 → 自动找 `CLIPTextEncode`,第一个非空的写正向、其余写负面
     (**二号那边的工作流可以原样粘进来,不用改一个字**)。
5. **出图**:提交 `/prompt`、轮询 `/history`,显示排队位置,可取消。
   **只把编译好的提示词送进 CLIP 文本节点**,其余节点(模型、LoRA、采样器)完全按你的工作流走。

---

## 安装

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/sasha07230001/ST-HuiTuJi-ZhongZhuan
cd ST-HuiTuJi-ZhongZhuan
npm install
npm run build
```

然后**重启 SillyTavern**(`node server.js` 那一下)。扩展列表里会出现「绘图姬·中转站」。

> `dist/index.js` 需要构建产物。如果你是直接下载的 zip,执行一次 `npm install && npm run build` 即可。

---

## 配置(扩展设置里)

### 中转站

| 项 | 说明 |
|---|---|
| API 地址 | 填到域名就行(`https://api.deepseek.com` 自动补 `/v1`);也可填完整 `…/v1` |
| API Key | 你自己的 key |
| 模型 | 任意 OpenAI 兼容模型名;旁边「拉模型列表」可以列出来选 |
| 温度 / 最大 token / 超时 | 提词任务建议温度 0.7~0.9、token 300~500 |

点「测试中转站」会发一句极短的话验证 url/key/model 三者都对。

### ComfyUI

| 项 | 说明 |
|---|---|
| 服务地址 | 如 `http://127.0.0.1:8188` |
| 工作流 JSON | ComfyUI 里 **Save (API Format)** 导出的那份 |
| 经 ST 后端转发 | 浏览器直连被 CORS 挡住时勾上;**需要重启过酒馆**才生效 |

点「载入内置工作流」会填入一份**已在 ComfyUI 0.43 实测出图**的 Anima Turbo 工作流
(见 [`examples/workflow-anima-turbo.json`](examples/workflow-anima-turbo.json)),
把里面三个模型文件名换成你本地有的即可。

### 编译提示词

- **system 提示词**:可改。占位符 `{{story}}` = 剧情正文,`{{note}}` = 额外任务提示。
- **恒定画风词**:追加在模型输出后面(去重)。
- **恒定负面词**:写进负面 CLIP 节点。
- **让模型额外输出负面词**:开启后要求模型用 `POSITIVE:` / `NEGATIVE:` 分段。
- **失败重试次数**:返回解析不过时重试几次。

---

## 怎么用

**悬浮球**是主入口:页面上一个可拖动的圆球,点一下打开面板,再点一下(或 Esc / 点遮罩)关闭。

- 拖动可自由摆放;**靠近左右边缘才吸附贴边**,贴边时半隐,悬停/聚焦才整条滑出
- **双击悬浮球**回到默认位置(拖到看不见的地方时的救命入口)
- 位置存 `localStorage`(纯视觉态);显隐、大小、透明度在设置里,跨设备同步
- 面板打开时球自动隐藏,关闭后恢复

面板有三页:

| 页签 | 内容 |
|---|---|
| **出图** | 选楼层或手填正文 → 「编译并出图」;显示进度、可取消;提示词可手改后「按此提示词出图」,也能「复制」或「插到楼层」 |
| **渠道** | 中转站 url/key/模型(带测试与拉模型列表)、ComfyUI 地址与工作流、后端转发开关 |
| **提示词** | 编译用 system 提示词、恒定画风/负面词、重试次数、**剧情范围**、自动插图、悬浮球设置 |

其它入口:

| 入口 | 行为 |
|---|---|
| 楼层右上角 **绘图** 按钮 | 把这一楼正文走完整条链,图直接挂在楼层里 |
| 顶栏菜单「绘图姬·中转站」 | 打开面板 |
| 设置里勾「每生成一楼自动插图」 | 每次 AI 回复完自动跑 |
| 设置抽屉「悬浮球 / 面板」栏 | 开关悬浮球、调大小/透明度、打开面板、重置球位置 |
| 控制台 `htjZhongZhuan.openPanel()` | 给别的插件留的接口 |

卡片上有:**重新生成**、**取消**、**复制提示词**、**编辑提示词**(手改后直接出图,跳过中转站)、**移除卡片**。

---

## 自动插图

开启后,每次 AI 回复完自动走一遍「正文 → 中转站 → CLIP → 出图」,图直接挂在那层楼里。

原理(移植自二号,按本插件形态简化):

1. **只在真正一次生成的最终渲染上触发**:先记 `GENERATION_STARTED`,
   再在 `CHARACTER_MESSAGE_RENDERED` 里消费它。swipe / 编辑 / 切聊天引起的渲染不算。
2. **不阻塞 ST 收尾**:渲染回调里只排一个 `setTimeout`,不在事件里做重活。
3. **每楼一把锁 + 正文指纹去重**:同一条正文不会重复烧后端。
4. **切聊天时整体清空**,不污染别的聊天。

> 与二号的差异:二号是「写 tag → 卡片消费标记」两段式握手;我们不出 tag,
> 拿到楼层直接出图,不需要往正文写任何东西。

---

## 剧情范围

模型常在正文外写思维链、状态栏、格式示例(`<StatusPlaceHolderImpl/>` 之类),
那些字一起喂给中转站就是噪音。配了**范围标签**后,只有这些标签包住的内容才算剧情。

```
<thought>很长的思维链...</thought>
<content>她站在雨里,霓虹映在积水里。</content>   ← 只有这段进中转站
<StatusPlaceHolderImpl/>
```

纪律(与二号一致,宁可少清洗也不能把剧情洗没):

- 没配标签 → 整楼都用。
- 配了但找不到**成对**的 `<标签>…</标签>` → 整楼都用(标签可能只是文本里出现)。
- 取到内容才生效;取不到一律回退整楼。

| 设置 | 说明 |
|---|---|
| 范围标签 | 逗号分隔,可粘 `<content>`、`content_fox` 这类带壳写法,会自动剥壳 |
| 同名块取哪个 | `last`(默认,前面常是格式示例)、`first`、`all`(全部拼接) |

---

## 工作流占位符

| 占位符 | 说明 |
|---|---|
| `%prompt%` | 中转站编译出的正向提示词(**推荐写**) |
| `%negative_prompt%` | 负面提示词 |
| `%seed%` | 本次随机种子(精确等于时替换成**数字**) |

- 只认这三个。写了别的(如 `%width%`)会明确报错,而不是悄悄留个原文进去。
- 没写 `%seed%` 时,会把种子塞进 `KSampler` / `KSamplerAdvanced` 的 `seed` 字段——否则重复出图永远是同一张。
- 完全没有 `%prompt%` 时走「定位式」:自动改 `CLIPTextEncode` 的 text。

---

## 与二号的关系

| | 绘图🐔二号 | 绘图姬·中转站 |
|---|---|---|
| 提词在哪 | ComfyUI 工作流内部节点 | 酒馆侧的中转站模型 |
| 送进 CLIP 的 | 正文原文 | 编译后的英文提示词 |
| 角色档案 / 图库 / 楼层开关 | 有 | 无(这一版只做这条链) |
| 工作流兼容 | — | 二号的 API 工作流可直接粘 |

---

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest,39 个用例(纯函数:URL 规范化、提示词清洗/验收、工作流渲染、设置合并)
npm run build       # 产出 dist/index.js
```

目录:

```
src/
  relay/    中转站:client(ST 代理调用)、prompt(清洗/验收,纯函数)、orchestrator(整条链)
  comfy/    workflow(占位符渲染/CLIP 定位,纯函数)、api(提交/轮询/取消)
  ui/       settingsPanel、card(楼层卡片)、floorButton、autoRun
  st/       context(ST getContext 薄封装)
  state/    settings(extension_settings 读写)
server/     /api/plugin/htj-zhongzhuan/comfy 后端转发(可选,CORS 兜底)
examples/   实测可用的工作流
scripts/    sync-version、live-check / builtin-check(对着真 ComfyUI 跑一遍)
```

---

## 许可

MIT。
