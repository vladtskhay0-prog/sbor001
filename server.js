'use strict';

const express = require('express');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'ffdata');
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
fs.mkdirSync(CLIPS_DIR, { recursive: true });

// Публичный базовый URL, по которому отдаются готовые клипы.
// На Railway задайте переменную окружения PUBLIC_BASE_URL,
// например: https://sbor001-production.up.railway.app
function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Статика: отдаём сгенерированные клипы/превью
app.use('/files', express.static(CLIPS_DIR, { maxAge: '1h' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- helpers ----------

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const doGet = (u, redirects) => {
      if (redirects > 6) return reject(new Error('too many redirects'));
      const lib = u.startsWith('http://') ? http : https;
      const req = lib.get(u, { headers: { 'User-Agent': 'ffmpeg-scene-service' } }, (res) => {
        // следуем за редиректами (Google Drive и т.п.)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return doGet(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('download failed, HTTP ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
      });
      req.on('error', (e) => {
        fs.unlink(destPath, () => reject(e));
      });
    };
    doGet(url, 0);
  });
}

function runFFprobe(input) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate,duration',
    '-of', 'json',
    input,
  ];
  const r = spawnSync('ffprobe', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + (r.stderr || r.error));
  const j = JSON.parse(r.stdout || '{}');
  const stream = (j.streams && j.streams[0]) || {};
  const format = j.format || {};
  let fps = 0;
  if (stream.r_frame_rate && stream.r_frame_rate.includes('/')) {
    const [a, b] = stream.r_frame_rate.split('/').map(Number);
    if (b) fps = a / b;
  }
  const duration = Number(format.duration || stream.duration || 0);
  return {
    duration: Number(duration.toFixed(3)),
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    fps: Number(fps.toFixed(3)),
  };
}

// Детекция границ сцен через ffmpeg scene-фильтр.
// Возвращает отсортированный массив таймкодов (сек) точек смены сцены.
function detectSceneCuts(input, threshold) {
  const thr = (threshold === undefined || threshold === null) ? 0.30 : Number(threshold);
  const args = [
    '-hide_banner',
    '-i', input,
    '-filter_complex', `select='gt(scene,${thr})',metadata=print`,
    '-an', '-f', 'null', '-',
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  const out = (r.stderr || '') + (r.stdout || '');
  const cuts = [];
  const re = /pts_time:([0-9]+(\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    cuts.push(Number(m[1]));
  }
  return cuts.sort((a, b) => a - b);
}

// Строим сегменты 3–7 сек (min..max) на основе точек смены сцены.
// Если сцен не нашлось — режем всё видео равномерно на куски длиной ~ (min+max)/2.
function buildSegments(duration, cuts, minLen, maxLen) {
  const min = Math.max(1, Number(minLen) || 3);
  const max = Math.max(min, Number(maxLen) || 7);
  const target = (min + max) / 2;

  // Кандидатные границы: 0, точки сцен, конец
  const bounds = [0, ...cuts.filter((t) => t > 0 && t < duration), duration]
    .sort((a, b) => a - b);

  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = bounds[i];
    const end = bounds[i + 1];
    let len = end - start;
    if (len < min) continue; // слишком короткая сцена — пропускаем

    // Длинную сцену дробим на куски по target, каждый в пределах [min, max]
    let cursor = start;
    while (end - cursor >= min) {
      let segLen = Math.min(max, end - cursor);
      // не оставляем "хвост" короче min
      if ((end - cursor) - segLen > 0 && (end - cursor) - segLen < min) {
        segLen = end - cursor; // включаем хвост в текущий кусок
        if (segLen > max) segLen = target; // но не превышаем разумно
      }
      const s = Number(cursor.toFixed(3));
      const e = Number(Math.min(cursor + segLen, end).toFixed(3));
      if (e - s >= min) segs.push({ start_time: s, end_time: e, duration: Number((e - s).toFixed(3)) });
      cursor += segLen;
    }
  }

  // Фолбэк: если сцены не дали сегментов — равномерная нарезка всего видео
  if (segs.length === 0 && duration >= min) {
    let cursor = 0;
    while (duration - cursor >= min) {
      const segLen = Math.min(target, duration - cursor);
      const s = Number(cursor.toFixed(3));
      const e = Number((cursor + segLen).toFixed(3));
      segs.push({ start_time: s, end_time: e, duration: Number((e - s).toFixed(3)) });
      cursor += segLen;
    }
  }
  return segs;
}

// Вырезаем один фрагмент из исходника в mp4 (h264/aac), быстрый и точный рез
function cutClip(input, start, dur, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', String(start),
      '-i', input,
      '-t', String(dur),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => code === 0 ? resolve(outPath) : reject(new Error('cut failed: ' + err.slice(-500))));
    p.on('error', reject);
  });
}

