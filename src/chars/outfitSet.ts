/**
 * 「成套」说法的展开:把 `black lace set` 这类聚合词拆成 CLIP 真正认识的独立 tag。
 *
 * ## 为什么必须拆
 *
 * `black lace set` 里的 `set` 不是 danbooru tag,CLIP 读到的是一个几乎没训练过的词。
 * 采样器只好拿 `black` 和 `lace` 两个弱线索自由发挥 —— 实测最常见的结果是
 * **只画上半截**:胸罩有了,内裤没画,腿上是光着的。用户看到的是"我明明写了整套"。
 *
 * 拆成 `black lace bra, black lace panties` 之后,每个词都有自己的训练分布,
 * 采样器知道该在哪儿画什么。
 *
 * ## 拆什么、不拆什么
 *
 * 只拆**有确定部位对应**的套词:
 *   - 内衣套(set / lingerie set / underwear set)→ bra + panties
 *   - 泳装(bikini / swimsuit / one-piece)→ 两件式拆 bikini top + bikini bottom,连体不拆
 *   - 校服 / 水手服 → 上衣 + 裙
 *   - 兔女郎 → bunny suit 本体 + bunny ears + fishnet
 *   - 女仆装 → maid outfit + apron + maid headdress
 *
 * **不拆**的:只是颜色/材质定语(`black lace`)、单一部件(`bra`)、
 * 以及任何认不出部位的说法。宁可漏拆也不能瞎拆 —— 拆错会把一套衣服拆成两套。
 *
 * 纯函数,不碰宿主,单测直接跑。
 */

/** 一套衣服的展开结果:主干 + 配件。 */
export interface OutfitExpansion {
  /** 主件(优先送)。 */
  main: string[];
  /** 附件。 */
  accessories: string[];
}

interface SetRule {
  /** 命中条件(作用在去掉定语后的"套名"上)。 */
  test: RegExp;
  /** 展开结果;`{prefix}` 会被替换成前缀定语(颜色 + 材质)。 */
  expand(prefix: string): string[];
}

/**
 * 定语:颜色与材质。展开时复制到每个部件上。
 *
 * 这里是**逐个 token 判断**用的词表,不是用来做前缀正则的 ——
 * 早期版本把它写成一个 `(?:...\s+)*` 的贪婪前缀,`black lace set` 里的 `set`
 * 会被当定语吞掉,于是永远走不到"末尾 set"那条规则。逐 token 判断就不会有这个问题。
 */
const QUALIFIER_WORDS = new Set(
  [
    'white', 'black', 'red', 'blue', 'green', 'pink', 'purple', 'yellow', 'orange', 'brown',
    'gray', 'grey', 'silver', 'golden', 'gold', 'navy', 'beige', 'ivory', 'cream', 'crimson',
    'scarlet', 'azure', 'emerald', 'violet', 'indigo', 'cyan', 'magenta', 'turquoise', 'teal',
    'maroon', 'khaki', 'lavender', 'lilac', 'peach', 'mint', 'rose', 'amber', 'copper', 'bronze',
    'platinum', 'dark', 'light', 'pale', 'deep', 'bright', 'neon', 'pastel', 'translucent',
    'sheer', 'transparent', 'opaque', 'glossy', 'matte', 'shiny', 'satin', 'silk', 'silken',
    'lace', 'leather', 'latex', 'rubber', 'velvet', 'mesh', 'fishnet', 'cotton', 'linen', 'wool',
    'chiffon', 'nylon', 'spandex', 'sequin', 'sequined', 'glitter', 'glittery', 'frilled',
    'frilly', 'ribboned', 'lacy', 'silky',
  ],
);

/** 双词定语(`rose gold`、`see through`)——按 token 逐词判断会漏,单独处理。 */
const QUALIFIER_PHRASES = new Set(['rose gold', 'see through', 'two piece', 'one piece']);

