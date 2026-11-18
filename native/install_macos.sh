#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == "" ]]; then
  echo 'Uso: bash native/install_macos.sh ID_ESTENSIONE' >&2
  exit 1
fi
id="$1"
if ! [[ "$id" =~ ^[a-p]{32}$ ]]; then echo 'ID estensione non valido' >&2; exit 1; fi
base="$(cd "$(dirname "$0")" && pwd)"
python_bin="$(command -v python3 || true)"
if [[ -z "$python_bin" ]]; then
  echo 'Python 3 non trovato. Installalo prima del motore locale.' >&2
  exit 1
fi
"$python_bin" - "$base/launch.sh" "$base/host.py" "$python_bin" <<'PY_LAUNCH'
from pathlib import Path
import shlex, sys
Path(sys.argv[1]).write_text('#!/bin/sh\nexec ' + shlex.quote(sys.argv[3]) + ' -u ' + shlex.quote(sys.argv[2]) + '\n', encoding='utf-8')
PY_LAUNCH
chmod +x "$base/launch.sh"
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.streamscout.personal.json"
"$python_bin" - "$manifest" "$base/launch.sh" "$id" <<'PY'
import json, sys
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    json.dump({'name':'com.streamscout.personal', 'description':'Brook - yt-dlp integration',
               'path':sys.argv[2], 'type':'stdio',
               'allowed_origins':[f'chrome-extension://{sys.argv[3]}/']}, f)
PY
echo "Host installato in $manifest"
echo 'Assicurati che yt-dlp e ffmpeg siano installati per Python 3.'
