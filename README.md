# @tokens/feishu — 飞书连接插件

一键连接飞书，面向小白：浏览器点两个链接就完成授权，**无需去开发者后台、无需配置回调、无需管理员审批**。

原理：自动创建飞书应用（RFC 8628 设备码，预填全部权限）→ 自动下载并校验官方 [Larksuite CLI](https://github.com/larksuite/cli)（锁版 + SHA-256）→ 驱动 lark-cli 内置的设备码登录拿到个人 user token（存进系统钥匙串/DPAPI）。之后所有工具都以你的个人身份、通过 `lark-cli api` 直连飞书开放平台。移植自 TokensAgent 的 Go 实现。

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

验证层已加载（应出现 `# == @tokens/feishu`）：

```sh
pnpm dsh --profile <名字> --dump-config
```

卸载：`pnpm dsh plugin --profile <名字> remove @tokens/feishu`

## 使用

对 agent 说「帮我连上飞书」，或直接敲 `/feishu-connect`：

1. 插件返回**第一个链接**，浏览器打开（可扫码），确认后飞书自动创建应用「TokensAgent」，全部 scope 预授权；
2. 插件自动下载校验官方 lark-cli（首次约 12 MB，存 `~/.dsh/runtime/lark-cli/`），用创建好的应用凭据初始化一个命名 profile，随即给出**第二个链接**做个人设备码授权；
3. 浏览器打开第二个链接确认后，lark-cli 把 user token 存入系统钥匙串，完成。登录一次，重启免重扫。

之后 `feishu_create_doc` / `feishu_send_message` / `feishu_create_bitable` 等工具以你个人身份操作。

## 工具与命令

| 名称 | 说明 |
|---|---|
| `feishu_connect` 工具 | 发起一键创建 + 设备码授权流程，返回链接 |
| `feishu_status` 工具 | 长轮询流程进度（agent 用它跟进并转发链接） |
| `feishu_create_doc` 工具 | 新建 docx 文档，返回 id 和 URL |
| `feishu_send_message` 工具 | 发文本消息（open_id / chat_id / email / user_id） |
| `feishu_create_bitable` 工具 | 新建多维表格（Base），返回 app_token 和 URL |
| `/feishu-connect [lark]` 命令 | 人类直接发起流程（`lark` = 国际版） |
| `/feishu-status` 命令 | 查看进度和待打开的链接 |

## 源码结构

- `src/register.ts` — 一键创建应用协议（RFC 8628 设备授权；begin/poll、域名自动切换、addons 权限预填）
- `src/scopes.ts` — 预授权 scope 清单（tenant + user；不含需管理员审批的 self_manage/patch）
- `src/larkcli-provision.ts` — 锁版直连 GitHub release 下载 lark-cli + 双重 SHA-256 校验 + 自带 zip/tar.gz 解包
- `src/larkcli.ts` — lark-cli 运行器：设备码登录、状态查询、`lark-cli api` 通用透传
- `src/index.ts` — 插件入口：工具与命令注册、连接状态机、凭据管理

## 开发

```sh
node_modules/.bin/tsc -b tsconfig.json   # 类型检查
```

注意：`exports` 指向 `src/index.ts`（TS 源码），依赖 `pnpm dsh` 的 tsx 源码启动。首次连接会联网下载 lark-cli 官方二进制（锁定 v1.0.76，逐平台校验 SHA-256）。
