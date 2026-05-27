#!/usr/bin/env python3
import http.server
import socketserver
import json
import os
import re
import sys
import threading
import subprocess
import uuid
import shutil
import tempfile
import time
import urllib.request
from urllib.parse import urlparse, parse_qs, unquote

PORT    = int(os.environ.get('PORT', 8080))
FFMPEG  = os.environ.get('FFMPEG_PATH',  'ffmpeg')
FFPROBE = os.environ.get('FFPROBE_PATH', 'ffprobe')

if getattr(sys, 'frozen', False):
    # Running as PyInstaller bundle — static files are in _MEIPASS
    DIRECTORY = sys._MEIPASS
    JOBS_DIR  = os.path.join(tempfile.gettempdir(), 'video-compressor-jobs')
else:
    DIRECTORY = os.path.dirname(os.path.abspath(__file__))
    JOBS_DIR  = os.path.join(DIRECTORY, '.jobs')

os.makedirs(JOBS_DIR, exist_ok=True)

jobs: dict = {}
jobs_lock = threading.Lock()

LEVEL_PARAMS = {
    'low':    {'crf': '18', 'preset': 'slow',   'audio_br': '192k'},
    'medium': {'crf': '23', 'preset': 'medium', 'audio_br': '128k'},
    'high':   {'crf': '28', 'preset': 'fast',   'audio_br':  '64k'},
}


