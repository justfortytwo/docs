import { searchPlugin } from '@vuepress/plugin-search'
import { viteBundler } from '@vuepress/bundler-vite'
import { defaultTheme } from '@vuepress/theme-default'
import { defineUserConfig } from 'vuepress'

export default defineUserConfig({
  lang: 'en-US',
  title: 'fortytwo',
  description:
    'Design and architecture documentation for fortytwo, the local-first personal-assistant spine distributed as the @justfortytwo/* packages.',

  bundler: viteBundler(),

  // Keep agent-instruction files and superpowers/ specs/plans off the site.
  pagePatterns: [
    '**/*.md',
    '!.vuepress',
    '!node_modules',
    '!CLAUDE.md',
    '!AGENTS.md',
    '!superpowers',
  ],

  plugins: [
    searchPlugin({
      // index h2/h3 text so headings match too
      getExtraFields: () => [],
    }),
  ],

  theme: defaultTheme({
    repo: 'justfortytwo/docs',

    navbar: [
      { text: 'Architecture', link: '/architecture.html' },
      { text: 'Packages', link: '/packages/' },
      { text: 'Design', link: '/scheduler.html' },
      { text: 'Homelab', link: '/homelab.html' },
      { text: 'forty-two.it', link: 'https://forty-two.it/' },
    ],

    lastUpdated: true,
    editLink: true,
    contributors: false,

    sidebar: {
      '/packages/': [
        {
          text: 'Packages',
          children: [
            '/packages/installer.md',
            '/packages/persona.md',
            '/packages/memory.md',
            '/packages/transcript.md',
            '/packages/runner.md',
            '/packages/scheduler.md',
            '/packages/telegram.md',
            '/packages/gate.md',
            '/packages/salience.md',
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
        {
          text: 'Guides',
          children: ['/homelab.md'],
        },
      ],
    },
  }),
})
