import type { ComponentType } from 'react';
import type { TeamService } from '../teams';
import Team1Page from './team1';
import Team2Page from './team2';
import Team3Page from './team3';
import Team4Page from './team4';
import Team5Page from './team5';
import Team6Page from './team6';
import Team7Page from './team7';
import Tdp2026Page from './tdp-2026';

export interface TeamPageProps {
  team: TeamService;
  onNavigate: (to: string) => void;
}

/** Maps a team id to the page component owned by that team's directory. */
export const TEAM_PAGES: Record<string, ComponentType<TeamPageProps>> = {
  team1: Team1Page,
  team2: Team2Page,
  team3: Team3Page,
  team4: Team4Page,
  team5: Team5Page,
  team6: Team6Page,
  team7: Team7Page,
  'tdp-2026': Tdp2026Page,
};
