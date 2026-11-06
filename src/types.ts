/**
 * 类型与常量:整个扩展的公共词汇表。
 *
 * 只放「跨模块都要用、且不依赖宿主」的东西;任何碰 ST / fetch 的都不在这里,
 * 这样纯函数模块(clean / protocol / prompt)能被 vitest 直接跑,不需要起酒馆。
 */

/** 一条已编译好的 CLIP 提示词。 */
export interface ClipPrompt {
  /** 正向提示词(英文 tag 或自然语言,视工作流里的 CLIP 节点而定)。 */
  positive: string;
  /** 负面提示词;空串 = 本次不写负面。 */
  negative: string;
  /** 这一张想抓的瞬间,给人看的一句话。 */
  note: string;
}

/** 中转站渠道配置(对应设置页「中转站」一栏)。 */
export interface RelayChannel {
  /** OpenAI 兼容的 base url,如 https://api.deepseek.com 或 .../v1。 */
  url: string;
  /** API Key;随请求发给 ST 服务端转发,不落磁盘以外的任何地方。 */
  key: string;
  /** 模型名,如 deepseek-chat、gpt-4o-mini。 */
  model: string;
  /** 采样温度。 */
  temperature: number;
  /** 单次回复上限 token。 */
  maxTokens: number;
  /** 单次请求超时(秒)。 */
  timeoutSec: number;
}

/** ComfyUI 连接配置。 */
export interface ComfyChannel {
  /** ComfyUI 地址,如 http://127.0.0.1:8188。 */
  url: string;
  /** Save (API Format) 导出的工作流 JSON 文本。 */
  workflow: string;
  /** 浏览器直连不通时是否回退 ST 后端转发。 */
  allowServerProxy: boolean;
}

/** 提示词编译设置。 */
export interface PromptSettings {
  /** 编译用的 system 提示词,支持 {{story}} {{note}} 占位符。 */
  system: string;
  /** 恒定追加在模型输出后面的正向词(画风基线)。 */
  styleSuffix: string;
  /** 恒定追加的负面词。 */
  negative: string;
  /** 是否要求模型额外给出负面词。 */
  wantNegative: boolean;
  /** 每次出图张数上限(1-3)。 */
  maxImages: number;
  /** 返回无法解析时的重试次数。 */
  retryCount: number;
}

/**
 * 剧情范围设置(移植自二号的 autoTag/storyScope)。
 *
 * 模型常在正文外写思维链、状态栏、格式示例,那些字不当剧情。
 * 配了标签就只取 `<标签>…</标签>` 里的内容;取不到时回退整楼。
 */
export interface StoryScopeSettings {
  /** 范围标签名(已解析过,不含尖括号)。空数组 = 不启用。 */
  tags: string[];
  /** 同名块取哪个:last=最后一个(默认)、first、all=全部拼接。 */
  pick: import('@/relay/storyScope').StoryScopePick;
}

/** 扩展总设置。 */
export interface Settings {
  /** 总开关。 */
  enabled: boolean;
  /** 每生成一楼后自动走一次「正文→中转站→CLIP→出图」。 */
  autoRun: boolean;
  relay: RelayChannel;
  comfy: ComfyChannel;
  prompt: PromptSettings;
  /** 悬浮球配置。位置这类纯视觉态走 localStorage,这里只放需要跨设备同步的开关。 */
  orb: OrbSettings;
  /** 剧情范围(哪些正文算剧情)。 */
  storyScope: StoryScopeSettings;
}

export interface OrbSettings {
  /** 是否显示悬浮球。关掉后仍可用顶栏菜单打开面板。 */
  show: boolean;
  /** 球体基准尺寸(px)。 */
  size: number;
  /** 静止时的不透明度(0.2 ~ 1)。 */
  opacity: number;
}

export const DEFAULT_SYSTEM_PROMPT = `你是 Stable Diffusion 的提示词工程师。把下面这段剧情正文编译成给 ComfyUI 用的 CLIP 文本提示词。

【剧情正文】
{{story}}

【任务提示】
{{note}}

输出要求:
- 只输出一行英文,逗号分隔的 danbooru 风格 tag,不要解释、不要编号、不要 Markdown、不要代码块。
- 顺序:镜头与视角 → 在场角色数量与身份 → 角色外观(发色/瞳色/服饰) → 动作与表情 → 场景 → 光线与色调 → 画风质量词。
- 画面里只出现正文里真正在做事的角色,代词先按上下文弄清是谁,不要凭空加人。
- 正文没写外貌的角色,按气质合理补全,不要留空。
- 不要写负面词(no / without 之类),负面另有一条通道。`;

export const DEFAULT_STYLE_SUFFIX = 'masterpiece, best quality, detailed background, cinematic lighting, anime style';

export const DEFAULT_NEGATIVE = 'lowres, bad anatomy, bad hands, extra fingers, worst quality, low quality, jpeg artifacts, blurry, watermark, signature, text';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  autoRun: false,
  relay: {
    url: '',
    key: '',
    model: '',
    temperature: 0.8,
    maxTokens: 400,
    timeoutSec: 120,
  },
  comfy: {
    url: 'http://127.0.0.1:8188',
    workflow: '',
    allowServerProxy: true,
  },
  prompt: {
    system: DEFAULT_SYSTEM_PROMPT,
    styleSuffix: DEFAULT_STYLE_SUFFIX,
    negative: DEFAULT_NEGATIVE,
    wantNegative: false,
    maxImages: 1,
    retryCount: 1,
  },
  orb: {
    show: true,
    size: 48,
    opacity: 0.62,
  },
  storyScope: {
    tags: [],
    pick: 'last',
  },
};

/** ST 服务端代理的补全端点(与 ST 自带的「自定义 OpenAI 兼容端点」同一个)。 */
export const ST_GENERATE_URL = '/api/backends/chat-completions/generate';
/** ST 服务端代理的模型列表端点。 */
export const ST_STATUS_URL = '/api/backends/chat-completions/status';
/** ST 服务端转发 ComfyUI 的扩展端点(本扩展自带后端,需 ST 重启后注册)。 */
export const ST_COMFY_PROXY = '/api/plugin/htj-zhongzhuan/comfy';

/** 设置落在 extension_settings 下的键名。 */
export const SETTINGS_KEY = 'htjZhongZhuan';

/**
 * 内置的极简工作流:Anima Turbo txt2img。
 * 与本仓库 examples/workflow-anima-turbo.json 同一份,已在 ComfyUI 0.43 上实测出图。
 * 换了模型记得把 UNETLoader / CLIPLoader / VAELoader 的文件名换成你本地的。
 *
 * 别的架构(SDXL checkpoint、Flux、Qwen-Image)不需要改代码:
 * 在 ComfyUI 里用「Save (API Format)」导出,把两个 CLIPTextEncode 的 text 改成
 * %prompt% 与 %negative_prompt%,KSampler 的 seed 改成 "%seed%",粘进设置即可。
 */
export const BUILTIN_WORKFLOW = JSON.stringify(
  {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'anima-turbo-v1.1.safetensors', weight_dtype: 'default' },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' },
    },
    '5': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 0] } },
    '8': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    '9': {
      class_type: 'KSampler',
      inputs: {
        seed: '%seed%',
        steps: 8,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['1', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['8', 0],
      },
    },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['5', 0] } },
    '11': { class_type: 'SaveImage', inputs: { filename_prefix: 'htj-zhongzhuan', images: ['10', 0] } },
  },
  null,
  2,
);
