import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const execFileP = promisify(execFile);
const ffprobePath = ffprobeStatic.path;
const app = express();
app.use(express.json({ limit: '10mb' }));

// --- helpers ---------------------------------------------------------------

async function safeUnlink(f) { try { await fs.unlink(f); } catch {} }

// Reliable download: validates completeness (Content-Length), rejects HTML
// stub pages from Google Drive, and retries with backoff on truncation.
async function downloadToTmp(url, { retries = 4 } = {}) {
  const file = path.join(os.tmpdir(), `src_${randomUUID()}.mp4`);
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        // Drive returned a confirm/quota HTML page instead of the file
        throw new Error('got HTML instead of video (Drive confirm/quota page)');
      }
      const expected = Number(res.headers.get('content-length')) || 0;

      await pipeline(res.body, createWriteStream(file));

      const { size } = await fs.stat(file);
      if (size < 100 * 1024) throw new Error(`file too small: ${size} bytes`);
      if (expected && size !== expected) {
        throw new Error(`truncated: got ${size} of ${expected} bytes`);
      }
      return file; // success
    } catch (e) {
      lastErr = e;
      await safeUnlink(file); // never leave a broken file behind
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff
      }
    }
  }
  throw new Error(`download failed after ${retries} attempts: ${lastErr?.message || lastErr}`);
}

async function ffprobe(file) {
  const { stdout } = await execFileP(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
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
    width: s.width ?? null,
    height: s.height ?? null,
    fps: fps ? Math.round(fps * 100) / 100 : null,
  };
}

async function fileToB64(file) {
  const buf = await fs.readFile(file);
  return buf.toString('base64');
}

// --- endpoints -------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ ok: true }));

// 1) Technical params of the source video
app.post('/ffprobe', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  let src;
  try {
    src = await downloadToTmp(url);
    const info = await ffprobe(src);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (src) await safeUnlink(src);
  }
});

// 2) Extract segments by timecodes (color + BW + preview).
//    Downloads the source ONCE, cuts all segments.
//    body: { url, segments: [{ clip_id, start, end }, ...] }
//    resp: { results: [{ clip_id, start, end, duration,
//                        color_b64, bw_b64, preview_b64 }, ...] }
app.post('/extract', async (req, res) => {
  const { url, segments } = req.body || {};
  if (!url || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'url and segments[] required' });
  }
  let src;
  const tmp = [];
  try {
    src = await downloadToTmp(url);

    // Guard: verify the source is actually decodable and long enough
    // before attempting any cut, so a bad download fails loudly & early.
    const probe = await ffprobe(src);
    if (!probe.duration || !probe.width) {
      throw new Error('source not decodable after download (corrupt/truncated file)');
    }

    const results = [];

    for (const seg of segments) {
      const start = Number(seg.start);
      const end = Number(seg.end);
      if (!isFinite(start) || !isFinite(end) || end <= start) continue;
      // Skip segments that fall outside the real duration of the source
      if (probe.duration && start >= probe.duration) {
        throw new Error(
          `segment ${seg.clip_id ?? ''} start ${start}s beyond duration ${probe.duration}s`
        );
      }
      const dur = end - start;

      const colorF = path.join(os.tmpdir(), `c_${randomUUID()}.mp4`);
      const bwF = path.join(os.tmpdir(), `b_${randomUUID()}.mp4`);
      const prevF = path.join(os.tmpdir(), `p_${randomUUID()}.jpg`);
      tmp.push(colorF, bwF, prevF);

      // color cut (accurate, re-encoded)
      await execFileP(ffmpegPath, [
        '-y', '-ss', String(start), '-i', src, '-t', String(dur),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-movflags', '+faststart', colorF,
      ]);

      // black & white version
      await execFileP(ffmpegPath, [
        '-y', '-i', colorF, '-vf', 'format=gray',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'copy', '-movflags', '+faststart', bwF,
      ]);

      // preview thumbnail (middle frame of the clip)
      await execFileP(ffmpegPath, [
        '-y', '-ss', String(dur / 2), '-i', colorF,
        '-frames:v', '1', '-q:v', '3', prevF,
      ]);

      results.push({
        clip_id: seg.clip_id ?? null,
        start, end, duration: Math.round(dur * 100) / 100,
        color_b64: await fileToB64(colorF),
        bw_b64: await fileToB64(bwF),
        preview_b64: await fileToB64(prevF),
      });
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (src) await safeUnlink(src);
    for (const f of tmp) await safeUnlink(f);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VPS listening on ${PORT}`));
