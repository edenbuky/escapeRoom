import { useEffect, useState } from 'react';
import type { TeamService } from '../teams';
import { fetchFromTeamApi } from '../api/teamApi';

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: unknown }
  | { status: 'error'; message: string };

/** Calls the team's backend through its /api/<team> ingress route. */
export function useTeamBackend(team: TeamService, endpoint = '/') {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    fetchFromTeamApi(team.apiPath, endpoint)
      .then((data) => {
        if (!cancelled) setState({ status: 'ok', data });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: 'error', message: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, [team.apiPath, endpoint]);

  return state;
}
