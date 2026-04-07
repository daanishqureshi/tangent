#!/usr/bin/env bash
# scripts/setup.sh
#
# Idempotent EC2 setup for Tangent.
# Safe to run multiple times — each step checks before acting.
#
# Usage:
#   curl -sSf https://... | bash
#   # or after cloning:
#   bash scripts/setup.sh

set -euo pipefail

TANGENT_DIR="/home/ubuntu/tangent"
WORKSPACE_DIR="/home/ubuntu/tangent-workspace"
NODE_MAJOR=24
PM2_LOG_DIR="${TANGENT_DIR}/logs"

log()  { echo "[setup] $*"; }
info() { log "INFO  $*"; }
ok()   { log "OK    $*"; }
err()  { log "ERROR $*" >&2; exit 1; }

# ─── 1. Node.js 24 ────────────────────────────────────────────────────────────

install_node() {
  if command -v node &>/dev/null && node --version | grep -q "^v${NODE_MAJOR}\."; then
    ok "Node.js $(node --version) already installed"
    return
  fi

  info "Installing Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
}

# ─── 2. PM2 ──────────────────────────────────────────────────────────────────

install_pm2() {
  if command -v pm2 &>/dev/null; then
    ok "pm2 $(pm2 --version) already installed"
    return
  fi

  info "Installing pm2..."
  sudo npm install -g pm2
  ok "pm2 installed"
}

# ─── 3. Docker ───────────────────────────────────────────────────────────────

install_docker() {
  if command -v docker &>/dev/null; then
    ok "Docker $(docker --version) already installed"
  else
    info "Installing Docker..."
    sudo apt-get update -y
    sudo apt-get install -y ca-certificates curl gnupg lsb-release

    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    sudo systemctl enable docker
    sudo systemctl start docker
    ok "Docker installed"
  fi

  # Add ubuntu to docker group (idempotent)
  if id -nG ubuntu | grep -qw docker; then
    ok "ubuntu already in docker group"
  else
    info "Adding ubuntu to docker group..."
    sudo usermod -aG docker ubuntu
    info "NOTE: log out and back in (or run 'newgrp docker') for docker group to take effect"
  fi
}

# ─── 4. pip-audit (for Python CVE scanning) ──────────────────────────────────

install_pip_audit() {
  if command -v pip-audit &>/dev/null; then
    ok "pip-audit already installed"
    return
  fi

  if command -v pip3 &>/dev/null; then
    info "Installing pip-audit..."
    pip3 install --user pip-audit
    ok "pip-audit installed"
  else
    info "pip3 not found — skipping pip-audit (Python CVE scanning will be skipped)"
  fi
}

# ─── 5. Workspace directory ───────────────────────────────────────────────────

setup_workspace() {
  if [[ -d "$WORKSPACE_DIR" ]]; then
    ok "Workspace dir already exists: ${WORKSPACE_DIR}"
  else
    info "Creating workspace dir: ${WORKSPACE_DIR}"
    mkdir -p "$WORKSPACE_DIR"
    chown ubuntu:ubuntu "$WORKSPACE_DIR"
    ok "Workspace dir created"
  fi
}

# ─── 6. Clone / pull Tangent repo ─────────────────────────────────────────────

setup_tangent_repo() {
  if [[ -d "${TANGENT_DIR}/.git" ]]; then
    info "Updating Tangent repo..."
    git -C "$TANGENT_DIR" pull --ff-only
    ok "Tangent repo updated"
  else
    info "Tangent directory ${TANGENT_DIR} exists but is not a git repo — skipping clone"
    info "  If you need to clone, run: git clone <url> ${TANGENT_DIR}"
  fi
}

# ─── 7. Build ────────────────────────────────────────────────────────────────

build_tangent() {
  info "Installing npm dependencies..."
  cd "$TANGENT_DIR"
  npm ci --omit=dev
  info "Building TypeScript..."
  npm run build
  ok "Build complete"
}

# ─── 8. PM2 start / restart ──────────────────────────────────────────────────

start_tangent() {
  mkdir -p "$PM2_LOG_DIR"

  if pm2 describe tangent &>/dev/null; then
    info "Restarting Tangent in pm2..."
    pm2 restart "${TANGENT_DIR}/pm2.config.cjs"
  else
    info "Starting Tangent in pm2..."
    pm2 start "${TANGENT_DIR}/pm2.config.cjs"
  fi

  pm2 save
  ok "Tangent running in pm2"
}

# ─── 9. pm2 startup (survive reboots) ────────────────────────────────────────

configure_pm2_startup() {
  info "Configuring pm2 to start on boot..."
  # pm2 startup outputs a command to run as root; we eval it directly.
  local startup_cmd
  startup_cmd=$(pm2 startup systemd -u ubuntu --hp /home/ubuntu | grep "sudo env")
  if [[ -n "$startup_cmd" ]]; then
    eval "$startup_cmd"
    ok "pm2 startup configured"
  else
    ok "pm2 startup already configured"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  info "=== Tangent EC2 Setup ==="
  info "Tangent dir: ${TANGENT_DIR}"
  info "Workspace:   ${WORKSPACE_DIR}"

  install_node
  install_pm2
  install_docker
  install_pip_audit
  setup_workspace
  setup_tangent_repo
  build_tangent
  start_tangent
  configure_pm2_startup

  info ""
  info "=== Setup complete ==="
  ok "Tangent is running. Check status with: pm2 status"
  ok "Tail logs with: pm2 logs tangent"
}

main "$@"
