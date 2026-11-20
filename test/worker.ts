import { vi } from 'vitest';
import worker, { ImportSession } from '../src/index';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: unknown) {}
  },
}));

export default worker;

export function importSessions(views: Fetcher): DurableObjectNamespace<ImportSession> {
  const sessions = new Map<string, ImportSession>();
  return {
    getByName(name: string) {
      let session = sessions.get(name);
      if (!session) {
        const entries = new Map<string, unknown>();
        const storage = {
          kv: {
            get: (key: string) => structuredClone(entries.get(key)),
            put: (key: string, value: unknown) => entries.set(key, structuredClone(value)),
            delete: (key: string) => entries.delete(key),
          },
          async sync() {},
          async setAlarm() {},
          async deleteAll() { entries.clear(); },
          transactionSync<T>(callback: () => T) { return callback(); },
        };
        session = new ImportSession({ storage } as unknown as DurableObjectState, { VIEWS: views });
        sessions.set(name, session);
      }
      return session;
    },
  } as unknown as DurableObjectNamespace<ImportSession>;
}
