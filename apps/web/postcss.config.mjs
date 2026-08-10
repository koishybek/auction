// Tailwind v4 подключается как плагин PostCSS; отдельного tailwind.config уже нет,
// вся настройка живёт в CSS (src/app/globals.css).
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
