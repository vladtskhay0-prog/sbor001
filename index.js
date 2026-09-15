// VPS FFmpeg service — cuts clips and RETURNS them as base64 (no Google Drive).
// Endpoints: GET /health, POST /ffprobe, POST /extract
import express from 'express';
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const ffprobePath = ffprobeStatic.path;
const app = express();
app.use(express.json({ limit: '50mb' }));

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vps-'));
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/ffprobe', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  let dir;
  try {
    dir = await tmpDir();
    const input = path.join(dir, 'input.mp4');
    await downloadTo(url, input);
    const { stdout } = await run(ffprobePath, [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', input,
    ]);
    const info = JSON.parse(stdout);
    const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
    let fps = null;
    if (v.avg_frame_rate && v.avg_frame_rate.includes('/')) {
      const [n, d] = v.avg_frame_rate.split('/').map(Number);
      if (d) fps = Math.round((n / d) * 1000) / 1000;
    }
    res.json({
      duration: info.format ? Number(info.format.duration) : null,
      width: v.width || null,
      height: v.height || null,
      fps,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    if (dir) fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/extract', async (req, res) => {
  const { url, segments, bw = true, preview = true } = req.body || {};
  if (!url || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'url and segments[] required' });
  }
  const common = ['-threads', '1', '-preset', 'ultrafast', '-crf', '23',
    '-max_muxing_queue_size', '1024', '-movflags', '+faststart', '-y'];
  let dir;
  try {
    dir = await tmpDir();
    const input = path.join(dir, 'input.mp4');
    await downloadTo(url, input);

    const results = [];
    for (const seg of segments) {
      const clipId = seg.clip_id;
      const start = Number(seg.start);
      const dur = Number(seg.end) - Number(seg.start);
      if (!clipId || !isFinite(start) || !isFinite(dur) || dur <= 0) {
        results.push({ clip_id: clipId, error: 'invalid segment' });
        continue;
      }

      const colorPath = path.join(dir, `${clipId}_color.mp4`);
      await run(ffmpegPath, ['-ss', String(start), '-t', String(dur), '-i', input,
        '-c:v', 'libx264', '-c:a', 'aac', ...common, colorPath]);
      const out = { clip_id: clipId };
      out.color_b64 = (await fs.readFile(colorPath)).toString('base64');

      if (bw) {
        const bwPath = path.join(dir, `${clipId}_bw.mp4`);
        await run(ffmpegPath, ['-ss', String(start), '-t', String(dur), '-i', input,
          '-vf', 'format=gray', '-c:v', 'libx264', '-c:a', 'aac', ...common, bwPath]);
        out.bw_b64 = (await fs.readFile(bwPath)).toString('base64');
      }

      if (preview) {
        const prevPath = path.join(dir, `${clipId}_preview.mp4`);
        await run(ffmpegPath, ['-ss', String(start), '-t', String(dur), '-i', input,
          '-vf', 'scale=640:-2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
          '-crf', '30', '-threads', '1', '-max_muxing_queue_size', '1024',
          '-movflags', '+faststart', '-y', prevPath]);
        out.preview_b64 = (await fs.readFile(prevPath)).toString('base64');
      }

      results.push(out);
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    if (dir) fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log(`VPS listening on ${port}`));
