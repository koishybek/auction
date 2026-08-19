import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // generated — клиент Prisma, его не мы пишем и не нам за него отвечать.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
    ],
  },

  js.configs.recommended,

  // Правила с учётом типов: без них не ловятся забытые await и утечки промисов,
  // а в realtime-коде ставок именно это и ломает всё молча.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Конфиги инструментов вне include у apps/api: добавить их туда нельзя,
          // иначе tsc потащит их в dist и сломает структуру сборки.
          // Тесты покрыты собственным apps/api/test/tsconfig.json — projectService
          // берёт ближайший tsconfig.json.
          allowDefaultProject: [
            'apps/api/prisma.config.ts',
            'apps/api/vitest.config.mts',
            'apps/api/vitest.config.e2e.mts',
            'apps/web/vitest.config.mts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md §4.1: any запрещён. Недоверенный вход — unknown, дальше сужение.
      '@typescript-eslint/no-explicit-any': 'error',

      // Плавающий промис в обработчике ставки = потерянная ставка без единой ошибки в логах.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Осознанное подавление правила обязано быть с объяснением «почему».
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Конфиги на JS вне tsconfig — типовые правила к ним неприменимы.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  /**
   * Скрипты запуска — обычный Node, но вне tsconfig.
   *
   * Без объявленных глобалей `process`, `console`, `fetch` и таймеры для ESLint
   * просто неизвестные имена, и весь файл превращается в сплошной no-undef.
   * Гасим не правило, а незнание: правило ловит опечатки, и терять его нельзя.
   */
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
  },

  /**
   * Сценарии k6 исполняются его собственным рантаймом, а не Node.
   *
   * `__ENV`, `__VU` и `open()` объявляет k6 — для ESLint это неизвестные
   * имена. Гасим только их и только здесь: отключать `no-undef` шире значило
   * бы потерять проверку опечаток в остальном коде.
   */
  {
    files: ['load/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' },
    },
  },

  // Идёт последним: гасит правила оформления, за которое отвечает Prettier.
  prettier,
);
