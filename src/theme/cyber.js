// Вторая тема — графит + лаймовый неон. Для проверки параметризации.
export default {
  name: 'cyber',
  colors: {
    bg: '#0E0E0C',
    cardBg: '#16170F', cardBg2: '#1E1F14', milk: '#F2FFE0',
    accent: '#A5FF00', accentDark: '#7BC400',
    text: '#EAF6D8', textSoft: '#9DB07E',
  },
  fonts: { display: 'Oswald', mono: 'JetBrains Mono', body: 'Onest' },
  radius: 18,
  cardShadow: '0 0 44px rgba(165,255,0,.28)',
  cardBorder: '2px solid rgba(165,255,0,.55)',
  motion: { spring: { damping: 11, mass: 0.7 }, glow: true },
};
