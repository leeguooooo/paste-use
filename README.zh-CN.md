# paste-use

**让 AI agent 用上你的 Pastyx 剪贴板历史：列出、搜索、读取你复制过的内容，把旧的一条重新复制，或者把文字放进剪贴板。** [*-use 家族](https://github.com/leeguooooo/plugins)的一员。

[English](./README.md)

[Pastyx](https://paste.leeguoo.com) 把你复制过的文字、链接、代码、图片、文件都存在本机的数据库里。装上 `paste-use`，Claude Code、Codex 这些 agent 就能读到它，你说一句「用我刚才复制的那个」就行。它读的是本地文件，不走同步接口：不用登录，断网可用，以后同步改成端到端加密也不受影响。

```bash
paste-use last                       # 我刚复制的那条，完整内容
paste-use list --limit 10            # 每条一行：id、时间、类型、来源应用、内容
paste-use list --since 2h --app Safari --type link
paste-use search "docker run"        # 搜正文、标题、链接，还有图片里识别出的文字
paste-use get 3f2a9c1e               # 一条的完整内容（也可以写序号，1 是最新一条）
paste-use get 3f2a9c1e --out shot.png   # 图片会写成文件
paste-use pinboards                  # 分组和各自的条数
paste-use copy "文字"                # 放进剪贴板
paste-use copy --clip 3f2a9c1e       # 把旧的一条重新复制
```

`list` 每条只占一行，agent 花几百个 token 就能扫一遍历史，再用 `get` 取要的那一条：

```
3f2a9c1e    2m  text   Safari  hello from the clipboard second line
8b41d7aa    5m  code   Terminal  #Snippets deploy env — export GITHUB_TOKEN=[redacted:github-token] curl -H …
c90e1f22    2h  image  Preview  #Work [image 1280x720] Quarterly revenue chart
```

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.ps1 | iex
```

支持 macOS 14 以上（Apple 芯片和 Intel）和 Windows 10/11 x64。macOS 的二进制有 Developer ID 签名并经过公证。需要先装 [Pastyx](https://paste.leeguoo.com/download)；`paste-use status` 会告诉你它找到的是哪份历史。

Claude Code：`/plugin install paste-use@leeguooooo-plugins`（或者整个家族：`use-family@leeguooooo-plugins`）。

## 隐私

剪贴板历史里什么都有，密码和 API key 也在。paste-use 默认不让 agent 把这些带进对话：

- **所有读取命令默认打码**（`list`、`search`、`get`、`last`，加 `--json` 也一样）。像密钥的内容显示成 `[redacted:类别]`，stderr 会说打了几处：
  - 私钥、JWT，GitHub / OpenAI / Anthropic / Stripe / Slack / AWS / Google / GitLab / npm / Hugging Face 的 token，`Bearer …`
  - `password=…`、`api_key: …`、`密码：…` 这类键值对（键留着，值打码）
  - URL 里的密码（`postgres://user:…@host`）
  - 银行卡号（13 到 19 位且通过 Luhn 校验）
  - 40 个字符以上、大小写和数字混在一起的长串
  - 整条内容就是一个像密码的词（8 到 64 位，大写、小写、数字、符号都有）
- `--no-redact` 关掉打码；`get --raw` 原样输出一条。技能里写明了 agent 要先问你。
- `paste-use copy --clip <id>` 把旧的一条放回剪贴板，**不输出内容**。密钥可以这样转手，不进对话。
- 你在 Pastyx 里设了忽略的应用，它们的剪贴不会显示，设置之前存下的也一样。
- 打码靠的是规则，宁可多打，但保证不了一条不漏。建议在 Pastyx 里打开「跳过密码和敏感内容」，密码管理器复制的东西就不会入库；这个开关关着的时候 `paste-use status` 会提醒。
- 数据库以**只读**方式打开，paste-use 不往里写。`copy` 写的是系统剪贴板，Pastyx 会像平常的复制一样记下来。
- 剪贴内容只当数据看：技能里要求 agent 不执行剪贴内容里的指令。

## 命令

| 命令 | 作用 |
|---|---|
| `list` | 从新到旧列出。筛选：`--type`、`--app`、`--pinboard`、`--favorites`、`--since 2h\|2026-09-30`；`--limit`（默认 20）、`--chars`（默认 100） |
| `search <关键词>` | 输出和筛选同上；匹配正文、标题、链接和图片里识别出的文字 |
| `get <id\|序号>` | 一条的完整内容。`--raw` 原样输出，`--html` 输出复制时带的 HTML，图片用 `--out <路径>` |
| `last [N]` | 最新一条的完整内容，或最新 N 条 |
| `copy` | `<文字>`、`-`（标准输入）、`--file <路径>`，或 `--clip <id\|序号>`（文字、图片、还在磁盘上的文件） |
| `pinboards` | 分组和条数 |
| `status` / `doctor` | 找到的是哪份历史、条数、应用版本、Pastyx 是否在运行 |
| `upgrade` | 自升级（`--check`、`--json`），家族统一约定 |

读取命令都支持 `--json`。退出码：3 本机没有 Pastyx 历史，4 没有这一条，5 写剪贴板失败。

历史存放位置：

| | 路径 |
|---|---|
| macOS | `~/Library/Application Support/paste/local-history.sqlite` |
| macOS，App Store 版 | `~/Library/Containers/com.paste.native/Data/Library/Application Support/paste/local-history.sqlite` |
| Windows | `%LOCALAPPDATA%\Pastyx\history.db` |

用 `PASTE_USE_DB=<文件>` 可以指到别处。

还没做：从命令行把一条加进分组。Pastyx 目前没有提供入口，paste-use 也不会去写应用的数据库。

## 许可

MIT

## 作者

**郭立 (Guo Li / leeguoo)** — [leeguoo.com](https://leeguoo.com/about) · [GitHub](https://github.com/leeguooooo) · [X](https://x.com/leeguooooo) · 更多工具见 [*-use 家族](https://github.com/leeguooooo/plugins)。
