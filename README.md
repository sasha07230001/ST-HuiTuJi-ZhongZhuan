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

| 入口 | 行为 |
|---|---|
| 楼层右上角 **绘图** 按钮 | 把这一楼正文走完整条链,图直接挂在楼层里 |
| 顶栏菜单「绘图姬·中转站」 | 给最新一楼出图 |
| 设置里勾「每生成一楼自动出图」 | 每次 AI 回复完自动跑 |
| 控制台 `htjZhongZhuan.generate(楼层号)` | 给别的插件留的接口 |

卡片上有:**重新生成**、**取消**、**复制提示词**、**编辑提示词**(手改后直接出图,跳过中转站)、**移除卡片**。

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
