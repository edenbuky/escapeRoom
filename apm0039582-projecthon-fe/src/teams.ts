export interface TeamService {
  id: string;
  name: string;
  /** Frontend route that renders the team's page. */
  path: string;
  /** Ingress path routed to the backend microservice. */
  apiPath: string;
  /** Kubernetes Service name the ingress forwards to. */
  service: string;
}

const teamServices: TeamService[] = Array.from({ length: 7 }, (_, i) => {
  const n = i + 1;
  return {
    id: `team${n}`,
    name: `Team ${n}`,
    path: `/team${n}`,
    apiPath: `/api/team${n}`,
    service: `projecthon-team${n}`,
  };
});

/** Reference service used to validate the full FE -> ingress -> backend -> DB chain. */
export const REFERENCE_SERVICE: TeamService = {
  id: 'tdp-2026',
  name: 'TDP 2026 (reference)',
  path: '/tdp-2026',
  apiPath: '/api/tdp-2026',
  service: 'tdp-2026',
};

export const TEAMS: TeamService[] = [...teamServices, REFERENCE_SERVICE];

export function findTeamByPath(pathname: string): TeamService | undefined {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return TEAMS.find((team) => team.path === normalized);
}