// ЧБ-версия
function makeBW(input, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-vf', 'hue=s=0,eq=contrast=1.05',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => code === 0 ? resolve(outPath) : reject(new Error('bw failed: ' + err.slice(-500))));
    p.on('error', reject);
  });
}

// Превью-картинка (кадр из середины)
function makePreview(input, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-vf', "select='eq(n\\,0)'+scale=640:-1",
      '-frames:v', '1',
      outPath,
    ];
    // берём кадр примерно на 1-й секунде
    const args2 = ['-y', '-ss', '1', '-i', input, '-vframes', '1', '-vf', 'scale=640:-1', outPath];
    const p = spawn('ffmpeg', args2, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => code === 0 ? resolve(outPath) : reject(new Error('preview failed: ' + err.slice(-500))));
    p.on('error', reject);
  });
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), crypto.randomBytes(8).toString('hex') + (ext || ''));
}

// ---------- endpoints ----------

// POST /ffprobe { url }
app.post('/ffprobe', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const local = tmpFile('.mp4');
  try {
    await downloadToFile(url, local);
    const info = runFFprobe(local);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.unlink(local, () => {});
  }
});

// POST /split-scenes { url, movie_id, min, max, threshold }
app.post('/split-scenes', async (req, res) => {
  const { url, movie_id, min, max, threshold } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const mid = movie_id || ('MOV_' + crypto.randomBytes(3).toString('hex'));
  const local = tmpFile('.mp4');
  try {
    await downloadToFile(url, local);
    const info = runFFprobe(local);
    const duration = info.duration || 0;
    if (!duration) throw new Error('could not read duration');

    const cuts = detectSceneCuts(local, threshold);
    const segments = buildSegments(duration, cuts, min || 3, max || 7);

    const outDir = path.join(CLIPS_DIR, mid);
    fs.mkdirSync(outDir, { recursive: true });

    const base = publicBase(req);
    const scenes = [];
    let idx = 0;
    for (const seg of segments) {
      idx++;
      const fname = `${mid}_scene_${String(idx).padStart(4, '0')}.mp4`;
      const outPath = path.join(outDir, fname);
      await cutClip(local, seg.start_time, seg.duration, outPath);
      scenes.push({
        index: idx,
        start_time: seg.start_time,
        end_time: seg.end_time,
        duration: seg.duration,
        original_path: `${base}/files/${mid}/${fname}`,
      });
    }

    res.json({ movie_id: mid, scene_cuts: cuts.length, scenes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.unlink(local, () => {});
  }
});

// POST /make-bw-preview { clip_id, original_path }
app.post('/make-bw-preview', async (req, res) => {
  const { clip_id, original_path } = req.body || {};
  if (!original_path) return res.status(400).json({ error: 'original_path required' });
  const cid = clip_id || ('CLIP_' + crypto.randomBytes(3).toString('hex'));
  const local = tmpFile('.mp4');
  try {
    await downloadToFile(original_path, local);

    const outDir = path.join(CLIPS_DIR, 'derived');
    fs.mkdirSync(outDir, { recursive: true });

    const bwName = `${cid}_bw.mp4`;
    const prevName = `${cid}_preview.jpg`;
    const bwPath = path.join(outDir, bwName);
    const prevPath = path.join(outDir, prevName);

    await makeBW(local, bwPath);
    await makePreview(local, prevPath);

    const base = publicBase(req);
    res.json({
      clip_id: cid,
      bw_path: `${base}/files/derived/${bwName}`,
      preview_path: `${base}/files/derived/${prevName}`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.unlink(local, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`ffmpeg-scene-service listening on :${PORT}, data=${DATA_DIR}`);
});
