#!/usr/bin/env bash
# Apply .env config to Penny GCE container.
# Usage: bash setup.sh [.env file]
set -euo pipefail

ENV_FILE="${1:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found"
  exit 1
fi

_val() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

ZONE="${GCP_ZONE:-$(_val GCP_ZONE)}"
ZONE="${ZONE:-us-central1-a}"
INSTANCE="${OPENCLAW_INSTANCE:-$(_val OPENCLAW_INSTANCE)}"
INSTANCE="${INSTANCE:-penny-vm}"
PROJECT="${GCP_PROJECT_ID:-$(_val GCP_PROJECT_ID)}"

echo "🐾 Penny Setup"
echo "   Instance: $INSTANCE ($ZONE)"
if [[ -n "$PROJECT" ]]; then
  echo "   Project:  $PROJECT"
fi
echo ""

# ── Build clean env file (skip blanks, comments, placeholders) ────
TMPENV=$(mktemp)
trap 'rm -f "$TMPENV"' EXIT

echo "📄 Loading from $ENV_FILE"
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  [[ -z "$line" || "$line" != *=* ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  [[ -z "$val" || "$val" == "..." ]] && continue
  echo "${key}=${val}" >> "$TMPENV"
done < "$ENV_FILE"

echo ""
echo "── Applying to $INSTANCE ──"
echo ""

PROJECT_FLAG=""
if [[ -n "$PROJECT" ]]; then
  PROJECT_FLAG="--project=$PROJECT"
fi

gcloud compute instances update-container "$INSTANCE" \
  --zone="$ZONE" \
  $PROJECT_FLAG \
  --container-env-file="$TMPENV"

echo ""
echo "✅ Setup complete! Container will restart with new config."
echo ""
echo "📱 Your bot is running — open Telegram and send it a message."
