import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { SessionView } from '@team5/contracts';
import { describeFailure } from '@team5/messaging';
import { publicView } from './projection.reducer';
import { ProjectionRepository, type ProjectionRecord } from './projection.repository';
import { ProjectionListener } from './projection.listener';
import type { StreamClaims } from './session-stream.guard';

export function validateCursor(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new BadRequestException('Invalid Last-Event-ID');
  }
}
interface Sink {
  write(chunk: string): boolean;
  end(): unknown;
  destroy(): unknown;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}
interface StreamResponse extends Sink {
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
}

export class SnapshotWriter {
  private readonly logger = new Logger(SnapshotWriter.name);
  private pending?: SessionView;
  private blocked = false;
  private finished = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(private readonly sink: Sink, private readonly expiresAt: number, private readonly closed: () => void) {
    sink.on('close', this.close);
    sink.on('error', this.failed);
    sink.on('drain', this.drain);
    this.heartbeat = setInterval(() => { if (!this.blocked) this.write(': heartbeat\n\n'); }, 15000);
    this.armExpiry();
  }
  private armExpiry(): void {
    this.expiry = setTimeout(() => {
      if (Date.now() >= this.expiresAt) this.close();
      else this.armExpiry();
    }, Math.max(0, Math.min(2147483647, this.expiresAt - Date.now())));
  }
  private failed = (): void => {
    this.logger.warn('Session stream connection failed');
    this.close();
  };
  send(view: SessionView): void {
    if (this.finished) return;
    if (Date.now() >= this.expiresAt) { this.close(); return; }
    if (this.blocked) { this.pending = view; return; }
    this.write(`event: session\nid: ${view.version}\ndata: ${JSON.stringify(view)}\n\n`);
  }
  private write(frame: string): void {
    if (this.finished) return;
    if (Date.now() >= this.expiresAt) { this.close(); return; }
    try {
      if (!this.sink.write(frame)) {
        this.blocked = true;
        this.drainTimer = setTimeout(this.close, 15000);
      }
    } catch {
      this.logger.warn('Session stream write failed; closing connection');
      this.close();
    }
  }
  private drain = (): void => {
    if (this.finished) return;
    this.blocked = false;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    const next = this.pending;
    this.pending = undefined;
    if (next) this.send(next);
  };
  close = (): void => {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.expiry);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.pending = undefined;
    this.sink.off('drain', this.drain);
    this.sink.off('close', this.close);
    this.sink.off('error', this.failed);
    this.closed();
    if (this.blocked) this.sink.destroy();
    else this.sink.end();
  };
}

interface Subscriber {
  claims: StreamClaims;
  writer?: SnapshotWriter;
  revision: bigint;
  closed: boolean;
  remove(): void;
  close(): void;
}
interface SessionReaders {
  sessionId: string;
  clients: Set<Subscriber>;
  dirty: boolean;
  read?: Promise<ProjectionRecord | null>;
  refreshing?: Promise<void>;
}

@Injectable()
export class SessionStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionStreamService.name);
  private readonly sessions = new Map<string, SessionReaders>();
  private closing = false;
  constructor(private readonly repository: ProjectionRepository, private readonly listener: ProjectionListener) {
    listener.changes.add(this.changed);
    listener.unavailable.add(this.closeAll);
  }
  private changed = (sessionId: string): void => {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.dirty = true;
    this.refresh(session);
  };
  private read(session: SessionReaders): Promise<ProjectionRecord | null> {
    if (!session.read) session.read = this.repository.read(session.sessionId).finally(() => { session.read = undefined; });
    return session.read;
  }
  private validate(record: ProjectionRecord, sessionId: string): SessionView {
    const view = publicView(record.view);
    if (view.sessionId !== sessionId || view.version !== record.version || !/^[1-9]\d*$/.test(record.revision)) {
      throw new Error('Invalid stored projection identity');
    }
    return view;
  }
  private refresh(session: SessionReaders): void {
    if (session.refreshing || !session.dirty || ![...session.clients].some(client => client.writer)) return;
    session.refreshing = (async () => {
      // An invalidation must cause a read begun after it, not reuse an older initial read.
      if (session.read) await session.read;
      while (session.dirty && session.clients.size && !this.closing) {
        session.dirty = false;
        const record = await this.read(session);
        if (!record || !this.listener.ready) throw new Error('Projection unavailable during refresh');
        const view = this.validate(record, session.sessionId);
        const revision = BigInt(record.revision);
        for (const client of session.clients) {
          if (!client.writer || client.closed) continue;
          if (record.ownerId !== client.claims.subject) { client.close(); continue; }
          if (revision > client.revision) {
            client.revision = revision;
            client.writer.send(view);
          }
        }
      }
    })().catch(error => {
      this.logger.warn(`Projection refresh failed; closing session streams: ${describeFailure(error)}`);
      for (const client of [...session.clients]) client.close();
    }).finally(() => {
      session.refreshing = undefined;
      if (session.clients.size) this.refresh(session);
    });
  }
  async open(sessionId: string, claims: StreamClaims, response: StreamResponse): Promise<void> {
    if (this.closing || !this.listener.ready) throw new ServiceUnavailableException('projection_unavailable');
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, clients: new Set(), dirty: false };
      this.sessions.set(sessionId, session);
    }
    const readers = session;
    const client: Subscriber = {
      claims, revision: 0n, closed: false,
      remove: () => {
        client.closed = true;
        response.off('close', client.close);
        readers.clients.delete(client);
        if (!readers.clients.size) this.sessions.delete(sessionId);
      },
      close: () => {
        if (client.closed) return;
        if (client.writer) client.writer.close();
        else { client.remove(); response.end(); }
      },
    };
    readers.clients.add(client);
    response.on('close', client.close);
    try {
      let record;
      try { record = await this.read(readers); }
      catch {
        this.logger.warn('Projection snapshot read failed');
        throw new ServiceUnavailableException('projection_unavailable');
      }
      if (client.closed) return;
      if (!record) {
        response.setHeader('Retry-After', '1');
        throw new ServiceUnavailableException('projection_not_ready');
      }
      if (record.ownerId !== claims.subject) {
        this.logger.warn('Session stream ownership denied');
        throw new ForbiddenException();
      }
      if (Date.now() >= claims.expiresAt) throw new UnauthorizedException();
      if (!this.listener.ready) throw new ServiceUnavailableException('projection_unavailable');
      let view: SessionView;
      try { view = this.validate(record, sessionId); }
      catch {
        this.logger.warn('Projection snapshot validation failed');
        throw new ServiceUnavailableException('projection_unavailable');
      }
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
      response.setHeader('X-Accel-Buffering', 'no');
      client.writer = new SnapshotWriter(response, claims.expiresAt, client.remove);
      response.flushHeaders();
      client.revision = BigInt(record.revision);
      client.writer.send(view);
      this.refresh(readers);
    } catch (error) {
      if (client.closed) return;
      client.remove();
      if (!client.writer) throw error;
      this.logger.warn(`Session stream setup failed after headers: ${describeFailure(error)}`);
      client.writer.close();
    }
  }
  private closeAll = (): void => {
    for (const session of [...this.sessions.values()]) for (const client of [...session.clients]) client.close();
  };
  onModuleDestroy(): void {
    this.closing = true;
    this.closeAll();
    this.listener.changes.delete(this.changed);
    this.listener.unavailable.delete(this.closeAll);
  }
}
