import type { Worker, WorkerHealth } from '../src/contracts.ts';

export class FakeWorker implements Worker {
  events: string[] = [];
  state: WorkerHealth['state'] = 'stopped';
  start() {
    this.events.push('start');
    this.state = 'running';
  }
  async stop() {
    this.events.push('stop');
    this.state = 'stopped';
  }
  getStatus(): WorkerHealth {
    return { state: this.state, lastRunAt: null, lastErrorCode: null };
  }
}
