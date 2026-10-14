# 私密聊天室

纯静态网页（GitHub Pages）+ Supabase 免费数据库。消息和图片在浏览器里用 AES-256-GCM 加密后才上传，服务器和 GitHub 都只能看到密文。

## 部署步骤

### 1. 创建 Supabase 项目（后端）
1. 打开 https://supabase.com ，用 GitHub 账号登录，点 New project（区域选离你们近的，如 Singapore / Tokyo）。
2. 项目建好后，左侧 SQL Editor → New query，把 `supabase.sql` 全部内容粘贴进去，点 Run。
3. 左侧 Project Settings → API（或 API Keys），复制：
   - Project URL
   - anon public key（或 publishable key）。不要用 service_role / secret key。
4. 打开 `config.js`，把这两个值填进去。

### 2. 创建 GitHub 仓库（前端）
1. https://github.com/new ，仓库名随意（比如 `notes`），选 Public（免费账号的 Pages 需要公开仓库，代码公开没关系，里面没有秘密），点 Create repository。
2. 在新仓库页面点 uploading an existing file，把本文件夹里所有文件拖进去（index.html、app.js、crypto.js、config.js、style.css、favicon.svg，supabase.sql 和 README.md 可选），点 Commit changes。
3. 仓库 Settings → Pages → Source 选 Deploy from a branch，Branch 选 `main`、目录 `/ (root)`，Save。
4. 等 1～2 分钟，访问 `https://你的用户名.github.io/仓库名/`。

### 3. 使用
- 你们约定同一个房间名 + 口令（口令建议 12 位以上、别用常见词），通过当面或其他安全渠道告诉朋友，不要发在微信里。
- 昵称随便填。口令输错会进入一个空房间（不会报错）。
- 支持文字、图片（选择或直接粘贴），图片会自动压缩并去除 EXIF/GPS 信息。

## 须知
- 口令就是唯一的钥匙：泄露 = 所有聊天记录可被解密；忘记 = 记录无法找回。
- 服务器能看到：某个房间在什么时间、有多少条消息、消息大小；看不到内容、昵称、房间名。
- 页面打开时每约 3 秒自动拉取新消息，没有手机推送通知。
- Supabase 免费项目连续一周没人访问会自动暂停，到控制台点 Restore 即可恢复；免费数据库 500MB。
- 国内访问 github.io / supabase.co 可能不稳定，取决于网络环境。
