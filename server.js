// Скачать видео по URL во временный файл.
// Особый случай: Google Drive для больших файлов отдаёт HTML-страницу
// подтверждения — обрабатываем через usercontent-эндпоинт и confirm-токен.
async function download(url) {
  const tmp = path.join(os.tmpdir(), `src_${rid()}.mp4`);

  // Извлечь fileId из любой формы ссылки Google Drive
  function driveId(u) {
    const m1 = u.match(/\/file\/d\/([^/]+)/);
    if (m1) return m1[1];
    const m2 = u.match(/[?&]id=([^&]+)/);
    if (m2) return m2[1];
    return null;
  }

  async function fetchToFile(target, cookie) {
    const headers = { "user-agent": "Mozilla/5.0" };
    if (cookie) headers.cookie = cookie;
    const resp = await fetch(target, { redirect: "follow", headers });
    if (!resp.ok) throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
    return resp;
  }

  const id = driveId(url);

  if (id) {
    // 1) Прямой usercontent-эндпоинт с confirm=t — работает для большинства больших публичных файлов
    let resp = await fetchToFile(
      `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    );
    let ct = resp.headers.get("content-type") || "";

    // 2) Если всё ещё HTML — вытащить confirm-токен и uuid из формы и повторить
    if (ct.includes("text/html")) {
      const html = await resp.text();
      const setCookie = resp.headers.get("set-cookie") || "";
      const cookie = setCookie.split(";")[0] || "";
      const confirm = (html.match(/name="confirm"\s+value="([^"]+)"/) || [])[1] || "t";
      const uuid = (html.match(/name="uuid"\s+value="([^"]+)"/) || [])[1] || "";
      let retry = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm}`;
      if (uuid) retry += `&uuid=${uuid}`;
      resp = await fetchToFile(retry, cookie);
      ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        throw new Error(
          "Google Drive не отдаёт файл напрямую. Убедитесь, что файл открыт по ссылке (Доступ → Все, у кого есть ссылка), либо используйте публичный bucket (S3/R2)."
        );
      }
    }

    const arrayBuf = await resp.arrayBuffer();
    await fs.writeFile(tmp, Buffer.from(arrayBuf));
    return tmp;
  }

  // Не Google Drive — обычное скачивание
  const resp = await fetchToFile(url);
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error("источник вернул HTML вместо видео (нужна прямая ссылка на файл)");
  }
  const arrayBuf = await resp.arrayBuffer();
  await fs.writeFile(tmp, Buffer.from(arrayBuf));
  return tmp;
}
