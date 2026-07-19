// Серверная аутентификация с хешированием паролей (bcrypt).
// Пароли никогда не хранятся и не сравниваются в открытом виде.
import bcrypt from 'bcryptjs';

async function upstash(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('База данных не настроена (UPSTASH_REDIS_REST_URL/TOKEN)');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function loadUsers() {
  const raw = await upstash(['GET', 'users']);
  const users = raw ? JSON.parse(raw) : {};
  if (!users['admin']) {
    users['admin'] = {
      passwordHash: bcrypt.hashSync('dima112233', 10),
      birthdate: null, gender: null, isAdmin: true, warnings: 0, banned: null, authProvider: 'local'
    };
    await upstash(['SET', 'users', JSON.stringify(users)]);
  }
  return users;
}
async function saveUsers(users) { await upstash(['SET', 'users', JSON.stringify(users)]); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Только POST-запросы' } });

  const { action } = req.body;

  try {
    if (action === 'register') {
      const { login, password, birthdate, gender } = req.body;
      if (!login || !password) return res.status(400).json({ error: { message: 'Заполните логин и пароль' } });
      const users = await loadUsers();
      if (users[login]) return res.status(409).json({ error: { message: 'Такой логин уже существует' } });
      const passwordHash = bcrypt.hashSync(password, 10);
      users[login] = { passwordHash, birthdate: birthdate || null, gender: gender || null, isAdmin: false, warnings: 0, banned: null, authProvider: 'local' };
      await saveUsers(users);
      return res.status(200).json({ ok: true, login, isAdmin: false });
    }

    if (action === 'login') {
      const { login, password } = req.body;
      const users = await loadUsers();
      const u = users[login];
      if (!u || !u.passwordHash) return res.status(401).json({ error: { message: 'Неверный логин или пароль' } });
      const match = bcrypt.compareSync(password, u.passwordHash);
      if (!match) return res.status(401).json({ error: { message: 'Неверный логин или пароль' } });
      if (u.banned && (u.banned.until === 'forever' || Date.now() < u.banned.until)) {
        return res.status(403).json({ banned: true, banned_info: u.banned });
      }
      return res.status(200).json({ ok: true, login, isAdmin: !!u.isAdmin });
    }

    if (action === 'google') {
      // Проверяем токен от Google Identity Services через официальный tokeninfo-эндпоинт
      const { credential } = req.body;
      if (!credential) return res.status(400).json({ error: { message: 'Нет токена Google' } });
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      const payload = await verifyRes.json();
      if (!verifyRes.ok || !payload.email) return res.status(401).json({ error: { message: 'Не удалось подтвердить аккаунт Google' } });

      const login = payload.email;
      const users = await loadUsers();
      if (!users[login]) {
        return res.status(200).json({ ok: true, needsProfile: true, email: login });
      }
      const u = users[login];
      if (u.banned && (u.banned.until === 'forever' || Date.now() < u.banned.until)) {
        return res.status(403).json({ banned: true, banned_info: u.banned });
      }
      return res.status(200).json({ ok: true, login, isAdmin: !!u.isAdmin });
    }

    if (action === 'google-complete') {
      // Завершение регистрации через Google: уже проверенный e-mail + дата рождения + ник
      const { credential, birthdate, gender } = req.body;
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      const payload = await verifyRes.json();
      if (!verifyRes.ok || !payload.email) return res.status(401).json({ error: { message: 'Не удалось подтвердить аккаунт Google' } });
      const login = payload.email;
      const users = await loadUsers();
      if (users[login]) return res.status(409).json({ error: { message: 'Аккаунт уже существует, войдите через Google' } });
      users[login] = { passwordHash: null, birthdate: birthdate || null, gender: gender || null, isAdmin: false, warnings: 0, banned: null, authProvider: 'google' };
      await saveUsers(users);
      return res.status(200).json({ ok: true, login, isAdmin: false });
    }

    return res.status(400).json({ error: { message: 'Неизвестное действие' } });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
