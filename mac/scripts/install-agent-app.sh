#!/usr/bin/env bash
# 由 Bifrost.app 内部调用：把「后台计划服务」指向本 app。
# 用法：bash install-agent-app.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$APP_DIR/Contents/Resources/bin/node"
SERVER_JS="$APP_DIR/Contents/Resources/app/server.js"
PLIST="$HOME/Library/LaunchAgents/com.rhazen.bifrost-synchro.plist"
# 服务端约定：SYNCHRO_DATA_DIR 即数据目录本身
DATA_ROOT="$HOME/Library/Application Support/Bifrost"
DATA_DIR="${SYNCHRO_DATA_DIR:-$DATA_ROOT/data}"

case "$APP_DIR" in
  */Downloads/*)
    echo "⚠️ 请先把 Bifrost.app 拖入「应用程序」文件夹，再安装后台服务。" >&2
    echo "   （macOS 会无提示地阻止后台进程读取「下载」文件夹）" >&2
    exit 1
    ;;
esac

if [[ ! -x "$NODE_BIN" ]]; then
  echo "错误：找不到内置 Node 运行时（$NODE_BIN）" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.rhazen.bifrost-synchro</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_JS}</string>
  </array>
  <key>WorkingDirectory</key><string>${APP_DIR}/Contents/Resources/app</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA_DIR}/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>${DATA_DIR}/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SYNCHRO_DATA_DIR</key><string>${DATA_DIR}</string>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
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
  echo "后台计划服务已安装并启动（开机自启）。控制台: http://127.0.0.1:8770"
else
  echo "服务已装载但未响应，请查看 $DATA_DIR/logs/launchd.err.log" >&2
  exit 1
fi
