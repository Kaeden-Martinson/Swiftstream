#!/bin/sh
# Install or update SwiftSSH on Void Linux as a runit service, and optionally host the website with nginx.
#
#   sudo sh deploy/void/install.sh --user alice
#   sudo sh deploy/void/install.sh --user alice --authorize "swiftssh-ed25519 AAAA..."
#   sudo sh deploy/void/install.sh --user alice --site swiftssh.example.com --email you@example.com
#   sudo sh deploy/void/install.sh --uninstall
#
# Re-running it updates SwiftSSH to the copy in this repository and restarts the service.
set -eu

PORT=7022
RUN_USER="${SUDO_USER:-}"
AUTHORIZE=""
SITE_DOMAIN=""
SITE_EMAIL=""
WITH_PTY=1
UNINSTALL=0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
SV_DIR=/etc/sv/swiftssh
LOG_DIR=/var/log/swiftssh
WEB_ROOT=/var/www/swiftssh
ACME_ROOT=/var/www/acme

say()  { printf '\033[32m>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mx\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --user NAME        account that owns files and shells (default: the user running sudo)
  --port N           port for SwiftSSH (default 7022)
  --authorize KEY    allow this client key (from "swiftssh key" on your computer)
  --site DOMAIN      also serve the website for DOMAIN with nginx
  --email ADDRESS    with --site: get a Let's Encrypt certificate for that domain
  --no-pty           skip the compilers needed for a full terminal (basic shell only)
  --uninstall        stop and remove the service (keeps keys and files)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) RUN_USER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --authorize) AUTHORIZE="$2"; shift 2 ;;
    --site) SITE_DOMAIN="$2"; shift 2 ;;
    --email) SITE_EMAIL="$2"; shift 2 ;;
    --no-pty) WITH_PTY=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root, for example: sudo sh $0 --user yourname"
command -v xbps-install >/dev/null 2>&1 || die "this script is for Void Linux (xbps-install not found)"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -L /var/service/swiftssh ]; then
    sv down swiftssh 2>/dev/null || true
    rm /var/service/swiftssh
  fi
  rm -rf "$SV_DIR"
  say "SwiftSSH service removed. Keys and files in the user's ~/.swiftssh were kept."
  exit 0
fi

[ -n "$RUN_USER" ] || die "pass --user NAME (the account whose files and shell SwiftSSH should use)"
id "$RUN_USER" >/dev/null 2>&1 || die "no such user: $RUN_USER"
case "$PORT" in *[!0-9]*|'') die "--port must be a number" ;; esac
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
RUN_GROUP=$(id -gn "$RUN_USER")
[ -d "$RUN_HOME" ] || die "home folder for $RUN_USER not found: $RUN_HOME"

# ---- packages ---------------------------------------------------------------
say "Installing packages"
xbps-install -Sy >/dev/null
PKGS="nodejs"
# node-pty (full terminal: vim, htop, tab completion) compiles a small native module.
[ "$WITH_PTY" -eq 1 ] && PKGS="$PKGS base-devel python3"
# shellcheck disable=SC2086
xbps-install -y $PKGS

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required (found $(node -v))"

# ---- swiftssh ---------------------------------------------------------------
say "Installing SwiftSSH from $REPO_DIR"
TARBALL_DIR=$(mktemp -d)
trap 'rm -rf "$TARBALL_DIR"' EXIT
(cd "$REPO_DIR" && npm pack --silent --pack-destination "$TARBALL_DIR" >/dev/null)
TARBALL=$(ls "$TARBALL_DIR"/swiftssh-*.tgz)
if [ "$WITH_PTY" -eq 1 ]; then
  npm install -g --no-fund --no-audit "$TARBALL"
else
  npm install -g --no-fund --no-audit --omit=optional "$TARBALL"
fi
SWIFTSSH_BIN=$(command -v swiftssh) || die "swiftssh did not install onto PATH"
NODE_MODULES=$(npm root -g)
if [ "$WITH_PTY" -eq 1 ] && ! node -e "require('$NODE_MODULES/swiftssh/node_modules/node-pty')" 2>/dev/null; then
  warn "node-pty didn't build; terminals will work in basic mode (no vim/htop). Check the npm output above."
fi

# ---- user setup -------------------------------------------------------------
as_user() { chpst -u "$RUN_USER:$RUN_GROUP" env HOME="$RUN_HOME" "$@"; }
if [ -n "$AUTHORIZE" ]; then
  as_user "$SWIFTSSH_BIN" authorize "$AUTHORIZE"
fi

