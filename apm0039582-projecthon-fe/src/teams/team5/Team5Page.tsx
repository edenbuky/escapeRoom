import type { TeamService } from '../../teams';
import TeamLayout from '../TeamLayout';
import GameApp from './game/GameApp';
import { ROOM_1_SCREENS } from './game/screens';

interface Props {
  team: TeamService;
  onNavigate: (to: string) => void;
}

/**
 * Team 5 page. Owned by team 5 — add your UI inside TeamLayout.
 * The game is a product page like the design (header from the page's top-left edge), so it uses TeamLayout's
 * productView: the shared navigation and diagnostics follow the game in "Development diagnostics".
 */
export default function Team5Page({ team, onNavigate }: Props) {
  return (
    <TeamLayout team={team} onNavigate={onNavigate} productView>
      <GameApp apiBase={import.meta.env.VITE_API_BASE_URL ?? team.apiPath} screens={ROOM_1_SCREENS} />
    </TeamLayout>
  );
}
