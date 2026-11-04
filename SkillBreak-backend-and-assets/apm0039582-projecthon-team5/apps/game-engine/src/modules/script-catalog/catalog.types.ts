import type { RoomFile } from '@team5/contracts';

export interface PuzzleDef {
  key: string; templateRef: string; opensAfter: string[]; onRuin: 'resetPuzzle' | 'resetRoom';
}
export interface TransitionDef { on: 'AllSolved'; to: string }
export interface StateDef { key: string; files: RoomFile[]; puzzles: PuzzleDef[]; transitions: TransitionDef[] }
export interface ScriptVersionDto {
  scriptId: string; version: number; durationMinutes: number; initialState: string;
  finalStates: string[]; states: StateDef[];
}
export interface SqlTemplateDefinition {
  imageDigest: string; seedRef: string;
  policy: { readOnly: boolean; singleStatement: boolean; maxQueryChars: number };
  goal: { type: 'resultContains'; value: string }; inputSchema: Record<string, unknown>;
}
export interface HashTemplateDefinition {
  seed: { expectedHashHex: string; revealedPassword: string }; inputSchema: Record<string, unknown>;
}
export interface AnswerTemplateDefinition {
  seed: { fields: Record<string, string> }; inputSchema: Record<string, unknown>;
}
export type ComponentTemplateDto = { key: string; version: number } & (
  | { family: 'sandbox'; engine: 'sql'; definition: SqlTemplateDefinition }
  | { family: 'input'; engine: 'hash'; definition: HashTemplateDefinition }
  | { family: 'input'; engine: 'answer'; definition: AnswerTemplateDefinition }
);