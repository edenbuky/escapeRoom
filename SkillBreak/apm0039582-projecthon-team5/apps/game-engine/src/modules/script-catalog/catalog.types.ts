import type { RoomFile } from '@team5/contracts';

export interface PuzzleDef {
  key: string; templateRef: string; opensAfter: string[]; onRuin: 'resetPuzzle' | 'resetRoom'; hint?: string;
}
export interface TransitionDef { on: 'AllSolved'; to: string }
/** A room file; revealedBy (a puzzle key) is catalog-only and is never part of the RoomFile view. */
export interface CatalogFile extends RoomFile { revealedBy?: string }
/** Where the room's door leads and the puzzle whose solve unlocks it. */
export interface DoorDef { to: string; unlockedBy: string }
export interface StateDef {
  key: string; files: CatalogFile[]; puzzles: PuzzleDef[]; transitions: TransitionDef[]; door?: DoorDef;
}
export interface ScriptVersionDto {
  scriptId: string; version: number; durationMinutes: number; initialState: string;
  finalStates: string[]; states: StateDef[];
}
export interface SqlTemplateDefinition {
  imageDigest: string; seedRef: string;
  policy: { readOnly: boolean; singleStatement: boolean; maxQueryChars: number };
  goal: { type: 'resultContains'; value: string }; inputSchema: Record<string, unknown>;
}
export interface TerminalGitTemplateDefinition {
  imageDigest: string; seedRef: string;
  policy: { allowedCommands: string[]; allowedGitSubcommands: string[]; singleCommand: boolean; maxCommandChars: number };
  goal: { type: 'resultContains'; value: string };
  invariants: {
    branch: string; headOid: string; headMessage: string; keyCommitOid: string; keyPath: string; keyRevision: string; workingDirectory: string;
  };
  inputSchema: Record<string, unknown>;
}
export interface RsaTemplateDefinition {
  seed: { modulusHex: string; publicExponent: number; encryptedPmsHex: string; expectedPmsHex: string };
  inputSchema: Record<string, unknown>;
}
export interface TlsTemplateDefinition {
  seed: {
    cipherSuite: string; cipherSuiteId: string; clientRandomHex: string; serverRandomHex: string;
    records: { direction: 'client' | 'server'; contentType: number; sequence: number; fragmentHex: string }[];
    decryptedCapture: string;
  };
  inputSchema: Record<string, unknown>;
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
  | { family: 'sandbox'; engine: 'terminal-git'; definition: TerminalGitTemplateDefinition }
  | { family: 'input'; engine: 'rsa'; definition: RsaTemplateDefinition }
  | { family: 'input'; engine: 'tls'; definition: TlsTemplateDefinition }
);