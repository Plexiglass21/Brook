"""Brook v1 — Native Messaging host.

yt-dlp + FFmpeg download public, non-DRM media. No cookies, passwords,
network listeners or DRM circumvention. Native stdout contains ONLY framed JSON.
"""
import ipaddress
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
from urllib.parse import urlsplit, urljoin
from urllib.request import Request, urlopen
import base64
import tempfile
import shutil
import xml.etree.ElementTree as ET

HOST_VERSION = '1.1.0'
OUT_DIR = Path.home() / 'Downloads' / 'Brook'
MAX_MESSAGE = 1024 * 1024


def read_message():
    raw = sys.stdin.buffer.read(4)
    if not raw:
        return None
    if len(raw) != 4:
        raise ValueError('Invalid native-messaging header')
    size, = struct.unpack('=I', raw)
    if size < 1 or size > MAX_MESSAGE:
        raise ValueError('Invalid message size')
    body = sys.stdin.buffer.read(size)
    if len(body) != size:
        raise ValueError('Truncated native-messaging message')
    return json.loads(body.decode('utf-8'))


def send(obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def valid_url(raw):
    """Reject local, private, and malformed URL literals from web pages."""
    if not isinstance(raw, str) or len(raw) > 10000:
        return False
    try:
        parsed = urlsplit(raw)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            return False
        host = parsed.hostname.lower().rstrip('.')
        if host in ('localhost',) or host.endswith(('.localhost', '.local', '.internal')):
            return False
        if parsed.username or parsed.password:
            return False
        try:
            ip = ipaddress.ip_address(host)
            if not ip.is_global:
                return False
        except ValueError:
            pass
        return True
    except (ValueError, UnicodeError):
        return False


def base_cmd():
    return [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--no-warnings', '--socket-timeout', '15']


def safe_error(message):
    return (re.sub(r'https?://\S+', '[URL rimossa]', str(message)).strip()[:320] or 'Operazione non riuscita')


def safe_filename(name):
    if not isinstance(name, str):
        name = 'Video'
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip().strip('. ')
    name = re.sub(r'\.(mp4|mkv|webm|m3u8|mpd)$', '', name, flags=re.I).rstrip('. ')
    name = name[:105].rstrip('. ')
    if not name:
        name = 'Video'
    if re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])', name, flags=re.I):
        name = f'_{name}'
    return name


def unique_stem(directory, stem):
    """Avoid overwriting a file when a previous download used the same name."""
    try:
        names = {p.name.casefold() for p in directory.iterdir() if p.is_file()}
    except OSError:
        return stem
    for idx in range(1, 1001):
        candidate = stem if idx == 1 else f'{stem} ({idx})'
        prefix = f'{candidate}.'.casefold()
        if not any(name.startswith(prefix) for name in names):
            return candidate
    raise RuntimeError('Troppi file con lo stesso nome nella cartella.')


def choose_folder():
    """Open native Windows/macOS directory chooser only after user opt-in."""
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes('-topmost', True)
        root.update()
        result = filedialog.askdirectory(parent=root, title='Brook — Scegli dove salvare il video',
                                         initialdir=str(OUT_DIR.parent if OUT_DIR.parent.exists() else Path.home()),
                                         mustexist=True)
        return Path(result) if result else None
    finally:
        root.destroy()


