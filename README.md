# @tokens/dsh-feishu-connect — 飞书连接插件

一键连接飞书，面向小白：浏览器点两个链接就完成授权，**无需去开发者后台、无需配置回调、无需管理员审批**。

原理：自动创建飞书应用（RFC 8628 设备码，预填全部权限）→ 自动下载并校验官方 [Larksuite CLI](https://github.com/larksuite/cli)（跟随最新 release，用该 release 自带的 `checksums.txt` 校验，缺了就下、有新版自动更新）→ 驱动 lark-cli 内置的设备码登录拿到个人 user token（存进系统钥匙串/DPAPI）。之后所有工具都以你的个人身份、通过 `lark-cli api` 直连飞书开放平台。

连接时还会把官方 `lark-*` skill（含各自定义 skill 依赖的底座 `lark-shared`）从**同一个二进制**物化到用户级 skill 目录 `~/.dsh/skills/`——版本与二进制天然对齐、缺了自动补齐、只管自己那一套不碰你的 skill；底座会热加载,装上即用,无需手改插件或重启。移植自 TokensAgent 的 Go 实现。

## 安装

从 GitHub 直接装进某个 dsh profile（仓库根就是插件，一行搞定）：

```sh
pnpm dsh plugin --profile <名字> add github:sobermh/tokens_DshFeishuConnect_code#main
pnpm dsh --profile <名字> web
```

或本地路径开发：

```sh
pnpm dsh plugin --profile <名字> add /path/to/tokens_DshFeishuConnect_code
```

验证层已加载（应出现 `# == @tokens/dsh-feishu-connect`）：

```sh
pnpm dsh --profile <名字> --dump-config
```

卸载：`pnpm dsh plugin --profile <名字> remove @tokens/dsh-feishu-connect`

## 使用

对 agent 说「帮我连上飞书」，或直接敲 `/feishu-connect`：

1. 插件返回**第一个链接**，浏览器打开（可扫码），确认后飞书自动创建应用「TokensAgent」，全部 scope 预授权；
2. 插件自动下载校验官方 lark-cli（跟随最新 release,首次约 12 MB，存 `~/.dsh/runtime/lark-cli/`），用创建好的应用凭据初始化一个命名 profile，随即给出**第二个链接**做个人设备码授权；
3. 浏览器打开第二个链接确认后，lark-cli 把 user token 存入系统钥匙串，完成。登录一次，重启免重扫。

**幂等复用**：连接以 lark-cli 的登录态为唯一真相源。已连接时再调 `feishu_connect` 直接返回「已连接」，不重复建应用；应用已建、只是要重新授权时，只出**那一个**个人授权链接（复用已有应用）——只有第一次连接才会出两个链接。要**换账号**，加 `force`（`/feishu-connect force`，或工具参数 `force: true`）重新走个人授权。

> user token 只由 lark-cli 保管在系统钥匙串（唯一真相源）。插件另在 `~/.dsh/runtime/lark-cli/<profile>.identity.json` 存一份**非密钥**身份元数据（用户名、open_id、profile、连接时间），供重启后识别与其他工具复用；有效性仍实时以 lark-cli `auth status` 为准。

之后 `feishu_create_doc` / `feishu_send_message` / `feishu_create_bitable` 等工具以你个人身份操作。

## 工具与命令

| 名称 | 说明 |
|---|---|
| `feishu_connect` 工具 | 发起/复用连接：幂等，已连接直接返回；`force` 换账号 |
| `feishu_status` 工具 | 长轮询流程进度（agent 用它跟进并转发链接） |
| `feishu_create_doc` 工具 | 新建 docx 文档，返回 id 和 URL |
| `feishu_send_message` 工具 | 发文本消息（open_id / chat_id / email / user_id） |
| `feishu_create_bitable` 工具 | 新建多维表格（Base），返回 app_token 和 URL |
| `/feishu-connect [lark] [force]` 命令 | 人类直接发起流程（`lark` = 国际版；`force` = 换账号） |
| `/feishu-status` 命令 | 查看进度和待打开的链接 |
| `/feishu-skills-refresh` 命令 | 强制按最新 release 更新 lark-cli 并重物化官方 lark-* skill（平时连接时自动完成） |

## 源码结构

- `src/register.ts` — 一键创建应用协议（RFC 8628 设备授权；begin/poll、域名自动切换、addons 权限预填）
- `src/scopes.ts` — 预授权 scope 清单（tenant + user；不含需管理员审批的 self_manage/patch）
- `src/larkcli-provision.ts` — 跟随最新 release 下载 lark-cli + 用 release 自带 `checksums.txt` 校验 + 版本戳（缺则下、有新版则更）+ 自带 zip/tar.gz 解包 + 离线回退缓存
- `src/concurrency.ts` — 公平 FIFO 并发门：槽位直接交给最早等待者，避免新任务插队突破上限
- `src/skills-provision.ts` — 从二进制物化官方 lark-* skill 到 `~/.dsh/skills/`（版本对齐、幂等自愈、严格限制 `lark-*` 命名空间、最多 8 个 CLI 并发）
- `src/larkcli.ts` — lark-cli 运行器：设备码登录、状态查询、`lark-cli api` 通用透传
- `src/identity.ts` — 连接身份元数据缓存（非密钥；重启识别、跨工具复用 profile）
- `src/index.ts` — 插件入口：工具与命令注册、连接状态机（幂等复用 + `force` 换账号）、连接后台物化 skill、凭据管理

## 开发

```sh
node_modules/.bin/tsc -b tsconfig.json   # 类型检查
node_modules/.bin/tsx --test tests/*.test.ts # 53 条正向 + 53 条反向业务/安全回归
```

注意：`exports` 指向 `src/index.ts`（TS 源码），依赖 `pnpm dsh` 的 tsx 源码启动。首次连接会联网:向 GitHub 解析 lark-cli 最新 release、下载对应平台二进制、用该 release 自带 `checksums.txt` 校验 sha256、再从同一二进制物化官方 lark-* skill。设 `MIN_VERSION` 下限防降级;离线且已有缓存二进制时复用不报错。

## 许可证

本项目采用 [MIT License](LICENSE)。
