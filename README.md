# @tokens/feishu — 飞书连接插件

一键连接飞书：自动创建飞书应用（预填全部权限）+ 个人 CLI 授权，无需去开发者后台。移植自 TokensAgent 的 Go 实现。

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

1. 插件返回**一个链接**，浏览器打开（可扫码），确认后飞书自动创建应用「DSH Agent」，全部 scope 预授权；
2. 插件自动把 `http://localhost:3000/callback` 写入应用安全设置，随即给出**第二个链接**做个人授权；
3. 点开授权后浏览器重定向回本地，code 自动换成 user token 存入凭据系统，完成。

之后 `feishu_create_doc` / `feishu_send_message` 等工具以你个人身份操作，token 过期自动用 refresh token 续期；无个人授权时退回应用（tenant）身份。

## 工具与命令

| 名称 | 说明 |
|---|---|
| `feishu_connect` 工具 | 发起一键创建 + 授权流程，返回链接 |
| `feishu_status` 工具 | 长轮询流程进度（agent 用它跟进并转发链接） |
| `feishu_create_doc` 工具 | 新建 docx 文档，返回 id 和 URL |
| `feishu_send_message` 工具 | 发文本消息（open_id / chat_id / email / user_id） |
| `/feishu-connect [lark]` 命令 | 人类直接发起流程（`lark` = 国际版） |
| `/feishu-status` 命令 | 查看进度和待打开的链接 |

## 源码结构

- `src/register.ts` — 一键创建应用协议（RFC 8628 设备授权；begin/poll、域名自动切换、addons 权限预填）
- `src/scopes.ts` — 预授权 scope 清单（tenant + user）
- `src/oauth-server.ts` — 本地一次性 OAuth 回调服务器
- `src/api.ts` — token 获取/交换/刷新 + docx/im 接口
- `src/index.ts` — 插件入口：工具与命令注册、连接状态机、凭据管理

## 开发

```sh
node_modules/.bin/tsc -b tsconfig.json   # 类型检查
```

注意：`exports` 指向 `src/index.ts`（TS 源码），依赖 `pnpm dsh` 的 tsx 源码启动。若改用安装版 dsh 二进制加载，需先构建出 JS 并把 `exports` 指向 `lib/`。
