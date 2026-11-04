import { TEAMS } from '../teams';

interface HomePageProps {
  onNavigate: (to: string) => void;
}

export default function HomePage({ onNavigate }: HomePageProps) {
  return (
    <section className="page">
      <h1>Projecthon</h1>
      <p>Frontend gateway for the projecthon team microservices.</p>
      <ul className="team-list">
        {TEAMS.map((team) => (
          <li key={team.id}>
            <a
              href={team.path}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(team.path);
              }}
            >
              {team.name}
            </a>
            <code>{team.path}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
