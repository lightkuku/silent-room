部署
# 1. 部署 Workers
cd cloudflare
npm run deploy


# 2. 部署前端
cd ..
VITE_API_URL=https://xxx.workers.dev \
VITE_WS_URL=wss://xxx.workers.dev \
npm run build
npx wrangler pages deploy dist


使用 wrangler d1 命令查看数据库：
# 列出所有数据库
wrangler d1 list
# 查看数据库中的表
wrangler d1 execute <database_name> --command ".tables"
# 查询数据
wrangler d1 execute <database_name> --command "SELECT * FROM users"
# 交互式查询
wrangler d1 execute <database_name> --local
先运行 wrangler d1 list 查看你的数据库名称。


G网盘
使用方法：
1. 在 Google Cloud Console 创建项目
   - https://console.cloud.google.com/
   - 启用 Google Drive API
   - 创建 OAuth 2.0 客户端凭据
2. 配置凭据
      cp server/storage/google-config.json server/storage/google-config.json
   # 编辑填入 client_id, client_secret, folderId
   
3. 获取授权
      node server/storage/auth-google.js
   # 按提示完成授权
   
4. 切换到 Google Drive
      export STORAGE_TYPE=google
   # 或修改默认值
   
切换存储只需修改环境变量或代码，无需改动其他业务逻辑。


已完成！创建了以下存储适配器：
---
支持的存储类型：
类型
local
google
r2
kv
pcloud
---
切换存储方式：
# 环境变量
export STORAGE_TYPE=r2      # 使用 R2
export STORAGE_TYPE=kv      # 使用 KV
export STORAGE_TYPE=pcloud  # 使用 pCloud
export STORAGE_TYPE=google  # 使用 Google Drive
export STORAGE_TYPE=local   # 使用本地存储
# flue-chat
