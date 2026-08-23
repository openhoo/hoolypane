#!/usr/bin/env bash
# Run Hoolypane E2E suites inside the hoolypane-linux KVM instead of on this
# workstation. Syncs the working tree via rsync (no git required in the VM),
# reconciles dependencies, builds, and executes the requested vitest suites
# under Xvfb.
#
# Usage: scripts/e2e-vm.sh [suite...]     e.g. scripts/e2e-vm.sh desktop runner
# Env:   VM_SSH (default "hoolypane@127.0.0.1"), VM_PORT (52223), VM_KEY (~/.ssh/id_ed25519),
#        VM_DIR (home-relative dir inside the VM, resolved as ~/$VM_DIR; default
#        "Projects/hoolypane"), VM_SCREEN (1920x1080x24) for the Xvfb screen size.
set -euo pipefail

VM_SSH="${VM_SSH:-hoolypane@127.0.0.1}"
VM_PORT="${VM_PORT:-52223}"
VM_KEY="${VM_KEY:-$HOME/.ssh/id_ed25519}"
VM_DIR="${VM_DIR:-Projects/hoolypane}"
VM_SCREEN="${VM_SCREEN:-1920x1080x24}"

# VM_DIR must be home-relative: every remote path is formed as "~/$VM_DIR".
# Tolerate one stray leading "/" (absolute-style habit), reject "~..." forms.
VM_DIR="${VM_DIR#/}"
if [[ -z "$VM_DIR" || "$VM_DIR" == \~* ]]; then
  echo "VM_DIR must be home-relative (e.g. Projects/hoolypane), got: '${VM_DIR:-}'" >&2
  exit 1
fi

SSH=(ssh -p "$VM_PORT" -i "$VM_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$VM_SSH")

cd "$(dirname "$0")/.."
SUITES=("$@")
if [[ ${#SUITES[@]} -eq 0 ]]; then SUITES=(desktop runner); fi
for suite in "${SUITES[@]}"; do
  case "$suite" in
    desktop|runner|unit|bench) ;;
    *) echo "unknown suite: $suite"; exit 1 ;;
  esac
done

echo "== sync working tree → VM"
RSYNC_SSH="ssh -p $VM_PORT -i $VM_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude .git --exclude node_modules --exclude dist --exclude build \
  --exclude ".tmp" --exclude "*.log" --exclude ".ui-shots" \
  ./ "$VM_SSH:$VM_DIR/"

echo "== install + build in VM"
"${SSH[@]}" "set -e; cd ~/$VM_DIR;
  pnpm install --prefer-offline --frozen-lockfile >/dev/null;
  # rsync-preserved mtimes can make tsc -b treat stale workspace dists as fresh — wipe dists
  # AND incremental state, then let typecheck re-emit every workspace package.
  rm -rf apps/desktop/dist packages/*/dist;
  find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete;
  pnpm typecheck >/dev/null || { echo 'typecheck FAILED'; exit 1; }; echo 'typecheck OK';
  pnpm --filter @hoolypane/desktop build >/dev/null || { echo 'desktop build FAILED'; exit 1; }; echo 'desktop build OK';
  pnpm build:runner >/dev/null || { echo 'runner build FAILED'; exit 1; }; echo 'runner build OK'"


for suite in "${SUITES[@]}"; do
  echo "== run $suite suite in VM"
  case "$suite" in
    desktop) CMD="pnpm test:desktop" ;;
    runner)  CMD="pnpm test:runner" ;;
    unit)    CMD="pnpm test:unit" ;;
    bench)   CMD="pnpm benchmark:desktop" ;;
    *) echo "unknown suite: $suite"; exit 1 ;;
  esac
  "${SSH[@]}" "cd ~/$VM_DIR && xvfb-run -a -s '-screen 0 ${VM_SCREEN}' $CMD"
done
