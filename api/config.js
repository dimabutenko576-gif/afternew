// Отдаёт публичный (не секретный) Google Client ID фронтенду.
// Сам Client ID не является секретом — это обычная практика для Google Sign-In.
export default function handler(req, res) {
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
}
