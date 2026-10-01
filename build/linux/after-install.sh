#!/bin/sh
set -e
# Chromium's sandbox helper (SUID) for kernels without unprivileged user namespaces.
if [ -f /opt/Tranzl/chrome-sandbox ]; then chown root:root /opt/Tranzl/chrome-sandbox && chmod 4755 /opt/Tranzl/chrome-sandbox; fi
# AppArmor profile so the renderer sandbox works on Ubuntu 24.04+.
if [ -d /etc/apparmor.d ] && [ -f /opt/Tranzl/resources/apparmor-tranzl ]; then
  install -m 0644 /opt/Tranzl/resources/apparmor-tranzl /etc/apparmor.d/tranzl
  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then apparmor_parser -r /etc/apparmor.d/tranzl || true; fi
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