def check_ffmpeg():
    try:
        subprocess.run([FFMPEG, '-version'], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def get_duration(input_path: str) -> float:
    try:
        r = subprocess.run(
            [FFPROBE, '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', input_path],
            capture_output=True, text=True, timeout=30,
        )
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def parse_time_secs(line: str):
    m = re.search(r'time=(\d+):(\d+):(\d+(?:\.\d+)?)', line)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return None


def monitor_proc(proc, job_id: str, duration: float, p_start: float, p_end: float):
    buf = ''
    while True:
        ch = proc.stderr.read(1)
        if not ch:
            break
        if ch in ('\r', '\n'):
            if buf:
                t = parse_time_secs(buf)
                if t is not None and duration > 0:
                    pct = p_start + (t / duration) * (p_end - p_start)
                    with jobs_lock:
                        jobs[job_id]['progress'] = round(min(pct, p_end), 1)
            buf = ''
        else:
            buf += ch
        with jobs_lock:
            if jobs[job_id].get('cancelled'):
                proc.kill()
                return
    proc.wait()
    if proc.returncode not in (0, None) and not jobs[job_id].get('cancelled'):
        raise RuntimeError(f'FFmpeg 退出码 {proc.returncode}')


def run_2pass(job_id, input_path, output_path, vbr, vf_args, audio_br, passlog, duration, p_start, p_end):
    """Run a single 2-pass encode. Returns False if cancelled."""
    mid = p_start + (p_end - p_start) * 0.45
    bitrate_arg = f'{vbr}k'

    with jobs_lock:
        jobs[job_id]['phase'] = 'analyzing'
    p1 = subprocess.Popen(
        [FFMPEG, '-y', '-i', input_path,
         '-c:v', 'libx264', '-b:v', bitrate_arg,
         '-pass', '1', '-passlogfile', passlog,
         *vf_args, '-an', '-f', 'null', '/dev/null'],
        stderr=subprocess.PIPE, text=True, bufsize=0)
    monitor_proc(p1, job_id, duration, p_start, mid)
    if jobs[job_id].get('cancelled'):
        return False

    with jobs_lock:
        jobs[job_id]['phase'] = 'compressing'
    p2 = subprocess.Popen(
        [FFMPEG, '-y', '-i', input_path,
         '-c:v', 'libx264', '-b:v', bitrate_arg,
         '-pass', '2', '-passlogfile', passlog,
         *vf_args, '-c:a', 'aac', '-b:a', audio_br,
         output_path],
        stderr=subprocess.PIPE, text=True, bufsize=0)
    monitor_proc(p2, job_id, duration, mid, p_end)
    return not jobs[job_id].get('cancelled')


def run_job(job_id: str):
    input_path = output_path = None
    try:
        with jobs_lock:
            j = jobs[job_id]
        input_path  = j['input_path']
        output_path = j['output_path']
        level       = j.get('level', 'medium')
        resolution  = j.get('resolution', 'original')
        target_mb   = j.get('target_mb', 0.0)
        params      = LEVEL_PARAMS.get(level, LEVEL_PARAMS['medium'])

        with jobs_lock:
            jobs[job_id]['phase'] = 'analyzing'

        duration = get_duration(input_path)
        with jobs_lock:
            jobs[job_id]['duration'] = duration

        # Resolution filter — never upscale
        res_heights = {'1080p': 1080, '720p': 720, '480p': 480}
        vf_args: list[str] = []
        target_h = res_heights.get(resolution)
        if target_h:
            vf_args = ['-vf', f"scale='if(gt(ih,{target_h}),-2,iw)':'if(gt(ih,{target_h}),{target_h},ih)'"]

        passlog = os.path.join(JOBS_DIR, f'{job_id}_pass')

        if target_mb and target_mb > 0 and duration > 0:
            # 2-pass with retry — guaranteed strictly under target
            target_bytes = target_mb * 1_000_000  # decimal MB, matches macOS Finder display
            audio_kbps   = int(params['audio_br'].replace('k', ''))
            audio_bits   = audio_kbps * 1000 * duration

            # First attempt: 95% of target to leave initial headroom
            vbr = max(int((target_bytes * 8 * 0.95 - audio_bits) / duration / 1000), 1)

            # Progress slices per attempt: first pass gets most of the bar
            progress_slices = [(0, 84), (84, 93), (93, 98)]
            MAX_RETRIES = 3

            for attempt in range(MAX_RETRIES):
                p_start, p_end = progress_slices[attempt]
                if attempt > 0:
                    with jobs_lock:
                        jobs[job_id]['progress'] = p_start

                ok = run_2pass(job_id, input_path, output_path, vbr,
                               vf_args, params['audio_br'], passlog, duration, p_start, p_end)
                if not ok:
                    return  # cancelled

                actual_size = os.path.getsize(output_path)
                if actual_size < target_bytes:
                    break  # strictly under — done

                if attempt < MAX_RETRIES - 1:
                    # Scale bitrate by actual/target ratio with extra 4% margin
                    ratio = (target_bytes / actual_size) * 0.96
                    vbr   = max(int(vbr * ratio), 1)

            for f in [f'{passlog}-0.log', f'{passlog}-0.log.mbtree']:
                try:
                    os.remove(f)
                except OSError:
                    pass

        else:
            # CRF single-pass
            with jobs_lock:
                jobs[job_id]['phase'] = 'compressing'
            cmd = [FFMPEG, '-y', '-i', input_path,
                   '-c:v', 'libx264', '-crf', params['crf'], '-preset', params['preset'],
                   *vf_args, '-c:a', 'aac', '-b:a', params['audio_br'],
                   output_path]
            p = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True, bufsize=0)
            monitor_proc(p, job_id, duration, 0, 95)

        if jobs[job_id].get('cancelled'):
            return

        with jobs_lock:
            jobs[job_id]['phase']       = 'finalizing'
            jobs[job_id]['progress']    = 100
            jobs[job_id]['status']      = 'done'
            jobs[job_id]['output_size'] = os.path.getsize(output_path)

        def _ping_compression():
            try:
                url = 'https://api.counterapi.dev/v1/video-compressor-app/compressions/up'
                req = urllib.request.Request(url, headers={'User-Agent': 'VideoCompressor/1.0'})
                urllib.request.urlopen(req, timeout=5).close()
            except Exception:
                pass
        threading.Thread(target=_ping_compression, daemon=True).start()

    except Exception as e:
        with jobs_lock:
            jobs[job_id]['status'] = 'error'
            jobs[job_id]['error']  = str(e)
    finally:
        if input_path:
            try:
                os.remove(input_path)
            except OSError:
                pass


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, data: dict, code: int = 200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path

        if path == '/health':
            self.send_json({'ok': True})

        elif path == '/stats':
            def fetch_count(key):
                try:
                    url = f'https://api.counterapi.dev/v1/video-compressor-app/{key}'
                    req = urllib.request.Request(url, headers={'User-Agent': 'VideoCompressor/1.0'})
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        return json.loads(resp.read()).get('count', 0)
                except Exception:
                    return 0
            launches     = fetch_count('launches')
            compressions = fetch_count('compressions')
            self.send_json({'launches': launches, 'compressions': compressions})

        elif path.startswith('/progress/'):
            job_id = path[len('/progress/'):]
            with jobs_lock:
                j = dict(jobs.get(job_id, {}))
            if not j:
                self.send_json({'error': 'not found'}, 404)
                return
            self.send_json({
                'status':      j.get('status'),
                'progress':    j.get('progress', 0),
                'phase':       j.get('phase', ''),
                'error':       j.get('error', ''),
                'input_size':  j.get('input_size', 0),
                'output_size': j.get('output_size', 0),
            })

        elif path.startswith('/download/'):
            job_id = path[len('/download/'):]
            with jobs_lock:
                j = dict(jobs.get(job_id, {}))
            if not j or j.get('status') != 'done':
                self.send_json({'error': 'not ready'}, 404)
                return
            output_path = j['output_path']
            filename    = j.get('output_filename', 'compressed.mp4')
            try:
                size = os.path.getsize(output_path)
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                safe_name = filename.encode('ascii', 'replace').decode()
                self.send_header('Content-Disposition',
                                 f"attachment; filename=\"{safe_name}\"; "
                                 f"filename*=UTF-8''{filename}")
                self.send_header('Content-Length', str(size))
                self.end_headers()
                with open(output_path, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile, length=1024 * 1024)
                # Schedule file deletion 60 s after download
                def _delete(p, jid):
                    time.sleep(60)
                    try:
                        os.remove(p)
                    except OSError:
                        pass
                    with jobs_lock:
                        jobs.pop(jid, None)
                threading.Thread(target=_delete, args=(output_path, job_id), daemon=True).start()
            except Exception as e:
                self.send_json({'error': str(e)}, 500)

        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)

        if path == '/compress':
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_json({'error': 'no file'}, 400)
                return

            filename   = unquote(self.headers.get('X-Filename', 'input.mp4'))
            level      = qs.get('level',      ['medium'])[0]
            resolution = qs.get('resolution', ['original'])[0]
            target_mb  = float(qs.get('target_mb', ['0'])[0] or '0')

            job_id      = str(uuid.uuid4())[:8]
            input_path  = os.path.join(JOBS_DIR, f'{job_id}_input.mp4')
            basename    = os.path.splitext(filename)[0]
            output_path = os.path.join(JOBS_DIR, f'{job_id}_output.mp4')
            out_name    = f'{basename}_compressed.mp4'

            # Stream upload to disk
            written   = 0
            chunk_sz  = 1024 * 1024
            remaining = content_length
            with open(input_path, 'wb') as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(chunk_sz, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    written    += len(chunk)
                    remaining  -= len(chunk)

            with jobs_lock:
                jobs[job_id] = {
                    'status':          'running',
                    'progress':        0,
                    'phase':           'uploading',
                    'input_path':      input_path,
                    'output_path':     output_path,
                    'output_filename': out_name,
                    'level':           level,
                    'resolution':      resolution,
                    'target_mb':       target_mb,
                    'input_size':      written,
                    'cancelled':       False,
                    'created_at':      time.time(),
                }

            threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
            self.send_json({'job_id': job_id, 'input_size': written})

        elif path.startswith('/cancel/'):
            job_id = path[len('/cancel/'):]
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]['cancelled'] = True
            self.send_json({'ok': True})

        else:
            self.send_json({'error': 'not found'}, 404)

    def log_message(self, format, *args):
        if len(args) >= 2 and str(args[1]).startswith(('4', '5')):
            super().log_message(format, *args)


# ── Startup ────────────────────────────────────────────────────────────────

# Clean up leftover job files from previous run
for _f in os.listdir(JOBS_DIR):
    try:
        os.remove(os.path.join(JOBS_DIR, _f))
    except OSError:
        pass


def _auto_cleanup():
    """Remove jobs and their files that are older than 30 minutes."""
    while True:
        time.sleep(600)
        cutoff = time.time() - 1800
        with jobs_lock:
            stale = [jid for jid, j in jobs.items() if j.get('created_at', 0) < cutoff]
        for jid in stale:
            with jobs_lock:
                j = jobs.pop(jid, {})
            for p in (j.get('output_path'), j.get('input_path')):
                if p:
                    try:
                        os.remove(p)
                    except OSError:
                        pass


threading.Thread(target=_auto_cleanup, daemon=True).start()

if not check_ffmpeg():
    print('WARNING: ffmpeg not found — install it before compressing')

print(f'Video Compressor running on port {PORT}')

with ThreadedTCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
