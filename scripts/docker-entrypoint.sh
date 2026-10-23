#!/bin/sh
set -eu
mkdir -p "$HOME"
# initdb resolves the current UID through libc, even when -U is provided.
# Compose can select a UID which has no entry in the image's /etc/passwd.
if ! getent passwd "$(id -u)" >/dev/null; then
  nu_identity_dir=$(mktemp -d)
  cat /etc/passwd > "$nu_identity_dir/passwd"
  cat /etc/group > "$nu_identity_dir/group"
  printf 'nu-host:x:%s:%s:Nu:%s:/bin/sh\n' "$(id -u)" "$(id -g)" "$HOME" >> "$nu_identity_dir/passwd"
  if ! getent group "$(id -g)" >/dev/null; then
    printf 'nu-host:x:%s:\n' "$(id -g)" >> "$nu_identity_dir/group"
  fi
  export NSS_WRAPPER_PASSWD="$nu_identity_dir/passwd"
  export NSS_WRAPPER_GROUP="$nu_identity_dir/group"
  export LD_PRELOAD=/usr/local/lib/libnss_wrapper.so
fi
exec "$@"
