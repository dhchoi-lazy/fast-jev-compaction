import { describe, expect, it } from 'vitest';
import { AUTO_COMPACT_DELAY_MS, register } from '../hooks/fast-jev.ts';

type Hook = (...args: any[]) => Promise<unknown>;

function setup(percent: number) {
  const hooks = new Map<string, Hook>();
  const order: string[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const logs: string[] = [];
  let compactImpl = async () => {
    order.push('compact');
    return {};
  };
  const $ = {
    session: {
      usage: async () => ({ context: { percent } }),
      compact: () => compactImpl(),
    },
    clock: {
      after: (ms: number, fn: () => void) => {
        order.push('schedule');
        timers.push({ ms, fn });
        return { cancel() {} };
      },
    },
    ui: { log: (t: string) => logs.push(t), toast: () => {} },
  };
  (register as any)((name: string, hook: Hook) => hooks.set(name, hook), { compactAtPercent: 30 });
  const next = async (e: unknown) => {
    order.push('next');
    return { text: 'answer' };
  };
  const fire = (e: object) => hooks.get('turn.complete')!($, { answer: '', turnId: 't', ...e }, next);
  const flush = async () => {
    for (const t of timers.splice(0)) t.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { fire, flush, order, timers, logs, setCompact: (f: typeof compactImpl) => (compactImpl = f) };
}

describe('turn.complete auto-compaction', () => {
  it('lets the turn finish, then compacts from a timer', async () => {
    const s = setup(45);
    await expect(s.fire({})).resolves.toEqual({ text: 'answer' });
    expect(s.order).toEqual(['next', 'schedule']);
    expect(s.timers[0]?.ms).toBe(AUTO_COMPACT_DELAY_MS);
    await s.flush();
    expect(s.order).toEqual(['next', 'schedule', 'compact']);
  });

  it('does nothing below the threshold or for a subagent turn', async () => {
    const low = setup(10);
    await low.fire({});
    const sub = setup(90);
    await sub.fire({ agentId: 'a1' });
    expect(low.order).toEqual(['next']);
    expect(sub.order).toEqual(['next']);
  });

  it('requests once while a compaction is pending and logs a rejected one', async () => {
    const s = setup(50);
    s.setCompact(async () => {
      throw new Error('a turn is running');
    });
    await s.fire({});
    await s.fire({});
    expect(s.timers).toHaveLength(1);
    await s.flush();
    expect(s.logs.some((l) => l.includes('a turn is running'))).toBe(true);
    await s.fire({});
    expect(s.timers).toHaveLength(1);
  });
});
