# mtproto-worker (flat)

Single-file Telegram MTProto worker. **No folders required** — все 5 файлов лежат в корне:

- `worker.js` — весь код воркера
- `package.json` — зависимости
- `Dockerfile` — для Railway
- `railway.json` — конфиг Railway
- `README.md` — этот файл

## Деплой
1. Залей все файлы в публичный GitHub-репозиторий (через `Add file → Upload files → choose your files`).
2. Подключи репо к Railway (Deploy from GitHub).
3. В Railway укажи env-переменные:
   - `MTPROTO_API_ID`, `MTPROTO_API_HASH`, `MTPROTO_SESSION_STRING`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `WORKSPACE_ID`
4. Жми Deploy. Логи покажут `=== mtproto-worker vX starting ===`.

Session string получается на странице `/mtproto-login` в твоём приложении.
