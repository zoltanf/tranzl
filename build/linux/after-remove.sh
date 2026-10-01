#!/bin/sh
set -e
if [ -f /etc/apparmor.d/tranzl ]; then
  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then apparmor_parser -R /etc/apparmor.d/tranzl || true; fi
  rm -f /etc/apparmor.d/tranzl
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
