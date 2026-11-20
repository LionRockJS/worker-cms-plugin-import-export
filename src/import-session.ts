import { DurableObject } from 'cloudflare:workers';
import { applyImportPass, importErrorView, importProgressView, importSessionErrorView, type ImportProgress } from './admin';
import { CmsClient } from './cms';
import type { CsvImportMode } from './csv';

const SESSION_TTL_MS = 60 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;

interface Session {
  expiresAt: number;
  chunks: number;
  mode?: CsvImportMode;
  progress?: ImportProgress;
  writing?: boolean;
}

interface Confirmation {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  userId: string;
  pageType: string;
  importId: string;
  offset: number;
  mode: CsvImportMode;
}

export class ImportSession extends DurableObject<{ VIEWS: Fetcher }> {
  #running = false;

  async stage(csv: string): Promise<void> {
    const storage = this.ctx.storage;
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const bytes = new TextEncoder().encode(csv);
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
    await storage.setAlarm(expiresAt);
    storage.transactionSync(() => {
      for (let i = 0; i < chunks; i++) {
        storage.kv.put(`csv:${i}`, bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
      }
      storage.kv.put('session', { expiresAt, chunks } satisfies Session);
    });
  }

  async confirm(input: Confirmation): Promise<Response> {
    const { pageType, importId, offset } = input;
    const views = this.env.VIEWS;
    const storage = this.ctx.storage;
    const session = storage.kv.get<Session>('session');
    if (!session || session.expiresAt <= Date.now()) return importSessionErrorView(views, 'expired');
    if (this.#running) return importSessionErrorView(views, 'running');
    if (session.writing) return importSessionErrorView(views, 'interrupted');
    if (session.progress && (!session.chunks || offset !== session.progress.offset)) {
      return importProgressView(views, pageType, importId, session.progress);
    }
    if (offset !== (session.progress?.offset ?? 0)) return importSessionErrorView(views, 'review_required');

    this.#running = true;
    try {
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      storage.kv.put('session', session);
      await storage.setAlarm(session.expiresAt);
      const decoder = new TextDecoder();
      let csv = '';
      for (let i = 0; i < session.chunks; i++) {
        csv += decoder.decode(storage.kv.get<Uint8Array>(`csv:${i}`), { stream: true });
      }
      csv += decoder.decode();
      const cms = new CmsClient(input).actAs(input.userId);
      const mode = session.mode ?? input.mode;
      const progress = await applyImportPass(cms, pageType, csv, mode, session.progress, async () => {
        if (session.writing) return;
        // If the Worker loses the response to a CMS write, replaying this pass
        // could duplicate pages, especially in Force new mode.
        session.writing = true;
        storage.kv.put('session', session);
        await storage.sync();
      });
      storage.transactionSync(() => {
        if (progress.offset >= progress.totalRows) {
          for (let i = 0; i < session.chunks; i++) storage.kv.delete(`csv:${i}`);
          session.chunks = 0;
        }
        storage.kv.put('session', { ...session, mode, progress, writing: false });
      });
      return importProgressView(views, pageType, importId, progress);
    } catch (error) {
      if (session.writing) return importSessionErrorView(views, 'interrupted');
      return importErrorView(views, error);
    } finally {
      this.#running = false;
    }
  }

  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    const session = storage.kv.get<Session>('session');
    if (session && session.expiresAt > Date.now()) {
      await storage.setAlarm(session.expiresAt);
    } else {
      await storage.deleteAll();
    }
  }
}
