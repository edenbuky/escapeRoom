import * as git from 'isomorphic-git';
import type { ParsedCommand } from './git-command';
import { diffFileSets, type FileSet } from './git-diff';

/**
 * The commands of the embedded git terminal, implemented over isomorphic-git on an in-memory file system.
 * Nothing here touches the host: `fs` is a memfs volume. Output imitates git's own so the player's
 * muscle memory works; commands that are not listed in `helpText` are not implemented.
 */
export interface ShellContext {
  fs: any; // memfs volume (node-style fs)
  dir: string;
  author: { name: string; email: string };
}
export interface ShellOutput { stdout: string; stderr: string; exitCode: number }

class Fail extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

function formatDate(when: { timestamp: number; timezoneOffset: number }): string {
  const local = new Date((when.timestamp - when.timezoneOffset * 60) * 1000);
  const zone = -when.timezoneOffset;
  return `${days[local.getUTCDay()]} ${months[local.getUTCMonth()]} ${local.getUTCDate()} ${pad(local.getUTCHours())}:`
    + `${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${local.getUTCFullYear()} `
    + `${zone < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(zone) / 60))}${pad(Math.abs(zone) % 60)}`;
}

const text = (data: Uint8Array) => Buffer.from(data).toString('utf8');
const subject = (message: string) => message.split('\n')[0];
const short = (oid: string) => oid.slice(0, 7);
const validBranch = (name: string | undefined): name is string =>
  !!name && /^[A-Za-z0-9._/-]{1,100}$/.test(name) && !name.startsWith('-') && !name.includes('..');

async function currentBranch(ctx: ShellContext): Promise<string | undefined> {
  return (await git.currentBranch({ fs: ctx.fs, dir: ctx.dir })) ?? undefined;
}

async function headOid(ctx: ShellContext): Promise<string> {
  try { return await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: 'HEAD' }); }
  catch { throw new Fail('fatal: your current branch does not have any commits yet', 128); }
}

/** HEAD, a branch, a full or abbreviated oid, each optionally followed by ~N and ^ steps. */
async function resolveRev(ctx: ShellContext, rev: string): Promise<string> {
  const match = rev.match(/^([^~^]*)((?:~\d*|\^\d*)*)$/);
  const bad = () => new Fail(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`, 128);
  if (!match || !match[1]) throw bad();
  const [, base, steps] = match;
  let oid: string | undefined;
  if (base === 'HEAD') oid = await headOid(ctx);
  else {
    try { oid = await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/heads/${base}` }); } catch { /* not a branch */ }
    if (!oid && /^[0-9a-f]{4,40}$/.test(base)) {
      try { oid = await git.expandOid({ fs: ctx.fs, dir: ctx.dir, oid: base }); } catch { /* not an object */ }
    }
  }
  if (!oid) throw bad();
  for (const step of steps.match(/~\d*|\^\d*/g) ?? []) {
    const count = step[0] === '~' ? (step.length > 1 ? Number(step.slice(1)) : 1) : 1;
    const parent = step[0] === '^' && step.length > 1 ? Number(step.slice(1)) - 1 : 0;
    for (let i = 0; i < count; i++) {
      const { commit } = await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid });
      if (!commit.parent[parent]) throw bad();
      oid = commit.parent[parent];
    }
  }
  return oid;
}

