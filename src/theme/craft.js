// БАЗОВАЯ тема — крафт «стиль Клода». Дефолт для всех монтажей.
export default {
  name: 'craft',
  colors: {
    bg: '#000000',
    cardBg: '#F0EAE0', cardBg2: '#EDE4D3', milk: '#FBF7F0',
    accent: '#CC785C', accentDark: '#B85C3E',
    text: '#3D2E24', textSoft: '#6B5647',
  },
  fonts: { display: 'Oswald', mono: 'JetBrains Mono', body: 'Onest' },
  radius: 26,
  cardShadow: '0 20px 50px rgba(61,46,36,.28)',
  cardBorder: '2px solid rgba(61,46,36,.14)',
  motion: { spring: { damping: 14, mass: 0.9 }, glow: false },
};
