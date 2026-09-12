#!/usr/bin/env bash
# 安装 LaunchAgent：让 Bifröst 服务常驻（开机自启 + 崩溃自动拉起），计划同步才会可靠运行。
#
# 注意：应用会被复制到 ~/Library/Application Support/Bifrost 再由 launchd 运行。
# 因为 macOS TCC 保护 ~/Downloads，后台服务直接读取 Downloads 里的项目会被
# 无提示地阻塞（open() 挂起）。复制到 Application Support 后无此问题。
# 工作区里的项目是源码；改动后重新运行本脚本即可更新常驻副本。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/Bifrost"
PLIST="$HOME/Library/LaunchAgents/com.rhazen.bifrost-synchro.plist"
NODE_BIN="$(command -v node)"

if [[ -z "${NODE_BIN}" ]]; then
  echo "错误：未找到 node，请先安装 Node.js" >&2
  exit 1
fi

# 同步应用副本
mkdir -p "$APP_DIR"
rsync -a --delete \
  --include 'server.js' --include 'cli.js' --include 'package.json' \
  --include 'lib/***' --include 'public/***' --include 'scripts/***' \
  --include 'data/***' --exclude '*' \
  "$PROJECT_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.rhazen.bifrost-synchro</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${APP_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${APP_DIR}/data/logs/agent.log</string>
  <key>StandardErrorPath</key><string>${APP_DIR}/data/logs/agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

for i in $(seq 1 10); do
  sleep 0.5
  if curl -sf -o /dev/null http://127.0.0.1:8770/; then break; fi
done

if curl -sf -o /dev/null http://127.0.0.1:8770/; then
  echo "✅ LaunchAgent 已安装并启动"
  echo "   常驻副本: $APP_DIR"
  echo "   数据目录: $APP_DIR/data（配置、备份、记录都在这里）"
  echo "   控制台:   http://127.0.0.1:8770"
  echo "   卸载:     bash scripts/uninstall-agent.sh"
else
  echo "⚠️ 服务已装载但未响应，请查看 $APP_DIR/data/logs/agent.err.log" >&2
  exit 1
fi