def manifest_relations(url, referer=None):
    """Return ONLY explicit references from HLS master playlists and DASH manifests.
    Never infer an audio/video pair from hostnames, similar filenames, or page titles.
    """
    try:
        path = urlsplit(url).path.lower()
        if not (path.endswith('.m3u8') or path.endswith('.mpd')):
            return []
        headers = {'User-Agent': 'Mozilla/5.0 (Brook Personal/1.0)'}
        if referer and valid_url(referer):
            headers['Referer'] = referer
        with urlopen(Request(url, headers=headers), timeout=6) as response:
            if int(response.headers.get('Content-Length') or 0) > 400_000:
                return []
            body = response.read(400_001)
            if len(body) > 400_000:
                return []
            text = body.decode('utf-8-sig', errors='replace')
            base_url = response.geturl()
        found = set()
        if path.endswith('.m3u8'):
            if '#EXTM3U' not in text[:200]:
                return []
            lines = [line.strip() for line in text.splitlines()]
            is_master = any(line.startswith('#EXT-X-STREAM-INF:') or line.startswith('#EXT-X-MEDIA:') for line in lines)
            if not is_master:
                return []
            variant_next = False
            for line in lines:
                if line.startswith('#EXT-X-MEDIA:') or line.startswith('#EXT-X-I-FRAME-STREAM-INF:'):
                    match = re.search(r'URI="([^"]+)"', line)
                    if match:
                        related = urljoin(base_url, match.group(1))
                        if valid_url(related): found.add(related)
                if variant_next and line and not line.startswith('#'):
                    related = urljoin(base_url, line)
                    if valid_url(related): found.add(related)
                    variant_next = False
                if line.startswith('#EXT-X-STREAM-INF:'):
                    variant_next = True
        else:
            if len(text) > 400_000 or '<MPD' not in text[:1000]:
                return []
            root = ET.fromstring(text)
            # DASH BaseURL can refer to segment templates; only include URLs of
            # explicit standalone media resources, not guessed segment paths.
            for el in root.iter():
                if el.tag.rsplit('}', 1)[-1] != 'BaseURL' or not el.text:
                    continue
                raw = el.text.strip()
                if not raw or raw.endswith('/'):
                    continue
                related = urljoin(base_url, raw)
                if valid_url(related): found.add(related)
        return sorted(found)[:60]
    except (OSError, ValueError, ET.ParseError, UnicodeError, TimeoutError):
        return []