# ---- runit service ----------------------------------------------------------
say "Writing runit service $SV_DIR"
mkdir -p "$SV_DIR/log" "$LOG_DIR"
cat > "$SV_DIR/run" <<EOF
#!/bin/sh
# SwiftSSH for $RUN_USER. Managed by deploy/void/install.sh; re-run it to change settings.
exec 2>&1
exec chpst -u $RUN_USER:$RUN_GROUP env HOME=$RUN_HOME NO_COLOR=1 $SWIFTSSH_BIN serve --port $PORT --root $RUN_HOME
EOF
cat > "$SV_DIR/finish" <<'EOF'
#!/bin/sh
# Back off briefly if the server exits, so a crash loop doesn't spin the CPU.
sleep 2
EOF
cat > "$SV_DIR/log/run" <<EOF
#!/bin/sh
exec svlogd -tt $LOG_DIR
EOF
# Keep 10 log files of up to 1 MB each.
printf 's1000000\nn10\n' > "$LOG_DIR/config"
chmod 755 "$SV_DIR/run" "$SV_DIR/finish" "$SV_DIR/log/run"

if [ -L /var/service/swiftssh ]; then
  say "Restarting the service"
  sv restart swiftssh
else
  ln -s "$SV_DIR" /var/service/
  say "Service enabled (runit picks it up within a few seconds)"
fi

# Wait for the port, then show the fingerprint clients will pin.
i=0
until node -e "require('net').connect($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || die "SwiftSSH did not start. Check: tail $LOG_DIR/current"
  sleep 1
done
FINGERPRINT=$(node -e "const c=require('crypto');console.log(new c.X509Certificate(require('fs').readFileSync('$RUN_HOME/.swiftssh/server_cert.pem')).fingerprint256)")

# ---- website (optional) -----------------------------------------------------
if [ -n "$SITE_DOMAIN" ]; then
  case "$SITE_DOMAIN" in *[!A-Za-z0-9.-]*) die "--site must be a domain name" ;; esac
  say "Publishing the website for $SITE_DOMAIN"
  xbps-install -y nginx
  mkdir -p "$WEB_ROOT" "$ACME_ROOT" /etc/nginx/conf.d
  cp -R "$REPO_DIR/site/." "$WEB_ROOT/"
  # Owned by the SwiftSSH user, so "npm run publish-site" can update it over SwiftSSH without root.
  chown -R "$RUN_USER:$RUN_GROUP" "$WEB_ROOT"
  chmod -R a+rX "$WEB_ROOT" "$ACME_ROOT"

  if ! grep -q 'conf.d/\*.conf' /etc/nginx/nginx.conf; then
    # Load our server block: add the include as the first line inside the http { } block.
    cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.swiftssh-backup
    sed -i '0,/^[[:space:]]*http[[:space:]]*{/s//&\n    include \/etc\/nginx\/conf.d\/*.conf;/' /etc/nginx/nginx.conf
  fi

  CERT_DIR=/etc/letsencrypt/live/$SITE_DOMAIN
  if [ -n "$SITE_EMAIL" ] && [ ! -f "$CERT_DIR/fullchain.pem" ]; then
    # Serve plain HTTP first so Let's Encrypt can verify the domain.
    sed -e "s/__DOMAIN__/$SITE_DOMAIN/g" "$SCRIPT_DIR/nginx-http.conf" > /etc/nginx/conf.d/swiftssh-site.conf
    [ -L /var/service/nginx ] || ln -s /etc/sv/nginx /var/service/
    sleep 2
    nginx -t && sv reload nginx
    xbps-install -y certbot
    certbot certonly --webroot -w "$ACME_ROOT" -d "$SITE_DOMAIN" --email "$SITE_EMAIL" --agree-tos --non-interactive
  fi

  if [ -f "$CERT_DIR/fullchain.pem" ]; then
    sed -e "s/__DOMAIN__/$SITE_DOMAIN/g" "$SCRIPT_DIR/nginx-https.conf" > /etc/nginx/conf.d/swiftssh-site.conf
  else
    sed -e "s/__DOMAIN__/$SITE_DOMAIN/g" "$SCRIPT_DIR/nginx-http.conf" > /etc/nginx/conf.d/swiftssh-site.conf
    warn "No certificate yet, so the site is served over plain HTTP. Re-run with --email to enable HTTPS."
  fi
  [ -L /var/service/nginx ] || ln -s /etc/sv/nginx /var/service/
  sleep 2
  nginx -t && sv reload nginx
fi

# ---- done -------------------------------------------------------------------
ADDRESS=$(hostname -f 2>/dev/null || hostname)
cat <<EOF

SwiftSSH is running as $RUN_USER on port $PORT.
  Fingerprint: $FINGERPRINT
  Logs:        tail -f $LOG_DIR/current
  Control:     sv status|restart|down swiftssh

Make sure port $PORT/tcp is open in your firewall.

On your computer, add this server with:
  swiftssh add $(echo "$ADDRESS" | cut -d. -f1) $ADDRESS:$PORT
and check the fingerprint matches the one above.
EOF
[ -n "$AUTHORIZE" ] || cat <<EOF
Then allow your computer here:
  sudo -u $RUN_USER swiftssh authorize "<output of 'swiftssh key' on your computer>"
EOF
[ -z "$SITE_EMAIL" ] || [ -z "$SITE_DOMAIN" ] || cat <<EOF
Certificates renew with "certbot renew"; add it to cron, for example:
  echo '0 3 * * * root certbot renew --quiet --deploy-hook "sv reload nginx"' > /etc/cron.d/certbot
EOF
