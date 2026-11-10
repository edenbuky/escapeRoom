import { readFileSync } from 'node:fs';
import { EmbeddedGit } from '../src/modules/sandbox/embedded-git';
import { parseCommandLine, type GitPolicy } from '../src/modules/sandbox/git-command';
import { room2GitFixture } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';

jest.setTimeout(60000);

const policy: GitPolicy = { allowedCommands: ['git', 'ls', 'cat', 'pwd', 'help'], maxCommandChars: 4096,
  allowedGitSubcommands: ['log', 'show', 'status', 'diff', 'branch', 'add', 'commit', 'checkout', 'reset'] };
const fixture = JSON.parse(readFileSync(room2GitFixture, 'utf8')) as { commits: { oid: string; message: string }[] };
const head = fixture.commits[fixture.commits.length - 1];

describe('git command policy', () => {
  test.each(['vim', 'less README.md', 'curl http://x', 'ssh host', 'git log | cat', 'git log > out', 'git log; ls', 'ls && ls',
    'echo `ls`', 'cat $(ls)', 'git push', 'git clone x', 'git config user.name x', 'rm -rf /', '', '   ', 'git log &', 'cat <x'])(
    'blocks %p', line => expect(parseCommandLine(line, policy)).toEqual({ ok: false, kind: 'blocked' }));
  test('accepts one plain command, quotes and the pager flag', () => {
    expect(parseCommandLine('git --no-pager log --oneline -n 2', policy)).toEqual({ ok: true, program: 'git', args: ['log', '--oneline', '-n', '2'] });
    expect(parseCommandLine('git commit --allow-empty -m "a b  c"', policy)).toEqual({ ok: true, program: 'git', args: ['commit', '--allow-empty', '-m', 'a b  c'] });
    expect(parseCommandLine('git commit -m "oops', policy)).toMatchObject({ ok: false, kind: 'syntax' });
  });
  test('honours the template limits', () => {
    expect(parseCommandLine('ls', { ...policy, allowedCommands: ['git'] })).toEqual({ ok: false, kind: 'blocked' });
    expect(parseCommandLine(`git log ${'a'.repeat(5000)}`, policy)).toEqual({ ok: false, kind: 'blocked' });
  });
});

