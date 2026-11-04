import { findTeamByPath } from './teams';
import { useRoute } from './useRoute';
import { TEAM_PAGES } from './teams/registry';
import HomePage from './pages/HomePage';
import NotFoundPage from './pages/NotFoundPage';
import './App.css';

export default function App() {
  const { pathname, navigate } = useRoute();
  const isHome = pathname === '/' || pathname === '';
  const team = findTeamByPath(pathname);
  const TeamPage = team ? TEAM_PAGES[team.id] : undefined;

  if (isHome) {
    return (
      <main className="app">
        <HomePage onNavigate={navigate} />
      </main>
    );
  }

  return (
    <main className={team?.id === 'team7' ? 'app app--team7' : 'app'}>
      {team && TeamPage ? (
        <TeamPage team={team} onNavigate={navigate} />
      ) : (
        <NotFoundPage onNavigate={navigate} />
      )}
    </main>
  );
}
