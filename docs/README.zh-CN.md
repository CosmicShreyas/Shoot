[English](../README.md) · **中文** · [हिन्दी](./README.hi.md) · [Español](./README.es.md) · [Français](./README.fr.md)

# 🐼 shoot

### *不掺假，真的。*

<!-- DEMO_GIF: add after recording via ScreenToGif, see DEMO.md -->

**除非能真正证明，否则不让 AI 编程助手说"完成了"。**

[![npm version](https://img.shields.io/npm/v/shoot-cc.svg)](https://www.npmjs.com/package/shoot-cc)
[![CI](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml/badge.svg)](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/shoot-cc.svg)](../LICENSE)
[![node](https://img.shields.io/node/v/shoot-cc.svg)](https://nodejs.org)

<!-- MASCOT_HERO_IMAGE -->

<!-- DEMO_VIDEO_LINK: add after recording, see DEMO.md -->

竹笋只有在根系确认稳固之后才会向上生长。这个工具也是同样的道理：
在测试通过之前，你的 AI 助手没有资格说"已修复"。

> 英文版 [README.md](../README.md) 是唯一权威来源。本译文可能落后于英文更新。

---

## 问题

编程助手经常声称自己完成了并未验证的工作。它们会在没有运行测试的情况下说"所有测试
都通过了"，在缺陷仍然存在时报告已修复，在构建仍然失败时结束对话。你事后才会发现，
而信任上的损失比缺陷本身更严重。

Shoot 负责闭合这个环节。它会在助手准备结束对话的那一刻介入，识别声称完成的措辞，
真实运行你项目自己的 test / lint / typecheck / build 命令，如果这些声称站不住脚，
就**阻止本次结束**，并把真实的错误输出交给助手，让它继续工作。

## 使用前后对比

没有 Shoot 时，对话就这样结束了：

```
Claude: Fixed the bug — all tests pass now.
        [turn ends. the test still fails.]
```

有了 Shoot，助手会被拦下，并收到真实的失败信息：

```
🐼 Shoot: Not yet. You said "Fixed" — it isn't true yet. Here's what broke:

--- test: failed with exit code 1
--- command: npm test

✖ adds (1.87ms)
ℹ pass 0
ℹ fail 1

  AssertionError [ERR_ASSERTION]: 0 == 4
      at TestContext.<anonymous> (sum.test.js:6:10)
    actual: 0,
    expected: 4,

Fix the underlying problem and re-run the checks. Do not report success until they pass.
```

助手读到这些内容后，会去修复真正的缺陷，然后再次尝试。当各项检查真正通过时：

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
```

以上两段都是 Shoot 的真实输出，不是示意稿。

## 快速开始

```bash
npx shoot-cc init
```

它会询问需要运行哪些命令（并根据你的 `package.json` 给出建议），写入
`.shoot.config.json`，并在 `.claude/settings.json` 中注册钩子。就这么简单。

> **包名说明：** 在 npm 上发布为 **`shoot-cc`**，因为 `shoot` 这个名字已被一个无关的
> 包占用。但你实际运行的命令仍然是 `shoot`。

不必等助手，现在就可以验证它是否生效：

```bash
shoot verify
```

## 工作原理

在助手每次发出停止（以及子助手停止）事件时，Shoot 会：

1. 从钩子载荷的 `last_assistant_message` 字段读取助手的最后一条消息。
   （不读取记录文件——该文件是异步写入的，可能落后于事件。）
2. 交给**声称检测器**处理——共 30 条短语模式，并配有否定与含糊语气的判定窗口，
   因此"tests don't pass yet"和"are tests passing?"不会被判定为声称完成。
3. **若未检测到声称，则静默退出。** 普通的任务中途对话不会被干预、不会被拖慢，
   也不会在记录中留下任何痕迹。
4. 若检测到声称，则真实运行你配置的命令，顺序为
   `typecheck → lint → test → build`，逐个串行执行，每个都有独立超时。
5. 全部通过则允许结束，并附上一条回执。任一失败则返回 `block` 决定，
   其原因中包含真实的失败输出。

第 2–4 步与平台无关。只有第 1 步的读取和第 5 步的写出是宿主特定的，而它们都位于一个薄适配器中——
这正是新增平台成本很小的原因。

### 我们发现并修复的无限循环

这一点值得明确写出来，因为它正是这个工具值得信任的理由：Shoot 是在真实的 Claude Code
会话中验证过的，而不仅仅是用构造的载荷做单元测试——而那次真实运行发现了一个单元测试
在结构上不可能发现的缺陷。

早期版本通过 `hookSpecificOutput.additionalContext` 返回其通过回执。在
`Stop` / `SubagentStop` 事件中，该字段会**让对话继续**，而不是让它结束。于是一次
*正确的*修复反而导致：通过 → 回执 → 对话继续 → Claude 重述"tests pass" →
检测器再次触发 → 回执 → 继续。它循环了**九次**，最后被 Claude Code 自身的内部上限
强制终止。

两项修复，均有回归测试覆盖：

- **优先检查 `stop_hook_active`。** 当 Claude Code 设置该标志时，说明对话已处于被迫
  继续的状态，因此 Shoot 会立即静默退出——不做声称检测、不做验证、不产生任何输出。
  在此处重新运行整套流程，正是维持循环的原因。
- **任何允许结束的路径都不使用 `additionalContext`。** 回执改用 `systemMessage`，
  它能在终端中呈现给你，同时不会重新打开对话。`additionalContext` 只有在配合真正的
  `block` 时才是正确的，而 `block` 本身已经带有自己的 `reason` 字段。那个让此错误
  得以发生的类型已被删除，因此它无法悄悄回归。

单次一次性的钩子调用永远无法复现"被迫继续"的状态。只有真实会话才能暴露这个问题。

### 断路器

一个真正损坏的测试套件绝不能把你困住。Shoot 会按会话统计针对同一失败的连续阻止次数，
并持久化到 `.shoot/sessions/`（每个钩子事件都是一个全新进程，因此在内存中计数会每次
归零、永远无法触发）。当针对同一失败第三次阻止时，它会明确地退让并允许对话结束：

```
🐼 Shoot: I've paused this 3 times now for the same failure (test failed). Something's
genuinely stuck, so I'm letting this through — but the checks still do NOT pass, and a
human should look at it.
```

*不同的*失败会重置计数器——那是真实的进展，不是循环。默认值 3 远低于 Claude Code
自身的 8 次阻止上限，并且 `maxBlocksPerSession` 的上限被限制为 6，因此你无法通过配置
突破这一界限。

## 零依赖，刻意如此

```
$ npm ls --omit=dev --all
shoot-cc@0.1.0
`-- (empty)
```

仅使用 Node 内置模块。**没有 postinstall 或 preinstall 脚本。永不进行网络请求。**
业界确实发生过通过携带隐藏安装脚本的恶意 Claude Code 钩子包实施的供应链攻击——因此
Shoot 的设计目标是能被一次性通读完毕。若有人添加运行时依赖，CI 会直接让构建失败。

此外，由于 Shoot 会以你的权限自动运行：

- **配置变更需要重新批准。** `.shoot.config.json` 会被提交到仓库，其命令无需确认即会运行——
  因此一个只改动一行配置的 PR，就可能让 Shoot 在每位审阅者的机器上执行任意命令，而 diff 看起来
  完全不像代码。Shoot 会把已批准命令的哈希记录在被 gitignore 的 `.shoot/trust.json` 中
  （因此 PR 无法改动它）。一旦命令发生变化，验证会**被跳过并给出醒目警告**，直到你运行
  `shoot trust` 并批准为止。
- **捕获的输出在写入磁盘或发送到任何地方之前会先做脱敏。** 测试输出会流向助手的上下文、你的终端，
  以及磁盘上的 `.shoot/history.jsonl`。可识别的密钥形态会在捕获环节被替换为 `[REDACTED]`。
- **CI 中的 Action 全部固定到 commit SHA**，而不是可被重新指向的浮动标签。
- **发布使用 npm Trusted Publishing（OIDC）**——不存在可被窃取的长期 `NPM_TOKEN`，
  且发布产物带有来源证明（provenance）。

前两项属于纵深防御，而非绝对保证。[SECURITY.md](../SECURITY.md)（英文）明确说明了它们各自
覆盖与不覆盖的范围，其中也包含脱敏所覆盖的完整模式清单。

## 配置

`.shoot.config.json`，由 `shoot init` 写入：

```json
{
  "mode": "block",
  "checks": {
    "test": "npm test",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": ""
  },
  "timeoutSeconds": 120,
  "maxBlocksPerSession": 3,
  "verifySubagents": true,
  "platform": "claude-code",
  "scopeDriftWarning": true,
  "scopeDriftFileThreshold": 12
}
```

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `mode` | `"block"` | `"block"` 在失败时阻止助手结束；`"warn"` 仅提示，从不阻止。 |
| `checks.test` | `""` | 测试命令。留空表示跳过，而非失败。 |
| `checks.lint` | `""` | 代码检查命令。留空表示跳过。 |
| `checks.typecheck` | `""` | 类型检查命令。留空表示跳过。 |
| `checks.build` | `""` | 构建命令。留空表示跳过。 |
| `timeoutSeconds` | `120` | 每项检查的超时时间。超时算作失败，并明确报告为"timed out"。 |
| `maxBlocksPerSession` | `3` | 针对同一失败连续阻止多少次后退让。上限为 6。 |
| `verifySubagents` | `true` | 同时验证 `SubagentStop`。子助手声称完成的频率同样很高。 |
| `platform` | `"claude-code"` | 使用哪个宿主的钩子协议。`"claude-code"` 或 `"codex"`。 |
| `scopeDriftWarning` | `true` | 当通过验证的改动显得异常宽泛时附加一条提示。绝不阻止。 |
| `scopeDriftFileThreshold` | `12` | 触发该提示所需的改动文件数下限。 |

无论配置中键的顺序如何，检查始终按 `typecheck → lint → test → build` 的顺序运行，
以便最省时的信号最先出现。

## 命令

| 命令 | 作用 |
| --- | --- |
| `shoot init` | 交互式设置：选择平台、写入配置、安装并注册钩子。 |
| `shoot verify` | 立即运行一次所有已配置的检查。若有失败则以非零码退出。 |
| `shoot doctor` | 诊断安装问题：Node 版本不符、脚本缺失、钩子注册失效、配置未获批准。 |
| `shoot trust` | 在检查命令变更后进行审查并批准。 |
| `shoot stats` | 汇总本地验证历史。 |
| `shoot status` | 显示配置，以及钩子是否已注册**且其脚本文件是否仍然存在**。 |
| `shoot uninstall` | 移除 Shoot 自己的钩子条目、配置与状态。不会触碰你的其他钩子。 |

### `shoot doctor`

它能捕捉那些看起来像成功的安装故障——最重要的是：钩子已注册但其脚本文件已不存在，
这种情况下它看似已安装，实际什么也没验证：

```
🐼 Shoot: Let's check your setup.

  ok    Node version         v22.14.0
  ok    Working directory    /path/to/project
  ok    Config file          .shoot.config.json
  ok    Platform             Claude Code
  ok    Checks configured    test, lint
  ok    test command         npm test → package.json scripts.test
  FAIL  lint command         npm run lint — no "lint" script in package.json
                             → Add a "lint" script, or change checks.lint in .shoot.config.json.
  FAIL  Hook registration    no Shoot hooks registered for Claude Code
                             → Run `shoot init` to register them.

🐼 Shoot: 2 problems will stop verification from working. The → lines above say how to fix each one.
```

当确实存在问题时以非零码退出，因此可用于 pre-commit 钩子或 CI。

### `shoot stats`

每次验证结果都会追加到 `.shoot/history.jsonl`——仅存本地，绝不上传到任何地方。
`shoot stats` 会读回这些记录：

```
🐼 Shoot: Your verification history

  verifications   3
  sessions        1
  first / last    2026-07-31 .. 2026-07-31

  passed          1
  blocked         2

  pass rate       33% of verified claims

🐼 Shoot: Caught 2 completion claims that weren't backed by passing checks.
```

通过率仅按真实完成过验证的声称计算——那些没有配置任何检查的对话会被排除，
因为无论把它们算作通过还是失败，都会歪曲这个数字。

## 支持的平台

| 平台 | 状态 |
| --- | --- |
| **Claude Code** | 完全支持。已在真实会话中验证。 |
| **OpenAI Codex CLI** | 支持。依据官方文档契约构建；尚未在真实 Codex 会话中验证。 |
| Cursor | 暂不支持——存在 `stop` 钩子，但它是否在 CLI 中触发尚未确认。 |
| Kiro | 暂不支持——钩子系统存在，但未确认有可用于阻止的完成事件。 |
| Antigravity | 暂不支持——未找到可对接的钩子系统。 |

`shoot init` 会根据 `.claude/` 或 `.codex/` 自动识别你使用的平台，只有在无法判断时才会询问。
完整说明（包括每个尚未支持的平台具体卡在什么地方）见
[docs/PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md)。

有两个 Codex 差异值得提前了解：那里的 `decision: "block"` 含义是*带着该原因继续*，
而不是*阻止结束*（两者都能产生 Shoot 想要的效果）；并且 Codex 在 `Stop` 事件上不支持
`systemMessage`，因此通过回执会出现在你的终端，但不会出现在 Codex 界面中。
`shoot init` 会在你确认使用该平台之前说明这一点。

## 范围偏移提示（仅供参考）

当某个声称通过验证后，Shoot 还可以指出这次改动是否显得异常宽泛——它会附加在回执之后，
绝不会阻止：

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
   Heads up (advisory, not a failure): 34 changed files across 6 areas — broader than a
   focused change usually is. Worth a glance if you expected something narrow.
```

**必须说清楚这是什么：** 一个基于文件数量的启发式判断。它只是询问 git 有多少文件发生了改动、
分布得有多分散。它不读取任务描述，不理解这次改动的目的，也无法区分一次正当的大范围重构
与助手跑偏。在它看来，一次覆盖整个 monorepo 的重命名和真正的范围偏移完全一样。

这正是它在任何模式下都绝不阻止的原因。基于如此模糊的信号进行阻止，只会训练你忽略 Shoot，
那样付出的代价远大于它所能发现的偏移。可用 `"scopeDriftWarning": false` 关闭，
或调整 `scopeDriftFileThreshold`。

## 已知限制

坦率说明这个工具能做什么、不能做什么：

- **Shoot 只能运行你给它的命令。** 它无法为一个没有测试的项目凭空造出测试。如果指向
  一个没有测试套件的项目，它没有任何可验证的内容，并会如实说明，而不是假装通过。
  验证的质量完全取决于所配置的命令——一个直接 `exit 0` 的占位命令什么也证明不了，
  而 Shoot 无法分辨这一点。
- **声称检测器无法识别自问自答的修辞句式。** `"Did I fix it? Yes."` 不会被捕获：
  疑问句式会抑制匹配，而回答本身是一个独立子句、其中并不含声称短语。要处理这种情况
  就会削弱对真正疑问句的抑制能力（`"Are the tests passing?"` 必须保持静默），
  因此这是一个刻意接受的缺口，而不是被隐藏的问题。
- **检测器偏向保守。** 含糊的声称（"I think it's fixed"、"almost done"）被视为
  非声称。含糊表述本身不值得触发强制阻止，但这也意味着软性声称会未经验证地通过。
- **声称检测是启发式的，而非语义式的。** 它匹配的是措辞。新颖的表达方式会漏过去——
  这正是[声称检测问题模板][claims]存在的意义。
- **范围偏移检测是基于文件数量的启发式判断，而非语义分析。** 见上文——它在设计上仅供参考，
  无法区分大范围重构与真正的偏移。
- **Codex 适配器尚未在真实 Codex 会话中验证。** 它依据官方文档契约构建并有单元测试覆盖，
  但真正经历过完整端到端实战的是 Claude Code 路径。请将 Codex 支持视为较新的能力。
- **Cursor 的 `stop` 钩子可能不会在 CLI 中触发。** Cursor 文档中确实有 `stop` 钩子，
  但其文档未说明标准助手钩子是否在 `cursor-agent` 下运行、还是仅限桌面应用。与其发布一个
  在 CLI 场景下静默失效的适配器——那正是 Shoot 要防止的失败模式——不如在确认之前暂不支持。
  这是平台限制，不是 Shoot 的缺陷。
- **一个会说谎的检查命令依然会说谎。** Shoot 验证的是退出码，而不是测试质量。

[claims]: .github/ISSUE_TEMPLATE/claim_detection.md

## 常见问题

**这会让我的助手变慢吗？**
在普通对话中几乎不会。如果最后一条消息中不包含声称完成的措辞，Shoot 什么都不运行并
静默退出——实测约 **0.3 秒**，其中几乎全部是 Node 进程启动时间，且不会在记录中留下
任何条目。只有当助手真的声称完成时，你才会付出真实代价（即你的测试套件耗时），
而那正是你希望它运行的时刻。

**如果我没有测试怎么办？**
把 `checks.test` 留空。任何留空的命令都会被跳过而不是判为失败——一个没有 lint 步骤的
项目不会因此受到惩罚。配置你确实拥有的检查即可；仅有类型检查或构建也是真实有效的
信号。如果什么都没有配置，Shoot 会告知你，而不是默默放行。

**为什么不直接让 Claude 自己验证？**
因为那等于让助手既做事、又给自己评分。一个会在没运行测试的情况下声称"tests pass"的
助手，同样会轻易声称自己已经验证过了。这道检查必须存在于助手控制范围之外的框架层：
Shoot 自己运行命令、自己读取真实退出码，助手无法跳过、无法重新解释，也无法把失败结果
说成通过。问题不在于助手不可信——而在于自我报告的验证根本不算验证。

**支持 Cursor 或 Windsurf 吗？**
暂不支持。目前支持 Claude Code 与 OpenAI Codex CLI。Cursor 文档中有 `stop` 钩子，
但它是否在 CLI 中触发尚不明确，因此我们刻意选择暂不支持，而不是提供半可用的实现——
详见 [docs/PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md)。验证引擎与钩子层相互独立，
因此新增一个平台只是一个小适配器，而不是重写。

**如果检查很慢怎么办？**
它们只在检测到声称完成时才运行，串行执行，且每项都受 `timeoutSeconds` 限制
（默认 120 秒）。超时会被当作失败并明确报告为超时，因此一个卡死的测试运行器永远
不会挂住你的会话。

**它会陷入永久阻止吗？**
不会。断路器会在针对同一失败连续阻止 `maxBlocksPerSession` 次后退让。
详见[断路器](#断路器)一节。

**它会影响我的其他钩子吗？**
不会。`init` 采用合并方式写入 `.claude/settings.json`，`uninstall` 只移除 Shoot 自己的
条目——这一点有往返测试验证，断言操作后文件与原始内容逐字节一致。

## 路线图

**目前已实现：** 声称检测、带超时的真实检查执行、block / warn 两种模式、断路器、
停止与子助手停止事件、Claude Code 与 Codex 适配器、配置篡改检测、密钥脱敏、本地验证历史、
`doctor`、范围偏移参考提示、七个 CLI 命令。

### 设想，而非承诺

以下内容**均未排期，仅为设想**。没有时间表，也没有承诺——列出它们只是为了让你看清方向。
其中若干项受阻于他人的文档而非工作量。完整说明见
[英文 README](../README.md#roadmap)。

- **Cursor 适配器**——Cursor 文档中有 `stop` 钩子及 `followup_message` 字段，与 Shoot 的
  需求相当接近。障碍在于其文档未说明助手钩子是否在 `cursor-agent`（CLI）中触发，还是仅限
  桌面应用。发布一个在 CLI 下静默失效的适配器，正是本工具要防止的失败模式，因此需等待确认。
  详见 [docs/PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md)。
- **Kiro 适配器**——Kiro 有钩子系统，但未确认存在可用于阻止的完成事件。只能观察的钩子可以
  记录虚假声称，却无法阻止它。需先对照 AWS 现行文档核实。
- **Codex 适配器的真实会话验证**——已依据官方文档契约构建并有单元测试覆盖，但从未在真实
  Codex 会话中运行。Claude Code 路径已经验证过；这一不对称应当消除。
- **可共享的统计摘要**（`shoot stats --team` 或类似形式）——面向希望展示自身虚假声称
  拦截率的团队。真正的设计难点在于：如何在不泄露声称文本与文件路径的前提下仍然有用。
- **非英语声称检测短语包**——检测器目前仅支持英语。以西班牙语、中文、印地语或其他语言表述的
  完成声称完全不会被捕获。模式表本身已是数据而非逻辑，因此这主要是翻译与测试的工作，
  也是对英语之外团队最可能产生实际影响的缺口。
- **可选的 GitHub Action 变体**——在 PR / CI 阶段运行同一套验证逻辑，而不仅是通过本地
  助手钩子。核心逻辑本已与平台无关，因此无需重构即可实现。
- **吉祥物插画**——设计说明见
  [assets/mascot-placeholder.md](../assets/mascot-placeholder.md)，插画本身尚不存在。
- **自用演示视频**——脚本见 [DEMO.md](../DEMO.md)，可随时录制。

### 明确不打算做

- 任何仪表盘或托管服务。Shoot 保持本地与离线。
- 语义级范围偏移检测。当前实现基于文件数量，并如实说明了这一点；把它做得"更聪明"
  只会让它更自信地出错。
- 针对单项检查的独立超时、并行执行检查、感知 Git 的检查。都说得通，但都不紧迫。

## 安全

Shoot 会以你的本地权限自动运行，因此它的威胁模型被明确写了下来，而不是想当然：
**[SECURITY.md](../SECURITY.md)**（英文）。其中说明了上述缓解措施实际能做什么、明确不能做什么，
以及如何私下报告漏洞（使用 GitHub 私密安全公告——请不要为安全问题创建公开 issue）。

## 参与贡献

欢迎贡献——尤其欢迎提交声称检测器漏掉的真实措辞。请参阅
[CONTRIBUTING.md](../.github/CONTRIBUTING.md)。唯一的硬性规则是：**零运行时依赖**，
由 CI 强制执行。

译文同样欢迎。英文 README 是权威来源；若译文出现滞后，欢迎通过 PR 修正。

## 许可证

[MIT](../LICENSE)
