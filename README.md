# Bifröst —— Dia ⇆ Chrome 双浏览器同步台

> Bifröst（彩虹桥）：北欧神话中连接两个世界的桥。这里连接的是 **Dia** 与 **Chrome** 两套互不相通的账号体系。

一个零依赖的 Node.js 本地同步器：常驻服务 + 玻璃质感 Web 控制台，同步两边的**书签（含文件夹层级）**与**插件（安装/卸载对齐）**。

## 功能

| 需求 | 实现 |
| --- | --- |
| 书签同步（含文件夹） | 读取两边的 Chromium `Bookmarks` JSON，整树镜像（书签栏 / 其他书签 / 移动设备书签，含全部层级与顺序），写入前自动备份、原子写入、重算 checksum |
| 插件同步（安装与卸载） | 扫描两边 `Extensions/` + `Secure Preferences`（名称、版本、启用状态、内置组件识别），向主侧对齐：缺失的引导安装、多余的引导移除、版本差异提示、可忽略名单 |
| 以谁为主（二选一） | 控制台点击浏览器芯片即切换主侧；CLI 亦可设置 |
| 同步频率 | 手动 / 每小时 / 每天（指定时刻）/ 每周（指定星期+时刻）；由常驻服务内置调度器执行，也可随时手动触发 |
| 界面 | 按 impeccable 规范设计的「日光玻璃」控制台：大面积磨砂玻璃、环境色场、分段控件、差异预览、同步记录 |

## 快速开始

### 方式一：Mac 安装包（推荐）

双击 `dist/Bifrost-1.0.0.dmg` → 把 **Bifrost.app** 拖入「应用程序」→ 打开：

- 菜单栏出现 Bifröst 桥拱图标：**打开同步控制台 / 立即同步 / 后台计划服务**；
- 打开时自动用内置 Node 运行时拉起同步服务（无需安装 Node），并弹出玻璃控制台窗口；
- 若 8770 端口已有 Bifröst 服务（如先前装过的后台服务），app 直接复用，不会重复拉起；
- 菜单「后台计划服务 → 安装」可让同步服务开机自启（需要先把 app 放进「应用程序」——macOS 不允许后台进程读取「下载」文件夹）；
- 数据（配置/备份/记录）统一在 `~/Library/Application Support/Bifrost/data/`，与 CLI/脚本方式完全互通。

重新构建安装包：`bash mac/build-app.sh`（产物在 `dist/`：Bifrost.app + Bifrost-1.0.0.dmg；`--no-dmg` 只出 .app）。

### 方式二：源码运行

```bash
# 1. 安装并启动常驻服务（复制应用到 ~/Library/Application Support/Bifrost 并装载 LaunchAgent）
bash scripts/install-agent.sh

# 2. 打开控制台
open http://127.0.0.1:8770
```

也可以不装常驻服务，临时跑一下：

```bash
npm start          # 启动控制台 + 调度器（前台）
npm run sync       # 手动同步一次
npm run status     # 查看状态
```

## 同步原理与边界

### 书签 —— 自动镜像写入
- 方向：**主 → 从**。把主侧书签树完整镜像到从侧（含文件夹结构）。
- 安全：写入前自动备份到 `data/backups/`；**从侧浏览器必须退出**，否则 Chromium 退出时会覆盖外部写入。
  - 从侧正在运行时，控制台会出现「退出并同步」按钮：优雅退出 → 写入 → 自动重新打开。
  - 计划同步遇到从侧在运行会记录「已跳过」，不会强行退出你的浏览器。
- 永久根节点（三个根的 id/guid）保持不变，子树重新分配 id/guid，浏览器启动时自动重算 checksum。

### 插件 —— 引导式对齐（Chromium 安全限制）
Chromium 不允许第三方静默安装/卸载扩展（扩展设置由 HMAC 完整性保护），因此：
- **缺失的插件**：点「装到 Dia/Chrome ↗」会在目标浏览器打开 Chrome Web Store 页，一键「添加扩展」即可；
- **主侧已卸载的插件**：点「去移除 ↗」打开目标浏览器的扩展管理页（`chrome://extensions`），点移除即可；
- 处理结果会在下次扫描时自动对账（待办清零、写入同步记录）。
- 浏览器内置组件（如 Chrome Web Store Payments，location 5/10）自动排除；也可手动忽略任意插件。

## CLI

```bash
node cli.js status                     # 主浏览器 / 计划 / 上次与下次同步
node cli.js sync                       # 立即同步（同 UI 的「立即同步」）
node cli.js primary dia|chrome         # 设置主浏览器
node cli.js schedule hourly|daily|weekly|manual [HH:MM] [mon..sun]
node cli.js open                       # 打开控制台
```

## 常驻服务（LaunchAgent）

```bash
bash scripts/install-agent.sh      # 安装/更新副本并启动
bash scripts/uninstall-agent.sh    # 停止并移除
```

- 服务地址 `http://127.0.0.1:8770`，开机自启、崩溃自动拉起。
- **为什么复制到 `~/Library/Application Support/Bifrost`？** macOS TCC 会无提示地阻塞后台服务读取 `~/Downloads`（项目所在目录）；终端里手动运行没问题，但 launchd 派生的进程会被挂起。常驻副本规避此问题。
- 工作区是源码；改完代码重新运行 `install-agent.sh` 即可更新常驻副本。
- 常驻副本的数据（配置/备份/记录）在 `~/Library/Application Support/Bifrost/data`；工作区 `data/` 仅用于前台开发运行。

## 开发与测试

```bash
npm test    # 12 项引擎测试：全部跑在 /tmp fixture 上，绝不读写真实浏览器数据
```

关键实现：
- `lib/bookmarks.js` —— 书签读取 / 结构化 diff（新增·移除·变更·移动重命名）/ 镜像写入
- `lib/extensions.js` —— 扩展扫描（本地化名称解析、启用状态、内置识别）/ 双向 diff
- `lib/sync.js` —— 编排：书签镜像 + 插件待办 + 落账 + macOS 通知
- `lib/schedule.js` —— hourly / daily / weekly 下次运行计算
- `server.js` —— REST API + 静态前端 + 30s 调度 tick
- `public/` —— 玻璃质感控制台（设计上下文见 `.impeccable.md`）
- `mac/` —— 原生菜单栏外壳（AppKit + WKWebView，内嵌 node 运行时）与 .app/.dmg 构建脚本

## 已知边界

- 插件的安装/卸载需要一次人工点击（浏览器安全模型决定），其余全自动。
- 书签「移动/重命名」按 url 识别；重命名文件夹会让其子树在 diff 中显示为移除+新增（镜像结果不受影响）。
- 多 profile：默认使用两边 `Default`；如需其它 profile，改 `data/config.json` 的 `profiles.dia` / `profiles.chrome`。
- 控制台字体来自 Google Fonts，离线时自动回退 PingFang SC / 系统字体，不影响使用。