def inspect_source(message):
    """Analyze one media URL, its quality options and manifest-declared children."""
    url = message.get('url')
    referer = message.get('referer')
    if not valid_url(url):
        return {'status': 'unknown', 'message': 'Indirizzo non valido'}
    relations = manifest_relations(url, referer)
    cmd = base_cmd() + ['--dump-single-json', '--skip-download', '--no-color',
                        '--socket-timeout', '6']
    if referer and valid_url(referer) and referer != url:
        cmd += ['--add-headers', f'Referer:{referer}']
    cmd += ['--', url]
    try:
        response = subprocess.run(cmd, capture_output=True, text=True,
                                  encoding='utf-8', errors='replace', timeout=20,
                                  stdin=subprocess.DEVNULL,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (subprocess.TimeoutExpired, OSError):
        return {'status':'unknown','message':'Sorgente non verificabile', 'relatedUrls':relations}
    if response.returncode != 0:
        return {'status':'unknown','message':'Il sito non consente l’analisi', 'relatedUrls':relations}
    try:
        data = json.loads(response.stdout)
    except (TypeError, json.JSONDecodeError):
        return {'status':'unknown','message':'Metadati non disponibili', 'relatedUrls':relations}
    formats = data.get('formats') or ([data] if isinstance(data, dict) else [])
    video = [f for f in formats if f.get('vcodec') not in (None, '', 'none')]
    audio = [f for f in formats if f.get('acodec') not in (None, '', 'none')]
    heights = sorted({int(f['height']) for f in video if isinstance(f.get('height'), int) and 144 <= f['height'] <= 8640}, reverse=True)[:12]
    langs = []
    for f in audio:
        lang = str(f.get('language') or '').strip()
        if lang and lang.lower() not in ('none','und','unknown') and lang not in langs:
            langs.append(lang[:24])
    if not video and not audio:
        status = 'unknown'
    elif video and audio:
        status = 'video_audio'
    elif video:
        status = 'video_only'
    else:
        status = 'audio_only'
    return {
        'status':status, 'height': heights[0] if heights else None,
        'qualities': heights, 'languages': langs[:12],
        'title': str(data.get('title') or '')[:140],
        'duration': data.get('duration') if isinstance(data.get('duration'), (int,float)) else None,
        'relatedUrls':relations,
        'message': {'video_audio':'Video e audio disponibili',
                    'video_only':'Solo video: scegli o collega una traccia audio',
                    'audio_only':'Solo audio',
                    'unknown':'Tracce non identificabili'}[status]
    }


def locate_downloaded_file(directory, stem, reported_file=''):
    """Do not trust file paths printed by external processes outside our chosen directory."""
    if reported_file:
        try:
            path = Path(reported_file).resolve()
            if path.is_file() and path.parent == directory.resolve() and path.stem == stem:
                return path
        except (OSError, ValueError):
            pass
    allowed = {'.mp4','.mkv','.webm','.mov','.m4v','.ts','.flv','.avi','.ogv','.mp3','.m4a'}
    for suffix in allowed:
        path = directory / (stem + suffix)
        if path.is_file():
            return path
    return None


def convert_windows_mp4(src, ffmpeg=None, ffprobe=None):
    """Conservatively remux H.264/AAC; transcode only codecs unsupported by common Windows thumbnailers.

    Returns (output_path, warning). The original remains if ffmpeg or ffprobe fails.
    """
    known_ffmpeg, known_ffprobe = ffmpeg_tools()
    ffmpeg = ffmpeg or known_ffmpeg or 'ffmpeg'
    ffprobe = ffprobe or known_ffprobe or 'ffprobe'
    probe = subprocess.run([ffprobe,'-v','error','-show_entries',
                            'stream=codec_type,codec_name,pix_fmt','-of','json',str(src)],
                           capture_output=True,text=True,encoding='utf-8',errors='replace',
                           stdin=subprocess.DEVNULL,timeout=25,
                           creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if probe.returncode != 0:
        return src, 'Impossibile analizzare i codec; file originale mantenuto.'
    streams = json.loads(probe.stdout).get('streams') or []
    video = next((x for x in streams if x.get('codec_type')=='video'),None)
    audio = next((x for x in streams if x.get('codec_type')=='audio'),None)
    if not video:
        return src, 'Il file non contiene una traccia video: sorgente solo audio.'
    copy_video = video.get('codec_name')=='h264' and video.get('pix_fmt') in ('yuv420p','yuvj420p')
    copy_audio = audio is None or audio.get('codec_name')=='aac'
    dst = src.with_suffix('.mp4')
    tmp = src.with_name('.'+src.stem+'.brook-tmp.mp4')
    if tmp.exists():
        tmp.unlink()
    cmd = [ffmpeg,'-hide_banner','-nostdin','-loglevel','error','-y','-i',str(src),
           '-map','0:v:0','-map','0:a:0?',
           '-c:v','copy' if copy_video else 'libx264']
    if not copy_video:
        cmd += ['-pix_fmt','yuv420p','-preset','veryfast','-crf','22']
    cmd += ['-c:a','copy' if copy_audio else 'aac']
    if not copy_audio:
        cmd += ['-b:a','160k']
    cmd += ['-movflags','+faststart',str(tmp)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding='utf-8',errors='replace',stdin=subprocess.DEVNULL,
                                timeout=2*60*60,
                                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode or not tmp.is_file() or tmp.stat().st_size == 0:
            return src, 'Non è stato possibile creare un MP4 compatibile; originale mantenuto.'
        os.replace(tmp,dst)
        if src != dst:
            src.unlink(missing_ok=True)
        return dst,''
    except (OSError,ValueError,subprocess.TimeoutExpired) as exc:
        return src, 'Conversione MP4 non riuscita; file originale mantenuto.'
    finally:
        if tmp.exists():
            try: tmp.unlink()
            except OSError: pass


def handle_probe(message):
    url = message.get('url')
    if not valid_url(url):
        send({'ok': False, 'error': 'URL non valido o indirizzo locale non consentito.'})
        return
    cmd = base_cmd() + ['--dump-single-json', '--skip-download', '--no-color', '--', url]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=65, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        send({'ok': False, 'error': 'Analisi scaduta. Riprova dopo aver avviato il video.'})
        return
    except Exception as exc:
        send({'ok': False, 'error': safe_error(exc)})
        return
    if result.returncode != 0:
        send({'ok': False, 'error': safe_error(result.stderr.splitlines()[-1] if result.stderr else 'Sorgente non supportata')})
        return
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        send({'ok': False, 'error': 'Il motore non ha restituito informazioni leggibili.'})
        return
    formats = data.get('formats') or []
    if not formats and not data.get('url') and data.get('_type') == 'playlist':
        send({'ok': False, 'error': 'La pagina sembra essere una playlist, non un singolo video.'})
        return
    title = str(data.get('title') or 'Video da pagina')[:160]
    send({'ok': True, 'item': {
        'url': url, 'title': title, 'kind': 'page', 'source': 'yt-dlp',
        'pageUrl': url, 'formatCount': len(formats), 'height': data.get('height'),
    }})


def ffmpeg_tools():
    """Resolve both executables even when Chrome was launched with a stale Windows PATH.

    Winget may install Gyan FFmpeg in a versioned package directory; keep the
    lookup limited to established local installation locations.
    """
    ffmpeg = shutil.which('ffmpeg')
    ffprobe = shutil.which('ffprobe')
    if ffmpeg and ffprobe:
        return str(Path(ffmpeg).resolve()), str(Path(ffprobe).resolve())
    directories = []
    explicit = os.environ.get('BROOK_FFMPEG_DIR')
    if explicit:
        directories.append(Path(explicit))
    local_app = os.environ.get('LOCALAPPDATA')
    if local_app:
        root = Path(local_app)
        directories += [root / 'Microsoft' / 'WinGet' / 'Links', root / 'Programs' / 'ffmpeg' / 'bin']
        package_root = root / 'Microsoft' / 'WinGet' / 'Packages'
        if package_root.is_dir():
            for package in package_root.glob('Gyan.FFmpeg_*'):
                directories += list(package.glob('ffmpeg*/bin'))
    for directory in directories:
        video = directory / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
        probe = directory / ('ffprobe.exe' if os.name == 'nt' else 'ffprobe')
        if video.is_file() and probe.is_file():
            return str(video.resolve()), str(probe.resolve())
    return ffmpeg, ffprobe


def analyze_file(path, ffprobe):
    """Probe media on disk: never mark a download complete from exit status alone."""
    result = subprocess.run([ffprobe, '-v', 'error', '-show_entries',
                             'stream=codec_type', '-of', 'json', str(path)],
                            capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=35, stdin=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        return False, False
    streams = json.loads(result.stdout).get('streams') or []
    return (any(x.get('codec_type') == 'video' for x in streams),
            any(x.get('codec_type') == 'audio' for x in streams))


def handle_download(message):
    url = message.get('url')
    referer = message.get('referer')
    if not valid_url(url):
        send({'type':'done', 'ok':False, 'message':'Indirizzo video non valido.'})
        return
    if referer and not valid_url(referer):
        referer = None
    file_name = safe_filename(message.get('fileName') or message.get('title'))
    ask_where = message.get('askWhere') is not False
    windows_mp4 = message.get('windowsMp4') is not False
    format_choice = message.get('container') if message.get('container') in ('mp4','mkv') else 'mp4'
    if format_choice == 'mkv': windows_mp4 = False
    height = message.get('quality')
    height = height if type(height) is int and 144 <= height <= 8640 else None
    language = message.get('audioLanguage')
    language = language if isinstance(language,str) and re.fullmatch(r'[a-zA-Z0-9_-]{2,16}', language) else None
    audio_url = message.get('audioUrl')
    if audio_url and (not valid_url(audio_url) or audio_url == url):
        send({'type':'done','ok':False,'message':'Traccia audio non valida.'})
        return
    is_stream = urlsplit(url).path.lower().endswith(('.m3u8','.mpd')) or message.get('kind') in ('hls','dash')
    expect_audio = message.get('allowSilent') is not True and (is_stream or message.get('expectAudio') is True or bool(audio_url))

    ffmpeg, ffprobe = ffmpeg_tools()
    if not ffmpeg or not ffprobe:
        send({'type':'done','ok':False,'message':
              'FFmpeg e FFprobe non sono disponibili per Brook. Verifica «ffmpeg -version» e «ffprobe -version» in PowerShell; poi chiudi e riapri completamente Chrome.'})
        return
    if ask_where:
        try:
            selected = choose_folder()
        except Exception:
            send({'type':'done','ok':False,'message':
                  'Impossibile aprire la scelta della cartella. Disattiva «Chiedimi dove salvarlo» oppure verifica tkinter.'})
            return
        if selected is None:
            send({'type':'done','ok':False,'cancelled':True,'message':'Scelta della cartella annullata.'})
            return
        out_dir = selected
    else:
        out_dir = OUT_DIR
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        file_name = unique_stem(out_dir, file_name)
    except OSError as exc:
        send({'type':'done','ok':False,'message':safe_error(exc)})
        return
    send({'type':'progress','status':'starting','message':'Preparo il download…'})
    if height:
        video_selector = f'bv[height<={height}]'
        combined_selector = f'b[height<={height}]'
    else:
        video_selector = 'bv'
        combined_selector = 'b'
    audio_selector = f'ba[language={language}]/ba' if language else 'ba'
    fmt = f'{video_selector}+({audio_selector})/{combined_selector}'

    try:
        # All intermediate audio/video tracks live in this disposable directory.
        # No .f1800/.faudio-italian partial files are exposed as final outputs.
        with tempfile.TemporaryDirectory(prefix='.brook-work-', dir=out_dir) as tmp_path:
            work_dir = Path(tmp_path)
            if audio_url:
                cmd = [ffmpeg,'-hide_banner','-nostdin','-loglevel','error','-y']
                if referer: cmd += ['-headers',f'Referer: {referer}\r\n']
                cmd += ['-i',url]
                if referer: cmd += ['-headers',f'Referer: {referer}\r\n']
                cmd += ['-i',audio_url,'-map','0:v:0','-map','1:a:0',
                        '-c','copy',str(work_dir / (file_name + '.mkv'))]
                send({'type':'progress','status':'downloading','message':'Unisco la traccia video con l’audio…'})
            else:
                cmd = base_cmd() + [
                    '--newline','--progress','--no-color','--continue',
                    '--no-overwrites','--no-keep-video','--windows-filenames',
                    '--ffmpeg-location',str(Path(ffmpeg).parent),
                    '--format',fmt,
                    '--merge-output-format','mp4/mkv' if format_choice == 'mp4' else 'mkv',
                    '--paths',str(work_dir),
                    '--output',file_name.replace('%','%%')+'.%(ext)s'
                ]
                if referer and referer != url:
                    cmd += ['--add-headers',f'Referer:{referer}']
                cmd += ['--print','after_move:BROOK_SAVED_FILE=%(filepath)s','--',url]
            proc = subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL,text=True,encoding='utf-8',
                                    errors='replace',bufsize=1,
                                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            last = ''
            last_percent = -1
            reported_file = ''
            for line in proc.stdout:
                value = line.strip()
                if not value: continue
                last = value
                if value.startswith('BROOK_SAVED_FILE='):
                    reported_file = value.split('=',1)[1]
                match = re.search(r'\[download\]\s+([\d.]+)%',value)
                if match:
                    whole = min(100,max(0,int(float(match.group(1)))))
                    if whole != last_percent:
                        last_percent = whole
                        send({'type':'progress','status':'downloading','percent':whole,
                              'message':f'Download della traccia: {whole}%'})
                elif '[Merger]' in value or '[VideoRemuxer]' in value or '[Fixup' in value:
                    send({'type':'progress','status':'merging','message':'Unisco audio e video…'})
                elif 'Destination:' in value:
                    send({'type':'progress','status':'downloading','message':'Scarico le tracce…'})
            code = proc.wait()
            if code != 0:
                send({'type':'done','ok':False,'message':
                      'Download o unione non riuscita. '+safe_error(last)})
                return
            output_file = locate_downloaded_file(work_dir,file_name,reported_file)
            if not output_file or not output_file.is_file() or output_file.stat().st_size == 0:
                send({'type':'done','ok':False,'message':
                      'Il motore non ha prodotto un video finale. Verifica che FFmpeg funzioni e riprova.'})
                return
            send({'type':'progress','status':'merging','message':'Verifico il file completo…'})
            has_video,has_audio = analyze_file(output_file,ffprobe)
            if not has_video:
                send({'type':'done','ok':False,'message':'Il file scaricato non contiene un flusso video valido.'})
                return
            if expect_audio and not has_audio:
                send({'type':'done','ok':False,'message':
                      'Il video non contiene audio. Nessun file incompleto è stato salvato: prova una sorgente completa oppure abbina la traccia audio nelle opzioni di salvataggio.'})
                return
            warning = ''
            if windows_mp4:
                send({'type':'progress','status':'converting',
                      'message':'Ottimizzo il video per Windows…'})
                try:
                    output_file,warning = convert_windows_mp4(output_file,ffmpeg,ffprobe)
                except (OSError,ValueError,subprocess.TimeoutExpired,json.JSONDecodeError):
                    warning = 'Conversione MP4 non riuscita.'
                has_video,has_audio = analyze_file(output_file,ffprobe)
                if not has_video or (expect_audio and not has_audio):
                    send({'type':'done','ok':False,'message':'La conversione non ha prodotto un video completo.'})
                    return
            extension = output_file.suffix
            final = out_dir / (file_name + extension)
            if final.exists():
                # Avoid overwrites if another download completed during processing.
                file_name = unique_stem(out_dir,file_name)
                final = out_dir / (file_name + extension)
            os.replace(output_file,final)
            result_message = f'Salvato: {final}'
            if warning: result_message += f' — {warning}'
            send({'type':'done','ok':True,'message':result_message})
    except BrokenPipeError:
        pass
    except (OSError,ValueError,subprocess.TimeoutExpired,json.JSONDecodeError) as exc:
        send({'type':'done','ok':False,'message':'Il download non è stato completato: '+safe_error(exc)})


def handle_preview(message):
    """Return up to five seconds of low-bitrate MP4 for a user-initiated Play.

    Uses ffmpeg's local processing, never a web listener. Keep output smaller
    than Chrome's native-messaging host-to-extension 1 MiB limit.
    """
    url = message.get('url')
    referer = message.get('referer')
    audio_url = message.get('audioUrl')
    if not valid_url(url) or (audio_url and not valid_url(audio_url)):
        send({'ok':False, 'error':'Anteprima: indirizzo non valido.'})
        return
    if referer and not valid_url(referer):
        referer = None
    ffmpeg, ffprobe = ffmpeg_tools()
    if not ffmpeg or not ffprobe:
        send({'ok':False,'error':'FFmpeg non è disponibile per Brook. Chiudi e riapri Chrome dopo aver verificato ffmpeg -version.'})
        return
    try:
        with tempfile.TemporaryDirectory(prefix='brook-preview-') as folder:
            target = Path(folder) / 'preview.mp4'
            cmd = [ffmpeg,'-hide_banner','-nostdin','-loglevel','error','-y']
            if referer: cmd += ['-headers', f'Referer: {referer}\r\n']
            cmd += ['-i',url]
            if audio_url:
                if referer: cmd += ['-headers', f'Referer: {referer}\r\n']
                cmd += ['-i',audio_url]
            cmd += ['-t','5','-map','0:v:0', '-map','1:a:0?' if audio_url else '0:a:0?',
                    '-vf','scale=w=480:h=270:force_original_aspect_ratio=decrease,format=yuv420p',
                    '-r','12','-c:v','libx264','-preset','ultrafast','-crf','31',
                    '-maxrate','290k','-bufsize','600k',
                    '-c:a','aac','-b:a','48k','-ac','1','-ar','24000',
                    '-movflags','+faststart',str(target)]
            result = subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',errors='replace',
                                    timeout=45,stdin=subprocess.DEVNULL,
                                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode or not target.is_file() or target.stat().st_size < 200:
                send({'ok':False,'error':'Anteprima non disponibile per questa sorgente. Puoi comunque tentare il download.'})
                return
            if target.stat().st_size > 625_000:
                send({'ok':False,'error':'Anteprima troppo grande per la finestra di Chrome.'})
                return
            encoded = base64.b64encode(target.read_bytes()).decode('ascii')
            send({'ok':True,'mime':'video/mp4','data':encoded,'seconds':5})
    except (OSError,ValueError,subprocess.TimeoutExpired):
        send({'ok':False,'error':'Non riesco a creare una breve anteprima per questa sorgente.'})


def main():
    while True:
        msg = read_message()
        if msg is None:
            return
        action = msg.get('action') if isinstance(msg, dict) else None
        if action == 'ping':
            try:
                result = subprocess.run([sys.executable, '-m', 'yt_dlp', '--version'],
                                        capture_output=True, text=True, timeout=8)
                installed = result.returncode == 0
                version = result.stdout.strip() if installed else None
            except (OSError, subprocess.TimeoutExpired):
                installed, version = False, None
            ffmpeg_bin, ffprobe_bin = ffmpeg_tools()
            send({'ok': True, 'version': HOST_VERSION, 'ytDlpInstalled': installed, 'ytDlpVersion': version,
                  'ffmpegReady': bool(ffmpeg_bin and ffprobe_bin)})
        elif action == 'probe':
            handle_probe(msg)
        elif action == 'inspect':
            send(inspect_source(msg))
        elif action == 'preview':
            handle_preview(msg)
        elif action == 'download':
            handle_download(msg)
        else:
            send({'ok': False, 'error': 'Comando non riconosciuto.'})


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, OSError):
        pass