/** 底色词(去掉后剩下的才是"部件名")。 */
const COLOR_WORDS = new Set(
  [
    'white', 'black', 'red', 'blue', 'green', 'pink', 'purple', 'yellow', 'orange', 'brown',
    'gray', 'grey', 'silver', 'golden', 'gold', 'navy', 'beige', 'ivory', 'cream', 'crimson',
    'scarlet', 'azure', 'emerald', 'violet', 'indigo', 'cyan', 'magenta', 'turquoise', 'teal',
    'maroon', 'khaki', 'lavender', 'lilac', 'peach', 'mint', 'rose', 'amber', 'copper', 'bronze',
    'platinum', 'dark', 'light', 'pale', 'deep', 'bright', 'neon', 'pastel',
  ],
);

/**
 * 把一条 tag 切成「前缀定语」+「剩下的主体」。
 *
 * 逐 token 往前吃:token 属于颜色/材质词表就归到前缀,遇到第一个不认识的词就停。
 * 双词定语(rose gold / see through)先合并成单 token 再判断。
 */
function splitQualifier(tag: string): { prefix: string; rest: string } {
  const tokens = String(tag ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { prefix: '', rest: '' };

  // 双词定语先合并
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const two = `${tokens[i]} ${tokens[i + 1] ?? ''}`.trim();
    if (QUALIFIER_PHRASES.has(two)) {
      merged.push(two);
      i += 1;
    } else {
      merged.push(tokens[i]);
    }
  }

  let cut = 0;
  while (cut < merged.length && QUALIFIER_WORDS.has(merged[cut])) cut += 1;
  // 全是定语(如 `black lace`)→ 没有主体,不能当前缀用
  if (cut >= merged.length) return { prefix: '', rest: String(tag ?? '').trim() };

  const prefix = merged.slice(0, cut).join(' ');
  const rest = merged.slice(cut).join(' ');
  return { prefix: prefix ? `${prefix} ` : '', rest };
}

const SET_RULES: SetRule[] = [
  // ---- 内衣套:最高频,也是"只画上半截"最严重的一类 ----
  {
    test: /underwear set|lingerie set|bra and panties set|matching underwear|(?:^|\s)set$/,
    expand: p => [`${p}bra`, `${p}panties`],
  },
  // 裸 `set`(前面只有颜色/材质):同样拆成内衣套,但**保留完整定语**,
  // 让 `black lace set` → `black lace bra, black lace panties` 而不是丢成 `black bra`
  {
    test: /^(?:set|一套|套装)$/,
    expand: p => [`${p}bra`, `${p}panties`],
  },
  {
    test: /lingerie|underwear|undergarment/,
    expand: p => [`${p}lingerie`, `${p}bra`, `${p}panties`],
  },
  // `red lingerie set` 剥掉末尾 set 后只剩 `red lingerie` → 上面那条管。
  // 注意这里**不能**用 lace / satin 这类材质词当锚点:它们只是定语,
  // 拿来做规则锚点会把 `black lace set` 拆成 `black bra`,蕾丝直接丢了。
  // 兜底只认「裸 set 且前面有定语」这种写法:`black set` / `underset` 不拆也不丢。
  {
    test: /^$/,
    expand: p => [`${p}bra`, `${p}panties`],
  },
  // ---- 泳装 ----
  {
    test: /bikini/,
    expand: p => [`${p}bikini`, `${p}bikini top`, `${p}bikini bottom`],
  },
  {
    test: /swimsuit|swimwear|bathing suit/,
    expand: p => [`${p}swimsuit`],
  },
  // ---- 校服 / 水手服 ----
  {
    test: /school uniform|serafuku|sailor uniform/,
    expand: p => [`${p}school uniform`, `${p}serafuku`, `${p}pleated skirt`, `${p}sailor collar`],
  },
  // ---- 兔女郎 ----
  {
    test: /bunny (?:suit|girl|outfit)/,
    expand: p => [`${p}bunny suit`, 'bunny ears', 'black fishnet tights', 'white collar'],
  },
  // ---- 女仆 ----
  {
    test: /maid (?:outfit|dress|uniform)|french maid/,
    expand: p => [`${p}maid outfit`, `${p}apron`, 'maid headdress'],
  },
  // ---- 制服 / 西装套 ----
  {
    test: /(?:business )?suit and tie|office suit|business suit/,
    expand: p => [`${p}suit`, `${p}necktie`, `${p}trousers`, `${p}shirt`],
  },
  // ---- 睡衣套 ----
  {
    test: /pajamas|pyjamas/,
    expand: p => ['pajamas', 'pajama top', 'pajama pants'],
  },
  // ---- 婚纱 / 礼服套 ----
  {
    test: /wedding dress(?: set)?/,
    expand: p => [`${p}wedding dress`, `${p}veil`],
  },
  // ---- 体操服套 ----
  {
    test: /gym uniform|gym clothes|track suit/,
    expand: p => [`${p}gym uniform`, `${p}bloomers`],
  },
];

