import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { google } from 'googleapis';

const execFileP = promisify(execFile);
const ffprobePath = ffprobeStatic.path;
const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Google Drive (service account) ---------------------------------------
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON = весь JSON-ключ сервис-аккаунта (одной строкой).
// В Google Drive расшарьте папку START и 3 целевые папки (color/bw/preview)
// на e-mail сервис-аккаунта (…@…iam.gserviceaccount.com) с правом "Editor".
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// Достаёт Drive fileId из голого id, из ссылки ?id=... или /d/<id>/
function extractDriveId(input) {
  if (!input) return null;
  const s = String(input);
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s) && !s.includes('/')) return s;
  const m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/) || s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function safeUnlink(f) { try { await fs.unlink(f); } catch {} }

// Надёжное скачивание через Drive API: metadata.size даёт реальный размер,
// поэтому обрыв ловится даже без Content-Length у публичной ссылки.
async function downloadFromDrive(fileId) {
  const file = path.join(os.tmpdir(), `src_${randomUUID()}.mp4`);
  const meta = await drive.files.get({ fileId, fields: 'size,name,mimeType' });
  const expected = Number(meta.data.size) || 0;

  const resp = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await pipeline(resp.data, createWriteStream(file));

  const { size } = await fs.stat(file);
  if (size < 100 * 1024) { await safeUnlink(file); throw new Error(`file too small: ${size} bytes`); }
  if (expected && size !== expected) {
    await safeUnlink(file);
    throw new Error(`truncated: got ${size} of ${expected} bytes`);
  }
  return file;
}

async function downloadWithRetry(fileId, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await downloadFromDrive(fileId); }
    catch (e) { lastErr = e; if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt)); }
  }
  throw new Error(`download failed after ${retries} attempts: ${lastErr?.message || lastErr}`);
}

async function ffprobe(file) {
  const { stdout } = await execFileP(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration,size:stream=width,height,r_frame_rate',
    '-of', 'json', file,
  ]);
  const info = JSON.parse(stdout);
  const s = (info.streams && info.streams[0]) || {};
  const f = info.format || {};
  const [n, d] = String(s.r_frame_rate || '0/1').split('/');
  const fps = d && Number(d) !== 0 ? Number(n) / Number(d) : null;
  return {
    duration: f.duration ? Number(f.duration) : null,
    size: f.size ? Number(f.size) : null,
    width: s.width ?? null, height: s.height ?? null,
    fps: fps ? Math.round(fps * 100) / 100 : null,
  };
}

// Гейт декодируемости: реально вытаскиваем кадр у ts — moov-заголовок больше не обманет.
async function assertDecodableAt(file, ts) {
  await execFileP(ffmpegPath, ['-v', 'error', '-ss', String(ts), '-i', file, '-frames:v', '1', '-f', 'null', '-']);
}

async function uploadToDrive(localPath, folderId, name, mimeType) {
  const res = await drive.files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType, body: createReadStream(localPath) },
    fields: 'id',
  });
  return res.data.id;
}

// --- endpoints -------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// body: { url | file_id }   resp: { duration, size, width, height, fps }
app.post('/ffprobe', async (req, res) => {
  const { url, file_id } = req.body || {};
  const fileId = extractDriveId(file_id || url);
  if (!fileId) return res.status(400).json({ error: 'file_id/url required' });
  let src;
  try {
    src = await downloadWithRetry(fileId);
    res.json(await ffprobe(src));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { if (src) await safeUnlink(src); }
});

// body: { url|file_id, segments:[{clip_id,start,end}], folders:{color,bw,preview} }
// resp: { results:[{ clip_id,start,end,duration, color_id,bw_id,preview_id }] }
app.post('/extract', async (req, res) => {
  const { url, file_id, segments, folders } = req.body || {};
  const fileId = extractDriveId(file_id || url);
  if (!fileId || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'file_id/url and segments[] required' });
  }
  let src; const tmp = [];
  try {
    src = await downloadWithRetry(fileId);

    const probe = await ffprobe(src);
    if (!probe.duration || !probe.width) throw new Error('source not decodable after download');

    // ключевой гейт: есть ли реальные кадры у самого дальнего нужного таймкода
    const maxEnd = Math.max(...segments.map(s => Number(s.end)).filter(Number.isFinite));
    await assertDecodableAt(src, Math.max(0, Math.min(maxEnd, probe.duration - 0.5)))
      .catch(() => { throw new Error(`source truncated: no frame data near ${maxEnd}s (incomplete download)`); });

    const results = [];
    for (const seg of segments) {
      const start = Number(seg.start), end = Number(seg.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      if (start >= probe.duration) throw new Error(`segment ${seg.clip_id ?? ''} start ${start}s beyond duration ${probe.duration}s`);
      const dur = end - start;

      const colorF = path.join(os.tmpdir(), `c_${randomUUID()}.mp4`);
      const bwF    = path.join(os.tmpdir(), `b_${randomUUID()}.mp4`);
      const prevF  = path.join(os.tmpdir(), `p_${randomUUID()}.jpg`);
      tmp.push(colorF, bwF, prevF);

      // color cut (accurate, re-encoded)
      await execFileP(ffmpegPath, ['-y','-ss',String(start),'-i',src,'-t',String(dur),
        '-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-movflags','+faststart',colorF]);
      // black & white version
      await execFileP(ffmpegPath, ['-y','-i',colorF,'-vf','format=gray',
        '-c:v','libx264','-preset','veryfast','-crf','20','-c:a','copy','-movflags','+faststart',bwF]);
      // preview thumbnail (middle frame)
      await execFileP(ffmpegPath, ['-y','-ss',String(dur/2),'-i',colorF,'-frames:v','1','-q:v','3',prevF]);

      // upload 3 версий в Drive
      const cid = seg.clip_id || 'clip';
      const color_id   = await uploadToDrive(colorF, folders?.color,   `${cid}_color.mp4`,   'video/mp4');
      const bw_id      = await uploadToDrive(bwF,    folders?.bw,      `${cid}_bw.mp4`,      'video/mp4');
      const preview_id = await uploadToDrive(prevF,  folders?.preview, `${cid}_preview.jpg`, 'image/jpeg');

      results.push({ clip_id: seg.clip_id ?? null, start, end,
        duration: Math.round(dur * 100) / 100, color_id, bw_id, preview_id });
    }

    res.json({ results });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { if (src) await safeUnlink(src); for (const f of tmp) await safeUnlink(f); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VPS listening on ${PORT}`));
