import express from "express";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function rid() {
  return crypto.randomBytes(8).toString("hex");
}

/* ----------------------- download (стримингом) ----------------------- */
async function download(url, { timeoutMs = 120000 } = {}) {
  const tmp = path.join(os.tmpdir(), `src_${rid()}.mp4`);

  function driveId(u) {
    const m1 = u.match(/\/file\/d\/([^/]+)/);
    if (m1) return m1[1];
    const m2 = u.match(/[?&]id=([^&]+)/);
    if (m2) return m2[1];
    return null;
  }

  async function doFetch(target, cookie) {
    const headers = { "user-agent": "Mozilla/5.0" };
    if (cookie) headers.cookie = cookie;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(target, { redirect: "follow", headers, signal: ac.signal });
      if (!resp.ok) throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
      return resp;
    } finally {
      clearTimeout(t);
    }
  }

  async function streamToFile(resp) {
    if (!resp.body) throw new Error("empty response body");
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmp));
  }

  function firstCookie(resp) {
    const list =
      typeof resp.headers.getSetCookie === "function"
        ? resp.headers.getSetCookie()
        : [resp.headers.get("set-cookie") || ""];
    return (list[0] || "").split(";")[0] || "";
  }

  const id = driveId(url);
  if (id) {
    let resp = await doFetch(
      `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    );
    let ct = resp.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      const html = await resp.text();
      const cookie = firstCookie(resp);
      const confirm = (html.match(/name="confirm"\s+value="([^"]+)"/) || [])[1] || "t";
      const uuid = (html.match(/name="uuid"\s+value="([^"]+)"/) || [])[1] || "";
      let retry = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm}`;
      if (uuid) retry += `&uuid=${uuid}`;
      resp = await doFetch(retry, cookie);
      ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        throw new Error(
          "Google Drive не отдаёт файл напрямую. Откройте доступ по ссылке или используйте публичный bucket."
        );
      }
    }
    await streamToFile(resp);
    return tmp;
  }

  const resp = await doFetch(url);
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("источник вернул HTML вместо видео");
  await streamToFile(resp);
  return tmp;
}

/* ----------------------- helpers ffmpeg/ffprobe ----------------------- */
function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    if (capture && p.stdout) p.stdout.on("data", (d) => (out += d));
    if (p.stderr) p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`))
    );
  });
}

async function safeUnlink(f) {
  try { await fs.unlink(f); } catch {}
}

/* ----------------------- HTTP server ----------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// POST /ffprobe  { url }
app.post("/ffprobe", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  let src;
  try {
    src = await download(url);
    const json = await run(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", src],
      { capture: true }
    );
    const info = JSON.parse(json);
    const v = (info.streams || []).find((s) => s.codec_type === "video") || {};
    const fps = (() => {
      const [n, d] = String(v.r_frame_rate || "0/1").split("/").map(Number);
      return d ? +(n / d).toFixed(3) : null;
    })();
    res.json({
      duration: info.format?.duration ? Number(info.format.duration) : null,
      width: v.width ?? null,
      height: v.height ?? null,
      fps,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (src) await safeUnlink(src);
  }
});

// POST /split-scenes  { url, movie_id, min, max }
// ЗАГЛУШКА-каркас: здесь должна быть ваша логика нарезки на сцены.
app.post("/split-scenes", async (req, res) => {
  const { url, movie_id, min = 3, max = 7 } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  let src;
  try {
    src = await download(url);
    // TODO: реальная детекция сцен (ffmpeg select='gt(scene,...)' или PySceneDetect)
    // и нарезка сегментов длиной min..max сек, сохранение в постоянное хранилище.
    // Ниже — форма ответа, которую ждёт workflow (массив scenes с original_path).
    res.json({
      movie_id: movie_id ?? null,
      scenes: [
        // { start_time: 0, end_time: 5, duration: 5, original_path: "https://.../CLIP_000001_original.mp4" }
      ],
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (src) await safeUnlink(src);
  }
});

// POST /make-bw-preview  { clip_id, original_path }
// ЗАГЛУШКА-каркас: ЧБ-версия + preview.
app.post("/make-bw-preview", async (req, res) => {
  const { clip_id, original_path } = req.body || {};
  if (!original_path) return res.status(400).json({ error: "original_path required" });
  try {
    // TODO: скачать original_path, сделать ffmpeg -vf hue=s=0 (BW) и preview,
    // залить в хранилище, вернуть пути.
    res.json({
      clip_id: clip_id ?? null,
      bw_path: null,
      preview_path: null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("listening on " + port));

export { download };