async function decorations(ctx: ShellContext): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const add = (oid: string, name: string) => map.set(oid, [...(map.get(oid) ?? []), name]);
  const branch = await currentBranch(ctx);
  const head = await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: 'HEAD' }).catch(() => undefined);
  if (head) add(head, branch ? `HEAD -> ${branch}` : 'HEAD');
  for (const name of await git.listBranches({ fs: ctx.fs, dir: ctx.dir })) {
    if (name !== branch) add(await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/heads/${name}` }), name);
  }
  return map;
}

async function commitFiles(ctx: ShellContext, oid: string | undefined): Promise<FileSet> {
  const files: FileSet = new Map();
  if (!oid) return files;
  for (const filepath of await git.listFiles({ fs: ctx.fs, dir: ctx.dir, ref: oid })) {
    const { oid: blob, blob: data } = await git.readBlob({ fs: ctx.fs, dir: ctx.dir, oid, filepath });
    files.set(filepath, { oid: blob, text: text(data) });
  }
  return files;
}

async function indexFiles(ctx: ShellContext): Promise<FileSet> {
  const files: FileSet = new Map();
  await git.walk({ fs: ctx.fs, dir: ctx.dir, trees: [git.STAGE()], map: async (filepath, [entry]) => {
    if (filepath === '.' || !entry || await entry.type() !== 'blob') return undefined;
    files.set(filepath, { oid: await entry.oid(), text: text((await entry.content())!) });
    return undefined;
  } });
  return files;
}

async function workFiles(ctx: ShellContext, directory = ''): Promise<FileSet> {
  const files: FileSet = new Map();
  for (const name of await ctx.fs.promises.readdir(directory ? `${ctx.dir}/${directory}` : ctx.dir) as string[]) {
    if (name === '.git') continue;
    const relative = directory ? `${directory}/${name}` : name;
    if ((await ctx.fs.promises.stat(`${ctx.dir}/${relative}`)).isDirectory()) {
      for (const [path, file] of await workFiles(ctx, relative)) files.set(path, file);
    } else {
      const content = (await ctx.fs.promises.readFile(`${ctx.dir}/${relative}`)) as Buffer;
      files.set(relative, { oid: (await git.hashBlob({ object: content })).oid, text: content.toString('utf8') });
    }
  }
  return files;
}

async function commitHeader(ctx: ShellContext, oid: string, decor: Map<string, string[]>): Promise<string> {
  const { commit } = await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid });
  const names = decor.get(oid);
  const body = commit.message.replace(/\n+$/, '').split('\n').map(line => (line ? `    ${line}` : '')).join('\n');
  return `commit ${oid}${names ? ` (${names.join(', ')})` : ''}\nAuthor: ${commit.author.name} <${commit.author.email}>\n`
    + `Date:   ${formatDate(commit.author)}\n\n${body}\n`;
}

async function commitPatch(ctx: ShellContext, oid: string, paths?: string[]): Promise<string> {
  const { commit } = await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid });
  return diffFileSets(await commitFiles(ctx, commit.parent[0]), await commitFiles(ctx, oid), paths);
}

function splitOptions(args: string[]): { flags: string[]; operands: string[]; paths: string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  const index = args.indexOf('--');
  for (const arg of index >= 0 ? args.slice(0, index) : args) (arg.startsWith('-') && arg.length > 1 ? flags : operands).push(arg);
  return { flags, operands, paths: index >= 0 ? args.slice(index + 1) : [] };
}

function unknown(flag: string): never {
  throw new Fail(`error: unknown option '${flag}'`, 129);
}

async function log(ctx: ShellContext, args: string[]): Promise<string> {
  const dashes = args.indexOf('--');
  const paths = dashes >= 0 ? args.slice(dashes + 1) : [];
  const words = dashes >= 0 ? args.slice(0, dashes) : args;
  let oneline = false;
  let patch = false;
  let max = Infinity;
  const operands: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let count: string | undefined;
    if (word === '--oneline') oneline = true;
    else if (word === '-p' || word === '--patch') patch = true;
    else if (word === '--no-patch' || word === '-s') patch = false;
    else if (word === '-n') count = words[++i] ?? '';
    else if (/^-n\d+$/.test(word)) count = word.slice(2);
    else if (/^--max-count=/.test(word)) count = word.slice(12);
    else if (/^-\d+$/.test(word)) count = word.slice(1);
    else if (word.startsWith('-') && word.length > 1) unknown(word);
    else operands.push(word);
    if (count !== undefined) {
      if (!/^\d+$/.test(count)) throw new Fail(`fatal: '${count}' is not a number`, 128);
      max = Number(count);
    }
  }
  if (operands.length > 1) throw new Fail('fatal: only one revision is supported', 128);
  let oid: string | undefined = await resolveRev(ctx, operands[0] ?? 'HEAD');
  const decor = await decorations(ctx);
  const entries: string[] = [];
  while (oid && entries.length < max) {
    const current: string = oid;
    const { commit } = await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid: current });
    oid = commit.parent[0];
    if (paths.length && !(await commitPatch(ctx, current, paths))) continue;
    if (oneline) {
      const names = decor.get(current);
      entries.push(`${short(current)}${names ? ` (${names.join(', ')})` : ''} ${subject(commit.message)}\n`);
    } else {
      const header = await commitHeader(ctx, current, decor);
      entries.push(patch ? `${header}\n${await commitPatch(ctx, current, paths)}` : header);
    }
  }
  return oneline || patch ? entries.join('') : entries.join('\n');
}

async function show(ctx: ShellContext, args: string[]): Promise<string> {
  const { flags, operands } = splitOptions(args);
  for (const flag of flags) if (flag !== '--no-patch' && flag !== '-s') unknown(flag);
  if (operands.length > 1) throw new Fail('fatal: only one object is supported', 128);
  const target = operands[0] ?? 'HEAD';
  const colon = target.indexOf(':');
  if (colon >= 0) {
    const filepath = target.slice(colon + 1).replace(/^\.\//, '');
    if (!filepath) throw new Fail(`fatal: path '${target.slice(colon + 1)}' is not a file`, 128);
    if (colon === 0) {
      const file = (await indexFiles(ctx)).get(filepath);
      if (!file) throw new Fail(`fatal: path '${filepath}' is in neither the index nor the working tree`, 128);
      return file.text;
    }
    const oid = await resolveRev(ctx, target.slice(0, colon));
    try {
      return text((await git.readBlob({ fs: ctx.fs, dir: ctx.dir, oid, filepath })).blob);
    } catch {
      throw new Fail(`fatal: path '${filepath}' does not exist in '${target.slice(0, colon)}'`, 128);
    }
  }
  const oid = await resolveRev(ctx, target);
  const header = await commitHeader(ctx, oid, await decorations(ctx));
  return flags.length ? header : `${header}\n${await commitPatch(ctx, oid)}`;
}

async function diff(ctx: ShellContext, args: string[]): Promise<string> {
  const { flags, operands, paths } = splitOptions(args);
  let cached = false;
  for (const flag of flags) if (flag === '--cached' || flag === '--staged') cached = true; else unknown(flag);
  let revs = operands;
  if (revs.length === 1 && revs[0].includes('..')) revs = revs[0].split(/\.\.\.?/);
  if (revs.length > 2 || (revs.length && cached)) throw new Fail('fatal: unsupported combination of diff arguments', 128);
  if (revs.length === 2) {
    const [a, b] = [await resolveRev(ctx, revs[0]), await resolveRev(ctx, revs[1])];
    return diffFileSets(await commitFiles(ctx, a), await commitFiles(ctx, b), paths);
  }
  if (revs.length === 1) return diffFileSets(await commitFiles(ctx, await resolveRev(ctx, revs[0])), await workFiles(ctx), paths);
  if (cached) {
    const head = await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: 'HEAD' }).catch(() => undefined);
    return diffFileSets(await commitFiles(ctx, head), await indexFiles(ctx), paths);
  }
  const tracked = await indexFiles(ctx);
  const work = await workFiles(ctx);
  for (const name of [...work.keys()]) if (!tracked.has(name)) work.delete(name);
  return diffFileSets(tracked, work, paths);
}

async function status(ctx: ShellContext): Promise<string> {
  const branch = await currentBranch(ctx);
  const head = await headOid(ctx);
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const [file, inHead, inWork, inIndex] of await git.statusMatrix({ fs: ctx.fs, dir: ctx.dir })) {
    if (inHead === 0 && inIndex > 0) staged.push(`new file:   ${file}`);
    else if (inHead === 1 && inIndex === 0) staged.push(`deleted:    ${file}`);
    else if (inHead === 1 && inIndex !== 1) staged.push(`modified:   ${file}`);
    if (inIndex > 0 && inWork === 0) unstaged.push(`deleted:    ${file}`);
    else if (inIndex > 0 && inWork === 2 && inIndex !== 2) unstaged.push(`modified:   ${file}`);
    else if (inIndex === 0 && inWork > 0) untracked.push(file);
  }
  const lines = [branch ? `On branch ${branch}` : `HEAD detached at ${short(head)}`];
  const section = (title: string, hints: string[], items: string[]) => {
    if (items.length) lines.push('', title, ...hints.map(hint => `  (${hint})`), ...items.map(item => `\t${item}`));
  };
  section('Changes to be committed:', ['use "git restore --staged <file>..." to unstage'], staged);
  section('Changes not staged for commit:', ['use "git add <file>..." to update what will be committed',
    'use "git restore <file>..." to discard changes in working directory'], unstaged);
  section('Untracked files:', ['use "git add <file>..." to include in what will be committed'], untracked);
  if (!staged.length && !unstaged.length && !untracked.length) lines.push('nothing to commit, working tree clean');
  else if (!staged.length) {
    lines.push('', unstaged.length ? 'no changes added to commit (use "git add" and/or "git commit -a")'
      : 'nothing added to commit but untracked files present (use "git add" to track)');
  }
  return `${lines.join('\n')}\n`;
}

async function branch(ctx: ShellContext, args: string[]): Promise<string> {
  const { flags, operands } = splitOptions(args);
  let verbose = false;
  let remove = false;
  for (const flag of flags) {
    if (flag === '-v' || flag === '-vv' || flag === '--verbose') verbose = true;
    else if (flag === '-d' || flag === '-D' || flag === '--delete') remove = true;
    else if (!['-a', '--all', '--list', '-l'].includes(flag)) unknown(flag);
  }
  const current = await currentBranch(ctx);
  if (remove) {
    if (!operands.length) throw new Fail('fatal: branch name required', 128);
    const out: string[] = [];
    for (const name of operands) {
      if (name === current) throw new Fail(`error: cannot delete branch '${name}' used by worktree`, 1);
      let oid: string;
      try { oid = await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/heads/${name}` }); }
      catch { throw new Fail(`error: branch '${name}' not found.`, 1); }
      await git.deleteBranch({ fs: ctx.fs, dir: ctx.dir, ref: name });
      out.push(`Deleted branch ${name} (was ${short(oid)}).`);
    }
    return `${out.join('\n')}\n`;
  }
  if (operands.length) {
    if (operands.length > 2) throw new Fail('fatal: too many arguments', 128);
    const name = operands[0];
    if (!validBranch(name)) throw new Fail(`fatal: '${name}' is not a valid branch name`, 128);
    if ((await git.listBranches({ fs: ctx.fs, dir: ctx.dir })).includes(name)) {
      throw new Fail(`fatal: a branch named '${name}' already exists`, 128);
    }
    await git.branch({ fs: ctx.fs, dir: ctx.dir, ref: name, object: operands[1] ? await resolveRev(ctx, operands[1]) : await headOid(ctx) });
    return '';
  }
  const lines: string[] = [];
  const head = await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: 'HEAD' }).catch(() => undefined);
  const describe = async (oid: string) =>
    `${short(oid)} ${subject((await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid })).commit.message)}`;
  if (!current && head) lines.push(`* (HEAD detached at ${short(head)})${verbose ? ` ${await describe(head)}` : ''}`);
  for (const name of (await git.listBranches({ fs: ctx.fs, dir: ctx.dir })).sort()) {
    const oid = await git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/heads/${name}` });
    lines.push(`${name === current ? '*' : ' '} ${name}${verbose ? ` ${await describe(oid)}` : ''}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

async function stage(ctx: ShellContext, trackedOnly: boolean, paths: string[]): Promise<void> {
  const matches = (file: string) => !paths.length || paths.includes('.')
    || paths.some(path => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`));
  for (const [file, , inWork, inIndex] of await git.statusMatrix({ fs: ctx.fs, dir: ctx.dir })) {
    if (!matches(file)) continue;
    if (inWork === 0) { if (inIndex > 0) await git.remove({ fs: ctx.fs, dir: ctx.dir, filepath: file }); }
    else if (!(trackedOnly && inIndex === 0)) await git.add({ fs: ctx.fs, dir: ctx.dir, filepath: file });
  }
}

async function add(ctx: ShellContext, args: string[]): Promise<string> {
  const { flags, operands, paths } = splitOptions(args);
  for (const flag of flags) if (!['-A', '--all', '-u'].includes(flag)) unknown(flag);
  const targets = [...operands, ...paths];
  if (!targets.length && !flags.length) throw new Fail("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?", 0);
  const known = new Set([...(await workFiles(ctx)).keys(), ...(await indexFiles(ctx)).keys()]);
  for (const target of targets) {
    if (target !== '.' && ![...known].some(file => file === target || file.startsWith(`${target.replace(/\/$/, '')}/`))) {
      throw new Fail(`fatal: pathspec '${target}' did not match any files`, 128);
    }
  }
  await stage(ctx, flags.includes('-u'), targets.length ? targets : ['.']);
  return '';
}

async function commit(ctx: ShellContext, args: string[]): Promise<string> {
  const messages: string[] = [];
  let all = false;
  let empty = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-empty') empty = true;
    else if (arg === '-a' || arg === '--all') all = true;
    else if (arg === '-m' || arg === '--message' || arg === '-am') {
      if (arg === '-am') all = true;
      if (i + 1 >= args.length) throw new Fail(`error: switch \`m' requires a value`, 129);
      messages.push(args[++i]);
    } else if (arg.startsWith('--message=')) messages.push(arg.slice(10));
    else if (arg.startsWith('-m') && arg.length > 2) messages.push(arg.slice(2));
    else unknown(arg);
  }
  const message = messages.join('\n\n').trim();
  if (!message) throw new Fail('Aborting commit due to empty commit message.', 1);
  if (all) await stage(ctx, true, []);
  const changed = (await git.statusMatrix({ fs: ctx.fs, dir: ctx.dir })).some(([, inHead, , inIndex]) =>
    inHead === 0 ? inIndex > 0 : inIndex !== 1);
  if (!changed && !empty) throw new Fail((await status(ctx)).trimEnd(), 1);
  const name = await currentBranch(ctx);
  const oid = await git.commit({ fs: ctx.fs, dir: ctx.dir, message, author: ctx.author, committer: ctx.author });
  return `[${name ?? 'detached HEAD'} ${short(oid)}] ${subject(message)}\n`;
}

