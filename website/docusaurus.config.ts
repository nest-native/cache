import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'stalefree',
  tagline:
    'tag-based cache invalidation through the database you already have — no Redis',
  favicon: 'img/logo.svg',

  future: {
    v4: true,
  },

  url: 'https://nest-native.dev',
  baseUrl: '/cache/',

  organizationName: 'nest-native',
  projectName: 'cache',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/nest-native/cache/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/logo.svg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'stalefree',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://www.npmjs.com/package/@stalefree/core',
          label: 'npm',
          position: 'right',
        },
        {
          href: 'https://github.com/nest-native/cache',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Introduction', to: '/docs/introduction'},
            {label: 'Quick Start', to: '/docs/quick-start'},
            {label: 'API Reference', to: '/docs/api-reference'},
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/nest-native/cache',
            },
            {
              label: 'npm (core)',
              href: 'https://www.npmjs.com/package/@stalefree/core',
            },
            {
              label: 'npm (NestJS adapter)',
              href: 'https://www.npmjs.com/package/@nest-native/cache',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} stalefree contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'sql'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
