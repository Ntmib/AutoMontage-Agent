// Нейтральная тема для шаблона lesson-presentation (ПУБЛИЧНАЯ, дефолт для чужих).
// Чистый тёмный слейт без фирменного декора. Брендовый вид (грунж, точный оранж,
// орбиты) подключается ОТДЕЛЬНОЙ внешней темой через THEMES_EXT и здесь НЕ живёт.
export default {
  name: 'lesson-neutral',
  colors: {
    bg: '#0F1216',
    cardBg: '#171B21', cardBg2: '#1E242C', milk: '#F3F5F7',
    accent: '#4C8DFF', accentDark: '#3B72CC',
    text: '#EDF1F5', textSoft: '#9AA6B2',
    // расширенные токены слайда (fallback'ы для LessonSlide)
    cream: '#EDF1F5', orange: '#4C8DFF', line: '#252C35', panel: '#171B21',
  },
  fonts: { display: 'Oswald', mono: 'JetBrains Mono', body: 'Onest' },
  radius: 26,
  cardShadow: '0 30px 70px rgba(0,0,0,.55)',
  cardBorder: '1px solid rgba(255,255,255,.08)',
  motion: { spring: { damping: 14, mass: 0.9 }, glow: false },
  // конфиг шаблона урока: у нейтральной темы декор выключен
  lesson: {
    badge: 'ЭФИР',
    decor: { orbit: false, stars: false, plus: false, arrow: false, frame: true, grain: false },
    grungeTexture: null,
  },
};
