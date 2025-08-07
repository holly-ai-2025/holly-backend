#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -euo pipefail

# Update local repository
echo "Syncing local repository..."
if ! git pull origin main; then
  echo "Failed to update local repository." >&2
  exit 1
fi

# Update Vast.ai instance
VAST_IP="<YOUR_VAST_IP>"
echo "Syncing Vast.ai repository at ${VAST_IP}..."
if ! ssh -p 50015 "root@${VAST_IP}" 'cd /root/holly-backend && git reset --hard && git pull origin main'; then
  echo "Failed to update Vast.ai repository." >&2
  exit 1
fi

# Launch development server
echo "Starting development environment..."
node launch-dev.js
