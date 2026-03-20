#!/usr/bin/env bash
# Deploy OpenClaw to a GCE VM
# Usage: bash deploy-gce.sh [.env file]
set -euo pipefail

ENV_FILE="${1:-.env}"

# ── Load config from .env or prompt ───────────────────────────────
load_var() {
  local key="$1" default="$2" prompt="$3"
  local val=""

  # Try .env file first
  if [[ -f "$ENV_FILE" ]]; then
    val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  fi

  # Fall back to env var
  val="${val:-${!key:-}}"

  # Fall back to default
  val="${val:-$default}"

  # Prompt if still empty
  if [[ -z "$val" ]]; then
    read -rp "$prompt: " val
    if [[ -z "$val" ]]; then
      echo "Error: $key is required" >&2
      exit 1
    fi
  fi

  echo "$val"
}

echo "🐾 OpenClaw GCE Deployment"
echo ""

# ── Required GCP settings ─────────────────────────────────────────
GCP_PROJECT_ID=$(load_var GCP_PROJECT_ID "" "GCP Project ID")
GCP_REGION=$(load_var GCP_REGION "us-central1" "GCP Region")
ZONE="${GCP_REGION}-a"
INSTANCE_NAME=$(load_var OPENCLAW_INSTANCE "openclaw-vm" "VM instance name")
MACHINE_TYPE=$(load_var OPENCLAW_MACHINE_TYPE "e2-medium" "Machine type")

echo "   Project:  $GCP_PROJECT_ID"
echo "   Region:   $GCP_REGION"
echo "   Instance: $INSTANCE_NAME"
echo "   Machine:  $MACHINE_TYPE"
echo ""

# ── Check for gcloud ──────────────────────────────────────────────
if ! command -v gcloud &>/dev/null; then
  echo "Error: gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# ── Build container image ─────────────────────────────────────────
TAG=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/openclaw/openclaw:${TAG}"

echo "📦 Building $IMAGE..."
gcloud builds submit --tag "$IMAGE" --project="$GCP_PROJECT_ID" .

# ── Check if instance exists ─────────────────────────────────────
if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$GCP_PROJECT_ID" &>/dev/null; then
  echo ""
  echo "🔄 Updating existing VM..."
  gcloud compute instances update-container "$INSTANCE_NAME" \
    --zone="$ZONE" \
    --project="$GCP_PROJECT_ID" \
    --container-image="$IMAGE" \
    --container-mount-host-path=host-path=/var/openclaw-brain,mount-path=/data/openclaw-brain

  echo "✅ Container updated on $INSTANCE_NAME"
else
  echo ""
  echo "🆕 Creating new GCE VM..."

  # ── Reserve static IP ────────────────────────────────────────────
  STATIC_IP_NAME="${INSTANCE_NAME}-ip"
  if ! gcloud compute addresses describe "$STATIC_IP_NAME" --region="$GCP_REGION" --project="$GCP_PROJECT_ID" &>/dev/null; then
    echo "   Reserving static IP ($STATIC_IP_NAME)..."
    gcloud compute addresses create "$STATIC_IP_NAME" \
      --region="$GCP_REGION" \
      --project="$GCP_PROJECT_ID"
  fi
  STATIC_IP=$(gcloud compute addresses describe "$STATIC_IP_NAME" \
    --region="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --format='get(address)')
  echo "   Static IP: $STATIC_IP"

  # ── VM hardening startup script ──────────────────────────────────
  STARTUP_SCRIPT=$(cat <<'STARTUP'
#!/bin/bash
set -euo pipefail
apt-get update -y && apt-get install -y --no-install-recommends ufw fail2ban
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 8080/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
systemctl enable --now fail2ban || true

# ── Disk cleanup: prune stale Docker images/containers/logs daily ──
cat > /etc/cron.daily/docker-cleanup <<'CRON'
#!/bin/bash
docker system prune -af --filter "until=72h" >/dev/null 2>&1 || true
journalctl --vacuum-time=7d >/dev/null 2>&1 || true
find /var/lib/docker/containers/ -name "*.log" -size +50M -exec truncate -s 10M {} \; 2>/dev/null || true
CRON
chmod +x /etc/cron.daily/docker-cleanup

echo "VM hardening + cleanup cron complete."
STARTUP
)

  # ── Detect service account ─────────────────────────────────────
  SERVICE_ACCOUNT=$(gcloud iam service-accounts list \
    --project="$GCP_PROJECT_ID" \
    --format="value(email)" \
    --limit=1 2>/dev/null || echo "")

  CREATE_ARGS=(
    --zone="$ZONE"
    --project="$GCP_PROJECT_ID"
    --machine-type="$MACHINE_TYPE"
    --scopes=cloud-platform
    --container-image="$IMAGE"
    --tags=http-server
    --address="$STATIC_IP"
    --metadata=google-logging-enabled=true,startup-script="$STARTUP_SCRIPT"
    --container-mount-host-path=host-path=/var/openclaw-brain,mount-path=/data/openclaw-brain
  )

  if [[ -n "$SERVICE_ACCOUNT" ]]; then
    CREATE_ARGS+=(--service-account="$SERVICE_ACCOUNT")
  fi

  gcloud compute instances create-with-container "$INSTANCE_NAME" "${CREATE_ARGS[@]}"

  # ── Firewall rule ────────────────────────────────────────────────
  gcloud compute firewall-rules create "allow-${INSTANCE_NAME}-8080" \
    --project="$GCP_PROJECT_ID" \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:8080 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=http-server \
    2>/dev/null || echo "   (firewall rule already exists)"

  echo "✅ VM created: $INSTANCE_NAME"
fi

# ── Get external IP ───────────────────────────────────────────────
EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE_NAME" \
  --zone="$ZONE" \
  --project="$GCP_PROJECT_ID" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Deployment complete!"
echo ""
echo "   Instance:    $INSTANCE_NAME ($ZONE)"
echo "   External IP: $EXTERNAL_IP"
echo ""
echo "Next steps:"
echo ""
echo "  1. Apply your config:"
echo "     bash setup.sh .env"
echo ""
echo "  2. Open Telegram and message your bot — it's running!"
echo "     (Uses polling mode, no webhook setup needed)"
echo ""
echo "  3. SSH into the VM:"
echo "     gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --tunnel-through-iap"
echo ""
echo "  4. View logs:"
echo "     gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --tunnel-through-iap -- \"docker logs \\\$(docker ps -q) --tail 50\""
echo ""
echo "  5. To delete:"
echo "     gcloud compute instances delete $INSTANCE_NAME --zone=$ZONE --delete-disks=all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