describe('embedded git sandbox', () => {
  const sandbox = new EmbeddedGit(policy);
  afterAll(() => sandbox.close());
  const run = async (command: string) => {
    const result = await sandbox.run({ type: 'run', command, limit: 65536 }, 5000);
    if (result === 'timeout' || !('stdout' in result)) throw new Error('unexpected');
    return result;
  };

  test('rebuilds the fixture history with the same oids', async () => {
    expect(await sandbox.start()).toBe(head.oid);
    const inspect = await sandbox.run({ type: 'inspect' }, 5000);
    expect(inspect).toMatchObject({ head: head.oid, branch: 'main', headMessage: head.message });
  });

  test('git log, --oneline, -n and -p', async () => {
    const full = await run('git log');
    expect(full.stdout).toContain(`commit ${head.oid} (HEAD -> main)`);
    expect(full.stdout).toContain('    Security fix: Removed private key from repository.');
    expect(full.stdout).toMatch(/Date:   \w{3} \w{3} \d+ \d\d:\d\d:\d\d 2026 \+0300/);
    expect((await run('git log --oneline')).stdout.split('\n').filter(Boolean)).toHaveLength(5);
    expect((await run('git log --oneline')).stdout.split('\n')[0]).toBe(`${head.oid.slice(0, 7)} (HEAD -> main) ${head.message}`);
    expect((await run('git log --oneline -n 2')).stdout.split('\n').filter(Boolean)).toHaveLength(2);
    expect((await run('git log -2 --oneline')).stdout.split('\n').filter(Boolean)).toHaveLength(2);
    const patch = (await run('git log -p -n 1')).stdout;
    expect(patch).toContain('diff --git a/server.key b/server.key');
    expect(patch).toContain('deleted file mode 100644');
    expect(patch).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(patch).not.toContain(room2Scenario.privateKeyPem.trimEnd());
  });

  test('git show <rev>:<path> prints the removed private key, in every revision spelling', async () => {
    const key = room2Scenario.privateKeyPem.trimEnd();
    for (const spec of ['HEAD~1', fixture.commits[3].oid, fixture.commits[3].oid.slice(0, 7), 'HEAD^']) {
      const result = await run(`git show ${spec}:server.key`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(key);
    }
    expect((await run('git show HEAD:server.key')).stderr).toContain("does not exist in 'HEAD'");
    expect((await run('git show HEAD~9')).stderr).toContain('unknown revision');
    expect((await run('git show HEAD')).stdout).toContain('Security fix: Removed private key');
    expect((await run('git show HEAD~1')).stdout).not.toContain('PRIVATE KEY');
  });

  test('git diff between two revisions', async () => {
    const result = await run('git diff HEAD~1 HEAD');
    expect(result.stdout).toContain('--- a/server.key');
    expect(result.stdout).toContain('+++ /dev/null');
    expect(result.stdout).toContain('@@ -1,');
    const readme = (await run('git diff HEAD~4 HEAD~1 -- README.md')).stdout;
    expect(readme).toContain('--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,7 @@\n # Cibus payments client\n');
    expect(readme).toContain('+## Local TLS test\n+\n+Use server.key');
    expect(readme).not.toContain('server.key b/server.key');
    expect((await run('git diff HEAD HEAD')).stdout).toBe('');
  });

  test('status, ls, cat, pwd, help, branch', async () => {
    expect((await run('git status')).stdout).toBe('On branch main\nnothing to commit, working tree clean\n');
    expect((await run('ls')).stdout).toBe('README.md\npayments.js\n');
    expect((await run('ls -a')).stdout).toContain('.git');
    expect((await run('cat README.md')).stdout).toContain('Cibus payments client');
    expect((await run('cat server.key')).stderr).toContain('No such file or directory');
    expect((await run('cat ../../etc/passwd')).exitCode).toBe(1);
    expect((await run('pwd')).stdout).toBe('/home/netanel/project_cibus_payment\n');
    expect((await run('help')).stdout).toContain('git log');
    expect((await run('git branch')).stdout).toBe('* main\n');
  });

  test('checkout of an old revision brings the key back and detaches HEAD', async () => {
    const result = await run('git checkout HEAD~1');
    expect(result.stdout).toContain('HEAD is now at 66d7591 Document local TLS test setup');
    expect((await run('ls')).stdout).toContain('server.key');
    expect((await run('cat server.key')).stdout).toContain(room2Scenario.privateKeyPem.trimEnd());
    expect((await run('git status')).stdout).toContain('HEAD detached at 66d7591');
    expect((await run('git branch')).stdout).toBe('* (HEAD detached at 66d7591)\n  main\n');
    expect((await run('git checkout main')).stdout).toBe("Switched to branch 'main'\n");
    expect((await run('ls')).stdout).toBe('README.md\npayments.js\n');
  });

  test('checkout <rev> -- <path> restores one file and stages it', async () => {
    expect((await run('git checkout HEAD~1 -- server.key')).stdout).toBe('Updated 1 path from 66d7591\n');
    expect((await run('cat server.key')).stdout).toContain(room2Scenario.privateKeyPem.trimEnd());
    expect((await run('git status')).stdout).toContain('new file:   server.key');
    expect((await run('git checkout HEAD~1 -- nothing.txt')).exitCode).toBe(1);
    await run('git reset --hard');
    expect((await run('git status')).stdout).toContain('nothing to commit');
  });

  test('commit, reset and a moved HEAD stay observable through inspect', async () => {
    expect((await run('git commit -m x')).stderr).toContain('nothing to commit');
    const empty = await run('git commit --allow-empty -m "Ruin it"');
    expect(empty.stdout).toMatch(/^\[main [0-9a-f]{7}\] Ruin it\n$/);
    const moved = await sandbox.run({ type: 'inspect' }, 5000);
    expect(moved).toMatchObject({ headMessage: 'Ruin it' });
    expect((moved as { head: string }).head).not.toBe(head.oid);
    expect((await run('git reset --hard HEAD~1')).stdout).toContain(`HEAD is now at ${head.oid.slice(0, 7)}`);
    expect(await sandbox.run({ type: 'inspect' }, 5000)).toMatchObject({ head: head.oid });
    await run('git reset --hard HEAD~2');
    expect((await run('ls')).stdout).toContain('server.key');
    expect((await run('git log --oneline')).stdout.split('\n').filter(Boolean)).toHaveLength(3);
    await run(`git reset --hard ${head.oid}`);
    expect(await sandbox.run({ type: 'inspect' }, 5000)).toMatchObject({ head: head.oid });
  });

  test('edits can be added and committed, and diff shows them', async () => {
    expect((await run('git checkout -b notes')).stdout).toContain("Switched to a new branch 'notes'");
    expect((await run('git branch')).stdout).toBe('  main\n* notes\n');
    await run('git checkout main');
    expect((await run('git branch -d notes')).stdout).toContain('Deleted branch notes');
  });

  test('rejects unsupported options without crashing', async () => {
    expect((await run('git log --graph')).stderr).toContain("unknown option '--graph'");
    expect((await run('git frobnicate')).exitCode).toBe(126);
  });

  test('caps the output at the limit', async () => {
    const result = await sandbox.run({ type: 'run', command: 'git log -p', limit: 200 }, 5000);
    expect(result).toMatchObject({ truncated: true, exitCode: null });
    expect(Buffer.byteLength((result as { stdout: string }).stdout)).toBeLessThanOrEqual(200);
  });

  test('a command that overruns is stopped and the sandbox restarts from the fixture', async () => {
    await run('git commit --allow-empty -m "before timeout"');
    expect(await sandbox.run({ type: 'sleep', ms: 4000 }, 300)).toBe('timeout');
    expect(await sandbox.run({ type: 'inspect' }, 5000)).toMatchObject({ head: head.oid });
  });
});
