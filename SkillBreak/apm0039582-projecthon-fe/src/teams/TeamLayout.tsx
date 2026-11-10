import type { ReactNode } from 'react';
import type { TeamService } from '../teams';
import { useTeamBackend } from './useTeamBackend';

interface TeamLayoutProps {
  team: TeamService;
  onNavigate: (to: string) => void;
  children?: ReactNode;
  productView?: boolean;
}

/** Shared chrome for team pages: header, back link, and backend status. */
export default function TeamLayout({ team, onNavigate, children, productView = false }: TeamLayoutProps) {
  const backend = useTeamBackend(team);
  const navigation = (
    <>
      <a
        className="back"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('/');
        }}
      >
        ← All teams
      </a>
      <h1 className={productView ? 'team7-visually-hidden' : undefined}>{team.name}</h1>
    </>
  );
  const diagnostics = (
    <>
      <dl className="meta">
        <dt>Page route</dt>
        <dd>
          <code>{team.path}</code>
        </dd>
        <dt>Backend service</dt>
        <dd>
          <code>{team.service}</code>
        </dd>
        <dt>API base path</dt>
        <dd>
          <code>{team.apiPath}</code>
        </dd>
        <dt>Backend status</dt>
        <dd>
          {backend.status === 'loading' && <span>Loading…</span>}
          {backend.status === 'error' && (
            <span className="status-error">Unreachable — {backend.message}</span>
          )}
          {backend.status === 'ok' && <span className="status-ok">Connected</span>}
        </dd>
      </dl>

      {backend.status === 'ok' && (
        <pre className="response">{JSON.stringify(backend.data, null, 2)}</pre>
      )}
    </>
  );
  return (
    <section className={productView ? 'page page--product' : 'page'}>
      {productView ? (
        <>
          {children}
          <aside className="team7-development">
            {navigation}
            <details>
              <summary>Development diagnostics</summary>
              {diagnostics}
            </details>
          </aside>
        </>
      ) : <>{navigation}{diagnostics}{children}</>}
    </section>
  );
}