/**
 * 「成套」的判定。
 *
 * 这里刻意分成两个层次,不能只用一个笼统的 `set` 判断:
 * - **具名套装**(lingerie / bikini / school uniform / bunny suit / pajamas …)
 *   本身就是"一套",不需要额外线索,写出来就该拆;
 * - **泛称**(`set`、`一套`、`整套`、`matching`、`full set`)只是提示"这是整套",
 *   拆不拆还要看后面有没有认得出的套名,认不出就原样返回。
 *
 * 早期版本只用 SET_HINT 一刀切,结果 `white lingerie`、`red bikini`、
 * `school uniform` 全被提前返回没拆 —— 而这些恰恰是最该拆的。
 */
const SET_HINT = /(\bset\b|整套|套装|一套|全身|上下|配套|full set|matching)/i;

/** 具名套装:命中即视为"成套",不必依赖 SET_HINT。 */
const NAMED_SET = new RegExp(
  [
    'lingerie',
    'underwear',
    'undergarment',
    'bikini',
    'swimsuit',
    'swimwear',
    'bathing suit',
    'one-piece swimsuit',
    'school uniform',
    'sailor uniform',
    'serafuku',
    'bunny (?:suit|girl|outfit)',
    'maid (?:outfit|dress|uniform)',
    'french maid',
    'business suit',
    'office suit',
    'suit and tie',
    'pajamas',
    'pyjamas',
    'wedding dress',
    'gym uniform',
    'gym clothes',
    'track suit',
  ].join('|'),
  'i',
);

/** 已经是独立部件的词,不必再拆,也不能被当成套名。 */
const SINGLE_PART =
  /^(?:.*\s)?(bra|panties|underwear\s?bra|thong|briefs|pantyhose|stockings|thighhighs|socks|skirt|shirt|blouse|dress|shorts|pants|trousers|collar|cuffs|gloves|shoes|boots|heels|apron|veil|ears|tie|necktie)\b/i;

/**
 * `matching` / `set of` 这类**不属于颜色材质**、但挂在最前面的修饰。
 * 不剥掉的话 `matching` 会变成前缀被复制到每个部件上,
 * 于是出现 `matching bra` 这种 CLIP 根本不认识的组合。
 */
const LEADING_JUNK = /^(?:(?:matching|matching\s+pair|pair of|set of|a set of|full|complete)\s+)+/i;

/** 末尾的 `set` / `套装` 也不该留进部件名。 */
const TRAILING_SET = /\s*(?:\bset\b|套装|一套)$/i;

/**
 * `black bra and panties` 这种"用 and 连接的成套"。
 *
 * **两边都必须认得出是穿戴部件**才算成套。早期版本只要求有 and,
 * 结果 `black hair and red eyes` 被拆成两个 tag、`black lace set` 被
 * `lace` 后面的 and 误判 —— 拆错比漏拆更糟(会把一套衣服拆成两套)。
 */
const AND_PAIR = /^(.+?)\s+(?:and|&|\/)\s+(.+)$/i;

/** 认得出的穿戴部件(用于 and 拆分的两侧校验)。 */
const GARMENT_PART =
  /^(?:matching\s+|pair of\s+)?(?:bra|panties|underwear|lingerie|thong|briefs|pantyhose|stockings|thighhighs|socks|skirt|shirt|blouse|dress|shorts|pants|trousers|collar|cuffs|gloves|shoes|boots|heels|apron|veil|ears|tie|necktie|top|bottom|bodysuit|corset|garter|belt)$/i;

/**
 * 展开一条 tag。认不出是套装的返回 `[原样]`。
 *
 * 输入已经是规范化的(小写、空格分隔)。输出的顺序:**主件在前、附件在后**,
 * 因为 CLIP 对靠前的 token 权重更高,主体不能压在后缀里。
 */
