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
          // prisma.config.ts — конфиг инструмента, он вне include у apps/api:
          // добавить его туда нельзя, иначе tsc потащит его в dist и сломает структуру.
          allowDefaultProject: ['apps/api/prisma.config.ts'],
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

  // Идёт последним: гасит правила оформления, за которое отвечает Prettier.
  prettier,
);
