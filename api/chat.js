// Посредник между сайтом и ИИ-провайдерами.
// GEMINI_API_KEY — основной (aistudio.google.com/apikey)
// GROQ_API_KEY — резервный, включается сам, если Gemini недоступен (console.groq.com/keys)
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — для счётчика использования (необязательно)

async function bumpUsageCounter() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(['INCR', 'usage_total']) });
    await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(['INCR', 'usage_' + today]) });
  } catch (e) { /* счётчик не критичен, молча игнорируем сбой */ }
}

async function callGemini(system, messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, skip: true };

  const contents = (messages || []).map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof m.content === 'string') parts = [{ text: m.content }];
    else parts = (m.content || []).map(p => p.type === 'image' ? { inlineData: { mimeType: p.mediaType, data: p.data } } : { text: p.text || '' });
    return { role, parts };
  });

  const MODEL_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-3-flash-preview'];
  let lastError = null;
  for (const MODEL of MODEL_CANDIDATES) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ system_instruction: { parts: [{ text: system || '' }] }, contents })
      });
      const data = await response.json();
      if (!response.ok) {
        lastError = data.error || { message: 'Ошибка Gemini (' + MODEL + ')' };
        const msg = (lastError.message || '').toLowerCase();
        if (msg.includes('not found') || msg.includes('no longer available') || msg.includes('quota') || response.status === 404 || response.status === 429) continue;
        return { ok: false, error: lastError };
      }
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      return { ok: true, text, provider: 'gemini:' + MODEL };
    } catch (err) { lastError = { message: err.message }; }
  }
  return { ok: false, error: lastError || { message: 'Gemini недоступен' } };
}

async function callGroq(system, messages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, skip: true };

  const chatMessages = [
    { role: 'system', content: system || '' },
    ...(messages || []).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : (m.content.find(p => p.type === 'text')?.text || '[пользователь прислал изображение — опиши, что не можешь его увидеть на этом резервном режиме]')
    }))
  ];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: chatMessages, max_tokens: 1500 })
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data.error || { message: 'Ошибка Groq' } };
    const text = data.choices?.[0]?.message?.content || '';
    return { ok: true, text, provider: 'groq' };
  } catch (err) { return { ok: false, error: { message: err.message } }; }
}

async function upstashCmd(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(command) });
    const data = await response.json();
    return data.result;
  } catch (e) { return null; }
}

async function checkRateLimit(userKey) {
  // 5 секунд между сообщениями одного пользователя
  const lastTs = await upstashCmd(['GET', 'lastreq_' + userKey]);
  const now = Date.now();
  if (lastTs && now - Number(lastTs) < 5000) {
    return { blocked: true, message: 'Слишком часто — подождите пару секунд между сообщениями.' };
  }
  await upstashCmd(['SET', 'lastreq_' + userKey, String(now)]);

  // общий дневной лимит 1000 запросов (Gemini + Groq вместе)
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = await upstashCmd(['GET', 'usage_' + today]);
  if (todayCount && Number(todayCount) >= 1000) {
    return { blocked: true, message: 'Дневной лимит запросов бота (1000) исчерпан. Попробуйте завтра.' };
  }
  return { blocked: false };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Только POST-запросы' } });

  const { system, messages, userLogin } = req.body;

  const rl = await checkRateLimit(userLogin || 'anon');
  if (rl.blocked) return res.status(429).json({ error: { message: rl.message } });

  let result = await callGemini(system, messages);
  if (!result.ok) {
    const fallback = await callGroq(system, messages);
    if (fallback.ok) result = fallback;
    else if (!fallback.skip) result = fallback; // покажем ошибку Groq, если он тоже настроен и тоже упал
  }

  if (!result.ok) {
    return res.status(500).json({ error: result.error || { message: 'Ни Gemini, ни Groq не сработали. Проверьте ключи в настройках Vercel.' } });
  }

  bumpUsageCounter(); // не ждём, чтобы не тормозить ответ
  res.status(200).json({ content: [{ text: result.text }], _provider: result.provider });
}