export function expandOutfitTag(tag: string): { tags: string[]; expanded: boolean } {
  const raw = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return { tags: [], expanded: false };

  // 先剥掉 matching / pair of / 末尾 set 这类非颜色修饰
  const cleaned = raw.replace(LEADING_JUNK, '').replace(TRAILING_SET, '').trim() || raw;

  // `black bra and panties` / `black bra / panties`:按连接词拆。
  // 必须**在** SINGLE_PART 之前判断:整串虽然长得像"单一部件 + and",
  // 但它其实是两件,先被 SINGLE_PART 拦下就永远拆不开。
  for (const candidate of [cleaned, raw]) {
    const pair = candidate.match(AND_PAIR);
    if (!pair) continue;
    const left = pair[1].trim();
    const right = pair[2].trim();
    if (!left || !right) continue;
    const leftParts = splitQualifier(left);
    const fullLeft = `${leftParts.prefix}${leftParts.rest}`.trim();
    // 右边常省略颜色(`black bra and panties`),把左边的前缀补过去
    const rightParts = splitQualifier(right);
    const rightHasQualifier = rightParts.prefix.trim().length > 0;
    const fullRight = rightHasQualifier ? right : `${leftParts.prefix}${right}`.trim();
    // 两侧都必须认得出是穿戴部件,否则 `black hair and red eyes` 也会被拆
    if (!GARMENT_PART.test(leftParts.rest) || !GARMENT_PART.test(rightParts.rest)) continue;
    if (fullLeft && fullRight && fullLeft !== fullRight) {
      return { tags: [fullLeft, fullRight], expanded: true };
    }
  }

  // 单一部件不拆
  if (SINGLE_PART.test(cleaned)) return { tags: [raw], expanded: false };

  // 定语前缀从 raw 切:cleaned 已经把末尾的 set 剥掉了,
  // 拿它切出来是 `black lace`(没有主体),`set` 规则永远匹配不上。
  const { prefix, rest } = splitQualifier(raw);

  // 具名套装 → 一定拆;泛称 `set` → 也要拆,但只在有认得出的套名时
  const isNamedSet = NAMED_SET.test(rest);
  const hasSetHint = SET_HINT.test(raw);
  if (!isNamedSet && !hasSetHint) return { tags: [raw], expanded: false };

  for (const rule of SET_RULES) {
    if (!rule.test.test(rest)) continue;
    const tags = rule.expand(prefix)
      .map(t => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (tags.length > 1) return { tags, expanded: true };
  }
  return { tags: [raw], expanded: false };
}

/**
 * 展开一整串 tag。去重(展开后常出现重复的 bra / panties),顺序保持。
 * 返回新增了多少条,方便 UI 提示"已展开 3 个成套词"。
 */
export function expandOutfitTags(tags: string): { tags: string; expanded: string[] } {
  const parts = String(tags ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  if (!parts.length) return { tags: String(tags ?? '').trim(), expanded: [] };

  const seen = new Set<string>();
  const out: string[] = [];
  const expandedFrom: string[] = [];
  for (const part of parts) {
    const result = expandOutfitTag(part);
    if (result.expanded) expandedFrom.push(part);
    for (const tag of result.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return { tags: out.join(', '), expanded: expandedFrom };
}

/**
 * 给模型看的『必须拆开写』清单。
 *
 * 提示词里光说"要写具体"没用——模型会把它理解成"多加几个形容词",
 * 于是照样输出 `black lace set`。这里给的是**替换对照表**,它照着抄就行。
 */
export const SPLIT_EXAMPLES = [
  'black lace set → black lace bra, black lace panties, black lace thighhighs',
  'white lingerie → white lingerie, white bra, white panties',
  'red bikini → red bikini, red bikini top, red bikini bottom',
  'school uniform → school uniform, serafuku, pleated skirt, sailor collar',
  'bunny suit → bunny suit, bunny ears, black fishnet tights, white collar',
  'maid outfit → maid outfit, apron, maid headdress',
  'pajamas → pajamas, pajama top, pajama pants',
].join('\n- ');
