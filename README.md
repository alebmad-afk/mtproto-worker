# MTProto Worker для Lovable Cloud

Node.js-воркер. Подключается к Telegram под вашим личным аккаунтом, выполняет нативный поиск чатов/групп по запросам из Lovable. Работает 24/7 в облаке Railway.

---

## 🚀 Деплой в 3 шага (~5 минут)

Регистрироваться на my.telegram.org **не нужно** — используются публичные api_id / api_hash Telegram Desktop, которые уже подставлены в ссылку Railway и в форму получения session string.

### Шаг 1 — Session string (2 мин, без терминала)
1. В Lovable откройте **Settings → Подключение MTProto → «Получить session string»**.
2. Введите телефон, код из Telegram, 2FA-пароль (если есть).
3. Скопируйте полученную строку — это `MTPROTO_SESSION_STRING`.

### Шаг 2 — Деплой на Railway (3 мин)
1. В Lovable Settings раскройте `SUPABASE_SERVICE_KEY` и скопируйте.
2. Нажмите **«Deploy on Railway»** → войдите через GitHub.
3. В Railway нужно вставить только 2 секрета: `MTPROTO_SESSION_STRING` и `SUPABASE_SERVICE_KEY`. Остальные (`MTPROTO_API_ID`, `MTPROTO_API_HASH`, `SUPABASE_URL`, `WORKSPACE_ID`, `WORKER_ID`) уже предзаполнены.
4. Нажмите Deploy. В логах появится `[boot] logged in as @username`.

### Шаг 3 — Проверка (1 мин)
1. Вернитесь в Lovable Settings — должно загореться зелёное **«Online ●»**.
2. На `/discovery` поставьте тумблер «MTProto» и запустите поиск.

> Если хотите свои api_id / api_hash — получите их на my.telegram.org → API development tools и замените значения переменных в Railway. Это опционально.

---

## Где взять каждое значение

| Переменная | Откуда |
|---|---|
| `MTPROTO_API_ID` | my.telegram.org (Шаг 1) |
| `MTPROTO_API_HASH` | my.telegram.org (Шаг 1) |
| `MTPROTO_SESSION_STRING` | login.html (Шаг 2) |
| `SUPABASE_URL` | Lovable Settings → MTProto → копи-кнопка |
| `SUPABASE_SERVICE_KEY` | Lovable Settings → MTProto → копи-кнопка (видна только владельцу) |
| `WORKSPACE_ID` | Lovable Settings → MTProto → копи-кнопка |
| `WORKER_ID` | Любая строка, например `railway-prod-1` |

---

## Безопасность аккаунта

Воркер делает **только чтение публичного поиска**:
- `contacts.search` — глобальный поиск чатов/каналов
- `messages.searchGlobal` — поиск по содержимому сообщений
- `contacts.resolveUsername` — раскрытие @username

**Никогда** не делает: join чатов, отправка сообщений, чтение приваток, инвайт-флуд.

## Лимиты по умолчанию (Safe режим)

- 200 запросов/сутки
- Пауза 3–5 секунд между запросами
- При FloodWait — автопауза на указанное Telegram время
- Каждый запрос пишется в `mtproto_audit_log`

Поднимать до Normal (500/сут) — после 2 недель прогрева. Aggressive (1000/сут) — на свой риск.

## Стоимость

Railway даёт **$5 кредитов/мес бесплатно** — хватает на один воркер с запасом (~256 MB RAM).

---

## Альтернативный способ session string (через терминал)

Если предпочитаете терминал:
```bash
cd mtproto-worker
npm install
npm run login
```