async function restorePaths(ctx: ShellContext, oid: string, targets: string[]): Promise<string> {
  const files = await commitFiles(ctx, oid);
  const restored = new Set<string>();
  for (const target of targets) {
    const clean = target.replace(/^\.\//, '').replace(/\/$/, '');
    const hits = [...files.keys()].filter(file => clean === '.' || file === clean || file.startsWith(`${clean}/`));
    if (!hits.length) throw new Fail(`error: pathspec '${target}' did not match any file(s) known to git`, 1);
    for (const file of hits) restored.add(file);
  }
  for (const file of restored) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) await ctx.fs.promises.mkdir(`${ctx.dir}/${parts.slice(0, i).join('/')}`).catch(() => undefined);
    await ctx.fs.promises.writeFile(`${ctx.dir}/${file}`, Buffer.from(files.get(file)!.text, 'utf8'));
    await git.add({ fs: ctx.fs, dir: ctx.dir, filepath: file });
  }
  return `Updated ${restored.size} path${restored.size === 1 ? '' : 's'} from ${short(oid)}\n`;
}

async function switchTo(ctx: ShellContext, ref: string): Promise<void> {
  try {
    await git.checkout({ fs: ctx.fs, dir: ctx.dir, ref });
  } catch (error) {
    const files = (error as { data?: { filepaths?: string[] } }).data?.filepaths;
    if (!files) throw error;
    throw new Fail(`error: Your local changes to the following files would be overwritten by checkout:\n${files.map(file => `\t${file}`).join('\n')}\n`
      + 'Please commit your changes or stash them before you switch branches.\nAborting', 1);
  }
}

