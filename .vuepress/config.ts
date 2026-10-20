import { viteBundler } from '@vuepress/bundler-vite'
import { defaultTheme } from '@vuepress/theme-default'
import { defineUserConfig } from 'vuepress'

export default defineUserConfig({
  lang: 'en-US',
  title: 'fortytwo',
  description:
    'Design and architecture documentation for fortytwo, the local-first personal-assistant spine distributed as the @justfortytwo/* packages.',

  bundler: viteBundler(),

  // Keep agent-instruction files out of the rendered site.
  pagePatterns: [
    '**/*.md',
    '!.vuepress',
    '!node_modules',
    '!CLAUDE.md',
    '!AGENTS.md',
  ],

  theme: defaultTheme({
    repo: 'justfortytwo/docs',

    navbar: [
      { text: 'Architecture', link: '/architecture.html' },
      { text: 'Packages', link: '/packages/' },
      { text: 'Design', link: '/scheduler.html' },
    ],

    sidebar: {
      '/packages/': [
        {
          text: 'Packages',
          children: [
            '/packages/installer.md',
            '/packages/persona.md',
            '/packages/memory.md',
            '/packages/runner.md',
            '/packages/scheduler.md',
            '/packages/telegram.md',
            '/packages/gate.md',
            '/packages/salience.md',
            '/packages/marketplace.md',
          ],
        },
      ],
      '/': [
        {
          text: 'Overview',
          children: ['/', '/architecture.md'],
        },
        {
          text: 'Design',
          children: ['/scheduler.md'],
        },
      ],
    },
  }),
})
