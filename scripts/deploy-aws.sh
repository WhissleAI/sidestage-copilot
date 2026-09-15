#!/usr/bin/env bash
# Stand up (or update) the SideStage backend on one small EC2 box.
#
#   scripts/deploy-aws.sh up       create key pair, security group and instance, then deploy
#   scripts/deploy-aws.sh deploy   rsync this checkout + .env + data/ to the box and restart
#   scripts/deploy-aws.sh ip       print the instance's public IP
#
# Sizing: t3.small (2 vCPU, 2 GB) is the smallest box that runs Postgres, the
# app and a real Chrome for the eBay Live watcher together. Anything smaller
# OOMs the moment a show is attached. ~$15/mo + a 24 GB gp3 volume.
#
# The eBay Live session travels as data/ebay-session.json (Playwright storage
# state), never as the Chrome profile: macOS Chrome encrypts cookies with the
# Keychain and a Linux Chrome cannot read them.
#
# TLS: Caddy issues a Let's Encrypt certificate for <ip-with-dashes>.sslip.io,
# so there is an https origin — which eBay's redirect registration requires —
# without owning a domain. Set SITE_ADDRESS to a real hostname to use one.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${AWS_REGION:-us-east-1}
NAME=sidestage-backend
KEY=${SIDESTAGE_KEY:-sidestage}
PEM=${SIDESTAGE_PEM:-$HOME/.ssh/$KEY.pem}
TYPE=${SIDESTAGE_INSTANCE_TYPE:-t3.small}
TAG="Name=$NAME"

aws() { command aws --region "$REGION" "$@"; }

instance_id() {
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" \
    --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null | grep -v None || true
}
public_ip() {
  aws ec2 describe-instances --instance-ids "$1" --query "Reservations[0].Instances[0].PublicIpAddress" --output text
}

cmd_up() {
  if [ -n "$(instance_id)" ]; then echo "instance already exists: $(instance_id)"; cmd_deploy; return; fi
  if ! aws ec2 describe-key-pairs --key-names "$KEY" >/dev/null 2>&1; then
    aws ec2 create-key-pair --key-name "$KEY" --query KeyMaterial --output text > "$PEM"
    chmod 600 "$PEM"; echo "key pair $KEY → $PEM"
  fi
  VPC=$(aws ec2 describe-vpcs --query "Vpcs[?IsDefault].VpcId" --output text)
  SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" --query "SecurityGroups[0].GroupId" --output text 2>/dev/null | grep -v None || true)
  if [ -z "$SG" ]; then
    SG=$(aws ec2 create-security-group --group-name "$NAME" --description "SideStage backend: ssh, http, https" --vpc-id "$VPC" --query GroupId --output text)
    for p in 22 80 443; do aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port $p --cidr 0.0.0.0/0 >/dev/null; done
    echo "security group $SG"
  fi
  AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
  USERDATA=$(cat <<'UD'
#!/bin/bash
set -e
apt-get update -y && apt-get install -y ca-certificates curl gnupg rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker ubuntu
mkdir -p /opt/sidestage && chown ubuntu:ubuntu /opt/sidestage
UD
)
  IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY" --security-group-ids "$SG" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":24,"VolumeType":"gp3"}}]' \
    --user-data "$USERDATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=sidestage}]" \
    --query "Instances[0].InstanceId" --output text)
  echo "instance $IID — waiting for it to boot"
  aws ec2 wait instance-running --instance-ids "$IID"
  aws ec2 wait instance-status-ok --instance-ids "$IID"
  echo "public ip $(public_ip "$IID")"
  cmd_deploy
}

cmd_deploy() {
  IID=$(instance_id); [ -n "$IID" ] || { echo "no instance — run: $0 up"; exit 1; }
  IP=$(public_ip "$IID")
  SITE=${SITE_ADDRESS:-$(echo "$IP" | tr . -).sslip.io}
  SSH="ssh -i $PEM -o StrictHostKeyChecking=accept-new ubuntu@$IP"
  echo "deploying to $IP as https://$SITE"
  # wait for cloud-init to finish installing docker
  $SSH 'until command -v docker >/dev/null && groups | grep -q docker; do sleep 5; done; echo docker ready' 2>/dev/null || $SSH 'until command -v docker >/dev/null; do sleep 5; done'
  # The container writes as uid 1001; rsync writes as ubuntu. Hand the tree
  # to ubuntu for the sync and back to the container afterwards.
  $SSH "sudo chown -R ubuntu:ubuntu /opt/sidestage"
  rsync -az --delete -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
    --exclude node_modules --exclude .git --exclude .tmp --exclude 'data/shows' --exclude 'data/ebay-profile' \
    ./ "ubuntu@$IP:/opt/sidestage/"
  # The app runs as the image's pwuser (uid 1001); rsync leaves files owned by
  # ubuntu (1000). Hand the writable directories over before starting.
  $SSH "cd /opt/sidestage && sudo mkdir -p data/shows fixtures/catalogs && sudo chown -R 1001:1001 data fixtures/catalogs && printf 'SITE_ADDRESS=%s\nEBAY_DISCOVERY_PROXY=%s\n' '$SITE' '${EBAY_DISCOVERY_PROXY:-}' > .deploy.env && sudo docker compose --env-file .deploy.env up -d --build --remove-orphans && sudo docker compose ps"
  echo
  echo "backend:  https://$SITE/health"
  echo "callback: https://$SITE/api/ebay/callback   ← eBay 'auth accepted URL'"
}

case "${1:-}" in
  up) cmd_up ;;
  deploy) cmd_deploy ;;
  ip) IID=$(instance_id); [ -n "$IID" ] && public_ip "$IID" ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
