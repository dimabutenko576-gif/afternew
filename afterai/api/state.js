// Общее хранилище (настоящая база данных на бесплатном Upstash Redis).
// Ключи вроде "users" или "shared_knowledge" видны ВСЕМ посетителям сайта.
// Нужны переменные окружения в Vercel: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

async function upstash(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN не заданы в настройках Vercel');

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: { message: 'Не передан key' } });
      const value = await upstash(['GET', key]);
      return res.status(200).json({ value: value ?? null });
    }
    if (req.method === 'POST') {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ error: { message: 'Не передан key' } });
      await upstash(['SET', key, value]);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: { message: 'Метод не поддерживается' } });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}
