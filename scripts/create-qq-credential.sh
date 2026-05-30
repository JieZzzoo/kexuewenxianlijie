#!/usr/bin/env bash
# ------------------------------------------------------------
# 在 n8n 容器内创建名为 "QQ SMTP" 的 SMTP 凭据（从 .env 读取账号/授权码）。
# 凭据 id 固定为 qqsmtpCRED000001 —— 与导入的工作流里邮件节点的引用一致，
# 因此创建后工作流的 "Send To QQ Mail" 节点会自动绑定，无需手动选。
#
# 用法：在仓库根目录执行  bash scripts/create-qq-credential.sh
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then echo "❌ 找不到 .env，请先 cp .env.example .env 并填写"; exit 1; fi
set -a; # shellcheck disable=SC1091
source .env; set +a

: "${QQ_SMTP_USER:?请在 .env 设置 QQ_SMTP_USER}"
: "${QQ_SMTP_AUTHCODE:?请在 .env 设置 QQ_SMTP_AUTHCODE（16位授权码）}"

mkdir -p out
TMP="out/.qqcred.json"
cat > "$TMP" <<EOF
[{"id":"qqsmtpCRED000001","name":"QQ SMTP","type":"smtp","data":{"host":"smtp.qq.com","port":465,"secure":true,"user":"${QQ_SMTP_USER}","password":"${QQ_SMTP_AUTHCODE}","disableStartTls":false}}]
EOF

docker compose exec -T n8n n8n import:credentials --input=/data/out/.qqcred.json --decrypted
rm -f "$TMP"
echo "✅ 已创建/更新 'QQ SMTP' 凭据。打开工作流执行即可发信。"
