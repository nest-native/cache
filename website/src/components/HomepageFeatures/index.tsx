import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  icon: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'No Redis required',
    icon: 'DB',
    description: (
      <>
        Coherence travels through the <strong>database your instances already
        share</strong>: Postgres <code>LISTEN</code>/<code>NOTIFY</code> across
        machines, a unix-socket mesh on one machine, in-process for a single
        node. No extra infrastructure to run.
      </>
    ),
  },
  {
    title: 'Transactional invalidation',
    icon: 'Tx',
    description: (
      <>
        On Postgres, <code>publishInTx</code> runs <code>pg_notify</code>{' '}
        inside your business transaction — delivered <strong>on commit</strong>,
        dropped on rollback. &ldquo;Wrote the row, crashed before invalidating,
        stale forever&rdquo; cannot happen.
      </>
    ),
  },
  {
    title: 'TTL is the backstop',
    icon: 'TTL',
    description: (
      <>
        Every entry has a TTL — <strong>no exceptions</strong>. The bus is
        best-effort by contract, so a lost invalidation message means{' '}
        <em>stale until TTL</em>, never <em>stale forever</em>. The API rejects
        infinite TTLs by design.
      </>
    ),
  },
  {
    title: 'Tags + single-flight wrap',
    icon: 'Tag',
    description: (
      <>
        <code>wrap(key, loader, {'{tags}'})</code> is read-through with
        in-process single-flight: concurrent misses share one loader run.{' '}
        <code>invalidateTags</code> evicts every entry carrying a tag — here
        and on every other instance.
      </>
    ),
  },
  {
    title: 'Optional shared L2',
    icon: 'L2',
    description: (
      <>
        A Drizzle-backed table (SQLite, Postgres, MySQL) so a fresh instance
        starts warm and instances share loader work. On Postgres, make it{' '}
        <code>UNLOGGED</code> — cache rows are transient, and skipping WAL
        roughly doubles write throughput.
      </>
    ),
  },
  {
    title: 'Framework-agnostic, fail-open',
    icon: 'Zero',
    description: (
      <>
        <code>@stalefree/core</code> has zero runtime dependencies; the{' '}
        <code>@nest-native/cache</code> adapter is a thin DI shell over it.
        Store/bus failures fail <strong>open</strong> — a degraded cache is a
        slower app, never a broken one.
      </>
    ),
  },
];

function Feature({title, icon, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md feature-card">
        <div className={styles.featureIcon}>{icon}</div>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
