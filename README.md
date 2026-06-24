# DNSHE 多账号自动续期 Worker

基于 Cloudflare Workers 的 DNSHE 免费域名自动续期工具，支持多账号管理、Web 面板手动执行、Cron 定时自动续期。

## ✨ 功能特性

- 🔄 **自动续期**：检测域名剩余天数，低于阈值自动续期
- 👥 **多账号支持**：最多支持 20 个账号批量管理
- ⏰ **定时任务**：内置 Cron 触发器，每季度自动执行
- 📊 **Web 面板**：可视化操作界面，SSE 实时日志输出
- 🛡️ **请求限流**：内置请求间隔，避免触发平台风控
- 🌐 **零成本运行**：基于 Cloudflare Workers，免费额度充足

## 🚀 部署方法

### 方法一：Wrangler CLI 部署（推荐）

1. 安装 Wrangler
```bash
npm install -g wrangler
```

2. 登录 Cloudflare
```bash
wrangler login
```

3. 克隆本仓库并部署
```bash
git clone <your-repo-url>
cd dnshe-autorenew-worker
wrangler deploy
```

### 方法二：复制代码手动部署

1. 进入 Cloudflare Dashboard → Workers & Pages → Create Worker
2. 将 `src/index.js` 内容全部粘贴到编辑器中
3. 保存并部署

## ⚙️ 环境变量配置

在 Cloudflare Worker 的 **Settings → Variables** 中添加：

### 单账号模式
| 变量名 | 说明 |
|--------|------|
| `API_KEY` | DNSHE API Key |
| `API_SECRET` | DNSHE API Secret |

### 多账号模式（序号从 1 开始）
| 变量名 | 说明 |
|--------|------|
| `API_KEY_1` | 第 1 个账号 API Key |
| `API_SECRET_1` | 第 1 个账号 API Secret |
| `ACCOUNT_NAME_1` | 第 1 个账号显示名称（可选） |
| `API_KEY_2` | 第 2 个账号 API Key |
| `API_SECRET_2` | 第 2 个账号 API Secret |
| ... | 最多支持 20 个账号 |

> API Key / Secret 可在 DNSHE 个人中心的 API 设置页面获取。

## 🎯 使用方式

### 手动执行
访问 Worker 域名，点击「开始批量续期」按钮即可手动触发，实时查看执行日志。

### 自动定时
默认每 3 个月（每年 1、4、7、10 月 1 号）UTC 00:00（北京时间 08:00）自动执行一次，可在 `wrangler.toml` 中修改 Cron 表达式。

## 🔧 可调参数

在 `src/index.js` 顶部可修改：

- `RENEW_BEFORE_DAYS`：剩余天数小于等于该值时触发续期（默认 180 天）
- `LIST_SLEEP_MS`：域名遍历间隔（默认 300ms）
- `RENEW_SLEEP_MS`：续期请求间隔（默认 800ms）
- `FETCH_TIMEOUT`：接口超时时间（默认 10000ms）
- `ACCOUNT_SLEEP_MS`：账号切换间隔（默认 1000ms）

## ⚠️ 注意事项

1. 本工具仅用于合法的自有域名续期，请勿滥用
2. 请合理设置请求间隔，避免对平台造成压力
3. 敏感密钥请通过环境变量配置，**切勿提交到公开仓库**
4. 如遇接口变更，请及时更新 API 地址

## 📄 License

MIT License
