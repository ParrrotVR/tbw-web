#!/usr/bin/env bash
# Harbor relay: one-step setup on a fresh Ubuntu server (DigitalOcean, Oracle, any VPS).
#
#   curl -fsSL https://raw.githubusercontent.com/ParrrotVR/tbw-web/portal/relay/host/setup-server.sh | sudo bash
#
# Optional settings (put them before "bash", e.g. "... | sudo HARBOR_DOMAIN=relay.example.com bash"):
#   HARBOR_DOMAIN=name   use your own domain (point its DNS A record at this server first).
#                        Without it the server gets a free <ip>.sslip.io name.
#   HARBOR_PUBLIC=1      let anyone browse without a key (with per-device limits).
#
# Run it again any time to update the relay; the address and key stay the same.
set -euo pipefail

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "Run this as root (add sudo before bash)."
command -v apt-get >/dev/null || fail "This script needs Ubuntu or Debian."

REPO_TARBALL="https://codeload.github.com/ParrrotVR/tbw-web/tar.gz/refs/heads/portal"
HARBOR_LINK="https://cdn.jsdelivr.net/gh/ParrrotVR/tbw-web@launch/index.svg"
APP=/opt/harbor-relay
CONF=/etc/harbor-relay
PORT=8787
export DEBIAN_FRONTEND=noninteractive

say "Installing system packages"
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https qrencode ufw openssl >/dev/null

# A little swap keeps the smallest servers from running out of memory while installing.
if ! swapon --show | grep -q . && [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Installing Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
node --version

say "Installing Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y >/dev/null
  apt-get install -y caddy >/dev/null
fi
caddy version

say "Downloading the Harbor relay"
id harbor >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin harbor
TMP=$(mktemp -d)
curl -fsSL "$REPO_TARBALL" | tar -xz -C "$TMP" --wildcards '*/relay/*'
SRC=$(find "$TMP" -maxdepth 2 -type d -name relay | head -n1)
[ -n "$SRC" ] || fail "Could not find the relay in the download."
mkdir -p "$APP"
cp -a "$SRC"/. "$APP"/
rm -rf "$TMP"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund >/dev/null
chown -R harbor:harbor "$APP"

say "Choosing this server's address"
IP=$(curl -fs --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || true)
[ -n "$IP" ] || IP=$(curl -4 -fs --max-time 10 https://api.ipify.org || true)
[ -n "$IP" ] || fail "Could not find this server's public IPv4 address."
mkdir -p "$CONF"; chmod 700 "$CONF"
if [ -n "${HARBOR_DOMAIN:-}" ]; then HOSTNAME_="$HARBOR_DOMAIN"
elif [ -f "$CONF/hostname" ]; then HOSTNAME_=$(cat "$CONF/hostname")
else HOSTNAME_="${IP//./-}.sslip.io"; fi
echo "$HOSTNAME_" > "$CONF/hostname"
ADDRESS="https://$HOSTNAME_"
echo "Address: $ADDRESS"

# The access key is made once and kept; re-running the script never changes it.
[ -f "$CONF/key" ] || openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' > "$CONF/key"
KEY=$(cat "$CONF/key")
PUBLIC_VALUE=${HARBOR_PUBLIC:-$( [ -f "$CONF/public" ] && cat "$CONF/public" || echo 0 )}
echo "$PUBLIC_VALUE" > "$CONF/public"
cat > "$CONF/env" <<EOF
HOST=127.0.0.1
PORT=$PORT
FIXTURE_PORT=$((PORT + 1))
NODE_ENV=production
HARBOR_ACCESS_KEY=$KEY
HARBOR_CLIENT_ORIGINS=https://cdn.jsdelivr.net
HARBOR_PUBLIC_ORIGIN=$ADDRESS
HARBOR_TRUST_PROXY=1
HARBOR_PUBLIC=$PUBLIC_VALUE
EOF
chmod 600 "$CONF/env"

say "Starting the relay service"
cat > /etc/systemd/system/harbor-relay.service <<EOF
[Unit]
Description=Harbor relay
After=network-online.target
Wants=network-online.target

[Service]
User=harbor
WorkingDirectory=$APP
EnvironmentFile=$CONF/env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable harbor-relay >/dev/null 2>&1
systemctl restart harbor-relay
for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null || { journalctl -u harbor-relay -n 30 --no-pager; fail "The relay did not start (log above)."; }

say "Setting up HTTPS for $HOSTNAME_"
cat > /etc/caddy/Caddyfile <<EOF
$HOSTNAME_ {
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

say "Opening the firewall (SSH, HTTP, HTTPS only)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Checking it from the internet (the certificate can take a minute the first time)"
OK=0
for i in $(seq 1 24); do
  if curl -fs --max-time 10 "$ADDRESS/api/health" >/dev/null; then OK=1; break; fi
  sleep 5
done

PAYLOAD=$(printf '{"a":"%s","k":"%s"}' "$ADDRESS" "$KEY" | base64 -w0 | tr '+/' '-_' | tr -d '=')
SETUP="$HARBOR_LINK#harbor-server=$PAYLOAD"
printf '\n\033[1;32m================ Harbor relay is running ================\033[0m\n'
echo "Address: $ADDRESS"
echo "Key:     $KEY"
[ "$PUBLIC_VALUE" = "1" ] && echo "Public mode: ON (anyone can browse, with per-device limits)" || echo "Public mode: off (the key is required)"
[ "$OK" = 1 ] && echo "Reachable over HTTPS: yes" || echo "Reachable over HTTPS: not yet. Wait a minute and open $ADDRESS/api/health in a browser."
echo
echo "On the iPad, scan this code with the Camera and tap the link:"
qrencode -t ansiutf8 "$SETUP" || true
echo
echo "Or open this setup link on the iPad (keep it private, it contains the key):"
echo "$SETUP"
echo
echo "Logs: journalctl -u harbor-relay -f      Update: run this script again."
