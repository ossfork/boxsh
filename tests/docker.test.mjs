/**
 * docker.test.mjs — container-engine contract tests.
 *
 * These tests assert boxsh's Docker self-adaptation: when running inside a
 * container, boxsh switches to the "container sandbox engine" (skips
 * CLONE_NEWUSER, routes COW through fuse-overlayfs) while keeping the full
 * namespace isolation (CLONE_NEWNS + CLONE_NEWPID + pivot_root + seccomp).
 *
 * The entire file skips automatically when not running inside a container, so
 * it is safe to include from tests/index.test.mjs on the host CI matrix.
 *
 * Required container privileges (provided by tests/docker-test.sh):
 *   --cap-add SYS_ADMIN --security-opt seccomp=unconfined --device /dev/fuse
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, TEMPDIR, toJsonRpc, fromJsonRpc } from './helpers.mjs';

// --- container detection (mirrors src/sandbox.cpp running_in_container) -----

const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  (fs.existsSync('/proc/1/cgroup') &&
    fs.readFileSync('/proc/1/cgroup', 'utf8').split('\n')
      .some(l => l.includes('docker') || l.includes('containerd') || l.includes('kubepods')));

const skip = !IN_CONTAINER && 'not running inside a container';

// --- helpers ---------------------------------------------------------------

function makeCowDirs() {
  const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-docker-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  return {
    src, dst,
    cleanup: () => {
      // fuse-overlayfs upper/work dirs may have restrictive perms.
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    },
  };
}

/** Run boxsh with --sandbox + extra flags, single JSON-RPC request. */
function rpcWith(extraFlags, req, timeout_ms = 10000) {
  const input = JSON.stringify(toJsonRpc(req)) + '\n';
  const r = run(
    ['--rpc', '--workers', '1', '--sandbox', ...extraFlags],
    input,
    timeout_ms,
  );
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}\nstderr: ${r.stderr}`);
  const line = r.stdout.trim();
  // sandbox_apply may fail (e.g. missing /dev/fuse); callers inspect stderr.
  if (line.length === 0) {
    return { _no_output: true, stderr: r.stderr, status: r.status };
  }
  return { ...fromJsonRpc(JSON.parse(line)), stderr: r.stderr, status: r.status };
}

function rpcCow(src, dst, cmd, timeout_ms = 10000) {
  return rpcWith(['--bind', `cow:${src}:${dst}`], { id: '1', cmd }, timeout_ms);
}

// ---------------------------------------------------------------------------

describe('docker — container engine', { skip }, () => {
  test('sandbox switches to container engine and runs a command', () => {
    const r = run(['--sandbox', '-c', 'echo ok'],
      '', 10000);
    assert.equal(r.status, 0,
      `sandbox shell failed; stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'ok');
    // Engine switch notice must be emitted so users can confirm the switch.
    assert.ok(r.stderr.includes('container sandbox engine'),
      `expected container engine notice on stderr, got: ${r.stderr}`);
  });

  test('COW via fuse-overlayfs: writes go to dst, src untouched (task.flow scenario)', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'task.flow'), 'original\n');
      const resp = rpcCow(src, dst,
        `echo modified > ${dst}/task.flow && echo new > ${dst}/extra.flow`);
      assert.equal(resp.exit_code, 0,
        `cmd failed; stderr: ${resp.stderr}\nstdout: ${resp.stdout}`);
      // Source must be untouched — this is the core COW guarantee.
      assert.equal(fs.readFileSync(path.join(src, 'task.flow'), 'utf8'),
        'original\n');
      // Writes land in the destination (fuse-overlayfs upper layer).
      assert.equal(fs.readFileSync(path.join(dst, 'task.flow'), 'utf8'),
        'modified\n');
      assert.equal(fs.readFileSync(path.join(dst, 'extra.flow'), 'utf8'),
        'new\n');
    } finally {
      cleanup();
    }
  });

  test('COW src-layer files are readable at the dst mount point', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'readme.txt'), 'from-src\n');
      const resp = rpcCow(src, dst, `cat ${dst}/readme.txt`);
      assert.equal(resp.exit_code, 0,
        `cmd failed; stderr: ${resp.stderr}`);
      assert.equal(resp.stdout, 'from-src\n');
    } finally {
      cleanup();
    }
  });

  test('write tool can create a file at the sandbox root (task.flow upload regression)', () => {
    // Regression for the "task.flow upload fails" symptom: when sandbox_apply
    // succeeds the RPC loop starts and the write tool must work.  /task.flow
    // lives on the fresh tmpfs root inside the sandbox.
    const resp = rpcWith(
      [],
      { id: '1', tool: 'write', path: '/task.flow', content: 'uploaded\n' },
    );
    assert.ok(!resp.error, `write tool failed: ${resp.error}`);
    assert.ok(resp.content && resp.content.some(c => c.text && c.text.includes('bytes')),
      `unexpected write response: ${JSON.stringify(resp)}`);
  });

  test('sandbox isolation still holds: host /etc/hostname not the live root', () => {
    // After pivot_root the sandbox root is a fresh tmpfs.  A file we write at
    // /marker.flow must be visible, but the host root must not leak through.
    const r = run(['--sandbox', '-c',
      'echo sandbox > /marker.flow && test -f /marker.flow && echo present'],
      '', 10000);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'present');
    // The marker must NOT exist on the host filesystem (it was inside the ns).
    assert.ok(!fs.existsSync('/marker.flow'),
      'sandbox leaked a file to the host root');
  });
});
