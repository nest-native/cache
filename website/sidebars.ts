import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'introduction',
        'quick-start',
      ],
    },
    'coherence',
    'stores',
    'semantics',
    'api-reference',
  ],
};

export default sidebars;