async function checkout(ctx: ShellContext, args: string[]): Promise<string> {
  const dashes = args.indexOf('--');
  const before = dashes >= 0 ? args.slice(0, dashes) : args;
  const after = dashes >= 0 ? args.slice(dashes + 1) : [];
  if (before[0] === '-b') {
    const name = before[1];
    if (!validBranch(name)) throw new Fail(`fatal: '${name ?? ''}' is not a valid branch name`, 128);
    if ((await git.listBranches({ fs: ctx.fs, dir: ctx.dir })).includes(name)) {
      throw new Fail(`fatal: a branch named '${name}' already exists`, 128);
    }
    await git.branch({ fs: ctx.fs, dir: ctx.dir, ref: name, object: before[2] ? await resolveRev(ctx, before[2]) : await headOid(ctx) });
    await switchTo(ctx, name);
    return `Switched to a new branch '${name}'\n`;
  }
  for (const arg of before) if (arg.startsWith('-')) unknown(arg);
  if (!before.length && !after.length) throw new Fail('error: you must specify a branch, a revision or paths', 1);
  if (!before.length) return restorePaths(ctx, await headOid(ctx), after);
  const [target, ...rest] = before;
  const paths = [...rest, ...after];
  if (paths.length) return restorePaths(ctx, await resolveRev(ctx, target), paths);
  if ((await git.listBranches({ fs: ctx.fs, dir: ctx.dir })).includes(target)) {
    if (target === await currentBranch(ctx)) return `Already on '${target}'\n`;
    await switchTo(ctx, target);
    return `Switched to branch '${target}'\n`;
  }
  let oid: string;
  try { oid = await resolveRev(ctx, target); }
  catch { throw new Fail(`error: pathspec '${target}' did not match any file(s) known to git`, 1); }
  await switchTo(ctx, oid);
  const { commit: detached } = await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid });
  return `Note: switching to '${target}'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\n`
    + 'changes and commit them, and you can discard any commits you make in this\nstate without impacting any branches by switching back to a branch.\n\n'
    + `HEAD is now at ${short(oid)} ${subject(detached.message)}\n`;
}

