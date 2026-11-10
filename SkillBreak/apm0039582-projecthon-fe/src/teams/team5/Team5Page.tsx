import type { TeamService } from '../../teams';
import TeamLayout from '../TeamLayout';
import GameApp from './game/GameApp';
import { ROOM_1_SCREENS, ROOM_2_SCREENS } from './game/screens';

/** Puzzle keys never repeat across rooms, so one registry serves the whole game. */
const ALL_SCREENS = { ...ROOM_1_SCREENS, ...ROOM_2_SCREENS };

interface Props {
  team: TeamService;
  onNavigate: (to: string) => void;
}

export default function Team5Page({ team, onNavigate }: Props) {
  return (
    <TeamLayout team={team} onNavigate={onNavigate}>
      <GameApp apiBase={import.meta.env.VITE_API_BASE_URL ?? team.apiPath} screens={ALL_SCREENS} />
    </TeamLayout>
  );
}
