import { TEAMS } from '../../../teams';
import Team5Page from '..';
import '../../../App.css';

const team5 = TEAMS.find(team => team.id === 'team5')!;

/** Serves Team 5 on its own, without the shared App and registry that import the other teams. */
export default function StandaloneApp() {
  return <main className="app"><Team5Page team={team5} onNavigate={to => window.location.assign(to)} /></main>;
}