async function reset(ctx: ShellContext, args: string[]): Promise<string> {
  const { flags, operands, paths } = splitOptions(args);
  let mode: 'soft' | 'mixed' | 'hard' = 'mixed';
  for (const flag of flags) {
    if (flag === '--soft') mode = 'soft'; else if (flag === '--mixed') mode = 'mixed'; else if (flag === '--hard') mode = 'hard';
    else unknown(flag);
  }
  let target = 'HEAD';
  let pathspec = paths;
  if (operands.length) {
    try { await resolveRev(ctx, operands[0]); target = operands[0]; pathspec = [...operands.slice(1), ...paths]; }
    catch (error) { if (paths.length) throw error; pathspec = operands; }
  }
  const oid = await resolveRev(ctx, target);
  const files = await commitFiles(ctx, oid);
  if (pathspec.length) {
    if (mode !== 'mixed') throw new Fail(`fatal: Cannot do ${mode} reset with paths.`, 128);
    const known = [...new Set([...files.keys(), ...(await indexFiles(ctx)).keys()])];
    for (const path of pathspec) {
      const hits = known.filter(file => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`));
      if (!hits.length) throw new Fail(`fatal: ambiguous argument '${path}': unknown revision or path not in the working tree.`, 128);
      for (const file of hits) await git.resetIndex({ fs: ctx.fs, dir: ctx.dir, filepath: file, ref: oid });
    }
    return '';
  }
  const name = await currentBranch(ctx);
  await git.writeRef({ fs: ctx.fs, dir: ctx.dir, ref: name ? `refs/heads/${name}` : 'HEAD', value: oid, force: true });
  if (mode === 'soft') return '';
  if (mode === 'hard') {
    await git.checkout({ fs: ctx.fs, dir: ctx.dir, ref: name ?? oid, force: true });
    const { commit: now } = await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid });
    return `HEAD is now at ${short(oid)} ${subject(now.message)}\n`;
  }
  for (const [file] of await git.statusMatrix({ fs: ctx.fs, dir: ctx.dir })) {
    await git.resetIndex({ fs: ctx.fs, dir: ctx.dir, filepath: file, ref: oid });
  }
  const lines: string[] = [];
  for (const [file, inHead, inWork, inIndex] of await git.statusMatrix({ fs: ctx.fs, dir: ctx.dir })) {
    if (inHead === 1 && inIndex === 1 && inWork === 0) lines.push(`D\t${file}`);
    else if (inHead === 1 && inIndex === 1 && inWork === 2) lines.push(`M\t${file}`);
  }
  return lines.length ? `Unstaged changes after reset:\n${lines.join('\n')}\n` : '';
}

export const helpText = `Commands available in this terminal:
  git log [--oneline] [-p] [-n N] [<rev>] [-- <path>]
  git show <rev> | git show <rev>:<path>
  git status | git diff [<rev> [<rev>]] [--cached]
  git branch [<name>] | git checkout <rev|branch> | git checkout <rev> -- <path>
  git add <path> | git commit [--allow-empty] -m <message> | git reset [--soft|--mixed|--hard] [<rev>]
  ls [path] | cat <path> | pwd | help
`;

/** Paths are relative to the repository; `..` may not climb above it. */
function safePath(raw: string): string {
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Fail(`${raw}: No such file or directory`, 2); parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

async function listDirectory(ctx: ShellContext, args: string[]): Promise<string> {
  const { flags, operands } = splitOptions(args);
  const all = flags.some(flag => /^-[A-Za-z]*a/.test(flag));
  const targets = operands.length ? operands : ['.'];
  const out: string[] = [];
  for (const target of targets) {
    const relative = safePath(target);
    const full = relative ? `${ctx.dir}/${relative}` : ctx.dir;
    let stat;
    try { stat = await ctx.fs.promises.stat(full); } catch { throw new Fail(`ls: cannot access '${target}': No such file or directory`, 2); }
    const names: string[] = stat.isDirectory() ? await ctx.fs.promises.readdir(full) as string[] : [target];
    if (targets.length > 1) out.push(`${target}:`);
    out.push(...names.filter(name => all || !name.startsWith('.')).sort());
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

async function concatenate(ctx: ShellContext, args: string[]): Promise<ShellOutput> {
  for (const flag of args.filter(arg => arg.startsWith('-') && arg !== '-')) unknown(flag);
  if (!args.length) throw new Fail('cat: missing file operand', 1);
  let stdout = '';
  let stderr = '';
  for (const file of args) {
    try {
      const full = `${ctx.dir}/${safePath(file)}`;
      if ((await ctx.fs.promises.stat(full)).isDirectory()) { stderr += `cat: ${file}: Is a directory\n`; continue; }
      stdout += text(await ctx.fs.promises.readFile(full) as Buffer);
    } catch {
      stderr += `cat: ${file}: No such file or directory\n`;
    }
  }
  return { stdout, stderr, exitCode: stderr ? 1 : 0 };
}

export async function runCommand(ctx: ShellContext, parsed: Extract<ParsedCommand, { ok: true }>): Promise<ShellOutput> {
  const ok = (stdout: string): ShellOutput => ({ stdout, stderr: '', exitCode: 0 });
  try {
    if (parsed.program === 'pwd') return ok(`${ctx.dir}\n`);
    if (parsed.program === 'help') return ok(helpText);
    if (parsed.program === 'ls') return ok(await listDirectory(ctx, parsed.args));
    if (parsed.program === 'cat') return await concatenate(ctx, parsed.args);
    if (parsed.program !== 'git') throw new Fail(`${parsed.program}: command not found`, 127);
    const [subcommand, ...args] = parsed.args;
    switch (subcommand) {
      case undefined: return ok(helpText);
      case 'log': return ok(await log(ctx, args));
      case 'show': return ok(await show(ctx, args));
      case 'status': return ok(await status(ctx));
      case 'diff': return ok(await diff(ctx, args));
      case 'branch': return ok(await branch(ctx, args));
      case 'add': return ok(await add(ctx, args));
      case 'commit': return ok(await commit(ctx, args));
      case 'checkout': return ok(await checkout(ctx, args));
      case 'reset': return ok(await reset(ctx, args));
      default: throw new Fail(`git: '${subcommand}' is not a git command.`, 1);
    }
  } catch (error) {
    if (error instanceof Fail) return { stdout: '', stderr: `${error.message}\n`, exitCode: error.exitCode };
    return { stdout: '', stderr: 'fatal: the command could not be completed\n', exitCode: 128 };
  }
}
