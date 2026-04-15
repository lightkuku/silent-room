# Silent Room 部署指南

## 概述

本项目使用 GitHub Actions 自动部署到 Cloudflare Workers（后端）和 Cloudflare Pages（前端）。

## 部署架构

```
GitHub Actions
    ├── 后端部署 (Workers)
    │   ├── D1 数据库
    │   ├── KV 命名空间
    │   ├── R2 存储桶
    │   └── Durable Objects (WebSocket)
    └── 前端部署 (Pages)
```

## GitHub Secrets 配置

### 必需

| Secret | 说明 | 示例 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | - |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID | - |
| `ADMIN_PASSWORD` | 管理员密码 | - |
| `PASSWORD_SALT` | 密码盐值 | - |
| `JWT_SECRET_KEY` | JWT 签名密钥 | - |
| `CSRF_SECRET_KEY` | CSRF 密钥 | - |
| `CLOUDFLARE_AI_TOKEN` | Cloudflare AI Token | - |


### 可选

| Secret | 说明 | 默认值 |
|--------|------|--------|
| `NAME` | 项目名称 | `silent-room` |
| `SITE_TITLE` | 网站标题 | `silent-room` |
| `VERSION` | 版本 | `2.0.1` |
| `CUSTOM_DOMAIN` | 自定义域名 | 无 |
| `FRONTEND_URL` | 前端自定义域名 | `https://silent-room.pages.dev` |
| `USE_ROUTES` | 使用 Routes 模式 | `true` |
| `D1_DATABASE_ID` | D1 数据库 ID | 自动创建 |
| `KV_NAMESPACE_ID` | KV 命名空间 ID | 自动创建 |
| `R2_BUCKET_NAME` | R2 存储桶名称 | `silent-room-files` |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key | '' |
| `TURNSTILE_SITE_KEY` | Turnstile Site Key | '' |

## API Token 权限

创建 Cloudflare API Token 时，需要以下权限：

- **Workers** - 编辑 (Workers 和 Workers KV)
- **Pages** - 编辑
- **D1** - 编辑
- **KV Namespace** - 编辑
- **R2** - 编辑
- **DNS** - 编辑 (用于绑定自定义域名)

## 部署方式

### 1. 自动部署（推荐）

推送代码到 `main` 分支即可自动触发部署：

```bash
git add .
git commit -m "deploy"
git push origin main
```

### 2. 手动部署

在 GitHub 仓库页面点击 `Actions` → `Deploy Silent Room to Cloudflare Workers` → `Run workflow`

可输入自定义域名：
- `custom_domain`: 自定义域名（如 `chat.example.com`）

## 自定义域名配置

### 方式一：使用 Routes（默认）

设置 `CUSTOM_DOMAIN`（如 `https://chat.example.com`）后自动使用 Routes：

```
*.chat.example.com/* -> Worker
```

需要在 Cloudflare 域名解析中添加 CNAME 记录指向 Worker。

### 方式二：Workers.dev

不设置 `CUSTOM_DOMAIN` 即可使用 Workers.dev 域名。

### Frontend（Pages）

- 有 `FRONTEND_URL` → 部署到自定义域名（使用 `--domain` 参数）
- 无 `FRONTEND_URL` → 部署到 `.pages.dev`

## 部署流程

1. **安装依赖** - npm install
2. **设置 KV 数据库** - 自动创建或复用
3. **设置 D1 数据库** - 自动创建或复用
4. **设置 R2 存储桶** - 自动创建或复用
5. **配置 wrangler.toml** - 替换环境变量
6. **存储敏感配置** - 上传到 Cloudflare Secrets
7. **运行数据库迁移** - D1 migrations
8. **部署 Worker** - wrangler deploy
9. **构建前端** - npm run build
10. **部署 Pages** - wrangler pages deploy
11. **初始化数据库** - 调用 /api/init

## 文件结构

```
.
├── .github/workflows/deploy.yml  # GitHub Actions 部署脚本
├── cloudflare/
│   ├── wrangler.toml             # 本地部署配置
│   ├── wrangler-action.toml      # GitHub Actions 部署配置
│   ├── package.json
│   └── src/
│       └── index.ts              # Worker 入口
├── src/                          # 前端源码
│   └── App.tsx
├── package.json
└── vite.config.ts
```

## 本地开发

### 前端

```bash
npm run dev
```

### 后端

```bash
cd cloudflare
pnpm install
pnpm wrangler dev
```

### 部署到本地

```bash
cd cloudflare
pnpm deploy
```

## 注意事项

1. 首次部署需要配置所有必填的 Secrets
2. `CUSTOM_DOMAIN` 格式：`https://chat.example.com`（带 https://）
3. 使用 Routes 需要在 Cloudflare 域名解析中添加相应记录
4. 数据库迁移会自动执行
5. `USE_ROUTES` 默认为 `true`，如需使用 Custom Hostname 模式可设置为 `false`
