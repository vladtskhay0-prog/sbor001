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

// Скачать видео по URL во временный файл (стримингом, без загрузки в память).
// Особый случай: Google Drive для больших файлов отдаёт HTML-страницу
// подтверждения — обрабатываем через usercontent-эндпоинт и confirm-токен.
async function download(url, { timeoutMs = 120000 } = {}) {
  const tmp = path.join(os.tmpdir(), `src_${rid()}.mp4`);

  // Извлечь fileId из любой формы ссылки Google Drive
  function driveId(u) {
    const m1 = u.match(/\/file\/d\/([^/]+)/);
    if (m1) return m1[1];
    const m2 = u.match(/[?&]id=([^&]+)/);
    if (m2) return m2[1];
    return null;
  }

  // Выполнить запрос с таймаутом; вернуть Response (тело ещё не прочитано)
  async function doFetch(target, cookie) {
    const headers = { "user-agent": "Mozilla/5.0" };
    if (cookie) headers.cookie = cookie;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(target, {
        redirect: "follow",
        headers,
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
      }
      return resp;
    } finally {
      clearTimeout(t);
    }
  }

  // Стримить тело Response в файл tmp
  async function streamToFile(resp) {
    if (!resp.body) throw new Error("empty response body");
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmp));
  }

  function firstCookie(resp) {
    // getSetCookie() корректнее для нескольких Set-Cookie заголовков
    const list =
      typeof resp.headers.getSetCookie === "function"
        ? resp.headers.getSetCookie()
        : [resp.headers.get("set-cookie") || ""];
    const raw = list[0] || "";
    return raw.split(";")[0] || "";
  }

  const id = driveId(url);

  if (id) {
    // 1) Прямой usercontent-эндпоинт с confirm=t
    let resp = await doFetch(
      `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    );
    let ct = resp.headers.get("content-type") || "";

    // 2) Если всё ещё HTML — вытащить confirm-токен и uuid из формы и повторить
    if (ct.includes("text/html")) {
      const html = await resp.text(); // здесь тело маленькое (HTML-страница) — ок
      const cookie = firstCookie(resp);
      const confirm =
        (html.match(/name="confirm"\s+value="([^"]+)"/) || [])[1] || "t";
      const uuid =
        (html.match(/name="uuid"\s+value="([^"]+)"/) || [])[1] || "";
      let retry = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm}`;
      if (uuid) retry += `&uuid=${uuid}`;

      resp = await doFetch(retry, cookie);
      ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        throw new Error(
          "Google Drive не отдаёт файл напрямую. Убедитесь, что файл открыт по ссылке (Доступ → Все, у кого есть ссылка), либо используйте публичный bucket (S3/R2)."
        );
      }
    }

    await streamToFile(resp);
    return tmp;
  }

  // Не Google Drive — обычное скачивание
  const resp = await doFetch(url);
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error("источник вернул HTML вместо видео (нужна прямая ссылка на файл)");
  }
  await streamToFile(resp);
  return tmp;
}

export { download };
