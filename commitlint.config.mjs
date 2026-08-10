/**
 * Формат коммита: `тип(T-NNN): описание`
 * Например: chore(T-004): линтеры и правила коммитов
 *
 * Conventional commits дают машиночитаемую историю (авто-changelog, semantic-release),
 * а scope с ID задачи связывает коммит с docs/TASKS.md: `git log --grep "T-024"`
 * показывает всё, что делалось по задаче.
 */

const TASK_ID = /^T-\d{3}$/;

export default {
  extends: ['@commitlint/config-conventional'],

  plugins: [
    {
      rules: {
        /**
         * Scope необязателен — у инфраструктурных коммитов задачи может не быть.
         * Но если он есть, это обязан быть ID задачи, а не произвольное слово:
         * иначе связь истории с планом расползётся уже через месяц.
         */
        'scope-task-id': ({ scope }) => {
          if (scope === null || scope === undefined || scope === '') {
            return [true, ''];
          }
          return [
            TASK_ID.test(scope),
            `scope должен быть ID задачи вида T-004, получено «${scope}». ` +
              `Список задач — docs/TASKS.md`,
          ];
        },
      },
    },
  ],

  rules: {
    'scope-task-id': [2, 'always'],
  },
};
