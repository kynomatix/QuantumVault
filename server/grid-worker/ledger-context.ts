import type {PoolClient} from 'pg';
import type {WorkerLease} from './lease';
export interface WorkerLedgerContext {
  lease(): WorkerLease;
  ready(): boolean;
  verifyStart(c: PoolClient, botId: string): Promise<void>;
  releaseReservation(c: PoolClient, botId: string): Promise<void>;
  terminate(pid: number): Promise<void>;
}
/** MAIN's request-bound holder is deliberately not a worker lease. */
export interface ProtectiveLedgerContext {
  requestId:string;botId:string;epoch:string;
  validate(c:PoolClient):Promise<void>;
  terminate(pid:number):Promise<void>;
}
